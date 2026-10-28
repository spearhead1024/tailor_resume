"""Who hears about a board change, and what they're told.

The rules, as asked for:

  creator assigns a caller          → the caller
  creator changes a cell            → the caller on that row
  caller is CHANGED to someone else → BOTH the new caller and the old one
  caller changes Status             → the creator
  manager assigns a caller          → the caller AND the creator
  a call is handed to a TEAM        → the team's manager AND every member
  a team caller is assigned         → the manager AND the creator
  a Call Board Manager edits a call → the caller (as above) AND the row's Creater
  the Creater edits their own call  → the caller (as above) AND every Call Board Manager

Batched: one person's edits to one row are collected and announced ONCE, after they have been quiet
on that row for a minute (QUIET_SECONDS; MAX_WAIT_SECONDS caps a non-stop editor). Filling in five
cells used to send five notifications to every person on the call. The announcement names the call by
its Index ("#119"), lists the fields that changed, and carries the before → after details, which the
bell shows in a dialog. Chat replies are batched the same way.

The actor is never notified about their own action — so a Call Board Manager who is also the row's
own Creater (or a Creater who also holds the CBM role) editing their own call triggers neither of the
two rules above for themselves; only other people in those roles are told.

Audience is computed from the row as it looks AFTER the change, plus the previous cells, so a
re-assignment can still reach the person who just lost the call. Everything is best-effort: a
notification must never break the edit that produced it.
"""
from __future__ import annotations

import atexit
import logging
import threading
import time
from copy import deepcopy

from core import inbox, push
from core.hub import hub

log = logging.getLogger("live")

# A pseudo-field: "this call's follow-up row was created" (see note_followup).
_FOLLOWUP = "__followup"

# Cells a caller/manager may change; used to decide "creator changed the details" vs "caller replied".
# The follow-up counts as content: the caller must hear that their call passed and has a next round.
_CONTENT_CELLS = ("c_title", "c_company", "c_type", "c_client", "c_sched", "c_min", "c_link",
                  "c_account", "c_jd", "c_skill", "c_salary", "c_index", _FOLLOWUP)


_users_cache: tuple[float, list] = (0.0, [])


def _users():
    """All users, cached for a few seconds: one notification resolves several names (caller,
    creator, team, board managers) and each used to re-read every user from the DB."""
    global _users_cache
    at, users = _users_cache
    if time.monotonic() - at > 5:
        from auth import storage
        users = storage.get_users()
        _users_cache = (time.monotonic(), users)
    return users


def _resolve(identity: str) -> dict | None:
    """A board cell holds a display name; map it back to a user (username or full name)."""
    needle = str(identity or "").strip().lower()
    if not needle:
        return None
    for u in _users():
        if needle in (str(u.get("username", "")).strip().lower(),
                      str(u.get("full_name", "")).strip().lower()):
            return u
    return None


def _team_id_by_name(name: str) -> str:
    from auth import storage
    n = str(name or "").strip().lower()
    if not n:
        return ""
    for t in storage.get_teams():
        if str(t.get("name", "")).strip().lower() == n:
            return str(t.get("id", ""))
    return ""


def _team_people(team_name: str) -> tuple[set[str], set[str]]:
    """(manager_ids, member_ids) for a team, by its display name."""
    tid = _team_id_by_name(team_name)
    if not tid:
        return set(), set()
    mgrs, members = set(), set()
    for u in _users():
        if str(u.get("team_id", "")).strip() != tid:
            continue
        roles = {str(r).strip() for r in (u.get("roles") or [])}
        if "manager" in roles:
            mgrs.add(u["id"])
        if "caller" in roles:
            members.add(u["id"])
    return mgrs, members


def _team_managers(team_id: str) -> set[str]:
    if not team_id:
        return set()
    return {u["id"] for u in _users()
            if str(u.get("team_id", "")).strip() == team_id
            and "manager" in {str(r).strip() for r in (u.get("roles") or [])}}


def _call_board_manager_ids() -> set[str]:
    """Every approved user holding the 'call_board_manager' role — they oversee the WHOLE board, so a
    content change on ANY call is theirs to know about, not just the ones they created."""
    return {u["id"] for u in _users()
            if "call_board_manager" in {str(r).strip() for r in (u.get("roles") or [])}
            and str(u.get("status", "")).strip() == "approved"}


