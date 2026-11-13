"""The extension's ChatGPT work queue (table cv_queue) — see CvQueueRow.

Each bidder's extension leases work from here, runs it in a hidden ChatGPT frame and reports
back; nothing it has finished is lost when the browser closes, and a lease that runs out puts
unfinished work back in the queue. Every change is one transaction with SQLite's write lock
taken first (BEGIN IMMEDIATE), so two browsers can never lease the same row.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import select

from core.db import session_scope
from core.db.models import CvQueueRow
from core.storage import _write_lock

AHEAD = 3                                   # CVs prepared ahead: the job on screen + the next 2
MAX_ATTEMPTS = 2
LEASE = {"write": timedelta(minutes=12), "answer": timedelta(minutes=6), "delete": timedelta(minutes=4)}
IDLE_CLOSE = timedelta(hours=12)            # a ready / failed row nobody touched → its conversation is deleted
DELETE_TRIES = 5


def _now() -> datetime:
    return datetime.utcnow()


def _iso(d: datetime | None) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ") if d else ""


def as_dict(r: CvQueueRow) -> dict:
    return {
        "key": f"{r.profile_id}:{r.job_id}", "profile_id": r.profile_id, "job_id": r.job_id,
        "company": r.company, "job_title": r.job_title, "stage": r.stage, "work": r.work,
        "attempts": r.attempts, "want": list(r.want or []), "conversation": r.conversation,
        "resume_id": r.resume_id, "ats_score": r.ats_score, "error": r.error,
        "updated_at": _iso(r.updated_at),
    }


def _release(r: CvQueueRow) -> None:
    r.work, r.lease_until, r.lease_device = "", None, ""
    r.updated_at = _now()


def _expire(session, user_id: str) -> None:
    """Leases that ran out (browser closed mid-work) and idle threads."""
    now = _now()
    for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == user_id)).all():
        if r.lease_until and r.lease_until < now:
            if r.work == "write" and r.stage == "writing":
                r.stage = "queued"
                r.error = "The browser stopped before ChatGPT finished — writing it again."
            _release(r)
        if r.stage in ("ready", "failed") and not r.work and r.updated_at and now - r.updated_at > IDLE_CLOSE:
            r.stage = "closing"
            r.updated_at = now


# ---------- what the panel asks for ----------
def prepare(db_path, user: dict, profile_id: str, jobs: list[dict], has_cv) -> list[dict]:
    """The bidder is on jobs[0]; jobs[1:] come next. Queue the first AHEAD of them that have
    no CV yet (has_cv(job_id)). Queued work of this bidder outside that window (another
    profile, jobs passed by) is dropped — nothing was sent to ChatGPT for it."""
    window = [j for j in jobs if not has_cv(j["id"])][:AHEAD]
    keep = {(profile_id, j["id"]) for j in window}
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid, CvQueueRow.stage == "queued")).all():
            if (r.profile_id, r.job_id) not in keep and not r.work and not (r.want or []):
                session.delete(r)
        for i, j in enumerate(window):
            r = session.get(CvQueueRow, (profile_id, j["id"]))
            if r is None:
                session.add(CvQueueRow(profile_id=profile_id, job_id=j["id"], user_id=uid, username=user.get("username", ""),
                                       company=j.get("company", "")[:255], job_title=j.get("job_title", "")[:255],
                                       stage="queued", priority=100 - i, want=[], created_at=_now(), updated_at=_now()))
            elif r.stage == "queued" and r.user_id == uid:
                r.priority = 100 - i
                r.updated_at = _now()
    return threads(db_path, user, profile_id)


def threads(db_path, user: dict, profile_id: str = "") -> list[dict]:
    with session_scope(db_path) as session:
        q = select(CvQueueRow).where(CvQueueRow.user_id == user.get("id", ""))
        if profile_id:
            q = q.where(CvQueueRow.profile_id == profile_id)
        return [as_dict(r) for r in session.scalars(q).all()]


def want_answers(db_path, user: dict, profile_id: str, job_id: str, questions: list[str], *,
                 resume_id: str = "", context: str = "", company: str = "", job_title: str = "") -> str:
    """Questions to answer for this job: in its CV conversation (now, or right after the CV).
    A CV built by hand has no conversation: a new chat gets the job (context) instead."""
    with session_scope(db_path) as session:
        _write_lock(session)
        r = session.get(CvQueueRow, (profile_id, job_id))
        if r is not None and r.stage == "closing":
            return "closing"
        if r is None:
            if not resume_id:
                return "no-cv"
            r = CvQueueRow(profile_id=profile_id, job_id=job_id, user_id=user.get("id", ""), username=user.get("username", ""),
                           company=company[:255], job_title=job_title[:255], stage="ready", resume_id=resume_id,
                           want=[], created_at=_now(), updated_at=_now())
            session.add(r)
        if resume_id and not r.resume_id:
            r.resume_id = resume_id
        if context:
            r.context = context[:20000]
        seen = {q.lower() for q in (r.want or [])}
        r.want = list(r.want or []) + [q for q in questions if q.lower() not in seen]
        r.error = ""
        r.updated_at = _now()
        return "ok"


def retry(db_path, user: dict, profile_id: str, job_id: str) -> None:
    with session_scope(db_path) as session:
        _write_lock(session)
        r = session.get(CvQueueRow, (profile_id, job_id))
        if r is not None and r.user_id == user.get("id", "") and not r.work:
            r.stage = "ready" if r.resume_id else "queued"
            r.attempts, r.error, r.updated_at = 0, "", _now()


def close(db_path, *, profile_id: str = "", job_id: str = "", job_ids: Iterable[str] = ()) -> int:
    """The job is done (applied / reported / skipped): its ChatGPT conversation is deleted by the
    owner's extension; a row with no conversation simply goes. Returns how many rows closed."""
    with session_scope(db_path) as session:
        _write_lock(session)
        q = select(CvQueueRow)
        if profile_id and job_id:
            q = q.where(CvQueueRow.profile_id == profile_id, CvQueueRow.job_id == job_id)
        else:
            ids = list(job_ids)
            if not ids:
                return 0
            q = q.where(CvQueueRow.job_id.in_(ids))
        n = 0
        for r in session.scalars(q).all():
            n += 1
            if not r.conversation:
                session.delete(r)
                continue
            r.stage = "closing"
            r.want = []
            if r.work in ("write", "answer"):
                _release(r)           # its frame finds the job gone when it reports
            r.updated_at = _now()
        return n


