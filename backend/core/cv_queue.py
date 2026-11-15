"""The extension's ChatGPT work queue (table cv_queue) and the ChatGPT conversations it must
delete from the bidder's account (table gpt_chats_to_delete) — see CvQueueRow, GptChatRow.

Each bidder's extension leases work from here, runs it in a hidden ChatGPT frame and reports
back; nothing it has finished is lost when the browser closes, and a lease that runs out puts
unfinished work back in the queue. Every change is one transaction with SQLite's write lock
taken first (BEGIN IMMEDIATE), so two browsers can never lease the same row.

Conversations: the extension reports a conversation the moment ChatGPT opens it (started), so
the server knows every one. A conversation is kept only while it is useful — the CV's own chat,
for questions asked later — and moves to the delete list as soon as it is not: the job is
applied / skipped / reported, the CV failed or is written again, the browser closed mid-write,
the bidder disconnected, or nobody touched it for IDLE_CLOSE.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import func, select

from core.db import session_scope
from core.db.models import CvQueueRow, GptChatRow
from core.storage import _write_lock

AHEAD = 3                                   # CVs prepared ahead: the job on screen + the next 2
MAX_ATTEMPTS = 2
LEASE = {"write": timedelta(minutes=12), "answer": timedelta(minutes=6), "delete": timedelta(minutes=4)}
IDLE_CLOSE = timedelta(hours=2)             # a ready / failed row nobody touched → its conversation is deleted
DELETE_BATCH = 25
DELETE_TRIES = 12                           # 5, 10, 20, 40, 60, 60… minutes apart (~8 hours), then given up
ANY_DEVICE_AFTER = timedelta(hours=24)      # a chat its own browser never deleted: any browser of the user tries

_CID = re.compile(r"/c/([A-Za-z0-9][A-Za-z0-9_-]{7,100})")


def _now() -> datetime:
    return datetime.utcnow()


def _iso(d: datetime | None) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ") if d else ""


def conversation_url(raw) -> str:
    """A ChatGPT conversation URL (…/c/<id>) or ''."""
    s = str(raw or "").strip()[:500]
    return s if _CID.search(s) else ""


def conversation_id(raw) -> str:
    m = _CID.search(str(raw or ""))
    return m.group(1) if m else ""


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


def _trash(session, user_id: str, conversation: str, *, device: str = "", label: str = "") -> None:
    """This conversation is no longer needed: delete it from the ChatGPT account."""
    cid = conversation_id(conversation)
    if not cid or session.get(GptChatRow, cid) is not None:
        return
    session.add(GptChatRow(conversation_id=cid, user_id=user_id, device=device[:64], label=label[:255], created_at=_now()))
    session.flush()


def _drop_chat(session, r: CvQueueRow, device: str = "") -> None:
    """The row's conversation goes to the delete list; the row (its CV, its answers) stays."""
    if r.conversation:
        _trash(session, r.user_id, r.conversation, device=device or r.lease_device, label=f"{r.company} — {r.job_title}")
    r.conversation = ""


def _requeue(session, r: CvQueueRow) -> None:
    """A CV write that will not finish (browser closed, Disconnect, an orphaned lease): write it
    again later in a NEW chat — the half-written one is deleted."""
    _drop_chat(session, r)
    r.stage = "queued"


def _expire(session, user_id: str) -> None:
    """Leases that ran out (browser closed mid-work) and idle rows."""
    now = _now()
    for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == user_id)).all():
        if r.lease_until and r.lease_until < now:
            if r.work == "write" and r.stage == "writing":
                _requeue(session, r)
                r.error = "The browser stopped before ChatGPT finished — writing it again."
            _release(r)
        if r.work:
            continue
        if r.stage == "closing" or (r.stage in ("ready", "failed") and r.updated_at and now - r.updated_at > IDLE_CLOSE):
            _drop_chat(session, r)      # the CV and its answers stay; a question asked later gets a new chat
            session.delete(r)
    for c in session.scalars(select(GptChatRow).where(GptChatRow.user_id == user_id, GptChatRow.lease_until.is_not(None))).all():
        if c.lease_until < now:
            c.lease_until, c.lease_device = None, ""


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
                _drop_chat(session, r)
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


