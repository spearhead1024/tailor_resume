"""Company intelligence: is a company a startup, how big is it, how old is it?

Startup rule (product decision):
    startup  = (fewer than 100 employees) OR (founded within the last 10 years)
    never a startup if publicly traded.

Only FREE, no-signup sources are used, cheapest/most reliable first:
    1. The company's own job descriptions  — "120 employees", "founded in 2019",
       "Series A", "(NASDAQ: XYZ)".
    2. Y Combinator public directory       — exact team size + batch year.
    3. Wikidata                            — employees / inception / stock exchange,
       accepted ONLY when its official website matches the company name (stops
       "Atlas" matching some unrelated Atlas).
    4. The company's website domain        — registration date (RDAP) and first
       Internet Archive snapshot give an age estimate for almost every company.
    5. Public ATS job boards (Greenhouse, Lever, Ashby, Workable) — number of open
       roles as a size estimate; enterprise ATSs (Workday, iCIMS…) imply 100+.

Every result records where each fact came from, and estimates are labelled "(est.)".
Admins can override a company by hand (locked — never re-checked automatically).

Run as a worker process (pm2 app "company-intel"):  python core/company_intel.py
New companies are registered by storage whenever a job is written and picked up
within seconds; the existing backlog is processed behind them.
"""
from __future__ import annotations

import logging
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

if __name__ == "__main__":   # allow `python core/company_intel.py` from backend/
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

log = logging.getLogger("company_intel")

MAX_EMPLOYEES = 100        # fewer than this → startup by size
MAX_AGE_YEARS = 10         # founded within this many years → startup by age
HTTP_TIMEOUT = (4, 8)      # (connect, read) seconds
UA = {"User-Agent": "TailorResume-company-check/1.0 (startup size/age lookup)"}

_http = requests.Session()
_http.headers.update(UA)
# Many company websites block non-browser clients (403), so homepage checks look
# like a normal browser. APIs (Wikidata, RDAP, ATS boards) get the honest UA above.
BROWSER = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
           "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9"}


def _get(url: str, **kw):
    try:
        r = _http.get(url, timeout=HTTP_TIMEOUT, **kw)
        if r.status_code == 200:
            return r
    except Exception:
        pass
    return None


# ── Domains ────────────────────────────────────────────────────────────────
_MULTI_TLDS = {"co.uk", "org.uk", "com.au", "co.in", "com.br", "co.jp", "co.nz", "com.sg",
               "co.za", "com.mx", "co.il", "com.tr", "com.cn", "com.hk", "co.kr"}
# Hosts that are job boards / ATSs / social / government — never a company's own site.
_NOT_COMPANY_DOMAINS = {
    "greenhouse.io", "ashbyhq.com", "lever.co", "myworkdayjobs.com", "workday.com", "myworkdaysite.com",
    "rippling.com", "rippling-ats.com", "workable.com", "applytojob.com", "icims.com", "bamboohr.com",
    "paylocity.com", "smartrecruiters.com", "adp.com", "jobdiva.com", "breezy.hr", "oraclecloud.com",
    "taleo.net", "successfactors.com", "successfactors.eu", "jobvite.com", "recruitee.com",
    "teamtailor.com", "pinpointhq.com", "dover.com", "gem.com", "wellfound.com", "angel.co",
    "workatastartup.com", "ycombinator.com", "linkedin.com", "indeed.com", "glassdoor.com",
    "ziprecruiter.com", "dice.com", "builtin.com", "google.com", "careers-page.com", "paycomonline.net",
    "ultipro.com", "ukg.com", "dayforcehcm.com", "hirebridge.com", "catsone.com", "jazzhr.com",
    "personio.de", "personio.com", "notion.site", "notion.so", "youtube.com", "github.com",
    "twitter.com", "x.com", "facebook.com", "instagram.com", "medium.com", "eeoc.gov", "dol.gov",
    "e-verify.gov", "uscis.gov", "bit.ly", "jobs.net", "hire.trakstar.com", "trakstar.com",
    "freshteam.com", "zohorecruit.com", "manatal.com", "comeet.com", "polymer.co", "ripplematch.com",
    "otta.com", "welcometothejungle.com", "simplify.jobs", "hiringcafe.com", "remoteok.com",
    "weworkremotely.com", "remotive.com", "flexjobs.com", "monster.com", "careerbuilder.com",
    # Hosting / site-builder / career-site platforms (a company's page ON them, not its domain)
    "salesforce-sites.com", "force.com", "site.com", "wixsite.com", "squarespace.com", "webflow.io",
    "vercel.app", "netlify.app", "github.io", "herokuapp.com", "azurewebsites.net", "cloudfront.net",
    "amazonaws.com", "hs-sites.com", "hubspot.com", "hubspotpagebuilder.com", "myshopify.com",
    "wordpress.com", "carrd.co", "framer.website", "framer.app", "typeform.com", "formstack.com",
    "jotform.com", "careerplug.com", "hrmdirect.com", "applicantpro.com", "isolvedhire.com",
    "paycor.com", "clearcompany.com", "silkroad.com", "brassring.com", "avature.net",
    "phenompeople.com", "eightfold.ai", "jobs2web.com", "hirehive.com", "recruiterbox.com",
    "grnh.se", "ukg.net", "lnkd.in", "t.co", "goo.gl", "tinyurl.com", "ow.ly", "workforcenow.adp.com",
    "myworkday.com", "ashbyhq.io", "gh.io", "hireology.com", "wd1.myworkdayjobs.com", "paycom.com",
}
_ENTERPRISE_ATS = {"myworkdayjobs.com", "workday.com", "myworkdaysite.com", "icims.com", "oraclecloud.com",
                   "taleo.net", "successfactors.com", "successfactors.eu", "adp.com", "ultipro.com",
                   "ukg.com", "dayforcehcm.com"}
