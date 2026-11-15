"""/api/gpt — the extension's ChatGPT work queue (core/cv_queue.py).

The side panel says which jobs the bidder is on (prepare) and which questions to answer (want);
the extension's worker leases work (claim), runs it in a hidden ChatGPT frame, and reports
back (started / result / answers / fail / release / deleted). The CV is built HERE the moment
ChatGPT's JSON arrives, so finished work survives a closed browser; a lease that runs out puts
unfinished work back in the queue. Every ChatGPT conversation is reported the moment it opens
(started) and deleted from the account once it is not needed (core/cv_queue.py). Bidders and
admins only; each sees and works their own rows.
"""
from __future__ import annotations

import json
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
    return {"threads": Q.threads(storage.db_path, user, profile_id), "to_delete": Q.chats_to_delete(storage.db_path, user)}


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
    return {"questions": missing, "context": "" if row.conversation else _context(row, rec)}


def _context(row, rec: dict) -> str:
    """A new chat (the CV's own was deleted, or the CV was built by hand): the job and the CV."""
    job = storage.get_job_by_id(row.job_id) or {}
    cv = rec.get("resume") or {}
    lines = [f"JOB: {row.job_title or job.get('title', '')} at {row.company or job.get('company', '')}"]
    if job.get("description"):
        lines.append("JOB DESCRIPTION:\n" + str(job["description"])[:6000])
    if cv.get("summary") or cv.get("work_history"):
        work = [{k: w.get(k) for k in ("title", "company", "start_date", "end_date", "bullets", "highlights") if w.get(k)}
                for w in cv.get("work_history") or [] if isinstance(w, dict)]
        lines.append("CANDIDATE RESUME:\n" + json.dumps({"name": cv.get("name"), "headline": cv.get("headline"), "summary": cv.get("summary"),
                                                         "skills": cv.get("technical_skills"), "work_history": work}, ensure_ascii=False)[:9000])
    elif row.context:
        return row.context
    return "\n\n".join(lines)


@router.post("/claim")
def claim(body: dict, user: dict = Depends(_bidder)):
    """body: {device, slots, active} → up to `slots` leased tasks for this browser. `active`: the
    keys it is still working on — its other leases are orphaned and handed back."""
    slots = max(0, min(int((body or {}).get("slots") or 0), 5))
    device = str((body or {}).get("device") or "")[:64]
    active = [str(k) for k in (body or {}).get("active") or []][:40]
    return Q.claim(storage.db_path, user, device, slots, build_task=_task, active=active, only_deletes=bool((body or {}).get("only_deletes")))


@router.post("/started")
def started(body: dict, user: dict = Depends(_bidder)):
    """ChatGPT opened a conversation for leased work. body: {profile_id, job_id, conversation, device}"""
    pid, jid = _ids(body)
    return {"state": Q.started(storage.db_path, user, pid, jid, str(body.get("conversation") or ""), str(body.get("device") or "")[:64])}


@router.post("/result")
def result(body: dict, user: dict = Depends(_bidder)):
    """ChatGPT wrote the CV (+ answers): build the CV now, save the answers.
    body: {profile_id, job_id, resume_json, conversation, questions?, answers?}"""
    pid, jid = _ids(body)
    conversation = Q.conversation_url(body.get("conversation"))
    device = str(body.get("device") or "")[:64]
    row = Q.lease_of(storage.db_path, user, pid, jid)
    if row is None or row["stage"] == "closing":   # applied / skipped while ChatGPT wrote: no CV, its chat is deleted
        _gone(user, pid, jid, conversation, device)
        return {"ok": True, "closed": True}
    data = body.get("resume_json")
    try:
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="ChatGPT did not return a resume object.")
        rec = R.build_cv(user, pid, jid, data, source="chatgpt_auto")
    except HTTPException as exc:
        msg = str(exc.detail)[:1000]

        def failed(r, session):
            _adopt(session, r, conversation, device)
            Q._drop_chat(session, r)              # a new try starts a new chat
            r.stage = "queued" if r.attempts < Q.MAX_ATTEMPTS else "failed"
            r.error = f"The CV could not be built: {msg}"
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

    def ready(r, session):
        _adopt(session, r, conversation, device)
        if r.stage == "closing":                  # applied / skipped while the CV was being saved
            Q._drop_chat(session, r)
            session.delete(r)
            return
        r.stage = "ready"
        r.resume_id, r.ats_score = rid, int(rec.get("ats_score") or 0)
        r.error = "" if fresh or not asked else "Answers: ChatGPT did not answer the questions."
        r.want = [q for q in r.want or [] if q.lower() not in done]
        Q._release(r)
    Q.update(storage.db_path, user, pid, jid, ready)
    return {"ok": True, "resume_id": rid, "ats_score": rec["ats_score"]}


