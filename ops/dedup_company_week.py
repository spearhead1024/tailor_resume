#!/usr/bin/env python
"""Enforce "one job per company per region per 7-day window" for a given ET day.

Removes (status -> rejected) TODAY's duplicate jobs while PRESERVING:
  - any job that has been applied (admin_applied, or a generated resume marked applied)
  - all pre-today jobs (older rows are never touched)
A company+region whose slot is already held within the window (by a pre-today
job, an applied job, or the first kept job of the day) loses its extra same-day
postings. Rejected/deleted jobs don't hold a slot.

Dry-run by default; pass --apply to commit. Pass --date YYYY-MM-DD (ET) to target
a specific day (defaults to today ET).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
DB = ROOT / "data" / "app.db"
ET = ZoneInfo("America/New_York")


def parse_dt(s):
    if not s:
        return None
    s = str(s).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.fromisoformat(s.split(".")[0])
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=datetime.now(ET).date().isoformat(),
                    help="ET day to de-duplicate (YYYY-MM-DD)")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    target = args.date

    c = sqlite3.connect(str(DB))
    c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute("""
        SELECT id, company, company_key, region, status, submitted_at, created_at,
               json_extract(data,'$.admin_applied') AS admin_applied,
               json_extract(data,'$.job_title')     AS job_title
        FROM jobs WHERE status IN ('approved','pending')
    """).fetchall()]
    applied_ids = {r[0] for r in c.execute(
        "SELECT DISTINCT job_id FROM generated_resumes "
        "WHERE json_extract(data,'$.applied_status')='applied'"
    ).fetchall()}
    c.close()

    def best_dt(r):
        return parse_dt(r["submitted_at"]) or parse_dt(r["created_at"])

    def et_day(r):
        dt = best_dt(r)
        return dt.astimezone(ET).date().isoformat() if dt else None

    def is_applied(r):
        return bool(r["admin_applied"]) or r["id"] in applied_ids

    for r in rows:
        r["et"] = et_day(r)
        r["dt"] = best_dt(r)
        r["key"] = (r["company_key"], r["region"])

    win_start = (datetime.fromisoformat(target).date() - timedelta(days=args.days)).isoformat()

    # Slots already held within the window by pre-today active jobs.
    kept = set()
    for r in rows:
        if r["et"] and win_start <= r["et"] < target and r["key"][0]:
            kept.add(r["key"])

    today = [r for r in rows if r["et"] == target and r["key"][0]]
    today.sort(key=lambda r: r["dt"] or datetime.min.replace(tzinfo=timezone.utc))

    to_remove = []
    protected = 0
    for r in today:
        if is_applied(r):
            protected += 1
            kept.add(r["key"])
            continue
        if r["key"] in kept:
            to_remove.append(r)
        else:
            kept.add(r["key"])

    print(f"Target ET day : {target}   window >= {win_start}  ({args.days}d)")
    print(f"Active jobs   : {len(rows)} total | {len(today)} on target day")
    print(f"Applied (kept): {protected} of the target day's jobs")
    print(f"To remove     : {len(to_remove)}   by region: {dict(Counter(r['region'] for r in to_remove))}")
    for r in to_remove[:30]:
        print(f"   - {r['region']:5} | {r['company']}  —  {r['job_title']}  [{r['id']}]")
    if len(to_remove) > 30:
        print(f"   ... +{len(to_remove) - 30} more")

    if not args.apply:
        print("\nDRY RUN — re-run with --apply to reject these duplicates.")
        return

    from auth import storage  # configured singleton (correct paths)
    for r in to_remove:
        storage.update_job(r["id"], {
            "status": "rejected",
            "note": "Auto-removed: duplicate company within 1 week",
        })
    print(f"\nApplied — rejected {len(to_remove)} duplicate job(s).")


if __name__ == "__main__":
    main()