def chats_to_delete(db_path, user: dict) -> int:
    with session_scope(db_path) as session:
        return int(session.scalar(select(func.count()).select_from(GptChatRow).where(GptChatRow.user_id == user.get("id", ""))) or 0)


def want_answers(db_path, user: dict, profile_id: str, job_id: str, questions: list[str], *,
                 resume_id: str = "", context: str = "", company: str = "", job_title: str = "") -> str:
    """Questions to answer for this job: in its CV conversation (now, or right after the CV).
    A CV with no conversation (built by hand, or its chat already deleted): a new chat gets the
    job and the CV (context) instead."""
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
        if r is not None and r.user_id == user.get("id", "") and not r.work and r.stage != "closing":
            if not r.resume_id:
                _drop_chat(session, r)                  # a new chat for the new try
            r.stage = "ready" if r.resume_id else "queued"
            r.attempts, r.error, r.updated_at = 0, "", _now()


def close(db_path, *, profile_id: str = "", job_id: str = "", job_ids: Iterable[str] = ()) -> int:
    """The job is done (applied / reported / skipped): its ChatGPT conversation goes to the delete
    list and the row goes. A row ChatGPT is still working on stays as 'closing' until its frame
    reports (whatever it reports is thrown away) or its lease runs out. Returns how many closed."""
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
            _drop_chat(session, r)
            if r.work in ("write", "answer"):
                r.stage, r.want, r.updated_at = "closing", [], _now()
            else:
                session.delete(r)
        return n


def cleanup(db_path, user: dict, device: str = "") -> int:
    """Disconnect: every conversation of this bidder that nothing is working on goes to the
    delete list (their CVs and answers stay). Returns how many chats are waiting to be deleted."""
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid)).all():
            if r.work:
                continue
            _drop_chat(session, r, device)
            if r.stage == "closing":
                session.delete(r)
        session.flush()
        return int(session.scalar(select(func.count()).select_from(GptChatRow).where(GptChatRow.user_id == uid)) or 0)


def trash(db_path, user: dict, conversations: Iterable[str], device: str = "") -> None:
    """Conversations the extension knows it created and nothing needs (e.g. left by an older version)."""
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        used = {conversation_id(r.conversation) for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid)).all()}
        for c in conversations:
            if conversation_id(c) not in used:
                _trash(session, uid, c, device=device)


# ---------- what the extension's worker asks for ----------
def claim(db_path, user: dict, device: str, slots: int, *, build_task, active: Iterable[str] = (), only_deletes: bool = False) -> dict:
    """Lease up to `slots` pieces of work to this browser: one batch of chats to delete, then
    the jobs (highest priority first), then answers for questions added later. build_task(row)
    adds what ChatGPT needs (the CV prompt, the questions). only_deletes: a disconnected
    browser still deletes the chats left behind, nothing else.

    `active`: the keys this browser is really working on. Any other lease it holds is orphaned
    (the browser closed between a lease and starting its frame) and is handed back right away
    instead of waiting for the lease to run out.

    → {tasks, to_delete}"""
    out: list[dict] = []
    keep = set(active)
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        _expire(session, uid)
        now = _now()
        if device:
            for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid, CvQueueRow.lease_device == device)).all():
                if r.work and f"{r.profile_id}:{r.job_id}" not in keep:
                    if r.stage == "closing":
                        _drop_chat(session, r)
                        session.delete(r)
                        continue
                    if r.work == "write" and r.stage == "writing":
                        _requeue(session, r)
                        r.attempts = max(0, r.attempts - 1)
                    _release(r)
            for c in session.scalars(select(GptChatRow).where(GptChatRow.user_id == uid, GptChatRow.lease_device == device)).all():
                if f"chat:{c.conversation_id}" not in keep:
                    c.lease_until, c.lease_device = None, ""
        session.flush()
        chats = session.scalars(select(GptChatRow).where(GptChatRow.user_id == uid).order_by(GptChatRow.created_at)).all()
        if slots > 0 and not any(c.lease_until for c in chats):
            due = [c for c in chats if (c.retry_at is None or c.retry_at <= now)
                   and (not c.device or c.device == device or (c.created_at and now - c.created_at > ANY_DEVICE_AFTER))][:DELETE_BATCH]
            if due:
                for c in due:
                    c.lease_until, c.lease_device = now + LEASE["delete"], device
                ids = [c.conversation_id for c in due]
                out.append({"work": "delete", "keys": [f"chat:{i}" for i in ids], "ids": ids})
                slots -= 1
        to_delete = len(chats)
        if only_deletes:
            return {"tasks": out, "to_delete": to_delete}
        rows = session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid)).all()
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
    return {"tasks": out, "to_delete": to_delete}