_STARTUP_BOARDS = {"workatastartup.com", "wellfound.com", "angel.co"}


def registrable_domain(host_or_url: str) -> str:
    host = str(host_or_url or "").strip().lower()
    if "//" in host:
        host = urlparse(host).netloc
    host = host.split("@")[-1].split(":")[0].strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = [p for p in host.split(".") if p]
    if len(parts) < 2:
        return ""
    if ".".join(parts[-2:]) in _MULTI_TLDS and len(parts) >= 3:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _compact(name: str) -> str:
    from core.storage import company_key_for
    return company_key_for(name).replace(" ", "")


def domain_matches_name(domain: str, name: str) -> bool:
    """Does this domain plausibly belong to this company? (acme.com / getacme.io / acmehq.com)"""
    if not domain:
        return False
    sld = domain.split(".")[0].replace("-", "")
    c = _compact(name)
    if len(c) < 3:
        return False
    if sld == c or sld in {f"get{c}", f"try{c}", f"use{c}", f"join{c}", f"{c}hq", f"{c}app",
                           f"{c}ai", f"{c}inc", f"{c}labs", f"{c}tech", f"{c}io"}:
        return True
    words = company_key_words(name)
    return len(words) > 1 and len(words[0]) >= 5 and sld == words[0]


def company_key_words(name: str) -> list[str]:
    from core.storage import company_key_for
    return company_key_for(name).split()


_URL_RE = re.compile(r"(?i)\b(?:https?://|www\.)([a-z0-9][a-z0-9.-]+\.[a-z]{2,})")


def _homepage_is(domain: str, name: str, loose: bool = False) -> bool:
    """Fetch the homepage and check its title/site_name mentions the company.
    `loose` (used when the domain came from the company's own job-board slug) also
    accepts the first significant word of the name ("Nexer" for "Nexer Czech Republic")."""
    r = _get(f"https://{domain}", allow_redirects=True, headers=BROWSER)
    if r is None or "html" not in r.headers.get("content-type", ""):
        return False
    html = r.text[:60000].lower()
    bits = re.findall(r"<title[^>]*>(.*?)</title>", html, re.S)
    bits += re.findall(r'property="og:(?:site_name|title)"\s+content="([^"]*)"', html)
    c = _compact(name)
    words = [w for w in company_key_words(name) if len(w) >= 4]
    for b in bits:
        flat = re.sub(r"[^a-z0-9]", "", b)
        if c and c in flat:
            return True
        if loose and words and words[0] in flat:
            return True
    return False


