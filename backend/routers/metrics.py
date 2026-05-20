"""Metrics endpoint.

Returns one row per (user, profile) pair with daily / weekly / lifetime
application counts. Each cell is delivered as a pair {applied, total} so
the UI can render the `applied / total` fraction.

Query params:
    week_start: ISO date (YYYY-MM-DD) of the Monday of the target week.
                Defaults to the current week.

Response shape::

    {
      "week_start": "2026-05-12",
      "week_end":   "2026-05-18",
      "days":       ["2026-05-12", ..., "2026-05-18"],
      "rows":       [
        {
          "user_id":     "...",
          "username":    "...",
          "profile_id":  "...",
          "profile_name":"...",
          "daily":       [{applied, total}, ... 7 entries],
          "week":        {applied, total},
          "lifetime":    {applied, total}
        }
      ],
      "totals":     {                  # admin only
        "daily":    [{applied, total}, ... 7 entries],
        "week":     {applied, total},
        "lifetime": {applied, total}
      }
    }
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from fastapi import APIRouter, Depends
from auth import get_current_user, storage

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


def _parse_iso_date(s: str) -> date | None:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


@router.get("")
def get_metrics(week_start: str = "", user: dict = Depends(get_current_user)):
    """Role-aware metrics for one calendar week (Mon..Sun)."""
    is_admin = bool(user.get("is_admin"))

    # Workweek = Mon..Fri only (the team doesn't work weekends).
    requested = _parse_iso_date(week_start) if week_start else None
    monday = _monday_of(requested or _today_utc())
    friday = monday + timedelta(days=4)
    days = [monday + timedelta(days=i) for i in range(5)]
    day_strs = [d.isoformat() for d in days]

    # Pull data
    users = storage.get_users()
    profiles = storage.get_profiles()
    resumes = [r for r in storage.get_generated_resumes() if r.get("status") == "generated"]
    profile_by_id = {p.get("id"): p for p in profiles}

    # To-Do denominator = approved jobs added on that day / week / ever.
    # Shared across every row because the job pool is profile-independent.
    approved_jobs = [j for j in storage.get_jobs() if j.get("status") == "approved"]
    job_by_id = {j.get("id"): j for j in approved_jobs}
    jobs_added_per_day: dict[str, int] = defaultdict(int)
    jobs_added_in_week = 0
    for j in approved_jobs:
        submitted = (j.get("submitted_at") or "")[:10]
        if not submitted:
            continue
        if submitted in day_strs:
            jobs_added_per_day[submitted] += 1
        if monday.isoformat() <= submitted <= friday.isoformat():
            jobs_added_in_week += 1
    jobs_added_lifetime = len(approved_jobs)

    # For the bidder view, restrict to the bidder's own assigned profiles.
    if not is_admin:
        allowed = set(user.get("assigned_profile_ids") or [])
        # Bidder's "user row" is themselves only.
        users = [u for u in users if u.get("id") == user.get("id")]
        for u in users:
            u["assigned_profile_ids"] = [pid for pid in (u.get("assigned_profile_ids") or []) if pid in allowed]

    # Build per-(user, profile) buckets of APPLIES.
    # Day bucket is keyed by the underlying JOB'S submitted_at (the day the
    # job was added), NOT by when the bidder marked it applied. That way the
    # numerator and denominator share the same cohort definition.
    # We attribute an applied resume to a user via:
    #   1) applied_by_user_id if set (new flow)
    #   2) created_by_user_id otherwise (legacy)
    Bucket = lambda: {"daily": defaultdict(int), "applied_total": 0, "lifetime": 0}
    buckets: dict[tuple[str, str], dict] = defaultdict(Bucket)
    for r in resumes:
        if r.get("applied_status") != "applied":
            continue
        pid = r.get("profile_id") or ""
        uid = r.get("applied_by_user_id") or r.get("created_by_user_id") or ""
        if not uid or not pid:
            continue
        # Resolve the underlying job's add-date.
        job = job_by_id.get(r.get("job_id") or "")
        if not job:
            continue  # job deleted / not approved — exclude from metrics
        job_added = (job.get("submitted_at") or "")[:10]
        if not job_added:
            continue
        key = (uid, pid)
        buckets[key]["lifetime"] += 1
        if job_added in day_strs:
            buckets[key]["daily"][job_added] += 1
        if monday.isoformat() <= job_added <= friday.isoformat():
            buckets[key]["applied_total"] += 1

    # Compose rows. For each user, emit one row per assigned profile.
    rows: list[dict] = []
    for u in users:
        uid = u.get("id") or ""
        uname = u.get("username") or u.get("email") or uid
        assigned = u.get("assigned_profile_ids") or []
        if is_admin and not assigned:
            # In the admin view, only show users who actually have profiles
            # assigned. (Otherwise the table fills with empty rows.)
            continue
        for pid in assigned:
            prof = profile_by_id.get(pid)
            if not prof:
                continue
            b = buckets.get((uid, pid)) or {"daily": {}, "applied_total": 0, "lifetime": 0}
            rows.append({
                "user_id": uid,
                "username": uname,
                "profile_id": pid,
                "profile_name": prof.get("name", ""),
                # Denominator = jobs added in that period (shared across rows).
                "daily": [
                    {"applied": b["daily"].get(d, 0), "total": jobs_added_per_day.get(d, 0)}
                    for d in day_strs
                ],
                "week":     {"applied": b["applied_total"], "total": jobs_added_in_week},
                "lifetime": {"applied": b["lifetime"],      "total": jobs_added_lifetime},
            })

    # Stable sort: by username, then profile name.
    rows.sort(key=lambda r: (r["username"].lower(), r["profile_name"].lower()))

    payload: dict = {
        "week_start": monday.isoformat(),
        "week_end":   friday.isoformat(),
        "days":       day_strs,
        "rows":       rows,
    }

    if is_admin:
        # Grand totals: SUM the numerators (applied) across every row.
        # Denominators (job-add counts) are profile-independent so they stay
        # constant — they come straight from the per-period job tallies.
        totals_daily = [
            {"applied": sum(r["daily"][i]["applied"] for r in rows),
             "total":   jobs_added_per_day.get(d, 0)}
            for i, d in enumerate(day_strs)
        ]
        totals_week = {
            "applied": sum(r["week"]["applied"] for r in rows),
            "total":   jobs_added_in_week,
        }
        totals_lifetime = {
            "applied": sum(r["lifetime"]["applied"] for r in rows),
            "total":   jobs_added_lifetime,
        }
        payload["totals"] = {
            "daily":    totals_daily,
            "week":     totals_week,
            "lifetime": totals_lifetime,
        }

    return payload
