"""Easy Apply vs outside-apply jobs — one rule, from the job link.

A job whose link is a LinkedIn job posting (https://www.linkedin.com/jobs/view/<id>, or a LinkedIn
search/collection page pointing at one with ?currentJobId=<id>) is an Easy Apply job: bidders apply
on LinkedIn, from the extension's "Easy Bids" tab. Every other job is an outside-apply job, bid from
"Out Bids" (and both are listed on the web Bid tab). A LinkedIn link that names no job (a company
page) is an outside job — there is nothing to Easy-Apply to.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

_VIEW_RE = re.compile(r"/jobs/view/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)", re.I)
_ID_RE = re.compile(r"^\d{6,}$")


def _host(link: str) -> str:
    try:
        return (urlsplit(str(link or "").strip()).hostname or "").lower()
    except ValueError:
        return ""


def is_linkedin_host(link: str) -> bool:
    host = _host(link)
    return host == "linkedin.com" or host.endswith(".linkedin.com")


def linkedin_job_id(link: str) -> str:
    """The LinkedIn job id a link points at, or '' (not LinkedIn / no job in it)."""
    raw = str(link or "").strip()
    if not is_linkedin_host(raw):
        return ""
    m = _VIEW_RE.search(urlsplit(raw).path + "/")
    if m:
        return m.group(1)
    for key, values in parse_qs(urlsplit(raw).query).items():
        if key.lower() == "currentjobid" and values and _ID_RE.match(values[0].strip()):
            return values[0].strip()
    return ""


def is_easy_apply(link: str) -> bool:
    return bool(linkedin_job_id(link))


def canonical_link(job_id: str) -> str:
    """The one link stored for an Easy Apply job — the same posting always maps to the same link."""
    return f"https://www.linkedin.com/jobs/view/{job_id}/"