def find_domain(name: str, jobs: list[dict], hints: list[str]) -> tuple[str, str]:
    """(domain, how-found). Tries cheap evidence before guessing."""
    # 1. The job link itself, when it's on the company's own site.
    for j in jobs:
        d = registrable_domain(j.get("link") or "")
        if d and d not in _NOT_COMPANY_DOMAINS:
            return d, "job link"
    # 2. URLs mentioned in the job descriptions / ATS board text that match the name.
    texts = [str(j.get("description") or "") for j in jobs] + hints
    for t in texts:
        for host in _URL_RE.findall(t):
            d = registrable_domain(host)
            if d and d not in _NOT_COMPANY_DOMAINS and domain_matches_name(d, name):
                return d, "job description"
    # 3. The company's slug on its job board (nexergroup.teamtailor.com, jobs.lever.co/acme)
    #    names its domain more often than not — confirm via the homepage.
    for j in jobs:
        slug = ats_slug(j.get("link") or "")
        if slug and len(slug) >= 3:
            for tld in ("com", "io", "ai", "co"):
                if _homepage_is(f"{slug}.{tld}", name, loose=True):
                    return f"{slug}.{tld}", "job board slug"
    # 4. Guess name.com / .ai / .io … and confirm via the homepage title.
    c = _compact(name)
    if len(c) < 3:
        return "", ""
    words = company_key_words(name)
    stems = [c] + (["-".join(words)] if len(words) > 1 else [])
    for stem in stems:
        for tld in ("com", "ai", "io", "co", "app", "dev", "tech"):
            d = f"{stem}.{tld}"
            if _homepage_is(d, name):
                return d, "website"
    for pre in ("get", "try", "use"):
        d = f"{pre}{c}.com"
        if _homepage_is(d, name):
            return d, "website"
    return "", ""


_ABOUT_PATHS = ("", "/about", "/about-us", "/company")


def website_facts(domain: str) -> dict:
    """Read the company's own homepage / About / Careers pages and pull the same
    facts as from job text: "founded in 2005", "over 600 employees", stock ticker."""
    from bs4 import BeautifulSoup
    texts: list[str] = []
    for path in _ABOUT_PATHS:
        r = _get(f"https://{domain}{path}", allow_redirects=True, headers=BROWSER)
        if r is None or "html" not in r.headers.get("content-type", ""):
            continue
        try:
            soup = BeautifulSoup(r.text[:400000], "html.parser")
            for t in soup(["script", "style", "noscript", "svg"]):
                t.decompose()
            texts.append(re.sub(r"\s+", " ", soup.get_text(" ")))
        except Exception:
            continue
        if len(texts) >= 3:
            break
    if not texts:
        return {}
    facts = from_job_text(texts)
    # "© 2008–2026 Acme" — the earliest copyright year is a floor on the company's age.
    years = [int(y) for t in texts for y in re.findall(r"(?:©|&copy;|copyright)\s*((?:19|20)\d{2})\s*[-–—]\s*(?:19|20)\d{2}", t, re.I)]
    if years and not facts.get("founded"):
        facts["copyright_since"] = min(years)
    return facts


def wayback_verified_since(domain: str, name: str) -> int | None:
    """The first year the Internet Archive shows THIS company's name on its domain.
    Unlike the raw registration date, this can't be fooled by an aged domain bought
    later — the old pages would show someone else's name. Names that are a single
    short word ("Granola") are skipped: an old granola-food site would match."""
    c = _compact(name)
    if len(company_key_words(name)) < 2 and len(c) < 9:
        return None
    r = _get("https://web.archive.org/cdx/search/cdx", params={
        "url": domain, "output": "json", "fl": "timestamp", "filter": "statuscode:200",
        "collapse": "timestamp:4", "limit": "30"})
    if r is None:
        return None
    try:
        stamps = [row[0] for row in r.json()[1:]]
    except Exception:
        return None
    for ts in stamps[:4]:   # oldest years first; stop at the first that shows the name
        snap = _get(f"https://web.archive.org/web/{ts}id_/http://{domain}/", headers=BROWSER)
        if snap is None:
            continue
        head = snap.text[:30000].lower()
        title = " ".join(re.findall(r"<title[^>]*>(.*?)</title>", head, re.S))
        if c in re.sub(r"[^a-z0-9]", "", title) or c in re.sub(r"[^a-z0-9]", "", head[:8000]):
            return int(ts[:4])
    return None


def domain_age_year(domain: str) -> tuple[int | None, str]:
    """Earliest of: domain registration year (RDAP) and first Internet Archive snapshot."""
    years: list[tuple[int, str]] = []
    r = _get(f"https://rdap.org/domain/{domain}", allow_redirects=True)
    if r is not None:
        try:
            for ev in r.json().get("events", []):
                if ev.get("eventAction") == "registration" and ev.get("eventDate"):
                    years.append((int(ev["eventDate"][:4]), "domain registered"))
        except Exception:
            pass
    r = _get("https://web.archive.org/cdx/search/cdx",
             params={"url": domain, "output": "json", "limit": "1", "fl": "timestamp"})
    if r is not None:
        try:
            rows = r.json()
            if len(rows) > 1 and rows[1]:
                years.append((int(str(rows[1][0])[:4]), "first archived"))
        except Exception:
            pass
    if not years:
        return None, ""
    y, how = min(years)
    return y, f"{how} {y}"