def roster_audience(user: dict) -> set[str]:
    """Who is shown THIS person's working hours, and therefore needs to know when they change.

    Mirrors _avail_scope in routers/interviews.py, from the other side: an admin sees everyone's roster;
    a manager sees their own team's; a caller sees only their own. So a change to one person's hours
    matters to every admin, to their team's manager, and to themselves.

    Without this the board fetched /people ONCE on mount and never again: a caller could switch a day
    off and the admin's calendar would keep shading it as free — right up until somebody happened to
    reload the page.
    """
    ids: set[str] = {str(user.get("id", ""))}
    tid = str(user.get("team_id", "")).strip()
    for u in _users():
        roles = {str(r).strip() for r in (u.get("roles") or [])}
        if "admin" in roles:
            ids.add(u["id"])
        elif "manager" in roles and tid and str(u.get("team_id", "")).strip() == tid:
            ids.add(u["id"])
    return {i for i in ids if i}


def on_roster_changed(user: dict) -> None:
    """Somebody's availability / time zone / meetings / days off changed. Tell the boards that show it,
    so they re-read /people instead of shading a week that is no longer true. Never raises."""
    try:
        hub.broadcast_soon({"type": "roster", "user_id": str(user.get("id", ""))}, roster_audience(user))
    except Exception:
        log.exception("on_roster_changed failed")


def row_audience(cells: dict) -> set[str]:
    """Everyone allowed to SEE this row — the only people a live update may be pushed to.

    Mirrors the REST visibility rules (interviews._visibility): every admin, the row's caller, and the
    managers of the team the call was handed to or whose caller it is. NOT the team's other callers: a
    caller sees only calls assigned to them, so pushing the row to the whole team showed colleagues a
    call (company, link, profile) that vanished on reload and 404'd on edit. The creator is kept — it is
    also the notification audience, and a creator without a board role never opens the socket."""
    cells = cells or {}
    ids: set[str] = set()
    for u in _users():
        if "admin" in {str(r).strip() for r in (u.get("roles") or [])}:
            ids.add(u["id"])
    caller = _resolve(str(cells.get("c_caller", "")).strip())
    if caller:
        ids.add(caller["id"])
        ids |= _team_managers(str(caller.get("team_id", "")).strip())
    creator = _resolve(str(cells.get("c_creater", "")).strip())
    if creator:
        ids.add(creator["id"])
    mgrs, _ = _team_people(str(cells.get("c_team", "")).strip())
    return ids | mgrs


def _title(cells: dict) -> str:
    """How a call is named in a notification: its Index ("#119"), the board's unique id for it.
    (Position/Title is not unique — several calls share "Senior Backend Engineer".)"""
    idx = str((cells or {}).get("c_index") or "").strip()
    if idx:
        return f"#{idx}"
    return str((cells or {}).get("c_title") or "an interview").strip() or "an interview"


# Column labels as the board shows them (Interviews.tsx DISPLAY_NAME renames a few stored names).
_DISPLAY_NAME = {"c_account": "Profile Name(Country)", "c_jd": "Job Description", "c_feedback": "Chat & Feedback",
                 _FOLLOWUP: "Follow-up row"}
# Not shown as field changes: the chat thread has its own notification, c_created is a machine stamp,
# and c_creater is private to admins (interviews.PRIVATE_CELLS) — the details went to callers too.
_NOT_A_FIELD = {"c_feedback", "c_created", "c_creater"}
_LONG = 400          # a long value (a job description) is trimmed in the details


def _columns() -> list[dict]:
    try:
        from auth import storage
        return storage.get_interview_columns()
    except Exception:
        return []


def _changes(orig: dict, new: dict) -> list[dict]:
    """[{id, label, type, before, after}] in board column order, for the fields that really changed."""
    cols = _columns()
    order = {c["id"]: i for i, c in enumerate(cols)}
    meta = {c["id"]: c for c in cols}
    out = []
    for cid in sorted(orig, key=lambda k: order.get(k, 999)):
        if cid in _NOT_A_FIELD:
            continue
        b, a = str(orig.get(cid) or ""), str(new.get(cid) or "")
        if b.strip() == a.strip():
            continue
        clip = lambda v: v if len(v) <= _LONG else v[:_LONG - 1] + "…"   # noqa: E731
        out.append({"id": cid, "label": _DISPLAY_NAME.get(cid) or meta.get(cid, {}).get("name") or cid,
                    "type": meta.get(cid, {}).get("type", "text"), "before": clip(b), "after": clip(a)})
    return out


