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
          "assigned":    true,       # false = not their profile; shown for applies they made this week
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
from core.storage import tech_stacks_match

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


@router.get("")
def get_metrics(week_start: str = "", user: dict = Depends(get_current_user)):
    """Role-aware metrics for one calendar week (Mon..Sun)."""
    is_admin = bool(user.get("is_admin"))

    # Workweek = Mon..Fri only (the team doesn't work weekends).
    requested = _parse_iso_date(week_start) if week_start else None
    monday = _monday_of(requested or _today())
    friday = monday + timedelta(days=4)
    days = [monday + timedelta(days=i) for i in range(5)]
    day_strs = [d.isoformat() for d in days]

    # Pull data
    users = storage.get_users()
    profiles = storage.get_profiles()
    resumes = [r for r in storage.get_generated_resumes() if r.get("status") == "generated"]
    profile_by_id = {p.get("id"): p for p in profiles}

    all_jobs = storage.get_jobs()  # every status — used for job-upload metrics

    # To-Do denominator = approved jobs eligible for the profile: region match
    # AND tech-stack match (any of the profile's main skills mentioned as a whole
    # word in the job description; empty stacks = All-Stack = every job).
    all_approved_jobs = [
        j for j in all_jobs
        if j.get("status") == "approved"
        and not j.get("flagged")
        and not j.get("admin_applied")
    ]
    job_by_id = {j.get("id"): j for j in all_approved_jobs}

    def _regions_match(job_region: str, profile_region: str) -> bool:
        return "ANY" in (job_region, profile_region) or job_region == profile_region

    def _job_eligible(job: dict, profile: dict) -> bool:
        """A job counts for a profile only if region AND tech stacks match."""
        p_region = str(profile.get("region") or "ANY").upper().strip() or "ANY"
        if not _regions_match(str(job.get("region") or "ANY").upper(), p_region):
            return False
        return tech_stacks_match(job.get("description"), profile.get("tech_stacks") or [])

    def _profile_approved_jobs(profile: dict) -> list[dict]:
        return [j for j in all_approved_jobs if _job_eligible(j, profile)]

    # For the bidder view, restrict to the bidder's own assigned profiles.
    if not is_admin:
        allowed = set(user.get("assigned_profile_ids") or [])
        # Bidder's "user row" is themselves only.
        users = [u for u in users if u.get("id") == user.get("id")]
        for u in users:
            u["assigned_profile_ids"] = [pid for pid in (u.get("assigned_profile_ids") or []) if pid in allowed]

    # Build per-(applier, profile) buckets of APPLIES.
    #
    # Attribution is EXACT: each application counts ONLY for the bidder who
    # actually marked it applied (applied_by_user_id), so a profile shared by
    # two bidders never leaks one bidder's applies onto the other.
    #
    # The day bucket is the day the JOB was added (submitted_at, by the 5pm-JST day) — NOT
    # the day the bidder clicked "applied". Each column is therefore "of the
    # jobs that arrived that day, how many has this bidder applied" — coverage
    # of the day's intake, which is how the team reads the grid (e.g. Tuesday
    # 50/50 = all of Tuesday's 50 jobs applied). Bucketing by the click day
    # instead scatters one day's jobs across whatever days the bidder happened
    # to work them and lets "applied" exceed that day's intake. A bidder onboarded
    # later still has their applies land on the day each job was added.
    #
    # `applies_by_profile` unions every applier (incl. an admin helping out) per
    # profile for the admin grand total below. Count UNIQUE JOBS (deduped by
    # job_id) so regenerated resumes don't inflate the count.
    def _new_bucket() -> dict:
        return {"daily": defaultdict(set), "week_jobs": set(), "lifetime_jobs": set()}
    applies: dict[tuple[str, str], dict] = defaultdict(_new_bucket)
    applies_by_profile: dict[str, dict] = defaultdict(_new_bucket)
    for r in resumes:
        if r.get("applied_status") != "applied":
            continue
        pid = r.get("profile_id") or ""
        job_id = r.get("job_id") or ""
        applier = r.get("applied_by_user_id") or ""
        if not pid or not job_id or not applier:
            continue
        # Only count applies against jobs still in the approved to-do pool AND
        # still eligible for this profile (region + tech stacks), so the
        # numerator stays inside the same cohort as the denominator.
        job = job_by_id.get(job_id)
        if not job:
            continue  # job deleted / not approved — exclude from metrics
        prof = profile_by_id.get(pid)
        if prof is None or not _job_eligible(job, prof):
            continue  # job no longer matches the profile's region/tech stacks
        job_added = _day_str(job.get("submitted_at"))
        if not job_added:
            continue
        for b in (applies[(applier, pid)], applies_by_profile[pid]):
            b["lifetime_jobs"].add(job_id)
            if job_added in day_strs:
                b["daily"][job_added].add(job_id)
            if monday.isoformat() <= job_added <= friday.isoformat():
                b["week_jobs"].add(job_id)

    # Compose rows. For each user, one row per assigned profile — plus one per profile they
    # applied on THIS WEEK without being assigned to it. Admins work jobs on any profile, never
    # assigned, so without these rows an admin's applies counted nowhere but the grand total.
    applied_this_week: dict[str, list[str]] = defaultdict(list)
    for (applier, pid), b in applies.items():
        if b["week_jobs"]:
            applied_this_week[applier].append(pid)
    rows: list[dict] = []
    # Per-profile to-do denominators, captured once per profile for the grand
    # total (and to de-duplicate profiles shared by several bidders).
    profile_denominator: dict[str, dict] = {}
    for u in users:
        uid = u.get("id") or ""
        uname = u.get("username") or u.get("email") or uid
        assigned = list(u.get("assigned_profile_ids") or [])
        extra = sorted(set(applied_this_week.get(uid, ())) - set(assigned))
        # A user with neither assigned profiles nor applies this week gets no rows (the table
        # would fill with empty ones).
        for pid in assigned + extra:
            prof = profile_by_id.get(pid)
            if not prof:
                continue
            b = applies.get((uid, pid)) or _new_bucket()
            # Denominator filtered by this profile's region AND tech stacks.
            profile_jobs = _profile_approved_jobs(prof)
            p_added_per_day: dict[str, int] = defaultdict(int)
            p_added_in_week = 0
            for j in profile_jobs:
                submitted = _day_str(j.get("submitted_at"))
                if not submitted:
                    continue
                if submitted in day_strs:
                    p_added_per_day[submitted] += 1
                if monday.isoformat() <= submitted <= friday.isoformat():
                    p_added_in_week += 1
            p_added_lifetime = len(profile_jobs)
            rows.append({
                "user_id": uid,
                "username": uname,
                "profile_id": pid,
                "profile_name": prof.get("name", ""),
                "assigned": pid in assigned,
                "daily": [
                    {"applied": len(b["daily"].get(d, ())), "total": p_added_per_day.get(d, 0)}
                    for d in day_strs
                ],
                "week":     {"applied": len(b["week_jobs"]),     "total": p_added_in_week},
                "lifetime": {"applied": len(b["lifetime_jobs"]), "total": p_added_lifetime},
            })
            # Capture this profile's denominator once for the grand total.
            profile_denominator[pid] = {
                "daily":    {d: p_added_per_day.get(d, 0) for d in day_strs},
                "week":     p_added_in_week,
                "lifetime": p_added_lifetime,
            }

    # Stable sort: by username, then assigned profiles before the extra ones, then profile name.
    rows.sort(key=lambda r: (r["username"].lower(), not r["assigned"], r["profile_name"].lower()))

    payload: dict = {
        "week_start": monday.isoformat(),
        "week_end":   friday.isoformat(),
        "days":       day_strs,
        "rows":       rows,
    }

    if is_admin:
        # Grand totals: per profile, count UNIQUE jobs applied by ANYONE on that
        # profile (every assigned bidder, plus an admin helping out — deduped so
        # a job two people both marked counts once) over the profile's to-do
        # pool. Restricted to profiles that have a row so the total reconciles
        # with the table; iterating profile_denominator de-dupes shared profiles.
        shown = list(profile_denominator.keys())
        totals_daily = [
            {"applied": sum(len(applies_by_profile[pid]["daily"].get(d, ())) for pid in shown),
             "total":   sum(profile_denominator[pid]["daily"][d] for pid in shown)}
            for d in day_strs
        ]
        totals_week = {
            "applied": sum(len(applies_by_profile[pid]["week_jobs"]) for pid in shown),
            "total":   sum(profile_denominator[pid]["week"] for pid in shown),
        }
        totals_lifetime = {
            "applied": sum(len(applies_by_profile[pid]["lifetime_jobs"]) for pid in shown),
            "total":   sum(profile_denominator[pid]["lifetime"] for pid in shown),
        }
        payload["totals"] = {
            "daily":    totals_daily,
            "week":     totals_week,
            "lifetime": totals_lifetime,
        }

    # ── Job-upload metrics ─────────────────────────────────────────────────
    # Per uploader: how many jobs they added, broken down by approved/rejected,
    # bucketed by the upload date (submitted_at). Synced jobs have no local uploader
    # (their adder is a VPS1 account), so they're excluded; deleted jobs don't count
    # as an "upload".
    def _zero_job() -> dict:
        return {"uploaded": 0, "approved": 0, "rejected": 0}

    def _new_job_bucket() -> dict:
        return {"daily": defaultdict(_zero_job), "week": _zero_job(), "lifetime": _zero_job()}

    def _bump(cell: dict, st: str) -> None:
        cell["uploaded"] += 1
        if st == "approved":
            cell["approved"] += 1
        elif st == "rejected":
            cell["rejected"] += 1

    job_buckets: dict[str, dict] = defaultdict(_new_job_bucket)
    for j in all_jobs:
        uid = str(j.get("created_by_user_id") or "").strip()
        if not uid:
            continue
        st = str(j.get("status") or "")
        if st == "deleted":
            continue
        added = _day_str(j.get("submitted_at"))
        if not added:
            continue
        b = job_buckets[uid]
        _bump(b["lifetime"], st)
        if added in day_strs:
            _bump(b["daily"][added], st)
        if monday.isoformat() <= added <= friday.isoformat():
            _bump(b["week"], st)

    # One row per job_adder, and per anyone else who added a job THIS WEEK (an admin adding jobs
    # by hand used to count nowhere). Admins see all; everyone else sees themselves, because
    # `users` was already filtered above for non-admins.
    job_rows: list[dict] = []
    for u in users:
        uid = u.get("id") or ""
        added_this_week = uid in job_buckets and job_buckets[uid]["week"]["uploaded"] > 0
        if "job_adder" not in set(u.get("roles") or []) and not added_this_week:
            continue
        uname = u.get("username") or u.get("email") or uid
        b = job_buckets.get(uid) or {"daily": {}, "week": _zero_job(), "lifetime": _zero_job()}
        job_rows.append({
            "user_id": uid,
            "username": uname,
            "daily": [dict(b["daily"].get(d) or _zero_job()) for d in day_strs],
            "week": dict(b["week"]),
            "lifetime": dict(b["lifetime"]),
        })
    job_rows.sort(key=lambda r: r["username"].lower())
    payload["job_rows"] = job_rows

    if is_admin and job_rows:
        def _sum_job(cells: list[dict]) -> dict:
            out = _zero_job()
            for c in cells:
                out["uploaded"] += c["uploaded"]
                out["approved"] += c["approved"]
                out["rejected"] += c["rejected"]
            return out
        payload["job_totals"] = {
            "daily":    [_sum_job([r["daily"][i] for r in job_rows]) for i in range(len(day_strs))],
            "week":     _sum_job([r["week"] for r in job_rows]),
            "lifetime": _sum_job([r["lifetime"] for r in job_rows]),
        }

    return payload