# ── Public ATS boards: open-role count as a size estimate ──────────────────
_SLUG_SUBDOMAIN_HOSTS = ("teamtailor.com", "recruitee.com", "bamboohr.com", "breezy.hr", "applytojob.com",
                         "workable.com", "freshteam.com", "zohorecruit.com", "pinpointhq.com", "rippling-ats.com",
                         "notion.site", "jobs.personio.de", "personio.de", "jobvite.com", "hire.trakstar.com")


def ats_slug(link: str) -> str:
    """The company's own slug on a job board: acme.teamtailor.com → acme,
    jobs.lever.co/acme → acme. '' when the link carries none."""
    u = urlparse(link or "")
    host, parts = u.netloc.lower().removeprefix("www."), [p for p in u.path.split("/") if p]
    board = ats_board(link)
    if board:
        return re.sub(r"[^a-z0-9-]", "", board[1].lower())
    for h in _SLUG_SUBDOMAIN_HOSTS:
        if host.endswith("." + h):
            sub = host[: -len(h) - 1].split(".")[-1]
            if sub not in {"www", "jobs", "careers", "apply", "app", "boards", "my"}:
                return re.sub(r"[^a-z0-9-]", "", sub)
    if host in {"jobs.smartrecruiters.com", "careers.smartrecruiters.com"} and parts:
        return re.sub(r"[^a-z0-9-]", "", parts[0].lower())
    return ""


def ats_board(link: str) -> tuple[str, str] | None:
    """(ats, slug) for job links on boards with a free public API."""
    u = urlparse(link or "")
    host, parts = u.netloc.lower(), [p for p in u.path.split("/") if p]
    if "greenhouse.io" in host:
        q = parse_qs(u.query)
        if q.get("for"):
            return "greenhouse", q["for"][0]
        if parts and parts[0] != "embed":
            return "greenhouse", parts[0]
    if host == "jobs.lever.co" and parts:
        return "lever", parts[0]
    if host == "jobs.ashbyhq.com" and parts:
        return "ashby", parts[0]
    if host == "apply.workable.com" and parts:
        return "workable", parts[0]
    return None


def ats_open_roles(ats: str, slug: str) -> tuple[int | None, str]:
    """(open role count, extra text such as the board's company blurb)."""
    try:
        if ats == "greenhouse":
            r = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
            meta = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}")
            blurb = (meta.json().get("content") or "") if meta is not None else ""
            return (len(r.json().get("jobs", [])) if r is not None else None), blurb
        if ats == "lever":
            r = _get(f"https://api.lever.co/v0/postings/{slug}", params={"mode": "json"})
            return (len(r.json()) if r is not None else None), ""
        if ats == "ashby":
            r = _get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
            return (len(r.json().get("jobs", [])) if r is not None else None), ""
        if ats == "workable":
            r = _get(f"https://apply.workable.com/api/v1/widget/accounts/{slug}")
            return (len(r.json().get("jobs", [])) if r is not None else None), ""
    except Exception:
        pass
    return None, ""


def size_band_from_open_roles(n: int) -> tuple[str, bool]:
    """Rough rule of thumb: companies keep ~5–10% of headcount as open roles."""
    if n <= 10:
        return "<100 employees (est.)", True
    if n <= 30:
        return "100–500 employees (est.)", False
    if n <= 150:
        return "500–2,000 employees (est.)", False
    return "2,000+ employees (est.)", False


# ── Job-description text ───────────────────────────────────────────────────
_NUM = r"(\d{1,3}(?:,\d{3})+|\d{1,6})"
_HEADCOUNT = re.compile(
    rf"(?i)\b(over |more than |nearly |almost |about |around |approximately |~)?{_NUM}\+?\s*"
    r"(?:full[- ]time )?(?:employees|staff members|team members|people strong|employees worldwide)\b")
_HEADCOUNT_CO = re.compile(rf"(?i)\b{_NUM}[- ](?:person|people|employee) (?:company|startup|business|firm|organization)\b")
_FOUNDED = re.compile(r"(?i)\b(?:founded|established)(?: in)? ((?:19|20)\d{2})\b")
_PUBLIC = re.compile(r"(?i)\((?:nasdaq|nyse)\s*:\s*[a-z.]{1,6}\)|\b(?:nasdaq|nyse)\s*:\s*[a-z]{1,5}\b|\bpublicly[- ]traded\b")
_EARLY = re.compile(r"(?i)\b(pre-seed|seed[- ]stage|seed round|seed-funded|series a)\b")