# ---------- what the extension's worker asks for ----------
def claim(db_path, user: dict, device: str, slots: int, *, build_task, active: Iterable[str] = ()) -> list[dict]:
    """Lease up to `slots` pieces of work to this browser: one delete batch, then the jobs
    (highest priority first), then answers for questions added later. build_task(row) adds
    what ChatGPT needs (the CV prompt, the questions).

    `active`: the keys this browser is really working on. Any other lease it holds is orphaned
    (the browser closed between a lease and starting its frame) and is handed back right away
    instead of waiting for the lease to run out."""
    out: list[dict] = []
    keep = set(active)
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        _expire(session, uid)
        if device:
            for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid, CvQueueRow.lease_device == device)).all():
                if r.work and f"{r.profile_id}:{r.job_id}" not in keep:
                    if r.work == "write" and r.stage == "writing":
                        r.stage, r.attempts = "queued", max(0, r.attempts - 1)
                    _release(r)
        if slots <= 0:
            return out
        rows = session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid)).all()
        now = _now()
        closing = [r for r in rows if r.stage == "closing" and not r.work and r.conversation
                   and (r.retry_delete_at is None or r.retry_delete_at <= now)]
        if closing and not any(r.work == "delete" for r in rows):
            for r in closing:
                r.work, r.lease_until, r.lease_device = "delete", now + LEASE["delete"], device
            out.append({"work": "delete", "keys": [f"{r.profile_id}:{r.job_id}" for r in closing],
                        "ids": [r.conversation.rsplit("/c/", 1)[-1] for r in closing]})
            slots -= 1
        todo = sorted((r for r in rows if not r.work and (r.stage == "queued" or (r.stage == "ready" and (r.want or []) and r.resume_id))),
                      key=lambda r: (r.stage != "queued", -(r.priority or 0), r.created_at or now))
        for r in todo:
            if slots <= 0:
                break
            work = "write" if r.stage == "queued" else "answer"
            try:
                task = build_task(r, work)
            except Exception as exc:                     # e.g. the job is no longer available
                r.attempts += 1
                r.error = str(getattr(exc, "detail", exc))[:1000]
                r.stage = "failed" if work == "write" and r.attempts >= MAX_ATTEMPTS else r.stage
                if work == "answer":
                    r.want, r.error = [], f"Answers: {r.error}"[:1000]
                r.updated_at = now
                continue
            if task is None:                             # nothing left to answer
                r.want, r.updated_at = [], now
                continue
            r.work, r.lease_until, r.lease_device = work, now + LEASE[work], device
            if work == "write":
                r.stage, r.attempts = "writing", r.attempts + 1
            r.updated_at = now
            out.append({"work": work, "key": f"{r.profile_id}:{r.job_id}", "profile_id": r.profile_id, "job_id": r.job_id,
                        "conversation": r.conversation, **task})
            slots -= 1
    return out


