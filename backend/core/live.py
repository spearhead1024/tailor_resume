"""Who hears about a board change, and what they're told.

The rules, as asked for:

  creator assigns a caller          → the caller
  creator changes a cell            → the caller on that row
  caller is CHANGED to someone else → BOTH the new caller and the old one
  caller changes Status             → the creator
  manager assigns a caller          → the caller AND the creator
  a call is handed to a TEAM        → the team's manager AND every member
  a team caller is assigned         → the manager AND the creator

The actor is never notified about their own action.

Audience is computed from the row as it looks AFTER the change, plus the previous cells, so a
re-assignment can still reach the person who just lost the call. Everything is best-effort: a
notification must never break the edit that produced it.
"""
from __future__ import annotations

import logging

from core import inbox
from core.hub import hub

log = logging.getLogger("live")

# Cells a caller/manager may change; used to decide "creator changed the details" vs "caller replied".
_CONTENT_CELLS = ("c_title", "c_company", "c_type", "c_client", "c_sched", "c_min", "c_link",
                  "c_account", "c_jd", "c_skill", "c_salary", "c_index")


def _users():
    from auth import storage
    return storage.get_users()


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

    Mirrors the REST visibility rules: every admin, the row's caller, and (if the call belongs to a
    team) that team's manager and members. Without this, a broadcast would leak one team's interviews
    onto another team's board."""
    cells = cells or {}
    ids: set[str] = set()
    for u in _users():
        if "admin" in {str(r).strip() for r in (u.get("roles") or [])}:
            ids.add(u["id"])
    caller = _resolve(str(cells.get("c_caller", "")).strip())
    if caller:
        ids.add(caller["id"])
    creator = _resolve(str(cells.get("c_creater", "")).strip())
    if creator:
        ids.add(creator["id"])
    mgrs, members = _team_people(str(cells.get("c_team", "")).strip())
    return ids | mgrs | members


def _title(cells: dict) -> str:
    return str(cells.get("c_title") or cells.get("c_index") or "an interview").strip() or "an interview"


def _actor_name(actor: dict) -> str:
    a = actor or {}
    return str(a.get("full_name") or a.get("username") or "Someone").strip() or "Someone"


def on_row_changed(row_id: str, before: dict, after: dict, actor: dict) -> None:
    """Emit the live notifications for one board edit. Never raises.

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
            fields = " and ".join(lbl for lbl, _ in answered)
            detail = ", ".join(f"{lbl}: {val}" for lbl, val in answered)
            add(creator_ids, f"{who} updated {fields}", f"{name} — {detail}")

        # the creator/admin changed the details of a call somebody already holds
        touched = [k for k in _CONTENT_CELLS if str(after.get(k, "")) != str(before.get(k, ""))]
        if touched and not (is_caller or is_manager) and new_caller and not caller_changed:
            cu = _resolve(new_caller)
            if cu:
                what = "the time" if "c_sched" in touched else "the details"
                add({cu["id"]}, "Interview updated", f"{who} changed {what} of {name}")

        # ── then the supervisory ones (creator / team manager) ─────────────────
        if caller_changed:
            audience: set[str] = set()
            if is_manager or is_caller:
                audience |= creator_ids           # a manager or team caller assigning → tell the creator
            if nu:
                mgrs, _ = _team_people(new_team or old_team)
                audience |= mgrs                  # ...and that team's manager
            add(audience, "Interview assigned", f"{who} assigned {name} to {new_caller or 'nobody'}")

        # ── least specific: the whole team, when a call is handed to one ───────
        if new_team and new_team.lower() != old_team.lower():
            mgrs, members = _team_people(new_team)
            add(mgrs | members, f"{new_team}: new interview", f"{who} gave your team {name}")

        # one message each, grouped so identical text is a single broadcast
        grouped: dict[tuple[str, str], set[str]] = {}
        for uid, msg in msgs.items():
            grouped.setdefault(msg, set()).add(uid)
        for (title, body), ids in grouped.items():
            # File it before pushing: a toast is gone in seconds, and whoever wasn't looking at the
            # board must still be able to find out what changed.
            inbox.add(ids, "board", title, body, row_id=row_id, frm=who)
            hub.broadcast_soon({"type": "notify", "kind": "board", "title": title, "body": body,
                                "row_id": row_id, "from": who}, ids)
    except Exception:
        log.exception("live notify failed for row %s", row_id)