def from_job_text(descs: list[str]) -> dict:
    out: dict = {}
    nums: list[tuple[int, bool]] = []
    for d in descs:
        for m in _HEADCOUNT.finditer(d):
            n = int(m.group(2).replace(",", ""))
            if 2 <= n <= 500000:
                nums.append((n, bool(m.group(1))))
        for m in _HEADCOUNT_CO.finditer(d):
            n = int(m.group(1).replace(",", ""))
            if 2 <= n <= 500000:
                nums.append((n, False))
        for y in _FOUNDED.findall(d):
            y = int(y)
            if 1800 <= y <= datetime.utcnow().year:
                out["founded"] = min(out.get("founded", 9999), y)
        if _PUBLIC.search(d):
            out["public"] = True
        if _EARLY.search(d):
            out["early_stage"] = True
    if nums:
        n, approx = max(nums)
        out["employees"], out["employees_plus"] = n, approx
    return out


# ── Y Combinator directory (free JSON, cached daily) ───────────────────────
_yc_lock = threading.Lock()
_yc: dict = {"at": 0.0, "by_key": {}}


def yc_lookup(name: str) -> dict | None:
    from core.storage import company_key_for
    with _yc_lock:
        if time.time() - _yc["at"] > 86400 or not _yc["by_key"]:
            r = _get("https://yc-oss.github.io/api/companies/all.json")
            if r is not None:
                by_key = {}
                for c in r.json():
                    k = company_key_for(c.get("name", ""))
                    if k:
                        by_key[k] = c
                _yc.update(at=time.time(), by_key=by_key)
        c = _yc["by_key"].get(company_key_for(name))
    if not c:
        return None
    m = re.search(r"(\d{4})", str(c.get("batch") or ""))
    return {
        "employees": c.get("team_size") if isinstance(c.get("team_size"), int) and c.get("team_size") > 0 else None,
        "founded": int(m.group(1)) if m else None,
        "public": str(c.get("status", "")).lower() == "public",
        "website": c.get("website") or "",
        "batch": c.get("batch") or "",
    }


# ── Publicly traded: Nasdaq's official symbol directories (Nasdaq + NYSE etc.) ─
_listed_lock = threading.Lock()
_listed: dict = {"at": 0.0, "keys": set()}
_SECURITY_TAIL = re.compile(
    r"(?i)\b(class [a-z]\b.*|common stock.*|ordinary shares.*|american depositary.*|depositary shares.*|"
    r"units?\b.*|warrants?\b.*|rights?\b.*|preferred.*|subordinated.*|notes due.*|senior notes.*)$")


_GENERIC_TAIL = {"software", "technologies", "technology", "tech", "group", "international", "global",
                 "systems", "solutions", "enterprises", "platforms", "brands", "di", "nv", "n v", "sa",
                 "se", "ag", "the", "worldwide", "networks", "labs", "industries"}


_LISTED_CACHE = Path(__file__).resolve().parent.parent.parent / "data" / "listed_companies.json"
_LISTED_FILES = (("nasdaqlisted.txt", 6, 3), ("otherlisted.txt", 4, 6))   # (file, ETF col, test-issue col)


def _fetch_listed_files() -> dict[str, str]:
    """Nasdaq's symbol directory: FTP first (no bot wall), HTTPS as a fallback."""
    import ftplib
    import io
    out: dict[str, str] = {}
    try:
        f = ftplib.FTP("ftp.nasdaqtrader.com", timeout=30)
        f.login()
        for name, _, _ in _LISTED_FILES:
            buf = io.BytesIO()
            f.retrbinary(f"RETR symboldirectory/{name}", buf.write)
            out[name] = buf.getvalue().decode("utf-8", "replace")
        f.quit()
    except Exception as exc:
        log.warning("Nasdaq FTP failed (%s); trying HTTPS", exc)
    for name, _, _ in _LISTED_FILES:
        if "|" not in out.get(name, ""):
            r = _get(f"https://www.nasdaqtrader.com/dynamic/SymDir/{name}",
                     headers={"User-Agent": BROWSER["User-Agent"]})
            if r is not None and "|" in r.text:
                out[name] = r.text
    return {k: v for k, v in out.items() if "|" in v}