def lease_of(db_path, user: dict, profile_id: str, job_id: str) -> dict | None:
    with session_scope(db_path) as session:
        r = session.get(CvQueueRow, (profile_id, job_id))
        return as_dict(r) if r is not None and r.user_id == user.get("id", "") else None


def update(db_path, user: dict, profile_id: str, job_id: str, fn) -> dict | None:
    """Read-modify-write one row of this bidder (fn(row, session) changes it; it may delete the
    row); None if it is gone."""
    with session_scope(db_path) as session:
        _write_lock(session)
        r = session.get(CvQueueRow, (profile_id, job_id))
        if r is None or r.user_id != user.get("id", ""):
            return None
        fn(r, session)
        if r in session.deleted:
            return None
        r.updated_at = _now()
        return as_dict(r)


def started(db_path, user: dict, profile_id: str, job_id: str, conversation: str, device: str = "") -> str:
    """ChatGPT opened a conversation for this row's work — recorded at once, so it is deleted
    even if the browser closes before the work is done. → 'ok' | 'closing' | 'gone'"""
    url = conversation_url(conversation)
    if not url:
        return "gone"
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        r = session.get(CvQueueRow, (profile_id, job_id))
        if r is None or r.user_id != uid or not r.work:
            _trash(session, uid, url, device=device)    # nobody needs it
            return "gone"
        if r.stage == "closing":
            _trash(session, uid, url, device=device, label=f"{r.company} — {r.job_title}")
            return "closing"
        if conversation_id(r.conversation) != conversation_id(url):
            _drop_chat(session, r, device)              # the work moved to a new chat: the old one is no use
            r.conversation = url
            r.updated_at = _now()
        return "ok"


def release(db_path, user: dict, keys: list[str], chats: Iterable[str] = (), device: str = "") -> None:
    """Work handed back without an attempt (Disconnect, a frame that disappeared, ChatGPT
    signed out / Free plan / usage limit). chats: conversations those frames had opened —
    a CV write starts again in a new chat, so a half-written one is deleted."""
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        for key in keys:
            if key.startswith("chat:"):
                c = session.get(GptChatRow, key[5:])
                if c is not None and c.user_id == uid:
                    c.lease_until, c.lease_device = None, ""
                continue
            pid, _, jid = key.partition(":")
            r = session.get(CvQueueRow, (pid, jid))
            if r is None or r.user_id != uid or not r.work:
                continue
            if r.stage == "closing":
                _drop_chat(session, r)
                session.delete(r)
                continue
            if r.work == "write" and r.stage == "writing":
                _requeue(session, r)
                r.attempts = max(0, r.attempts - 1)
            _release(r)
        session.flush()
        used = {conversation_id(r.conversation) for r in session.scalars(select(CvQueueRow).where(CvQueueRow.user_id == uid)).all()}
        for c in chats:
            if conversation_id(c) not in used:
                _trash(session, uid, c, device=device)


def deleted(db_path, user: dict, done_ids: list[str], failed_ids: list[str]) -> None:
    """A delete batch came back: deleted chats go; failures wait longer each time (5, 10, 20,
    40, 60 minutes…) and are given up after DELETE_TRIES."""
    with session_scope(db_path) as session:
        _write_lock(session)
        uid = user.get("id", "")
        for cid in done_ids:
            c = session.get(GptChatRow, cid)
            if c is not None and c.user_id == uid:
                session.delete(c)
        for cid in failed_ids:
            c = session.get(GptChatRow, cid)
            if c is None or c.user_id != uid:
                continue
            c.tries += 1
            if c.tries >= DELETE_TRIES:
                session.delete(c)
                continue
            c.retry_at = _now() + timedelta(minutes=min(60, 5 * 2 ** (c.tries - 1)))
            c.lease_until, c.lease_device = None, ""