def _fields_text(changes: list[dict]) -> str:
    labels = [c["label"] for c in changes]
    if len(labels) <= 3:
        return ", ".join(labels) if len(labels) < 3 else f"{labels[0]}, {labels[1]} and {labels[2]}"
    return f"{', '.join(labels[:3])} and {len(labels) - 3} more"


def _company(cells: dict) -> str:
    """The second line of a notification: the call is named by its #index (not the position, which
    isn't unique); the company makes it recognizable at a glance."""
    return str((cells or {}).get("c_company") or "").strip()


def _context(cells: dict) -> str:
    """Company — Position, for the details dialog (full context once you open it)."""
    parts = [str((cells or {}).get(k) or "").strip() for k in ("c_company", "c_title")]
    return " — ".join(p for p in parts if p)


def _actor_name(actor: dict) -> str:
    a = actor or {}
    return str(a.get("full_name") or a.get("username") or "Someone").strip() or "Someone"


_PUSH_INLINE = False      # set while flushing at shutdown: daemon threads would die with the process


def _push_soon(user_ids: set[str], payload: dict) -> None:
    """Fire the OS pushes off the request thread.

    send_push talks HTTP to a push service (FCM and friends), once per device, and waits. This runs
    inside the PATCH that saved the cell, so doing it inline would make every edit on the board pay
    for somebody else's notification — several hundred milliseconds, sometimes seconds if a push
    service is slow, and all of it while the person who typed the value is watching the cell.
    A push is best-effort by nature (the socket already delivered it to anyone actually looking), so
    it is the right thing to hand to a thread and forget."""
    ids = [u for u in user_ids if u]
    if not ids:
        return

    def _run() -> None:
        for uid in ids:
            try:
                push.send_push(uid, payload)
            except Exception:               # send_push already swallows; belt and braces
                log.exception("push failed for %s", uid)

    if _PUSH_INLINE:
        _run()
        return
    threading.Thread(target=_run, name="board-push", daemon=True).start()


# ── batching ────────────────────────────────────────────────────────────────
QUIET_SECONDS = 60         # announce once the person has left the row alone this long
MAX_WAIT_SECONDS = 300     # …but never hold a busy editor's changes longer than this

_pending: dict[tuple[str, str, str], dict] = {}     # (kind, row_id, actor_id) → batch
_plock = threading.Lock()


def _schedule(key: tuple[str, str, str], batch: dict) -> None:
    """(Re)arm the batch's timer: QUIET_SECONDS from now, capped at MAX_WAIT from its first edit."""
    if batch.get("timer"):
        batch["timer"].cancel()
    delay = max(0.0, min(QUIET_SECONDS, batch["first"] + MAX_WAIT_SECONDS - time.monotonic()))
    t = threading.Timer(delay, _flush, args=(key,))
    t.daemon = True
    batch["timer"] = t
    t.start()


def on_row_changed(row_id: str, before: dict, after: dict, actor: dict) -> None:
    """Queue one saved edit. Never raises.

    Only the fields THIS person changed are tracked, each from its value before their first edit to
    its latest value — so another person editing the same row meanwhile is never credited to them, and
    a field changed and changed back drops out. A brand-new row (before == {}) is announced as created.
    """
    try:
        before, after = before or {}, after or {}
        actor_id = str((actor or {}).get("id", ""))
        key = ("edit", str(row_id), actor_id)
        created = not before
        with _plock:
            b = _pending.get(key)
            if b is None:
                b = _pending[key] = {"orig": {}, "new": {}, "cells": {}, "created": created,
                                     "actor": actor, "first": time.monotonic(), "timer": None}
            for cid in set(before) | set(after):
                if str(before.get(cid, "")) == str(after.get(cid, "")):
                    continue
                b["orig"].setdefault(cid, before.get(cid, ""))
                b["new"][cid] = after.get(cid, "")
            # Keep a follow-up already folded into this batch (note_followup): replacing the cells
            # dropped it, so "Passed, then Approved within a minute" announced no follow-up at all.
            followup = b["cells"].get(_FOLLOWUP)
            b["cells"] = deepcopy(after)
            if followup is not None:
                b["cells"][_FOLLOWUP] = followup
            b["actor"] = actor
            _schedule(key, b)
    except Exception:
        log.exception("queueing notify failed for row %s", row_id)


