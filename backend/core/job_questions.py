"""A job's application questions — one shared list per job.

Whoever meets the application form first fills them in (a job adder in the Add job form, or
the first bidder in the extension's Bid tab) and every bidder after them sees the same list;
each bidder's CV conversation in ChatGPT answers them.

Stored in the job's `application_questions`. Jobs added in VPS2 also mirror them in `note`
(the web Jobs form labels `note` "Application questions (one per line)"). A job synced from
VPS1 carries VPS1's free-text reviewer note in `note` — that is never read as questions.
"""
from __future__ import annotations

import re

MAX_QUESTIONS = 15
MAX_LEN = 500
_SYSTEM_NOTES = ("Automatic scrape failed", "⚠")   # sync / duplicate notes, not questions
_LIST_MARK = re.compile(r"^\s*(?:[-*•]|\d{1,2}[.)])\s*")   # "1. ", "- ", "• "


def clean_questions(lines) -> list[str]:
    """Trim, drop list marks / blanks / system notes / case-insensitive repeats; cap the count."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in lines or []:
        q = re.sub(r"\s+", " ", _LIST_MARK.sub("", str(raw or ""))).strip()[:MAX_LEN]
        if not q or q.startswith(_SYSTEM_NOTES) or q.lower() in seen:
            continue
        seen.add(q.lower())
        out.append(q)
    return out[:MAX_QUESTIONS]


def job_questions(job: dict) -> list[str]:
    stored = job.get("application_questions") or []
    if stored:
        return clean_questions(stored)
    if str(job.get("source") or "") == "sync":
        return []
    return clean_questions(str(job.get("note") or "").splitlines())


def questions_patch(job: dict, questions: list[str]) -> dict:
    """The job fields to write for a new question list (a VPS2 job keeps `note` in step)."""
    patch = {"application_questions": questions}
    if str(job.get("source") or "") != "sync":
        patch["note"] = "\n".join(questions)
    return patch
