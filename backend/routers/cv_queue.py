"""/api/gpt — the extension's ChatGPT work queue (core/cv_queue.py).

The side panel says which jobs the bidder is on (prepare) and which questions to answer (want);
the extension's worker leases work (claim), runs it in a hidden ChatGPT frame, and reports
back (result / answers / fail / release / deleted). The CV is built HERE the moment ChatGPT's
JSON arrives, so finished work survives a closed browser; a lease that runs out puts unfinished
work back in the queue. Bidders and admins only; each sees and works their own rows.
"""
from __future__ import annotations

import threading

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user, has_role, storage
from core import cv_queue as Q
from core.job_questions import clean_questions, job_questions
from routers import resumes as R

router = APIRouter(prefix="/api/gpt", tags=["gpt"])


def _bidder(user: dict = Depends(get_current_user)) -> dict:
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    return user


def _ids(body: dict) -> tuple[str, str]:
    pid, jid = str((body or {}).get("profile_id") or "").strip(), str((body or {}).get("job_id") or "").strip()
    if not pid or not jid:
        raise HTTPException(status_code=400, detail="profile_id and job_id are required")
    return pid, jid


def _answers(raw, questions: list[str]) -> list[dict]:
    """[answer strings] (ChatGPT's order) → [{question, answer}]."""
    out = []
    for q, a in zip(questions, raw or []):
        a = str(a or "").strip()[:3000]
        if q and a:
            out.append({"question": q, "answer": a})
    return out


def _merge_answers(resume_id: str, fresh: list[dict]) -> None:
    rec = storage.get_generated_resume_by_id(resume_id) or {}
    keep = [a for a in rec.get("application_answers") or [] if a.get("question", "").lower() not in {f["question"].lower() for f in fresh}]
    storage.update_generated_resume(resume_id, {"application_answers": keep + fresh})


# ---------- the panel ----------
@router.post("/prepare")
def prepare(body: dict, user: dict = Depends(_bidder)):
    """body: {profile_id, jobs: [{id, company, job_title}]} — the job on screen first, then the
    next ones in the Bid queue. The first 3 without a CV are queued."""
    pid = str((body or {}).get("profile_id") or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="profile_id is required")
    R._check_profile_access(user, pid)
    jobs = [j for j in (body or {}).get("jobs") or [] if isinstance(j, dict) and j.get("id")][:20]
    with_cv = {r.get("job_id") for r in storage.get_generated_resumes_for_profile(pid) if r.get("status") == "generated"}
    return {"threads": Q.prepare(storage.db_path, user, pid, jobs, lambda jid: jid in with_cv)}


@router.get("/threads")
def threads(profile_id: str = "", user: dict = Depends(_bidder)):
    return {"threads": Q.threads(storage.db_path, user, profile_id)}


@router.post("/want")
def want(body: dict, user: dict = Depends(_bidder)):
    """Questions to answer for this job in its CV conversation (now, or right after the CV)."""
    pid, jid = _ids(body)
    R._check_profile_access(user, pid)
    qs = clean_questions((body or {}).get("questions") or [])
    r = Q.want_answers(storage.db_path, user, pid, jid, qs, resume_id=str(body.get("resume_id") or ""),
                       context=str(body.get("context") or ""), company=str(body.get("company") or ""), job_title=str(body.get("job_title") or ""))
    return {"ok": r == "ok", "reason": r}


@router.post("/retry")
def retry(body: dict, user: dict = Depends(_bidder)):
    pid, jid = _ids(body)
    Q.retry(storage.db_path, user, pid, jid)
    return {"ok": True}


@router.post("/close")
def close(body: dict, user: dict = Depends(_bidder)):
    pid, jid = _ids(body)
    R._check_profile_access(user, pid)
    Q.close(storage.db_path, profile_id=pid, job_id=jid)
    return {"ok": True}


# ---------- the extension's worker ----------
def _task(row, work: str) -> dict | None:
    """What ChatGPT needs for one leased row."""
    if work == "write":
        job = storage.get_job_by_id(row.job_id)
        if not job or job.get("status") != "approved" or job.get("flagged") or job.get("admin_applied"):
            raise HTTPException(status_code=404, detail="The job is no longer available.")
        return {"prompt": R._build_prompt(R._get_profile(row.profile_id), job), "questions": job_questions(job)}
    rec = storage.get_generated_resume_by_id(row.resume_id) or {}
    have = {a.get("question", "").lower() for a in rec.get("application_answers") or []}
    missing = [q for q in row.want or [] if q.lower() not in have]
    if not missing:
        return None
    return {"questions": missing, "context": "" if row.conversation else row.context}


@router.post("/claim")
def claim(body: dict, user: dict = Depends(_bidder)):
    """body: {device, slots, active} → up to `slots` leased tasks for this browser. `active`: the
    keys it is still working on — its other leases are orphaned and handed back."""
    slots = max(0, min(int((body or {}).get("slots") or 0), 5))
    device = str((body or {}).get("device") or "")[:64]
    active = [str(k) for k in (body or {}).get("active") or []][:20]
    return {"tasks": Q.claim(storage.db_path, user, device, slots, build_task=_task, active=active)}