def note_followup(row_id: str, actor: dict, followup_index: str) -> bool:
    """Marking a call Passed creates its follow-up row in the same request. Report that inside the
    Passed edit's own notification ("…updated Status and Follow-up row of #119") instead of as a second
    notification about the new row — it has the same caller and team, so it's the same people.
    False if there is no pending edit to fold it into (the caller then notifies the new row itself)."""
    key = ("edit", str(row_id), str((actor or {}).get("id", "")))
    with _plock:
        b = _pending.get(key)
        if b is None:
            return False
        b["orig"].setdefault(_FOLLOWUP, "")
        b["new"][_FOLLOWUP] = f"#{followup_index}" if followup_index else "created"
        b["cells"][_FOLLOWUP] = b["new"][_FOLLOWUP]
        return True


def forget_row(row_id: str) -> None:
    """A deleted call: drop its pending notifications — nobody needs "assigned you #120" about a call
    that was created by mistake and removed a moment later."""
    with _plock:
        for key in [k for k in _pending if k[1] == str(row_id)]:
            b = _pending.pop(key)
            if b.get("timer"):
                b["timer"].cancel()


def _flush(key: tuple[str, str, str]) -> None:
    with _plock:
        b = _pending.pop(key, None)
    if not b:
        return
    kind, row_id, _ = key
    if kind == "edit":
        after = b["cells"]
        before = {**after, **b["orig"]}       # the row as it was before THIS person's edits
        _notify_row_change(row_id, before, after, b["actor"], created=b["created"])
    elif kind == "chat":
        _notify_feedback(row_id, b["cells"], b["actor"], b["messages"])


def flush_pending() -> None:
    """Announce everything still waiting — on shutdown, so a restart doesn't swallow it. OS pushes are
    sent inline here: a daemon push thread would be killed as the process exits."""
    global _PUSH_INLINE
    _PUSH_INLINE = True
    with _plock:
        keys = list(_pending)
        for k in keys:
            if _pending[k].get("timer"):
                _pending[k]["timer"].cancel()
    for k in keys:
        _flush(k)


atexit.register(flush_pending)