@router.post("/answers")
def answers(body: dict, user: dict = Depends(_bidder)):
    """Answers to questions added after the CV. body: {profile_id, job_id, questions, answers, conversation}"""
    pid, jid = _ids(body)
    conversation = Q.conversation_url(body.get("conversation"))
    device = str(body.get("device") or "")[:64]
    row = Q.lease_of(storage.db_path, user, pid, jid)
    if row is None or not row["resume_id"]:
        _gone(user, pid, jid, conversation, device)
        return {"ok": False, "gone": True}
    asked = clean_questions(body.get("questions") or [])
    fresh = _answers(body.get("answers"), asked)
    if fresh:
        _merge_answers(row["resume_id"], fresh)
    done = {f["question"].lower() for f in fresh}

    def answered(r, session):
        _adopt(session, r, conversation, device)       # a new chat: kept for later questions, deleted with the job
        if r.stage == "closing":
            Q._drop_chat(session, r)
            session.delete(r)
            return
        r.want = [q for q in r.want or [] if q.lower() not in done]
        r.error = ""
        Q._release(r)
    Q.update(storage.db_path, user, pid, jid, answered)
    return {"ok": True}


@router.post("/fail")
def fail(body: dict, user: dict = Depends(_bidder)):
    """ChatGPT could not do it. body: {profile_id, job_id, work, error, conversation, device}"""
    pid, jid = _ids(body)
    msg = str((body or {}).get("error") or "ChatGPT failed.")[:900]
    work = str((body or {}).get("work") or "")
    conversation = Q.conversation_url(body.get("conversation"))
    device = str(body.get("device") or "")[:64]

    def failed(r, session):
        _adopt(session, r, conversation, device)
        if r.stage == "closing":
            Q._drop_chat(session, r)
            session.delete(r)
            return
        if work == "write" and r.stage == "writing":
            Q._drop_chat(session, r)              # the failed chat is deleted; a new try starts a new one
            r.stage = "queued" if r.attempts < Q.MAX_ATTEMPTS else "failed"
            r.error = msg
        elif work == "answer":
            r.want, r.error = [], f"Answers: {msg}"
        Q._release(r)
    if Q.update(storage.db_path, user, pid, jid, failed) is None:
        _gone(user, pid, jid, conversation, device)
    return {"ok": True}


@router.post("/release")
def release(body: dict, user: dict = Depends(_bidder)):
    """body: {keys, chats?, device?} — chats: conversations those frames had opened."""
    b = body or {}
    Q.release(storage.db_path, user, [str(k) for k in b.get("keys") or []][:50],
              [str(c) for c in b.get("chats") or []][:50], str(b.get("device") or "")[:64])
    return {"ok": True}


@router.post("/deleted")
def deleted(body: dict, user: dict = Depends(_bidder)):
    """A delete batch came back. body: {done: [conversation ids], failed: [...]}"""
    b = body or {}
    Q.deleted(storage.db_path, user, [str(x) for x in b.get("done") or []][:100], [str(x) for x in b.get("failed") or []][:100])
    return {"ok": True}


@router.post("/cleanup")
def cleanup(body: dict, user: dict = Depends(_bidder)):
    """Disconnect: delete every ChatGPT chat this bidder's queue still keeps (CVs and answers stay)."""
    return {"to_delete": Q.cleanup(storage.db_path, user, str((body or {}).get("device") or "")[:64])}


@router.post("/trash")
def trash(body: dict, user: dict = Depends(_bidder)):
    """Conversations the extension created and nothing needs (left by an older version)."""
    b = body or {}
    Q.trash(storage.db_path, user, [str(c) for c in b.get("chats") or []][:200], str(b.get("device") or "")[:64])
    return {"ok": True}


# ---------- helpers: a conversation the report names ----------
def _adopt(session, r, conversation: str, device: str) -> None:
    """The report names the work's conversation: the row's own (started may have been missed)."""
    if conversation and Q.conversation_id(conversation) != Q.conversation_id(r.conversation):
        Q._drop_chat(session, r, device)
        r.conversation = conversation


def _gone(user: dict, pid: str, jid: str, conversation: str, device: str) -> None:
    """The row is gone (or closing): nothing needs this conversation; a closing row goes now."""
    Q.release(storage.db_path, user, [f"{pid}:{jid}"], [conversation] if conversation else [], device)
