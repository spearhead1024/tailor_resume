"""Metrics endpoint — one week (Mon..Sun) of applications and jobs added, per person.

The numbers are built to equal the other tabs for the same work day (5pm JST → 5pm JST):

* Applications: every applied CV, filed under the day it was APPLIED (`applied_at`) — local
  bidders and VPS_1's (the old server, mirrored) alike — so a day's GRAND TOTAL is exactly what the
  Applied tab lists for that day. One row per (applier, profile); a local profile's row also shows
  its to-do pool (approved jobs added that day that match the profile's region and tech stacks).
* Jobs added: every job that isn't deleted, filed under the day it was added (`submitted_at`),
  per adder — a local user, or the VPS_1 adder of a synced job — so a day's GRAND TOTAL is the
  Jobs tab's count for that day (all statuses but deleted; ✓ = its "approved").
* `easy` in every cell: the part that is LinkedIn Easy Apply (core/easy_apply, by the job link).

Query: week_start = the Monday (YYYY-MM-DD); default this week.
Rows: {user_id, username, source: local|vps1, profile_id, profile_name, assigned,
       daily: [{applied, total, easy} x7], week: {...}}   (total is null for a VPS_1 profile)
job_rows: {user_id, username, source, daily: [{uploaded, approved, rejected, pending, easy} x7], week}
totals / job_totals (admins): the same cells summed over everyone.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from fastapi import APIRouter, Depends
from auth import get_current_user, storage
from core.storage import tech_stacks_match
from core.easy_apply import is_easy_apply
from core import vps1_adapt

# The Metrics day starts at 5pm JST (UTC+9, no daylight saving) and runs to 5pm JST the next
# day — i.e. 08:00 UTC, which is 3am EST / 4am EDT, so a US working day sits wholly inside one
# Metrics day. A day is labelled by the JST date it STARTS on: "Mon" = Mon 5pm → Tue 5pm JST.
# Every bucket on this tab (applications, job uploads, "this week") uses this boundary.
_JST = timezone(timedelta(hours=9))
_DAY_START = timedelta(hours=17)        # 5pm JST

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


def _parse_iso_date(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _metrics_day(ts: datetime) -> date:
    """The Metrics day an instant falls in (see _DAY_START)."""
    return (ts.astimezone(_JST) - _DAY_START).date()


def _today() -> date:
    """The Metrics day it is right now."""
    return _metrics_day(datetime.now(timezone.utc))


def _day_str(iso_ts: str) -> str:
    """The Metrics day ('YYYY-MM-DD') of a UTC ISO timestamp — "" if there is none.

    Never bucket by the raw date text (`iso[:10]`): that is the UTC calendar day, which
    does not line up with the 5pm JST boundary."""
    raw = str(iso_ts or "").strip()
    if not raw:
        return ""
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw[:10]
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return _metrics_day(ts).isoformat()


def _vps1_key(name: str) -> str:
    return "vps1:" + (str(name or "").strip().lower() or "unknown")


@router.get("")
def get_metrics(week_start: str = "", user: dict = Depends(get_current_user)):
    """Role-aware metrics for one week (Mon..Sun) — see the module docstring."""
    is_admin = bool(user.get("is_admin"))
    requested = _parse_iso_date(week_start) if week_start else None
    monday = _monday_of(requested or _today())
    sunday = monday + timedelta(days=6)
    day_strs = [(monday + timedelta(days=i)).isoformat() for i in range(7)]
    in_week = set(day_strs)

    users = storage.get_users()
    profiles = storage.get_profiles()
    profile_by_id = {p.get("id"): p for p in profiles}
    all_jobs = storage.get_jobs()
    job_link = {j.get("id"): j.get("link") or "" for j in all_jobs}

    # The to-do pool of a local profile: approved jobs matching its region AND tech stacks.
    approved = [j for j in all_jobs if j.get("status") == "approved" and not j.get("flagged") and not j.get("admin_applied")]

    def _regions_match(job_region: str, profile_region: str) -> bool:
        return "ANY" in (job_region, profile_region) or job_region == profile_region

    def _job_eligible(job: dict, profile: dict) -> bool:
        p_region = str(profile.get("region") or "ANY").upper().strip() or "ANY"
        if not _regions_match(str(job.get("region") or "ANY").upper(), p_region):
            return False
        return tech_stacks_match(job.get("description"), profile.get("tech_stacks") or [])

    pool_cache: dict[str, dict[str, int]] = {}

    def _pool(pid: str) -> dict[str, int]:
        if pid not in pool_cache:
            prof = profile_by_id.get(pid) or {}
            per_day: dict[str, int] = defaultdict(int)
            for j in approved:
                d = _day_str(j.get("submitted_at"))
                if d in in_week and _job_eligible(j, prof):
                    per_day[d] += 1
            pool_cache[pid] = per_day
        return pool_cache[pid]

    me = user.get("id") or ""
    if not is_admin:
        users = [u for u in users if u.get("id") == me]
        allowed = set(user.get("assigned_profile_ids") or [])
        for u in users:
            u["assigned_profile_ids"] = [pid for pid in (u.get("assigned_profile_ids") or []) if pid in allowed]
    user_by_id = {u.get("id"): u for u in users}

    # ── Applications: (applier, profile) → day → [applies], each {job_id, easy} ─────────────
    applies: dict[tuple[str, str], dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    names: dict[str, tuple[str, str]] = {}          # applier key → (username, source)
    profile_names: dict[str, str] = {}
    for r in storage.get_applied_metrics_index():   # the Applied tab's rows, light (no resume blobs)
        d = _day_str(r.get("applied_at") or r.get("created_at"))
        if d not in in_week:
            continue
        uid = r.get("applied_by_user_id") or r.get("created_by_user_id") or ""
        pid = r.get("profile_id") or ""
        if not uid or not pid or (not is_admin and uid != me):
            continue
        link = r.get("job_link") or job_link.get(r.get("job_id"), "")
        applies[(uid, pid)][d].append(is_easy_apply(link))
    if is_admin:   # VPS_1's applies (the Applied tab lists them too)
        for a in storage.get_vps1_applications(status="applied"):
            row = vps1_adapt.applied_row(a)
            d = _day_str(row.get("applied_at") or row.get("created_at"))
            if d not in in_week:
                continue
            key = _vps1_key(row.get("bidder"))
            names[key] = (str(row.get("bidder") or "unknown"), "vps1")
            pid = str(row.get("profile_id") or "vps1:")
            profile_names[pid] = str(row.get("profile_name") or "")
            applies[(key, pid)][d].append(is_easy_apply(row.get("job_link") or ""))

    def _cell(easies: list[bool], total) -> dict:
        return {"applied": len(easies), "total": total, "easy": sum(1 for e in easies if e)}

    rows: list[dict] = []
    keys = set(applies)
    for u in users:                                  # a local user's assigned profiles show even when empty
        for pid in u.get("assigned_profile_ids") or []:
            if pid in profile_by_id:
                keys.add((u.get("id"), pid))
    for uid, pid in keys:
        local = not uid.startswith("vps1:")
        u = user_by_id.get(uid) if local else None
        if local and u is None:
            continue                                  # a deleted account / another bidder (bidder view)
        if local and pid not in profile_by_id:
            continue
        days = applies.get((uid, pid), {})
        pool = _pool(pid) if local else None
        daily = [_cell(days.get(d, []), pool.get(d, 0) if pool is not None else None) for d in day_strs]
        week = _cell([e for d in day_strs for e in days.get(d, [])], sum(pool.values()) if pool is not None else None)
        rows.append({
            "user_id": uid,
            "username": (u.get("username") or u.get("email") or uid) if local else names[uid][0],
            "source": "local" if local else "vps1",
            "profile_id": pid,
            "profile_name": (profile_by_id[pid].get("name", "") if local else profile_names.get(pid, "")),
            "assigned": (pid in (u.get("assigned_profile_ids") or [])) if local else True,
            "daily": daily,
            "week": week,
        })
    rows.sort(key=lambda r: (r["source"] != "local", r["username"].lower(), not r["assigned"], r["profile_name"].lower()))

    payload: dict = {"week_start": monday.isoformat(), "week_end": sunday.isoformat(), "days": day_strs, "rows": rows}

    def _sum(cells: list[dict], keys_=("applied", "easy")) -> dict:
        out = {k: sum(c.get(k) or 0 for c in cells) for k in keys_}
        return out

    if is_admin:   # = the Applied tab's count for each day (each applied CV once)
        payload["totals"] = {
            "daily": [{**_sum([r["daily"][i] for r in rows]), "total": None} for i in range(7)],
            "week": {**_sum([r["week"] for r in rows]), "total": None},
        }

    # ── Jobs added: adder → day → cells ───────────────────────────────────────────────────
    def _zero_job() -> dict:
        return {"uploaded": 0, "approved": 0, "rejected": 0, "pending": 0, "easy": 0}

    job_days: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(_zero_job))
    adder_names: dict[str, tuple[str, str]] = {}
    for j in all_jobs:
        st = str(j.get("status") or "")
        if st == "deleted":
            continue
        d = _day_str(j.get("submitted_at"))
        if d not in in_week:
            continue
        uid = str(j.get("created_by_user_id") or "").strip()
        if uid and uid in user_by_id:
            key = uid
        elif uid:
            continue                                  # another local user (bidder view) / a deleted account
        else:
            if not is_admin:
                continue
            key = _vps1_key(j.get("created_by_username"))      # synced from VPS_1: its adder there
            adder_names[key] = (str(j.get("created_by_username") or "").strip() or "unknown", "vps1")
        c = job_days[key][d]
        c["uploaded"] += 1
        if st in ("approved", "rejected", "pending"):
            c[st] += 1
        if is_easy_apply(j.get("link") or ""):
            c["easy"] += 1

    job_rows: list[dict] = []
    job_keys = set(job_days) | {u.get("id") for u in users if "job_adder" in set(u.get("roles") or [])}
    for key in job_keys:
        local = not str(key).startswith("vps1:")
        u = user_by_id.get(key) if local else None
        if local and u is None:
            continue
        days = job_days.get(key, {})
        daily = [dict(days.get(d) or _zero_job()) for d in day_strs]
        week = _zero_job()
        for c in daily:
            for k in week:
                week[k] += c[k]
        job_rows.append({
            "user_id": key,
            "username": (u.get("username") or u.get("email") or key) if local else adder_names[key][0],
            "source": "local" if local else "vps1",
            "daily": daily,
            "week": week,
        })
    job_rows.sort(key=lambda r: (r["source"] != "local", r["username"].lower()))
    payload["job_rows"] = job_rows
    if is_admin and job_rows:
        def _sum_job(cells: list[dict]) -> dict:
            out = _zero_job()
            for c in cells:
                for k in out:
                    out[k] += c[k]
            return out
        payload["job_totals"] = {
            "daily": [_sum_job([r["daily"][i] for r in job_rows]) for i in range(7)],
            "week": _sum_job([r["week"] for r in job_rows]),
        }
    return payload