def lease_of(db_path, user: dict, profile_id: str, job_id: str) -> dict | None:
    with session_scope(db_path) as session:
        r = session.get(CvQueueRow, (profile_id, job_id))
        return as_dict(r) if r is not None and r.user_id == user.get("id", "") else None


def update(db_path, user: dict, profile_id: str, job_id: str, fn) -> dict | None:
    """Read-modify-write one row of this bidder (fn(row) changes it); None if it is gone."""
    with session_scope(db_path) as session:
        _write_lock(session)
        r = session.get(CvQueueRow, (profile_id, job_id))
        if r is None or r.user_id != user.get("id", ""):
            return None
        fn(r)
        r.updated_at = _now()
        return as_dict(r)


def release(db_path, user: dict, keys: list[str]) -> None:
    """Work handed back without an attempt (Disconnect, a frame that disappeared, ChatGPT
    signed out / Free plan / usage limit)."""
    with session_scope(db_path) as session:
        _write_lock(session)
        for key in keys:
            pid, _, jid = key.partition(":")
            r = session.get(CvQueueRow, (pid, jid))
            if r is None or r.user_id != user.get("id", "") or not r.work:
                continue
            if r.work == "write" and r.stage == "writing":
                r.stage, r.attempts = "queued", max(0, r.attempts - 1)
            _release(r)


def deleted(db_path, user: dict, keys: list[str], done_ids: list[str], failed_ids: list[str]) -> None:
    """A delete batch came back: deleted conversations' rows go; failures wait longer each
    time (5, 10, 20, 40, 60 minutes) and are given up after DELETE_TRIES."""
    done, failed = set(done_ids), set(failed_ids)
    with session_scope(db_path) as session:
        _write_lock(session)
        for key in keys:
            pid, _, jid = key.partition(":")
            r = session.get(CvQueueRow, (pid, jid))
            if r is None or r.user_id != user.get("id", ""):
                continue
            cid = r.conversation.rsplit("/c/", 1)[-1]
            if cid in done:
                session.delete(r)
                continue
            r.delete_tries += 1
            if r.delete_tries >= DELETE_TRIES:
                session.delete(r)
                continue
            r.retry_delete_at = _now() + timedelta(minutes=min(60, 5 * 2 ** (r.delete_tries - 1)))
            r.error = "Could not delete the ChatGPT conversation — trying again later."
            _release(r)
