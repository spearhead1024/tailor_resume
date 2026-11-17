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


# ---- a profile's market (the region its Easy Bids jobs are added with) ----
_US_STATES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
    "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska",
    "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
    "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
}
_US_CODES = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks", "ky", "la", "me",
    "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa",
    "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc", "us", "usa",
}
_EUROPE = {
    "albania", "andorra", "austria", "belarus", "belgium", "bosnia", "bulgaria", "croatia", "cyprus", "czech",
    "czechia", "denmark", "estonia", "finland", "france", "germany", "greece", "hungary", "iceland", "ireland",
    "italy", "kosovo", "latvia", "liechtenstein", "lithuania", "luxembourg", "malta", "moldova", "monaco",
    "montenegro", "netherlands", "north macedonia", "macedonia", "norway", "poland", "portugal", "romania",
    "san marino", "serbia", "slovakia", "slovenia", "spain", "sweden", "switzerland", "ukraine", "united kingdom",
    "uk", "england", "scotland", "wales", "europe", "european union", "eu",
}
_LATAM = {
    "argentina", "bolivia", "brazil", "brasil", "chile", "colombia", "costa rica", "cuba", "dominican republic",
    "ecuador", "el salvador", "guatemala", "honduras", "mexico", "méxico", "nicaragua", "panama", "panamá",
    "paraguay", "peru", "perú", "puerto rico", "uruguay", "venezuela", "latam", "latin america",
}
MARKETS = ("US", "EU", "LATAM", "ANY")


def market_of_location(location: str) -> str:
    """'Romania' → EU, 'Duncanville, Texas' → US, 'São Paulo, Brazil' → LATAM; '' when unknown."""
    text = str(location or "").lower()
    parts = [p.strip() for p in re.split(r"[,;/|·-]", text) if p.strip()]
    if not parts:
        return ""
    if "united states" in text or "u.s." in text or any(p in _US_STATES for p in parts):
        return "US"
    if any(p in _LATAM for p in parts) or any(c in text for c in ("latin america", "latam")):
        return "LATAM"
    if any(p in _EUROPE for p in parts):
        return "EU"
    # Two-letter state codes last: "DE" is Delaware but also Germany's code, so a country name wins.
    if any(p in _US_CODES for p in parts):
        return "US"
    return ""


def profile_market(profile: dict) -> str:
    """The region a profile bids in: its own region field when it is US / EU / LATAM, else inferred
    from its location (country / state), else ANY (open to every job)."""
    region = str((profile or {}).get("region") or "").strip().upper()
    if region in ("US", "EU", "LATAM"):
        return region
    return market_of_location((profile or {}).get("location", "")) or "ANY"