def _notify_row_change(row_id: str, before: dict, after: dict, actor: dict, *, created: bool = False) -> None:
    """Emit the notifications for one finished batch of edits. Never raises.

    ONE notification per person, per change. A single save can match several rules at once — the
    Caller dropdown writes c_caller AND c_team together, so the person being assigned used to match
    both "you've been assigned" and "your team got a call" and was pinged twice. Rules are applied
    most-specific first into `msgs`, and a person already spoken to is not spoken to again.
    """
    try:
        before, after = before or {}, after or {}
        actor_id = str((actor or {}).get("id", ""))
        actor_roles = {str(r).strip() for r in (actor or {}).get("roles", [])}
        is_manager = "manager" in actor_roles and "admin" not in actor_roles
        is_caller = "caller" in actor_roles and not (actor_roles & {"admin", "manager"})
        who = _actor_name(actor)
        name = _title(after)
        changes = _changes({k: before.get(k, "") for k in set(before) | set(after)
                            if str(before.get(k, "")) != str(after.get(k, ""))}, after)
        if not changes and not created:
            return                                  # edited and changed back — nothing to say
        fields = _fields_text(changes)
        verb = f"{who} created {name}" if created else f"{who} updated {fields} of {name}"
        detail = {"row_id": row_id, "index": str(after.get("c_index") or ""), "context": _context(after),
                  "actor": who, "created": created, "changes": changes}

        new_caller = str(after.get("c_caller", "")).strip()
        old_caller = str(before.get("c_caller", "")).strip()
        new_team = str(after.get("c_team", "")).strip()
        old_team = str(before.get("c_team", "")).strip()
        creator_name = str(after.get("c_creater", "")).strip()
        creator = _resolve(creator_name)
        creator_ids = {creator["id"]} if creator else set()
        if creator_name and not creator:
            # The cell holds a name that belongs to nobody — a typo, or a user who was renamed or
            # deleted. Every notification meant for the creator of this row then goes nowhere, and it
            # goes nowhere SILENTLY, which is indistinguishable from the feature being broken. Say so.
            log.warning("Row %s: Creater %r matches no user — nobody can be notified about it.",
                        row_id, creator_name)

        msgs: dict[str, tuple[str, str]] = {}          # user_id → (title, body); first (most specific) wins

        def add(ids: set[str], title: str, body: str) -> None:
            for uid in ids:
                if uid and uid != actor_id and uid not in msgs:      # never yourself, never twice
                    msgs[uid] = (title, body)

        caller_changed = new_caller.lower() != old_caller.lower()
        nu = _resolve(new_caller) if caller_changed else None
        ou = _resolve(old_caller) if caller_changed else None

        # ── most specific: this is about YOU personally ────────────────────────
        if nu:
            add({nu["id"]}, "New interview assigned", f"{who} assigned you {name}")
        if ou:
            add({ou["id"]}, "Interview reassigned", f"{who} moved {name} away from you")

        # A caller/manager answering on a call → tell whoever booked it.
        #
        # BOTH fields count. Only Status used to, which left the more important one silent: Approved
        # is the caller saying whether the call will happen at all, so a caller could reject a call and
        # the person who booked it would never be told. If one save changes both, they are reported
        # together in a single message rather than as two pings.
        answered = [(lbl, str(after.get(cid) or "").strip() or "—")
                    for cid, lbl in (("c_approved", "Approved"), ("c_status", "Status"))
                    if str(after.get(cid, "")) != str(before.get(cid, ""))]
        if answered and (is_caller or is_manager):
            summary = ", ".join(f"{lbl}: {val}" for lbl, val in answered)
            add(creator_ids, verb, summary)

        # the creator/admin changed the details of a call somebody already holds
        touched = [k for k in _CONTENT_CELLS if str(after.get(k, "")) != str(before.get(k, ""))]
        if touched and not (is_caller or is_manager):
            if new_caller and not caller_changed:
                cu = _resolve(new_caller)
                if cu:
                    add({cu["id"]}, verb, _company(after))
            # A Call Board Manager editing a call is news to whoever booked it — a CBM isn't
            # otherwise in the loop on a row they didn't create. No-ops when the CBM IS the row's
            # own creater: add() already excludes the actor from their own audience.
            if "call_board_manager" in actor_roles and creator_ids:
                add(creator_ids, verb, _company(after))

        # Call Board Managers oversee the whole board, but they were being pinged on EVERY content
        # edit (company, link, salary…) — far too noisy. They care about only two things: WHEN a call
        # is and WHO is on it. So notify every CBM when the schedule or the caller changes, and only
        # then — regardless of who made the edit. (add() already excludes the actor, so a CBM editing
        # is not told about their own change.) The caller-change wording is handled by the dedicated
        # block below; here we cover the schedule move.
        if "c_sched" in touched and not caller_changed:
            add(_call_board_manager_ids(), verb, _company(after))

        # ── then the supervisory ones (creator / team manager / board manager) ──
        if caller_changed:
            audience: set[str] = set()
            if is_manager or is_caller:
                audience |= creator_ids           # a manager or team caller assigning → tell the creator
            if nu:
                mgrs, _ = _team_people(new_team or old_team)
                audience |= mgrs                  # ...and that team's manager
            audience |= _call_board_manager_ids()  # WHO is on a call is one of the two things a CBM watches
            add(audience, "Interview assigned", f"{who} assigned {name} to {new_caller or 'nobody'}")

        # ── least specific: the team's managers, when a call is handed to a team ───────
        # (Not its callers: they can't see a call until it is assigned to them, so "Open on board"
        # led nowhere — the assignment notification reaches the one it is given to.)
        if new_team and new_team.lower() != old_team.lower():
            mgrs, _ = _team_people(new_team)
            add(mgrs, f"{new_team}: new interview", f"{who} gave your team {name}")

        # one message each, grouped so identical text is a single broadcast
        grouped: dict[tuple[str, str], set[str]] = {}
        for uid, msg in msgs.items():
            grouped.setdefault(msg, set()).add(uid)
        for (title, body), ids in grouped.items():
            # File it before pushing: a toast is gone in seconds, and whoever wasn't looking at the
            # board must still be able to find out what changed.
            inbox.add(ids, "board", title, body, row_id=row_id, frm=who, detail=detail)
            hub.broadcast_soon({"type": "notify", "kind": "board", "title": title, "body": body,
                                "row_id": row_id, "from": who}, ids)
            # And to the OS, for everyone who isn't looking at the board — which is most people, most
            # of the time. Only reminders used to be pushed, so being handed a call, or having the
            # call you booked confirmed, reached you only if you happened to have the tab open. That
            # is the one notification you cannot afford to find out about later.
            # No `alarm`: this is news, not an imminent interview, and it must not ring.
            _push_soon(ids, {
                "title": title, "body": body,
                "tag": f"board-{row_id}",     # a later edit to the same call replaces the old banner
                "url": f"/interviews?row={row_id}",
                "row_id": row_id,
            })
    except Exception:
        log.exception("live notify failed for row %s", row_id)