def _parse_listed(files: dict[str, str]) -> set[str]:
    from core.storage import company_key_for
    keys: set[str] = set()
    for name, etf_col, test_col in _LISTED_FILES:
        for line in files.get(name, "").splitlines()[1:]:
            cols = line.split("|")
            if len(cols) <= max(etf_col, test_col) or cols[etf_col] == "Y" or cols[test_col] == "Y":
                continue
            issuer = _SECURITY_TAIL.sub("", cols[1].split(" - ")[0]).strip(" ,.")
            k = company_key_for(issuer)
            if not k:
                continue
            keys.add(k)
            # Jobs use the short brand ("Unity", "Cellebrite") while the listing says
            # "Unity Software Inc." / "Cellebrite DI Ltd." — also index without generic tails.
            words = k.split()
            while len(words) > 1 and words[-1] in _GENERIC_TAIL:
                words.pop()
                keys.add(" ".join(words))
    return keys


def is_publicly_listed(name: str) -> bool:
    """True if the company is listed on Nasdaq/NYSE/other US exchanges. The list is
    refreshed daily; a failed download keeps the last good copy (memory, then disk)
    and waits an hour before retrying, so a blocked source never empties it."""
    import json
    from core.storage import company_key_for
    with _listed_lock:
        if time.time() - _listed["at"] > 86400:
            keys = _parse_listed(_fetch_listed_files())
            if len(keys) > 1000:
                _listed.update(at=time.time(), keys=keys)
                try:
                    _LISTED_CACHE.write_text(json.dumps(sorted(keys)))
                except Exception:
                    pass
            else:
                if not _listed["keys"] and _LISTED_CACHE.exists():
                    try:
                        _listed["keys"] = set(json.loads(_LISTED_CACHE.read_text()))
                    except Exception:
                        pass
                _listed["at"] = time.time() - 86400 + 3600     # retry in an hour
                log.warning("public-company list refresh failed; using %d cached names", len(_listed["keys"]))
        return company_key_for(name) in _listed["keys"]


# ── Wikidata (validated by official website) ───────────────────────────────
def wikidata_lookup(name: str, domain: str = "") -> dict | None:
    """Find the company on Wikidata via its search API, then read employees (P1128),
    inception (P571), stock exchange (P414) and official website (P856).
    A match is accepted only when it is clearly the same company: its website
    matches the company name (and our domain, if known), or — with no website —
    its label equals the name and its description says it is a company."""
    from core.storage import company_key_for
    s = _get("https://www.wikidata.org/w/api.php", params={
        "action": "wbsearchentities", "search": name, "language": "en", "type": "item",
        "limit": 5, "format": "json"})
    if s is None:
        return None
    cands = {x["id"]: x for x in s.json().get("search", [])}
    if not cands:
        return None
    vals = " ".join(f"wd:{q}" for q in cands)
    q = f"""SELECT ?item (SAMPLE(?site) AS ?website) (MAX(?emp) AS ?employees)
             (MIN(YEAR(?inc)) AS ?founded) (MAX(?p) AS ?isPublic) WHERE {{
      VALUES ?item {{ {vals} }}
      OPTIONAL {{ ?item wdt:P856 ?site . }}
      OPTIONAL {{ ?item wdt:P1128 ?emp . }}
      OPTIONAL {{ ?item wdt:P571 ?inc . }}
      OPTIONAL {{ ?item wdt:P414 ?ex . BIND(1 AS ?p) }}
    }} GROUP BY ?item"""
    try:
        r = _http.get("https://query.wikidata.org/sparql", params={"query": q, "format": "json"},
                      timeout=(4, 25))
        rows = r.json()["results"]["bindings"] if r.status_code == 200 else []
    except Exception:
        return None
    key = company_key_for(name)
    for b in rows:
        qid = b["item"]["value"].rsplit("/", 1)[-1]
        c = cands.get(qid, {})
        site = registrable_domain(b.get("website", {}).get("value", ""))
        if site:
            if not domain_matches_name(site, name) or (domain and site != domain):
                continue
        else:
            desc = str(c.get("description") or "").lower()
            if company_key_for(c.get("label", "")) != key or not re.search(
                    r"company|corporation|startup|business|firm|manufacturer|developer|provider|platform|retailer|bank", desc):
                continue
        return {
            "employees": int(float(b["employees"]["value"])) if "employees" in b else None,
            "founded": int(b["founded"]["value"]) if "founded" in b else None,
            "public": "isPublic" in b,
            "website": site,
        }
    return None