@router.post("/result")
def result(body: dict, user: dict = Depends(_bidder)):
    """ChatGPT wrote the CV (+ answers): build the CV now, save the answers.
    body: {profile_id, job_id, resume_json, conversation, questions?, answers?}"""
    pid, jid = _ids(body)
    row = Q.lease_of(storage.db_path, user, pid, jid)
    if row is None:
        return {"ok": False, "gone": True}
    conversation = str(body.get("conversation") or "")[:500] if "/c/" in str(body.get("conversation") or "") else ""
    if row["stage"] == "closing":               # applied / skipped while ChatGPT wrote: no CV, just delete it
        Q.update(storage.db_path, user, pid, jid, lambda r: (setattr(r, "conversation", conversation or r.conversation), Q._release(r)))
        return {"ok": True, "closed": True}
    data = body.get("resume_json")
    try:
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="ChatGPT did not return a resume object.")
        rec = R.build_cv(user, pid, jid, data, source="chatgpt_auto")
    except HTTPException as exc:
        msg = str(exc.detail)[:1000]

        def failed(r):
            r.stage = "queued" if r.attempts < Q.MAX_ATTEMPTS else "failed"
            r.error, r.conversation = f"The CV could not be built: {msg}", conversation or r.conversation
            Q._release(r)
        Q.update(storage.db_path, user, pid, jid, failed)
        return {"ok": False, "error": msg}
    rid = rec["saved_resume_id"]
    threading.Thread(target=R._render_pdf_to_cache, args=(rid,), daemon=True).start()
    asked = clean_questions(body.get("questions") or [])
    fresh = _answers(body.get("answers"), asked)
    if fresh:
        _merge_answers(rid, fresh)
    try:   # the Bid audit: this covers the copy-prompt and generate steps
        R.bid_track({"action": "auto_generate", "profile_id": pid, "job_id": jid, "company": rec["job_company"], "job_title": rec["job_title"]}, user)
    except Exception:
        pass
    done = {f["question"].lower() for f in fresh}

    def ready(r):
        r.stage = "closing" if r.stage == "closing" else "ready"
        r.resume_id, r.ats_score, r.conversation = rid, int(rec.get("ats_score") or 0), conversation or r.conversation
        r.error = "" if fresh or not asked else "Answers: ChatGPT did not answer the questions."
        r.want = [q for q in r.want or [] if q.lower() not in done]
        Q._release(r)
    Q.update(storage.db_path, user, pid, jid, ready)
    return {"ok": True, "resume_id": rid, "ats_score": rec["ats_score"]}


@router.post("/answers")
def answers(body: dict, user: dict = Depends(_bidder)):
    """Answers to questions added after the CV. body: {profile_id, job_id, questions, answers, conversation}"""
    pid, jid = _ids(body)
    row = Q.lease_of(storage.db_path, user, pid, jid)
    if row is None or not row["resume_id"]:
        return {"ok": False, "gone": True}
    asked = clean_questions(body.get("questions") or [])
    fresh = _answers(body.get("answers"), asked)
    if fresh:
        _merge_answers(row["resume_id"], fresh)
    done = {f["question"].lower() for f in fresh}
    conversation = str(body.get("conversation") or "")[:500] if "/c/" in str(body.get("conversation") or "") else ""

    def answered(r):
        r.want = [q for q in r.want or [] if q.lower() not in done]
        r.conversation = r.conversation or conversation        # a new chat: deleted later too
        r.error = ""
        Q._release(r)
    Q.update(storage.db_path, user, pid, jid, answered)
    return {"ok": True}


@router.post("/fail")
def fail(body: dict, user: dict = Depends(_bidder)):
    """ChatGPT could not do it. body: {profile_id, job_id, work, error}"""
    pid, jid = _ids(body)
    msg = str((body or {}).get("error") or "ChatGPT failed.")[:900]
    work = str((body or {}).get("work") or "")

    def failed(r):
        if work == "write" and r.stage == "writing":
            r.stage = "queued" if r.attempts < Q.MAX_ATTEMPTS else "failed"
            r.error = msg
        elif work == "answer":
            r.want, r.error = [], f"Answers: {msg}"
        Q._release(r)
    Q.update(storage.db_path, user, pid, jid, failed)
    return {"ok": True}


@router.post("/release")
def release(body: dict, user: dict = Depends(_bidder)):
    Q.release(storage.db_path, user, [str(k) for k in (body or {}).get("keys") or []][:50])
    return {"ok": True}


@router.post("/deleted")
def deleted(body: dict, user: dict = Depends(_bidder)):
    b = body or {}
    Q.deleted(storage.db_path, user, [str(k) for k in b.get("keys") or []][:100],
              [str(x) for x in b.get("done") or []], [str(x) for x in b.get("failed") or []])
    return {"ok": True}