def on_feedback_added(row_id: str, cells: dict, actor: dict, text: str) -> None:
    """Queue a chat reply; several replies in a row become one notification (see _flush). Never raises."""
    try:
        if "admin" in {str(r).strip() for r in (actor or {}).get("roles", [])}:
            return                      # admin-authored messages never notify (see _notify_feedback)
        key = ("chat", str(row_id), str((actor or {}).get("id", "")))
        with _plock:
            b = _pending.get(key)
            if b is None:
                b = _pending[key] = {"messages": [], "cells": {}, "actor": actor,
                                     "first": time.monotonic(), "timer": None}
            b["messages"].append(str(text or "").strip() or "📷 Image attached")
            b["cells"] = deepcopy(cells or {})
            b["actor"] = actor
            _schedule(key, b)
    except Exception:
        log.exception("queueing feedback notify failed for row %s", row_id)


def _notify_feedback(row_id: str, cells: dict, actor: dict, messages: list[str]) -> None:
    """A caller, team member, or team manager posted in the Chat & Feedback thread — tell whoever is
    responsible for the call: the row's Creater, and every Call Board Manager (they oversee the whole
    board, so every reply matters to them, not just ones on rows they created). Admin-authored messages
    do NOT trigger this — an admin posting isn't "a reply somebody needs to follow up on" the way a
    caller's is. Board-type notification: filed + toasted, but never rings (see core/notify.py for the
    alarm-carrying reminders). Never raises — a notification must never break a chat post."""
    try:
        actor_roles = {str(r).strip() for r in (actor or {}).get("roles", [])}
        if "admin" in actor_roles:
            return
        cells = cells or {}
        actor_id = str((actor or {}).get("id", ""))
        who = _actor_name(actor)
        name = _title(cells)

        creator = _resolve(str(cells.get("c_creater", "")).strip())
        audience: set[str] = {creator["id"]} if creator else set()
        for u in _users():
            roles = {str(r).strip() for r in (u.get("roles") or [])}
            if "call_board_manager" in roles and str(u.get("status", "")).strip() == "approved":
                audience.add(u["id"])
        audience.discard(actor_id)          # never yourself
        if not audience:
            return

        preview = messages[-1]
        if len(preview) > 160:
            preview = preview[:157] + "…"
        n = len(messages)
        title = f"{who} replied on {name}" if n == 1 else f"{who} sent {n} messages on {name}"
        detail = {"row_id": row_id, "index": str(cells.get("c_index") or ""), "context": _context(cells),
                  "actor": who, "messages": [m if len(m) <= _LONG else m[:_LONG - 1] + "…" for m in messages]}

        inbox.add(audience, "board", title, preview, row_id=row_id, frm=who, detail=detail)
        hub.broadcast_soon({"type": "notify", "kind": "board", "title": title, "body": preview,
                            "row_id": row_id, "from": who}, audience)
        # No `alarm`: a chat reply is news, not an imminent interview, and must not ring.
        _push_soon(audience, {
            "title": title, "body": preview,
            "tag": f"feedback-{row_id}",     # a later reply to the same call replaces the old banner
            "url": f"/interviews?row={row_id}",
            "row_id": row_id,
        })
    except Exception:
        log.exception("feedback notify failed for row %s", row_id)