# ── Verdict ─────────────────────────────────────────────────────────────────
def finalize(d: dict) -> dict:
    """Fill labels + verdict from the raw facts in `d` (employees / size_lt100 /
    founded / public). Used for both automatic results and manual overrides."""
    cutoff = datetime.utcnow().year - MAX_AGE_YEARS
    emp = d.get("employees")
    if isinstance(emp, int) and emp > 0:
        if d.get("employees_plus"):          # "over 50 employees" is only a lower bound
            d["size_lt100"] = False if emp >= MAX_EMPLOYEES else None
        else:
            d["size_lt100"] = emp < MAX_EMPLOYEES
        d["size_label"] = f"{emp:,}{'+' if d.get('employees_plus') else ''} employees"
    elif not d.get("size_label"):
        d["size_label"] = "Size unknown"
        d["size_lt100"] = None
    founded = d.get("founded")
    if isinstance(founded, int):
        d["founded_label"] = f"Founded {founded}" if d.get("founded_exact") else f"Since ~{founded}"
    else:
        d["founded_label"] = "Age unknown"

    small = d.get("size_lt100")
    # A real founding year counts on its own (startup = small OR young). An ESTIMATED
    # one (domain / archive / copyright) does not overrule a known 100+ headcount —
    # an 11,200-person company with a domain from its 2020 rebrand is no startup.
    young = isinstance(founded, int) and founded >= cutoff and (d.get("founded_exact") or small is not False)
    old = isinstance(founded, int) and founded < cutoff
    reasons = []
    if d.get("public"):
        verdict = "not_startup"
        reasons.append("publicly traded")
    elif small or young:
        verdict = "startup"
        if small:
            reasons.append(f"under {MAX_EMPLOYEES} employees")
        if young:
            reasons.append(f"founded {founded} (≤{MAX_AGE_YEARS} yrs)")
    elif small is False or old:
        verdict = "not_startup"
        if small is False:
            reasons.append(f"{MAX_EMPLOYEES}+ employees")
        if old:
            reasons.append(f"founded before {cutoff}")
    else:
        verdict = "unknown"
        reasons.append("no size or age found")
    d["verdict"] = verdict
    d["reason"] = ", ".join(reasons)
    return d


def enrich(name: str, jobs: list[dict]) -> dict:
    """Run every free source for one company and return finalized facts."""
    d: dict = {"sources": []}
    size_src = founded_src = ""

    def set_size(emp=None, band=None, lt100=None, src="", plus=False):
        nonlocal size_src
        if size_src:
            return
        if emp:
            d["employees"], d["employees_plus"] = int(emp), plus
        elif band:
            d["size_label"], d["size_lt100"] = band, lt100
        else:
            return
        size_src = src

    def set_founded(year, src, exact):
        nonlocal founded_src
        if founded_src or not year:
            return
        d["founded"], d["founded_exact"] = int(year), exact
        founded_src = src

    descs = [str(j.get("description") or "") for j in jobs]
    text = from_job_text(descs)
    yc = yc_lookup(name)

    # Exact facts first.
    if yc:
        d["sources"].append(f"YC {yc['batch']}".strip())
        set_size(emp=yc["employees"], src="YC directory")
        set_founded(yc["founded"], f"YC {yc['batch']}", True)
        d["public"] = d.get("public") or yc["public"]
    if text.get("employees"):
        set_size(emp=text["employees"], plus=text.get("employees_plus", False), src="job description")
    if text.get("founded"):
        set_founded(text["founded"], "job description", True)
    # (A stock ticker in the text is NOT used: job ads cite customers' and partners'
    #  tickers. Only the official exchange listings / Wikidata decide "public".)
    if text.get("employees") or text.get("founded"):
        d["sources"].append("job description")

    # Public job boards: open roles + blurb (which may name the website).
    hints: list[str] = []
    open_roles = None
    for j in jobs:
        board = ats_board(j.get("link") or "")
        if board:
            open_roles, blurb = ats_open_roles(*board)
            hints.append(blurb)
            if open_roles is not None:
                d["open_roles"] = open_roles
                d["sources"].append(f"{board[0]} board: {open_roles} open roles")
                break

    # Website domain (YC knows it; otherwise find it).
    domain, how = (registrable_domain(yc["website"]), "YC") if yc and yc.get("website") else find_domain(name, jobs, hints)
    d["domain"] = domain
    guessed_domain = how == "website"     # found by guessing name.tld, not from evidence

    # The company's own website (About / Careers pages).
    if domain:
        site = website_facts(domain)
        # Only the founding year is taken from marketing pages: "founded in 2005" is
        # reliably about the company, while headcounts there often describe customers
        # ("built for teams of 1,000 employees") and tickers often belong to partners.
        if site.get("founded"):
            set_founded(site["founded"], f"{domain} website", True)
        if site.get("founded"):
            d["sources"].append(f"{domain} website")
        if site.get("copyright_since"):
            d["copyright_since"] = site["copyright_since"]

    # Always asked: it is also the main "publicly traded" check.
    wd = wikidata_lookup(name, domain)
    if wd:
        d["sources"].append("Wikidata")
        set_size(emp=wd["employees"], src="Wikidata")
        set_founded(wd["founded"], "Wikidata", True)
        d["public"] = d.get("public") or wd["public"]
        domain = domain or wd["website"]
        d["domain"] = domain
    if is_publicly_listed(name):
        d["public"] = True
        d["sources"].append("listed on Nasdaq/NYSE")

    # Estimates — size first, so the domain-age step below can see size signals.
    if open_roles is not None:
        band, lt = size_band_from_open_roles(open_roles)
        set_size(band=band, lt100=lt, src="open roles on job board")
    if text.get("early_stage"):
        set_size(band="<100 employees (est., seed/Series A)", lt100=True, src="funding stage in job description")
    links = [registrable_domain(j.get("link") or "") for j in jobs]
    if any(l in _ENTERPRISE_ATS for l in links):
        set_size(band="100+ employees (est., enterprise hiring system)", lt100=False, src="hiring system")
    if any(l in _STARTUP_BOARDS for l in links):
        set_size(band="<100 employees (est., startup job board)", lt100=True, src="startup job board")

    if domain and not founded_src:
        since = wayback_verified_since(domain, name)
        if since:
            set_founded(since, f"on {domain} since {since} (Internet Archive)", False)
            d["sources"].append(f"{domain}: company name archived since {since}")
    if domain and not founded_src and d.get("copyright_since"):
        set_founded(d["copyright_since"], f"{domain} copyright since {d['copyright_since']}", False)
        d["sources"].append(f"{domain}: © since {d['copyright_since']}")
    if domain and not founded_src:
        # Asymmetric on purpose: a RECENT domain is good evidence of a young company,
        # but an OLD domain proves nothing — startups often buy aged domains
        # (granola.com dates from 1995). So only a recent date sets the age.
        # And a GUESSED domain may be a side-site of an old company (akamai.dev, 2019),
        # so its age can't overrule evidence that the company is big.
        year, how_age = domain_age_year(domain)
        big = d.get("size_lt100") is False or (d.get("employees") or 0) >= MAX_EMPLOYEES
        if year and year >= datetime.utcnow().year - MAX_AGE_YEARS and not (guessed_domain and big):
            set_founded(year, how_age, False)
            d["sources"].append(f"{domain}: {how_age}")
        elif year:
            d["sources"].append(f"{domain}: {how_age} (not used)")

    d["size_source"], d["founded_source"] = size_src, founded_src
    d["public"] = bool(d.get("public"))
    d["confidence"] = "high" if (d.get("employees") or d.get("founded_exact")) else (
        "medium" if (size_src or founded_src) else "low")
    return finalize(d)


# ── Worker ─────────────────────────────────────────────────────────────────
def _process(storage, item: dict) -> None:
    try:
        jobs = storage.jobs_for_company(item["job_company_keys"])
        data = enrich(item["name"], jobs)
        storage.save_company(item["key"], data, "done")
        log.info("%s → %s (%s; %s)", item["name"], data["verdict"], data["size_label"], data["founded_label"])
    except Exception as exc:
        log.exception("check failed for %s", item["name"])
        storage.save_company(item["key"], {"error": str(exc)[:300], "verdict": "unknown",
                                           "size_label": "Size unknown", "founded_label": "Age unknown"}, "error")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from auth import storage   # same storage instance setup as the API
    added = storage.seed_companies_from_jobs()
    log.info("company-intel started; registered %d existing companies for checking", added)
    last_seed = time.time()
    with ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            # Safety net: every 10 min, register any company whose job reached the DB
            # without going through the registration hook (e.g. a sync process still
            # running older code). Guarantees every company gets checked.
            if time.time() - last_seed > 600:
                n = storage.seed_companies_from_jobs()
                if n:
                    log.info("registered %d companies that were missing", n)
                last_seed = time.time()
            batch = storage.companies_to_check(limit=8)
            if not batch:
                time.sleep(5)
                continue
            list(pool.map(lambda it: _process(storage, it), batch))


if __name__ == "__main__":
    main()
