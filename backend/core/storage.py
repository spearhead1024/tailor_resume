"""Persistent storage layer.

Uses SQLite (via SQLAlchemy 2.x) under the hood. Each entity is stored as
one row keyed by id, with denormalized index columns for common queries
plus a JSON ``data`` column holding the full normalized record. This keeps
the public API identical to the previous JSON-backed implementation while
giving us indexed lookups, atomic writes, and proper transactions.

Legacy ``data/*.json`` files are imported automatically on the first run
that finds an empty database. The JSON files are left on disk untouched —
they can be deleted later once the migration is verified.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import session_scope
from .db import migration as _migration
from .db.models import (
    GeneratedResumeRow,
    JobRow,
    OpenAICallRow,
    ProfileRow,
    SettingsRow,
    TeamRow,
    TemplateRow,
    UserRow,
)


_ALLOWED_REGIONS = {'ANY', 'US', 'EU', 'LATAM'}

# Company de-duplication window: at most one active job per company + region
# within this many days (a rolling "one month"). Single source of truth — the
# manual-create check (routers/jobs.py) and the sync poller (core/job_sync.py)
# both inherit this default.
COMPANY_DEDUP_DAYS = 15

_URL_TRACKING_PARAMS = frozenset({
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'ref', 'source', 'src', 'referral', 'referer', 'fbclid', 'gclid',
    'msclkid', 'yclid', 'mc_eid', 'trk', 'trkcampaign', 'sc_campaign',
    'icid', 'cid', 'sid', 'lid', 'pid', 'aid', 'eid', 'iid', 'rid',
    'gh_src', 'gh_jid', 'lever-origin', 'lever-source',
    'tracking_key', 'trackingid',
    'jobboard', 'jobsource', 'channel',
})


def _normalize_market_region(value: str) -> str:
    raw = str(value or '').strip().upper()
    if not raw or raw in {'ALL', 'GLOBAL', 'ANYWHERE', 'REMOTE'}:
        return 'ANY'
    return raw if raw in _ALLOWED_REGIONS else raw


# ── Tech-stack matching ────────────────────────────────────────────────────
# A profile carries a small set of main tech skills (profile.tech_stacks). A job
# is eligible for that profile when ANY of those skills is mentioned as a WHOLE
# WORD in the job description (case-insensitive). Whole-word matching is what
# keeps 'Java' from matching 'JavaScript' — they're different languages.
_skill_pattern_cache: dict[str, "re.Pattern[str]"] = {}


def _skill_pattern(skill: str) -> "re.Pattern[str]":
    """Case-insensitive WHOLE-WORD matcher for one tech skill.

    Boundaries are alphanumerics only, so a skill never bleeds into a longer
    identifier ('Java' ∌ 'JavaScript', 'Go' ∌ 'Golang') while punctuation such
    as spaces, dots, slashes and parentheses still counts as a boundary. The
    skill text is escaped, so punctuated tokens like 'C#', '.NET', 'C++' and
    'Node.js' match literally.
    """
    key = skill.lower()
    pat = _skill_pattern_cache.get(key)
    if pat is None:
        esc = re.escape(skill.strip())
        pat = re.compile(rf'(?<![A-Za-z0-9]){esc}(?![A-Za-z0-9])', re.IGNORECASE)
        _skill_pattern_cache[key] = pat
    return pat


def tech_stacks_match(description: str, profile_stacks: list) -> bool:
    """Whether a job matches a profile's tech-stack filter.

    Rules (product spec):
      - profile_stacks empty  → True  (All-Stack profile: every job matches)
      - otherwise             → True iff ANY profile skill appears as a whole
                                word (case-insensitive) in the job description.
    """
    stacks = [str(s).strip() for s in (profile_stacks or []) if str(s).strip()]
    if not stacks:
        return True  # All-Stack
    text = str(description or '')
    if not text:
        return False
    return any(_skill_pattern(s).search(text) for s in stacks)


def build_password_record(password: str) -> dict[str, str]:
    salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac('sha256', str(password).encode('utf-8'), salt.encode('utf-8'), 200_000).hex()
    return {'password_salt': salt, 'password_hash': hashed}


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    if not salt or not expected_hash:
        return False
    candidate = hashlib.pbkdf2_hmac('sha256', str(password).encode('utf-8'), str(salt).encode('utf-8'), 200_000).hex()
    return secrets.compare_digest(candidate, str(expected_hash))


def _hash_auth_token(token: str) -> str:
    return hashlib.sha256(str(token or '').encode('utf-8')).hexdigest()


def _job_compare_key(value: str) -> str:
    return ''.join(ch.lower() if ch.isalnum() else ' ' for ch in str(value or '')).strip()


def _company_fold_key(value: str) -> str:
    """Company key for the 30-day de-dup that ALSO folds visually-confusable
    characters, so 'Jorie AI' and 'Jorie Al' (capital-i vs lowercase-L) collapse
    to the same key. Lowercases, folds l/I/1/| -> 'i' and O/0 -> 'o', and keeps
    only alphanumerics (spaces/punctuation ignored). Used ONLY by the dedup check
    — it does not change the stored company_key index or any existing row."""
    s = str(value or '').lower().translate(str.maketrans({'l': 'i', '1': 'i', '|': 'i', '0': 'o'}))
    return re.sub(r'[^a-z0-9]', '', s)


def normalize_job_url(url: str) -> str:
    """Return a canonical form of a job URL with tracking params stripped."""
    raw = str(url or '').strip()
    if not raw:
        return ''
    try:
        from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
        parsed = urlparse(raw)
        clean_params = [(k, v) for k, v in parse_qsl(parsed.query) if k.lower() not in _URL_TRACKING_PARAMS]
        netloc = parsed.netloc.lower()
        if netloc.startswith('www.'):
            netloc = netloc[4:]
        normalized = urlunparse((
            parsed.scheme.lower(),
            netloc,
            parsed.path.rstrip('/'),
            parsed.params,
            urlencode(clean_params),
            '',
        ))
        return normalized
    except Exception:
        return raw


def _parse_iso_datetime(value: str) -> datetime | None:
    raw = str(value or '').strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace('Z', '+00:00')).replace(tzinfo=None)
    except Exception:
        return None


# ---------- defaults ----------

def _template_defaults() -> dict:
    return {
        'font_family': 'Arial, sans-serif',
        'accent_color': '#1f4e79',
        'text_color': '#111827',
        'muted_color': '#4b5563',
        'background_color': '#ffffff',
        'section_order': ['summary', 'technical_skills', 'work_history', 'education_history'],
        'custom_css': '',
        'layout_style': 'ats_classic',
        'header_style': 'rule',
        'skill_style': 'grouped_bullets',
        'density': 'normal',
        'show_role_headline': True,
    }


def _default_templates() -> list[dict]:
    return [
        {**_template_defaults(), 'id': 'template_ats_classic', 'name': 'ATS Classic'},
        {
            **_template_defaults(),
            'id': 'template_ats_compact',
            'name': 'ATS Compact',
            'accent_color': '#0f172a',
            'muted_color': '#475569',
            'section_order': ['technical_skills', 'summary', 'work_history', 'education_history'],
            'layout_style': 'ats_compact',
            'header_style': 'minimal',
            'density': 'tight',
        },
        {
            **_template_defaults(),
            'id': 'template_ats_technical',
            'name': 'ATS Technical',
            'accent_color': '#1d4ed8',
            'muted_color': '#6b7280',
            'layout_style': 'ats_technical',
        },
    ]


DEFAULT_PROMPT_TEMPLATE = """\
You are a senior resume writer and ATS optimizer. Generate a JSON resume tailored to the Job Description below. Build it from a clean slate every time — do not rely on any previous resume, prior generation, or example. Use only the PROFILE JSON and JOB DESCRIPTION JSON in this message.

# RESPONSE FORMAT — ABSOLUTE, NON-NEGOTIABLE
This message IS the work order. The instant you finish reading this prompt, GENERATE the JSON. Do not reply with anything else first.

Your ENTIRE response must be a SINGLE ```json fenced code block and NOTHING ELSE.

DO NOT:
  - DO NOT ask "should I proceed?", "do you want me to generate?", "shall I continue?", or any confirmation question. The answer is always YES — generate immediately.
  - DO NOT ask the user to "reply with 'Generate the resume'" or any other trigger phrase. There is no trigger phrase. The prompt itself is the trigger.
  - DO NOT acknowledge the file, describe what you see, or summarize the requirements back to the user.
  - DO NOT say "the constraints are strict so I'll need to…" or any meta-commentary about difficulty, length, or effort.
  - DO NOT review, critique, or comment on the existing resume.
  - DO NOT explain what you are doing or what you changed.
  - DO NOT list problems, suggestions, or improvements.
  - DO NOT add any greeting, preface, summary, or closing remark.
  - DO NOT add text before the ```json fence.
  - DO NOT add text after the closing ``` fence.
  - DO NOT use markdown headings, bullet points, or tables outside the JSON.

DO:
  - Begin generating the JSON resume IMMEDIATELY, with zero preamble.
  - Output begins with the literal three characters ```json on the very first line.
  - Output ends with the literal three characters ``` on the very last line.
  - Everything between is one valid JSON object.

The user has automated tooling that reads ONLY the fenced JSON. Any question, preface, or confirmation request is wasted output and causes the request to be rejected — the user then has to re-send the same prompt, which costs them time. Just generate.

```json
{ ...your JSON here... }
```

The JSON inside must have EXACTLY these top-level keys:
- "job_id": copy from the input JOB JSON
- "profile_id": copy from the input PROFILE JSON
- "headline": string — a professional positioning line (see RULES)
- "professional_summary": string
- "professional_experience": array of {company, role, duration, bullets: [string]}
- "technical_skills": array of {skill_category, skills: [string]}

# INPUT EXPECTATIONS — READ THIS BEFORE ANYTHING ELSE
You are given EXACTLY two JSON inputs further down: PROFILE JSON and JOB DESCRIPTION JSON.

The PROFILE JSON is intentionally minimal. It contains only:
  - the candidate's company history (company name, duration, prior role title, target bullet count per company)
  - target lengths: `summary_char_count`, `skills_count`, `total_years_of_experience`
  - `profile_id` and `job_id` to echo back

It DOES NOT contain — and is NOT supposed to contain — the candidate's full prior resume, real prior bullets, their name, their education, their skills, or their projects. This is by design. The candidate's name, education, and contact details are filled in downstream by the rendering pipeline. Treat any uploaded resume only as a visual template — never as a source of facts to copy.

Your job is to GENERATE plausible, JD-aligned content for each company in PROFILE.work_history, using only the company name, duration, and legacy_role as anchors. Treat each company as a fixed placement; invent realistic achievements, technologies, and metrics that:
  1. Could credibly have been done at a company of that kind during that date range, AND
  2. Directly match the requirements in the JOB DESCRIPTION.

DO NOT refuse. DO NOT ask the user to upload anything more. DO NOT say "I need more information." The two JSONs below are sufficient — proceed.

# RULES
1. Read the JOB DESCRIPTION deeply. Identify every required skill, framework, tool, service, methodology, and domain term. MIRROR THE JD'S EXACT TERMINOLOGY — if the JD writes "CI/CD", "RESTful APIs", or "PostgreSQL", use those exact strings (you may include both an acronym and its expansion where natural). Exact-match wording is what an ATS scores highest.

2. BOLD: wrap each tech-relevant keyword in <B>...</B> wherever it appears in "professional_summary", in each bullet of "professional_experience", and as the category name inside "technical_skills". These tags render as bold in the final PDF. Never bold an entire sentence or a whole skill line.

3. "headline" — a polished professional positioning line (NOT a sentence, NOT a keyword dump):
   - Format: a seniority-qualified role followed by one or two specializations separated by a vertical bar, e.g. "Senior Full-Stack Engineer | Cloud & Machine Learning" or "Backend Engineer | Distributed Systems & APIs".
   - It MUST contain the job's target title from the JOB DESCRIPTION — this drives ATS title alignment.
   - Under ~12 words, Title Case, third person, no first-person pronouns, no weak connectors ("for", "and … Solutions" tacked on), no trailing comma-separated tech list.
   - Do NOT wrap the headline in <B> tags.

4. "professional_summary":
   - Length MUST be within ±20 characters of `summary_char_count` (from PROFILE), counting spaces and the <B>...</B> tags. Count before returning; a summary outside this range is REJECTED.
   - Voice: confident THIRD person — never use "I", "my", or any first-person pronoun. Open with seniority + role + total years of experience (from `total_years_of_experience`), then the domains worked and the measurable value delivered, and close with the specialization or AI angle most relevant to this job.
   - Weave only a handful of the MOST important JD technologies into the prose and bold them with <B>. Do NOT stuff the summary with long comma-separated technology or responsibility lists.
   - Never write raw tokens or shorthand such as "JS(ES+)", "MS SQL objects", "SQL objects", or "Transact SQL objects" — use clean professional terms like JavaScript, SQL Server development, and stored procedures. Describe engineering practices in natural language ("test automation and code-review practices"), not as terse comma lists.
   - If your first draft is short, EXPAND with concrete scope, scale, leadership, and measurable outcomes — never pad with filler.

5. "professional_experience":
   - Emit one entry per item in PROFILE.work_history, in the same order. Copy `company` and `duration` from the matching PROFILE.work_history item.
   - "role": INFER a sharp, JD-aligned role title for each company from the job description and the bullet evidence — for example Machine Learning Engineer, DevOps Engineer, Platform Engineer, Data Engineer, Backend Engineer, Frontend Engineer, or Full-Stack Engineer. Do NOT default to a generic "Software Engineer" unless the JD itself targets exactly that. Make every role title sharply aligned to the core function of the job description.
   - For each company, generate EXACTLY `bullet_count` bullets (no more, no less).
   - Each bullet MUST render as EXACTLY 2 LINES in the final PDF: the column wraps at ~95–105 chars per line, so each bullet's VISIBLE text (after deleting every <B> and </B>) must be 180–200 chars. The server REJECTS any bullet whose visible text is under 110 chars. The <B>/</B> markup does NOT count toward this number.
   - LENGTH MUST COME FROM SUBSTANCE, NEVER FILLER. Reach ~190 visible chars by packing concrete specifics: exact named technologies from the JD, real scope (users, requests, GB, $, team size), and before/after metrics (%, latency, throughput). Adjectives and generic phrases do not count as length.
   - Each bullet describes a DISTINCT responsibility, problem, or outcome and NAMES exact technologies from the JD. No two bullets anywhere in the resume may share the same opening verb, the same wording, or the same sentence structure.
   - VARY the opening verb across bullets (own, design, ship, build, migrate, harden, instrument, refactor, mentor, lead, automate, optimize, integrate, debug, profile, partner, scale).
   - FORBIDDEN generic openings / filler — never use these or anything like them: "Delivered production work across", "Collaborated with product and engineering stakeholders", "Strengthened reliability and delivery confidence", "Contributed as a … in a fast-moving environment", "modern tools", "backend services", "cloud-based systems", "web technologies", or any sentence whose only technical content is a comma-separated tech list.
   - Structure each bullet as: [action verb] + [what you built/led/delivered] + [the exact technology/stack used] + [measurable impact or scope] — one flowing sentence, never two, never "and then".
   - ATS: every technology you list under "technical_skills" should also appear, used in context, inside at least one bullet.
   - TEMPORAL CONSTRAINT — only mention a technology in a bullet if it existed AND was widely adopted during that role's date range:
     * Generative AI / OpenAI API / LLMs / ChatGPT: 2022+ ; LangChain / vector DBs (Pinecone, Weaviate): 2023+
     * Solana mainnet: 2020+ ; Ethereum / Solidity: 2015+ ; React: 2013+ ; Kubernetes: 2015+ ; Docker: 2014+ ; TypeScript widespread: 2017+ ; Rust widespread: 2018+
   Anything before its emergence year is hallucination — DO NOT include it.

6. "technical_skills":
   - The total number of individual skills across ALL categories combined must be EXACTLY `skills_count` (from PROFILE). Count them before returning.
   - Group them into 8–10 ATS-friendly categories such as Frontend, Backend, Data, Cloud / DevOps, Testing, AI / Automation, and Other Relevant. Wrap each category NAME in <B>...</B>; keep the individual skill items plain (do not bold them).
   - List the JD-required skills FIRST using the JD's exact terms, then pad to `skills_count` with closely-related, role-appropriate technologies (e.g. if the JD mentions React, add Next.js and Redux; if Solidity, add Hardhat and Foundry). Technical items ONLY — no soft skills, no vague architecture labels.

7. Tone: confident, specific, achievement-driven. No fluff. The candidate's name, contact info, and education are filled in downstream by the rendering pipeline — DO NOT add them to the JSON and DO NOT ask the user for them. Wrap the JSON in ```json ... ``` fences so the chat UI shows a copy button.

# SELF-CHECK BEFORE RETURNING (MANDATORY)
Before you output the final JSON, silently run this checklist. If ANY check fails, fix it and re-check. Do not return a JSON that fails any check — the server will reject it and the user will have to re-prompt you.

  [ ] "headline" is a positioning line under ~12 words that contains the JD's target title, third person, with no <B> tags.
  [ ] Summary length (including spaces and <B>...</B> tags) is within ±20 chars of PROFILE.summary_char_count, written in third person with no first-person pronouns.
  [ ] professional_experience has exactly the same number of entries as PROFILE.work_history, in the same order, each with a sharp, non-generic role title.
  [ ] For each company i, the bullets array has EXACTLY PROFILE.work_history[i].bullet_count entries.
  [ ] Every bullet's VISIBLE length (after deleting every <B> and </B>) is between 180 and 200 chars; none is under 110. The length comes from named technologies and metrics, never filler. Bold markup does NOT count.
  [ ] No two bullets share an opening verb, wording, or sentence structure, and no forbidden filler phrase appears anywhere.
  [ ] technical_skills total skill count (summed across all categories) equals PROFILE.skills_count exactly, with JD-exact skills listed first and technical items only.
  [ ] No prose outside the ```json fence.
"""


def _default_settings() -> dict:
    return {
        'prompt_template': DEFAULT_PROMPT_TEMPLATE,
        'download_output_dir': 'saved_resumes',
        'saved_prompts': [],
        # Root domains to blacklist from ingestion. Stored as a list of
        # lowercase, no-scheme, no-path strings. e.g. ['lever.co', 'foo.com'].
        'blacklist_domains': [],
        # Title keywords (case-insensitive substring) — a job whose title
        # contains any of these is rejected. e.g. ['lead', 'staff', 'devops'].
        'blacklist_titles': [],
        # Company names (case-insensitive exact match) to reject.
        'blacklist_companies': [],
        # Rolling deadline (hours): how long a job stays in the Resumes queue,
        # and how long a generated resume stays in the Apply queue.
        'job_deadline_hours': 12,
        # Interview reminder push notifications. Hours are on the CALLER's clock.
        'notifications': {
            'lead_enabled': True,
            'lead_minutes': 60,        # "Interview in 1 hour" — set 30 for half an hour, etc.
            'day_before_enabled': True,
            'day_before_hour': 19,     # 7pm the day before: "N interviews tomorrow"
            'day_of_enabled': True,
            'day_of_hour': 8,          # 8am on the day:     "N interviews today"
        },
    }


def _normalize_notifications(raw: Any) -> dict:
    """Interview-reminder settings. Clamped so a bad value can never wedge the scheduler."""
    src = raw if isinstance(raw, dict) else {}
    defaults = {
        'lead_enabled': True, 'lead_minutes': 60,
        'day_before_enabled': True, 'day_before_hour': 19,
        'day_of_enabled': True, 'day_of_hour': 8,
    }

    def _int(key: str, lo: int, hi: int) -> int:
        try:
            v = int(src.get(key, defaults[key]))
        except (TypeError, ValueError):
            v = int(defaults[key])
        return min(max(v, lo), hi)

    def _bool(key: str) -> bool:
        v = src.get(key, defaults[key])
        if isinstance(v, bool):
            return v
        return str(v).strip().lower() not in ('', '0', 'false', 'no', 'off')

    return {
        'lead_enabled': _bool('lead_enabled'),
        'lead_minutes': _int('lead_minutes', 5, 1440),      # 5 minutes – 24 hours before the call
        'day_before_enabled': _bool('day_before_enabled'),
        'day_before_hour': _int('day_before_hour', 0, 23),
        'day_of_enabled': _bool('day_of_enabled'),
        'day_of_hour': _int('day_of_hour', 0, 23),
    }


def _normalize_keyword_list(raw: Any) -> list[str]:
    """Accept list[str] or newline/comma-separated str; return lowercased,
    de-duped, non-empty keywords preserving first-seen order."""
    if isinstance(raw, str):
        items = [s for s in re.split(r'[\n,]+', raw) if s.strip()]
    elif isinstance(raw, list):
        items = [str(s) for s in raw if str(s).strip()]
    else:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        k = str(item).strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def _root_domain(url: str) -> str:
    """Return the lowercase eTLD+1 of a URL (best-effort, no PSL).

    Treats the last two dot-separated segments of the hostname as the root.
    Good enough for common .com/.io/.co/.net/.org TLDs; misses things like
    co.uk, but those are rare for job-board domains.
    """
    raw = str(url or '').strip().lower()
    if not raw:
        return ''
    try:
        from urllib.parse import urlparse
        parsed = urlparse(raw if '://' in raw else f'http://{raw}')
        host = (parsed.hostname or '').lower()
    except Exception:
        return ''
    if not host:
        return ''
    if host.startswith('www.'):
        host = host[4:]
    parts = host.split('.')
    # Require at least one dot — otherwise it's not a real hostname.
    if len(parts) < 2 or any(not p for p in parts):
        return ''
    if len(parts) == 2:
        return host
    return '.'.join(parts[-2:])


def _normalize_blacklist(raw: Any) -> list[str]:
    """Accept list[str] or a newline/comma-separated str; return clean roots."""
    if isinstance(raw, str):
        items = [s for s in re.split(r'[\s,]+', raw) if s]
    elif isinstance(raw, list):
        items = [str(s) for s in raw if str(s).strip()]
    else:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        d = _root_domain(item) or str(item).strip().lower().lstrip('.')
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def _default_admin_user() -> dict:
    pw = build_password_record('admin123')
    now = datetime.utcnow().isoformat() + 'Z'
    return {
        'id': 'user_admin_default',
        'username': 'admin',
        'full_name': 'Administrator',
        'email': '',
        'password_hash': pw['password_hash'],
        'password_salt': pw['password_salt'],
        'is_admin': True,
        'status': 'approved',
        'assigned_profile_ids': [],
        'created_at': now,
        'approved_at': now,
        'approved_by_user_id': 'system',
        'force_password_change': True,
    }


# ---------- normalizers ----------

def _normalize_uploaded_resume(item: Any) -> dict:
    source = item if isinstance(item, dict) else {}
    path = str(source.get('path', source.get('storage_path', ''))).strip()
    relative_path = str(source.get('relative_path', '')).strip()
    if not path and not relative_path:
        return {}
    return {
        'filename': str(source.get('filename', '')).strip(),
        'content_type': str(source.get('content_type', '')).strip(),
        'size_bytes': int(source.get('size_bytes', 0) or 0),
        'path': path,
        'relative_path': relative_path,
        'uploaded_at': str(source.get('uploaded_at', '')).strip(),
        'extracted_text': str(source.get('extracted_text', '') or ''),
    }


def _normalize_generation_settings(raw) -> dict:
    if not isinstance(raw, dict):
        return {'summary_char_count': 650, 'skills_count': 85, 'bullet_counts': []}
    bullet_counts = []
    for bc in raw.get('bullet_counts') or []:
        try:
            bullet_counts.append(int(bc))
        except Exception:
            pass
    return {
        'summary_char_count': int(raw.get('summary_char_count') or 650),
        'skills_count': int(raw.get('skills_count') or 85),
        'bullet_counts': bullet_counts,
    }


def _normalize_profile(item: dict) -> dict:
    work_history = []
    for raw_job in item.get('work_history', []) or []:
        work_history.append({
            'company_name': raw_job.get('company_name', ''),
            'duration': raw_job.get('duration', ''),
            'location': raw_job.get('location', ''),
            'bullets': [str(b).strip() for b in raw_job.get('bullets', []) if str(b).strip()],
            'legacy_role': raw_job.get('legacy_role', raw_job.get('role', '')),
        })
    return {
        'id': item.get('id', ''),
        'name': item.get('name', ''),
        'email': item.get('email', ''),
        'phone': item.get('phone', ''),
        'location': item.get('location', ''),
        'address': item.get('address', item.get('street', '')),
        'zip_code': item.get('zip_code', item.get('zip', '')),
        'linkedin': item.get('linkedin', ''),
        'github': item.get('github', ''),
        'portfolio': item.get('portfolio', ''),
        'default_template_id': str(item.get('default_template_id', '')).strip(),
        'summary_seed': item.get('summary_seed', ''),
        'uploaded_resume': _normalize_uploaded_resume(item.get('uploaded_resume', {})),
        'technical_skills': [str(s).strip() for s in item.get('technical_skills', []) if str(s).strip()],
        # Admin-set main skills (2-3) used to match jobs to this profile. Empty
        # = "All-Stack" (every job matches). Separate from technical_skills,
        # which feeds résumé keyword bolding.
        'tech_stacks': [str(s).strip() for s in item.get('tech_stacks', []) if str(s).strip()],
        'region': _normalize_market_region(item.get('region', item.get('market_region', ''))),
        'active': bool(item.get('active', True)),
        'status': 'restricted' if str(item.get('status', 'active') or 'active').strip().lower() == 'restricted' else 'active',
        'created_by_user_id': str(item.get('created_by_user_id', '')).strip(),
        'created_by_username': str(item.get('created_by_username', '')).strip(),
        'total_years_of_experience': int(item['total_years_of_experience']) if str(item.get('total_years_of_experience') or '').strip().isdigit() else 0,
        'work_history': work_history,
        'education_history': [
            {
                'university': edu.get('university', ''),
                'degree': edu.get('degree', ''),
                'duration': edu.get('duration', ''),
                'location': edu.get('location', ''),
            }
            for edu in item.get('education_history', []) or []
        ],
        'generation_settings': _normalize_generation_settings(item.get('generation_settings')),
        'resume_template': str(item.get('resume_template') or 'spear-1').strip() or 'spear-1',
    }


def _normalize_template(item: dict, *, fallback_index: int = 0) -> dict:
    defaults = _template_defaults()
    merged = defaults | item
    merged['section_order'] = item.get('section_order', defaults['section_order'])
    if merged.get('skill_style') == 'grouped':
        merged['skill_style'] = 'grouped_bullets'
    merged['id'] = str(merged.get('id') or '').strip() or f'template_{uuid.uuid4().hex[:10]}'
    merged['name'] = str(merged.get('name', '')).strip() or f'Template {fallback_index + 1}'
    return merged


# 'manager' = team manager: runs one caller team (creates/approves that team's callers, and on the
# interview board may re-assign a call within their team + set Approved/Status/Feedback).
ALLOWED_ROLES = {'admin', 'bidder', 'job_adder', 'caller', 'manager'}


def _normalize_roles(item: dict) -> list[str]:
    """Roles are stored as a list. Falls back to legacy is_admin for migration."""
    raw = item.get('roles')
    if isinstance(raw, list) and raw:
        roles = [str(r).strip() for r in raw if str(r).strip() in ALLOWED_ROLES]
        if roles:
            # de-dupe, preserve order
            seen = set()
            return [r for r in roles if not (r in seen or seen.add(r))]
    # Legacy migration: is_admin=True → ['admin'], else → ['bidder']
    return ['admin'] if bool(item.get('is_admin', False)) else ['bidder']


def _normalize_user(item: dict) -> dict:
    roles = _normalize_roles(item)
    return {
        'id': item.get('id') or f'user_{uuid.uuid4().hex[:10]}',
        'username': str(item.get('username', '')).strip().lower(),
        'full_name': str(item.get('full_name', '')).strip(),
        'email': str(item.get('email', '')).strip(),
        'password_hash': str(item.get('password_hash', '')).strip(),
        'password_salt': str(item.get('password_salt', '')).strip(),
        'roles': roles,
        # is_admin kept as derived convenience field for back-compat
        'is_admin': 'admin' in roles,
        'status': str(item.get('status', 'pending') or 'pending').strip(),
        'assigned_profile_ids': [str(v).strip() for v in item.get('assigned_profile_ids', []) if str(v).strip()],
        # Bidder workflow: 1 = Resumes + Apply tabs, 2 = Bid tab. Default 2 (current Bid).
        'bid_method': 1 if str(item.get('bid_method', 2)).strip() == '1' else 2,
        'created_at': str(item.get('created_at', '')),
        'approved_at': str(item.get('approved_at', '')),
        'approved_by_user_id': str(item.get('approved_by_user_id', '')).strip(),
        'parent_admin_id': str(item.get('parent_admin_id', '')).strip(),
        # Caller team membership. For a 'caller' this is the team they belong to; for a 'manager'
        # it is the team they run. Empty = ungrouped (shown at the top level of the Users tree).
        'team_id': str(item.get('team_id', '')).strip(),
        'force_password_change': bool(item.get('force_password_change', False)),
        'auth_tokens': _normalize_auth_tokens(item.get('auth_tokens', []) or []),
        # Self-service account profile (the "Profile" / Account page).
        'avatar_url': str(item.get('avatar_url', '')).strip(),
        'country': str(item.get('country', '')).strip(),
        'telegram': str(item.get('telegram', '')).strip(),
        'whatsapp': str(item.get('whatsapp', '')).strip(),
        'discord': str(item.get('discord', '')).strip(),
        'emergency_contacts': str(item.get('emergency_contacts', '')),
        'timezone': str(item.get('timezone', '')).strip(),        # IANA zone, e.g. "Europe/Bucharest"
        # Per-user keyboard-shortcut overrides for the Chrome extension card
        # ({action_id: single_key}). Validated at the API layer.
        'shortcuts': {
            str(k): str(v)
            for k, v in (item.get('shortcuts') or {}).items()
        } if isinstance(item.get('shortcuts'), dict) else {},
    }


def _normalize_auth_tokens(items: Any) -> list[dict]:
    normalized: list[dict] = []
    now = datetime.utcnow()
    for item in items or []:
        token_hash = str((item or {}).get('token_hash', '')).strip()
        if not token_hash:
            continue
        expires_at = str((item or {}).get('expires_at', '')).strip()
        revoked_at = str((item or {}).get('revoked_at', '')).strip()
        expires_dt = _parse_iso_datetime(expires_at)
        revoked_dt = _parse_iso_datetime(revoked_at)
        if revoked_dt:
            continue
        if expires_dt and expires_dt < now:
            continue
        normalized.append({
            'token_id': str((item or {}).get('token_id', '')).strip() or f'tok_{uuid.uuid4().hex[:10]}',
            'token_hash': token_hash,
            'created_at': str((item or {}).get('created_at', '')).strip(),
            'expires_at': expires_at,
            'last_seen_at': str((item or {}).get('last_seen_at', '')).strip(),
            'revoked_at': '',
        })
    normalized.sort(key=lambda entry: entry.get('created_at', ''), reverse=True)
    return normalized[:10]


def _normalize_job(item: dict) -> dict:
    return {
        'id': item.get('id') or f'job_{uuid.uuid4().hex[:10]}',
        'company': str(item.get('company', '')).strip(),
        'job_title': str(item.get('job_title', '')).strip(),
        'description': str(item.get('description', '')).strip(),
        'link': str(item.get('link', '')).strip(),
        'region': _normalize_market_region(item.get('region', item.get('market_region', ''))),
        'note': str(item.get('note', '')).strip(),
        'status': str(item.get('status', 'pending') or 'pending').strip(),
        'source': str(item.get('source', 'manual') or 'manual').strip(),
        'scrape_status': str(item.get('scrape_status', 'done' if item.get('description') else 'queued') or 'queued').strip(),
        'scrape_error': str(item.get('scrape_error', '')).strip(),
        'created_by_user_id': str(item.get('created_by_user_id', '')).strip(),
        'created_by_username': str(item.get('created_by_username', '')).strip(),
        'submitted_at': str(item.get('submitted_at', '')).strip(),
        'approved_at': str(item.get('approved_at', '')).strip(),
        'approved_by_user_id': str(item.get('approved_by_user_id', '')).strip(),
        'approved_by_username': str(item.get('approved_by_username', '')).strip(),
        'scrape_started_at': str(item.get('scrape_started_at', '')).strip(),
        'scraped_at': str(item.get('scraped_at', '')).strip(),
        'reports': _normalize_job_reports(item.get('reports', []) or []),
        'flagged': bool(item.get('flagged', False)),
        # Set when an admin dismisses reports (double-approves the job). Locks the
        # job from being reported again — stops the report/dismiss ping-pong.
        'report_locked': bool(item.get('report_locked', False)),
        'admin_applied': bool(item.get('admin_applied', False)),
        'admin_applied_at': str(item.get('admin_applied_at', '')).strip(),
        'admin_applied_by_user_id': str(item.get('admin_applied_by_user_id', '')).strip(),
        'admin_applied_by_username': str(item.get('admin_applied_by_username', '')).strip(),
        'sync_remote_id': str(item.get('sync_remote_id', '')).strip(),
        'sync_locked': bool(item.get('sync_locked', False)),
    }


def _normalize_job_reports(items: Any) -> list[dict]:
    normalized: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        reason = str(item.get('reason', '')).strip()
        if not reason:
            continue
        normalized.append({
            'reason': reason,
            'reported_by_user_id': str(item.get('reported_by_user_id', '')).strip(),
            'reported_by_username': str(item.get('reported_by_username', '')).strip(),
            'reported_at': str(item.get('reported_at', '')).strip(),
            'source': str(item.get('source', 'user') or 'user').strip(),
        })
    return normalized


def _normalize_generated_resume(item: dict) -> dict:
    resume = item.get('resume', {}) if isinstance(item.get('resume', {}), dict) else {}
    normalized_groups: list[dict] = []
    raw_groups = resume.get('skill_groups')
    if isinstance(raw_groups, list):
        for group in raw_groups:
            if not isinstance(group, dict):
                continue
            category = str(group.get('category', '')).strip() or 'Other Relevant'
            items_clean = [str(v).strip() for v in group.get('items', []) or [] if str(v).strip()]
            if items_clean:
                normalized_groups.append({'category': category, 'items': items_clean})
    elif isinstance(raw_groups, dict):
        for key, values in raw_groups.items():
            items_clean = [str(v).strip() for v in values or [] if str(v).strip()]
            if items_clean:
                normalized_groups.append({'category': str(key).strip() or 'Other Relevant', 'items': items_clean})
    if not normalized_groups:
        legacy_grouped = resume.get('grouped_skills')
        if isinstance(legacy_grouped, dict):
            for key, values in legacy_grouped.items():
                items_clean = [str(v).strip() for v in values or [] if str(v).strip()]
                if items_clean:
                    normalized_groups.append({'category': str(key).strip() or 'Other Relevant', 'items': items_clean})
    normalized_resume = {
        'name': str(resume.get('name', '')).strip(),
        'headline': str(resume.get('headline', '')).strip(),
        'summary': str(resume.get('summary', '')).strip(),
        'fit_keywords': [str(v).strip() for v in resume.get('fit_keywords', []) if str(v).strip()],
        'technical_skills': [str(v).strip() for v in resume.get('technical_skills', []) if str(v).strip()],
        'skill_groups': normalized_groups,
        'bold_keywords': [str(v).strip() for v in resume.get('bold_keywords', []) if str(v).strip()],
        'auto_bold_fit_keywords': bool(resume.get('auto_bold_fit_keywords', False)),
        'work_history': [
            {
                'company_name': str(work.get('company_name', '')).strip(),
                'duration': str(work.get('duration', '')).strip(),
                'location': str(work.get('location', '')).strip(),
                'role_title': str(work.get('role_title', work.get('role', ''))).strip(),
                'role_headline': str(work.get('role_headline', '')).strip(),
                'bullets': [str(v).strip() for v in work.get('bullets', []) if str(v).strip()],
            }
            for work in resume.get('work_history', []) or []
        ],
        'education_history': [
            {
                'university': str(edu.get('university', '')).strip(),
                'degree': str(edu.get('degree', '')).strip(),
                'duration': str(edu.get('duration', '')).strip(),
                'location': str(edu.get('location', '')).strip(),
            }
            for edu in resume.get('education_history', []) or []
        ],
    }
    interview_schedule = item.get('interview_schedule', {}) if isinstance(item.get('interview_schedule', {}), dict) else {}
    created_at = str(item.get('created_at', '')).strip()
    created_date = str(item.get('created_date', '')).strip() or (created_at[:10] if len(created_at) >= 10 else '')
    return {
        'saved_resume_id': str(item.get('saved_resume_id', '')).strip() or f'resume_{uuid.uuid4().hex[:10]}',
        'created_at': created_at,
        'created_date': created_date,
        'created_by_user_id': str(item.get('created_by_user_id', '')).strip(),
        'created_by_username': str(item.get('created_by_username', '')).strip(),
        'profile_id': str(item.get('profile_id', '')).strip(),
        'template_id': str(item.get('template_id', '')).strip(),
        'job_id': str(item.get('job_id', '')).strip(),
        'job_company': str(item.get('job_company', '')).strip(),
        'job_title': str(item.get('job_title', item.get('target_role', ''))).strip(),
        'job_link': str(item.get('job_link', '')).strip(),
        'job_description': str(item.get('job_description', '')).strip(),
        'job_region': _normalize_market_region(item.get('job_region', item.get('region', ''))),
        'target_role': str(item.get('target_role', item.get('job_title', ''))).strip(),
        'resume': normalized_resume,
        'answers': [
            {
                'question': str(a.get('question', '')).strip(),
                'answer': str(a.get('answer', '')).strip(),
                'note': str(a.get('note', '')).strip(),
            }
            for a in (item.get('answers', []) or []) if isinstance(a, dict)
        ],
        'application_answers': [
            {
                'question': str(a.get('question', '')).strip(),
                'answer': str(a.get('answer', '')).strip(),
            }
            for a in (item.get('application_answers', []) or []) if isinstance(a, dict)
        ],
        'status': str(item.get('status', 'generated') or 'generated').strip(),
        'applied_status': str(item.get('applied_status', 'pending') or 'pending').strip(),
        'applied_at': str(item.get('applied_at', '')).strip(),
        'applied_by_user_id': str(item.get('applied_by_user_id', '')).strip(),
        'applied_by_username': str(item.get('applied_by_username', '')).strip(),
        'ats_score': int(item.get('ats_score', 0) or 0),
        'download_filename': str(item.get('download_filename', '')).strip() or 'resume.pdf',
        'download_mode': str(item.get('download_mode', 'browser') or 'browser').strip(),
        'saved_pdf_path': str(item.get('saved_pdf_path', '')).strip(),
        'company_message': str(item.get('company_message', '')).strip(),
        'company_message_status': str(item.get('company_message_status', 'pending') or 'pending').strip(),
        'company_message_updated_at': str(item.get('company_message_updated_at', '')).strip(),
        'interview_schedule': {
            'interviewer_name': str(interview_schedule.get('interviewer_name', '')).strip(),
            'interview_time': str(interview_schedule.get('interview_time', '')).strip(),
            'meeting_link': str(interview_schedule.get('meeting_link', '')).strip(),
            'note': str(interview_schedule.get('note', '')).strip(),
            'submitted_at': str(interview_schedule.get('submitted_at', '')).strip(),
            'review_status': str(interview_schedule.get('review_status', 'not_submitted') or 'not_submitted').strip(),
            'reviewed_at': str(interview_schedule.get('reviewed_at', '')).strip(),
            'reviewed_by_user_id': str(interview_schedule.get('reviewed_by_user_id', '')).strip(),
            'reviewed_by_username': str(interview_schedule.get('reviewed_by_username', '')).strip(),
            'review_note': str(interview_schedule.get('review_note', '')).strip(),
        },
    }


def _normalize_settings(item: Any) -> dict:
    defaults = _default_settings()
    source = item if isinstance(item, dict) else {}
    merged = defaults | source
    raw_template = str(merged.get('prompt_template', '') or '').strip()
    merged['prompt_template'] = raw_template or DEFAULT_PROMPT_TEMPLATE
    merged['download_output_dir'] = str(merged.get('download_output_dir', 'saved_resumes')).strip() or 'saved_resumes'
    # Strip legacy OpenAI fields
    for k in ('default_prompt', 'openai_model', 'always_clean_generation'):
        merged.pop(k, None)
    raw_prompts = merged.get('saved_prompts', [])
    normalized_prompts = []
    for p in raw_prompts if isinstance(raw_prompts, list) else []:
        if not isinstance(p, dict):
            continue
        name = str(p.get('name', '')).strip()
        text = str(p.get('text', '')).strip()
        if name:
            normalized_prompts.append({
                'id': str(p.get('id') or f'prompt_{uuid.uuid4().hex[:10]}'),
                'name': name,
                'text': text,
            })
    merged['saved_prompts'] = normalized_prompts
    merged['blacklist_domains'] = _normalize_blacklist(merged.get('blacklist_domains'))
    merged['blacklist_titles'] = _normalize_keyword_list(merged.get('blacklist_titles'))
    merged['blacklist_companies'] = _normalize_keyword_list(merged.get('blacklist_companies'))
    try:
        dh = int(merged.get('job_deadline_hours') or 12)
    except (TypeError, ValueError):
        dh = 12
    merged['job_deadline_hours'] = min(max(dh, 1), 168)  # clamp 1h–7d
    merged['notifications'] = _normalize_notifications(merged.get('notifications'))
    return merged


def _normalize_openai_call(entry: dict) -> dict:
    usage = entry.get('usage', {}) if isinstance(entry.get('usage', {}), dict) else {}
    cost = entry.get('cost', {}) if isinstance(entry.get('cost', {}), dict) else {}
    return {
        'user_id': str(entry.get('user_id', '')).strip(),
        'kind': str(entry.get('kind', '')).strip(),
        'recorded_at': str(entry.get('recorded_at', '')).strip(),
        'flow_id': str(entry.get('flow_id', '')).strip(),
        'call_kind': str(entry.get('call_kind', '')).strip(),
        'status': str(entry.get('status', '')).strip() or 'success',
        'attempt': int(entry.get('attempt', 0) or 0),
        'model': str(entry.get('model', '')).strip(),
        'schema_name': str(entry.get('schema_name', '')).strip(),
        'response_id': str(entry.get('response_id', '')).strip(),
        'duration_ms': int(entry.get('duration_ms', 0) or 0),
        'developer_message_chars': int(entry.get('developer_message_chars', 0) or 0),
        'input_estimated_tokens_local': int(entry.get('input_estimated_tokens_local', 0) or 0),
        'output_text_chars': int(entry.get('output_text_chars', 0) or 0),
        'output_estimated_tokens_local': int(entry.get('output_estimated_tokens_local', 0) or 0),
        'output_text': str(entry.get('output_text', '') or ''),
        'output_text_truncated': bool(entry.get('output_text_truncated', False)),
        'output_pretty': str(entry.get('output_pretty', '') or ''),
        'output_pretty_truncated': bool(entry.get('output_pretty_truncated', False)),
        'usage': {
            'input_tokens': int(usage.get('input_tokens', 0) or 0),
            'output_tokens': int(usage.get('output_tokens', 0) or 0),
            'total_tokens': int(usage.get('total_tokens', 0) or 0),
            'cached_input_tokens': int(usage.get('cached_input_tokens', 0) or 0),
            'reasoning_output_tokens': int(usage.get('reasoning_output_tokens', 0) or 0),
            'billable_input_tokens': int(usage.get('billable_input_tokens', 0) or 0),
        },
        'cost': {
            'input_cost_usd': cost.get('input_cost_usd'),
            'cached_input_cost_usd': cost.get('cached_input_cost_usd'),
            'output_cost_usd': cost.get('output_cost_usd'),
            'reasoning_output_cost_usd': cost.get('reasoning_output_cost_usd'),
            'total_cost_usd': cost.get('total_cost_usd'),
            'pricing_source': cost.get('pricing_source', {}) if isinstance(cost.get('pricing_source', {}), dict) else {},
        },
        'payload_summary': entry.get('payload_summary', {}) if isinstance(entry.get('payload_summary', {}), dict) else {},
        'error': str(entry.get('error', '')).strip(),
        'post_validation': entry.get('post_validation', {}) if isinstance(entry.get('post_validation', {}), dict) else {},
    }


# ---------- Storage ----------

class Storage:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / 'app.db'
        self._lock = threading.RLock()
        self._bootstrap()

    # ---- bootstrap ----

    def _bootstrap(self) -> None:
        with session_scope(self.db_path) as session:
            if _migration.db_is_empty(session) and _migration.has_legacy_data(self.data_dir):
                _migration.migrate(
                    session,
                    self.data_dir,
                    normalize_profile=_normalize_profile,
                    normalize_job=_normalize_job,
                    normalize_user=_normalize_user,
                    normalize_template=_normalize_template,
                    normalize_generated=_normalize_generated_resume,
                    normalize_settings=_normalize_settings,
                    job_compare_key=_job_compare_key,
                    normalize_url=normalize_job_url,
                )
            self._purge_disabled_users(session)
            self._ensure_default_templates(session)
            self._ensure_default_settings(session)
            self._ensure_default_admin(session)

    @staticmethod
    def _purge_disabled_users(session: Session) -> None:
        for row in session.scalars(select(UserRow).where(UserRow.status == 'disabled')).all():
            session.delete(row)

    @staticmethod
    def _ensure_default_templates(session: Session) -> None:
        if session.scalar(select(TemplateRow).limit(1)) is not None:
            return
        for index, raw in enumerate(_default_templates()):
            payload = _normalize_template(raw, fallback_index=index)
            session.merge(TemplateRow(id=payload['id'], name=payload['name'], data=payload))

    @staticmethod
    def _ensure_default_settings(session: Session) -> None:
        existing = session.get(SettingsRow, 'app')
        if existing is None:
            session.merge(SettingsRow(key='app', data=_normalize_settings({})))

    @staticmethod
    def _ensure_default_admin(session: Session) -> None:
        admin_exists = session.scalar(
            select(UserRow.id).where(UserRow.is_admin.is_(True), UserRow.status == 'approved').limit(1)
        )
        if admin_exists is not None:
            return
        admin = _normalize_user(_default_admin_user())
        session.merge(UserRow(
            id=admin['id'],
            username=admin['username'],
            email=admin['email'],
            status=admin['status'],
            is_admin=True,
            data=admin,
        ))

    @staticmethod
    def make_id(prefix: str) -> str:
        return f'{prefix}_{uuid.uuid4().hex[:10]}'

    # ---- profiles ----

    def get_profiles(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            rows = session.scalars(
                select(ProfileRow).where(ProfileRow.deleted_at.is_(None)).order_by(ProfileRow.name)
            ).all()
            return [self._profile_row_to_dict(row) for row in rows]

    def get_profile_by_id(self, profile_id: str) -> dict | None:
        pid = str(profile_id or '').strip()
        if not pid:
            return None
        with session_scope(self.db_path) as session:
            row = session.get(ProfileRow, pid)
            if row is None or row.deleted_at is not None:
                return None
            return self._profile_row_to_dict(row)

    def upsert_profile(self, payload: dict) -> None:
        normalized = _normalize_profile(payload)
        if not normalized.get('id'):
            normalized['id'] = self.make_id('profile')
        with session_scope(self.db_path) as session:
            existing = session.get(ProfileRow, normalized['id'])
            # Preserve original creator on update
            if existing is not None:
                if existing.created_by_user_id and not normalized.get('created_by_user_id'):
                    normalized['created_by_user_id'] = existing.created_by_user_id
                if existing.created_by_username and not normalized.get('created_by_username'):
                    normalized['created_by_username'] = existing.created_by_username
            session.merge(ProfileRow(
                id=normalized['id'],
                name=normalized.get('name', ''),
                email=normalized.get('email', ''),
                region=normalized['region'],
                active=bool(normalized.get('active', True)),
                deleted_at=None,
                created_by_user_id=normalized.get('created_by_user_id', ''),
                created_by_username=normalized.get('created_by_username', ''),
                data=normalized,
            ))

    def delete_profile(self, profile_id: str) -> None:
        pid = str(profile_id or '').strip()
        if not pid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(ProfileRow, pid)
            if row is not None:
                session.delete(row)

    @staticmethod
    def _profile_row_to_dict(row: ProfileRow) -> dict:
        data = dict(row.data or {})
        data['id'] = row.id
        data['active'] = bool(row.active)
        # Columns are the source of truth; let them win over JSON if they diverge
        if row.name:
            data['name'] = row.name
        if row.email:
            data['email'] = row.email
        if row.created_by_user_id:
            data['created_by_user_id'] = row.created_by_user_id
        if row.created_by_username:
            data['created_by_username'] = row.created_by_username
        return _normalize_profile(data)

    # ---- templates ----

    def get_templates(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            rows = session.scalars(select(TemplateRow).order_by(TemplateRow.id)).all()
            return [_normalize_template(dict(row.data or {}) | {'id': row.id, 'name': row.name}, fallback_index=i)
                    for i, row in enumerate(rows)]

    def get_template_by_id(self, template_id: str) -> dict | None:
        tid = str(template_id or '').strip()
        if not tid:
            return None
        with session_scope(self.db_path) as session:
            row = session.get(TemplateRow, tid)
            if row is None:
                return None
            return _normalize_template(dict(row.data or {}) | {'id': row.id, 'name': row.name})

    def upsert_template(self, payload: dict) -> None:
        normalized = _normalize_template(payload)
        with session_scope(self.db_path) as session:
            session.merge(TemplateRow(id=normalized['id'], name=normalized['name'], data=normalized))

    def delete_template(self, template_id: str) -> None:
        tid = str(template_id or '').strip()
        if not tid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(TemplateRow, tid)
            if row is not None:
                session.delete(row)
            for prof in session.scalars(select(ProfileRow)).all():
                data = dict(prof.data or {})
                if str(data.get('default_template_id', '')).strip() == tid:
                    data['default_template_id'] = ''
                    prof.data = data

    # ---- generated resumes ----

    def get_generated_resumes(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            rows = session.scalars(select(GeneratedResumeRow).order_by(GeneratedResumeRow.created_at_ts)).all()
            return [_normalize_generated_resume(dict(row.data or {})) for row in rows]

    def save_generated_resume(self, payload: dict) -> None:
        normalized = _normalize_generated_resume(payload)
        with session_scope(self.db_path) as session:
            session.merge(GeneratedResumeRow(
                id=normalized['saved_resume_id'],
                profile_id=normalized['profile_id'],
                job_id=normalized['job_id'],
                job_company=normalized.get('job_company', ''),
                job_title=normalized.get('job_title', ''),
                created_by_user_id=normalized['created_by_user_id'],
                created_by_username=normalized.get('created_by_username', ''),
                created_at_ts=_parse_iso_datetime(normalized['created_at']),
                data=normalized,
            ))

    def get_generated_resume_by_id(self, saved_resume_id: str) -> dict | None:
        sid = str(saved_resume_id or '').strip()
        if not sid:
            return None
        with session_scope(self.db_path) as session:
            row = session.get(GeneratedResumeRow, sid)
            return _normalize_generated_resume(dict(row.data or {})) if row else None

    def update_generated_resume(self, saved_resume_id: str, patch: dict) -> None:
        sid = str(saved_resume_id or '').strip()
        if not sid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(GeneratedResumeRow, sid)
            if row is None:
                return
            normalized = _normalize_generated_resume(dict(row.data or {}) | (patch or {}))
            row.data = normalized
            row.profile_id = normalized['profile_id']
            row.job_id = normalized['job_id']
            row.job_company = normalized.get('job_company', '')
            row.job_title = normalized.get('job_title', '')
            row.created_by_user_id = normalized['created_by_user_id']
            row.created_by_username = normalized.get('created_by_username', '')
            row.created_at_ts = _parse_iso_datetime(normalized['created_at'])

    def delete_generated_resume(self, saved_resume_id: str) -> int:
        """Delete a single generated_resume row by id. Returns rows deleted."""
        sid = str(saved_resume_id or '').strip()
        if not sid:
            return 0
        with session_scope(self.db_path) as session:
            row = session.get(GeneratedResumeRow, sid)
            if row is None:
                return 0
            session.delete(row)
            return 1

    def delete_generated_resumes_for(self, profile_id: str, job_ids: list[str]) -> int:
        """Delete all generated_resume rows matching (profile_id, job_id) — used by 'reset'."""
        pid = str(profile_id or '').strip()
        wanted = {str(j or '').strip() for j in job_ids if str(j or '').strip()}
        if not pid or not wanted:
            return 0
        deleted = 0
        with session_scope(self.db_path) as session:
            rows = session.scalars(
                select(GeneratedResumeRow).where(
                    GeneratedResumeRow.profile_id == pid,
                    GeneratedResumeRow.job_id.in_(wanted),
                )
            ).all()
            for row in rows:
                session.delete(row)
                deleted += 1
        return deleted

    # ---- settings ----

    def get_app_settings(self) -> dict:
        with session_scope(self.db_path) as session:
            row = session.get(SettingsRow, 'app')
            return _normalize_settings(dict(row.data or {}) if row else {})

    def save_app_settings(self, payload: dict) -> None:
        normalized = _normalize_settings(payload)
        with session_scope(self.db_path) as session:
            session.merge(SettingsRow(key='app', data=normalized))

    # ---- teams (caller teams) ----

    def get_teams(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            rows = session.query(TeamRow).order_by(TeamRow.name).all()
            return [{'id': r.id, 'name': r.name} for r in rows]

    def get_team(self, team_id: str) -> dict | None:
        tid = str(team_id or '').strip()
        if not tid:
            return None
        with session_scope(self.db_path) as session:
            r = session.get(TeamRow, tid)
            return {'id': r.id, 'name': r.name} if r else None

    def upsert_team(self, payload: dict) -> dict:
        tid = str((payload or {}).get('id') or '').strip() or f'team_{uuid.uuid4().hex[:10]}'
        name = str((payload or {}).get('name', '')).strip()
        if not name:
            raise ValueError('Team name is required')
        with session_scope(self.db_path) as session:
            row = session.get(TeamRow, tid)
            if row is None:
                session.add(TeamRow(id=tid, name=name))
            else:
                row.name = name
        return {'id': tid, 'name': name}

    def delete_team(self, team_id: str) -> None:
        """Remove the team and un-group everyone who was in it (members are never deleted)."""
        tid = str(team_id or '').strip()
        if not tid:
            return
        with session_scope(self.db_path) as session:
            for row in session.query(UserRow).all():
                data = dict(row.data or {})
                if str(data.get('team_id', '')).strip() == tid:
                    data['team_id'] = ''
                    row.data = data
            row = session.get(TeamRow, tid)
            if row is not None:
                session.delete(row)

    # ---- users ----

    def get_users(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            rows = session.scalars(select(UserRow).order_by(UserRow.username)).all()
            return [_normalize_user(dict(row.data or {})) for row in rows]

    def get_user_by_id(self, user_id: str) -> dict | None:
        uid = str(user_id or '').strip()
        if not uid:
            return None
        with session_scope(self.db_path) as session:
            row = session.get(UserRow, uid)
            return _normalize_user(dict(row.data or {})) if row else None

    def get_user_by_username(self, username: str) -> dict | None:
        needle = str(username or '').strip().lower()
        if not needle:
            return None
        with session_scope(self.db_path) as session:
            row = session.scalar(select(UserRow).where(UserRow.username == needle))
            return _normalize_user(dict(row.data or {})) if row else None

    def upsert_user(self, payload: dict) -> None:
        normalized = _normalize_user(payload)
        if not normalized.get('username'):
            return
        with session_scope(self.db_path) as session:
            existing = session.get(UserRow, normalized['id'])
            # parent_admin_id is immutable once set
            if existing is not None and existing.parent_admin_id and not normalized.get('parent_admin_id'):
                normalized['parent_admin_id'] = existing.parent_admin_id
            session.merge(UserRow(
                id=normalized['id'],
                username=normalized['username'],
                full_name=normalized['full_name'],
                email=normalized['email'],
                status=normalized['status'],
                is_admin=normalized['is_admin'],
                parent_admin_id=normalized.get('parent_admin_id', ''),
                data=normalized,
            ))

    def update_user(self, user_id: str, patch: dict) -> None:
        uid = str(user_id or '').strip()
        if not uid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(UserRow, uid)
            if row is None:
                return
            merged = dict(row.data or {}) | (patch or {})
            # parent_admin_id is immutable once set
            if row.parent_admin_id and not str(merged.get('parent_admin_id', '')).strip():
                merged['parent_admin_id'] = row.parent_admin_id
            normalized = _normalize_user(merged)
            row.data = normalized
            row.full_name = normalized['full_name']
            row.email = normalized['email']
            row.status = normalized['status']
            row.is_admin = normalized['is_admin']
            row.parent_admin_id = normalized.get('parent_admin_id', '')

    def delete_user(self, user_id: str) -> None:
        uid = str(user_id or '').strip()
        if not uid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(UserRow, uid)
            if row is not None:
                session.delete(row)

    # ---- auth tokens ----

    def issue_auth_token(self, user_id: str, ttl_days: int = 30) -> str:
        raw_token = secrets.token_urlsafe(32)
        now = datetime.utcnow()
        token_record = {
            'token_id': self.make_id('tok'),
            'token_hash': _hash_auth_token(raw_token),
            'created_at': now.isoformat() + 'Z',
            'expires_at': (now + timedelta(days=max(1, int(ttl_days or 30)))).isoformat() + 'Z',
            'last_seen_at': now.isoformat() + 'Z',
            'revoked_at': '',
        }
        with session_scope(self.db_path) as session:
            row = session.get(UserRow, str(user_id or '').strip())
            if row is None:
                return raw_token
            data = dict(row.data or {})
            tokens = _normalize_auth_tokens(data.get('auth_tokens', []) or [])
            tokens.insert(0, token_record)
            data['auth_tokens'] = tokens[:10]
            row.data = _normalize_user(data)
        return raw_token

    def get_user_by_auth_token(self, raw_token: str) -> dict | None:
        token_hash = _hash_auth_token(raw_token)
        now = datetime.utcnow()
        matched_user_id: str | None = None
        with session_scope(self.db_path) as session:
            for row in session.scalars(select(UserRow)).all():
                data = dict(row.data or {})
                tokens = data.get('auth_tokens', []) or []
                refreshed: list[dict] = []
                changed = False
                for token in tokens:
                    expires_at = _parse_iso_datetime(token.get('expires_at', ''))
                    revoked_at = _parse_iso_datetime(token.get('revoked_at', ''))
                    if revoked_at or (expires_at and expires_at < now):
                        changed = True
                        continue
                    if token.get('token_hash') == token_hash:
                        token = token | {'last_seen_at': now.isoformat() + 'Z'}
                        matched_user_id = row.id
                        changed = True
                    refreshed.append(token)
                if changed:
                    data['auth_tokens'] = refreshed
                    row.data = _normalize_user(data)
        if matched_user_id:
            return self.get_user_by_id(matched_user_id)
        return None

    def revoke_auth_token(self, raw_token: str) -> None:
        token_hash = _hash_auth_token(raw_token)
        with session_scope(self.db_path) as session:
            for row in session.scalars(select(UserRow)).all():
                data = dict(row.data or {})
                tokens = data.get('auth_tokens', []) or []
                refreshed = []
                changed = False
                for token in tokens:
                    if token.get('token_hash') == token_hash and not str(token.get('revoked_at', '')).strip():
                        token = token | {'revoked_at': datetime.utcnow().isoformat() + 'Z'}
                        changed = True
                    refreshed.append(token)
                if changed:
                    data['auth_tokens'] = refreshed
                    row.data = _normalize_user(data)

    def revoke_all_auth_tokens_for_user(self, user_id: str) -> None:
        uid = str(user_id or '').strip()
        if not uid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(UserRow, uid)
            if row is None:
                return
            data = dict(row.data or {})
            tokens = data.get('auth_tokens', []) or []
            now_iso = datetime.utcnow().isoformat() + 'Z'
            refreshed = []
            for token in tokens:
                if not str(token.get('revoked_at', '')).strip():
                    token = token | {'revoked_at': now_iso}
                refreshed.append(token)
            data['auth_tokens'] = refreshed
            row.data = _normalize_user(data)

    # ---- jobs ----

    def get_jobs(self, include_pending: bool = True) -> list[dict]:
        with session_scope(self.db_path) as session:
            stmt = select(JobRow)
            if not include_pending:
                stmt = stmt.where(JobRow.status == 'approved')
            rows = session.scalars(stmt.order_by(JobRow.submitted_at)).all()
            return [_normalize_job(dict(row.data or {})) for row in rows]

    def get_job_by_id(self, job_id: str) -> dict | None:
        jid = str(job_id or '').strip()
        if not jid:
            return None
        with session_scope(self.db_path) as session:
            row = session.get(JobRow, jid)
            return _normalize_job(dict(row.data or {})) if row else None

    def is_link_blacklisted(self, link: str) -> bool:
        """True if the URL's root domain is in the admin-configured blacklist."""
        d = _root_domain(link)
        if not d:
            return False
        return d in set(self.get_app_settings().get('blacklist_domains') or [])

    def is_title_blacklisted(self, title: str) -> bool:
        """True if the job title contains any blacklisted keyword (substring,
        case-insensitive)."""
        t = str(title or '').lower()
        if not t:
            return False
        return any(kw in t for kw in (self.get_app_settings().get('blacklist_titles') or []))

    def is_company_blacklisted(self, company: str) -> bool:
        """True if the company name exactly matches a blacklisted company
        (case-insensitive)."""
        c = str(company or '').strip().lower()
        if not c:
            return False
        return c in set(self.get_app_settings().get('blacklist_companies') or [])

    def job_block_reason(self, payload: dict) -> str | None:
        """Return a human-readable reason if this job should be blocked from
        ingestion, else None. Checks domain, title, and company blacklists in
        one settings read."""
        settings = self.get_app_settings()
        domains = set(settings.get('blacklist_domains') or [])
        titles = settings.get('blacklist_titles') or []
        companies = set(settings.get('blacklist_companies') or [])

        link = str(payload.get('link') or '')
        d = _root_domain(link)
        if d and d in domains:
            return f"domain '{d}' is blacklisted"

        title_l = str(payload.get('job_title') or '').lower()
        for kw in titles:
            if kw in title_l:
                return f"title contains blacklisted keyword '{kw}'"

        company_l = str(payload.get('company') or '').strip().lower()
        if company_l and company_l in companies:
            return f"company '{payload.get('company')}' is blacklisted"

        return None

    def upsert_job(self, payload: dict) -> bool:
        """Insert/update a job. Returns False if blocked by any blacklist
        (domain, title, or company)."""
        normalized = _normalize_job(payload)
        if self.job_block_reason(normalized) is not None:
            return False
        with session_scope(self.db_path) as session:
            self._write_job_row(session, normalized)
        return True

    def update_job(self, job_id: str, patch: dict) -> None:
        jid = str(job_id or '').strip()
        if not jid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(JobRow, jid)
            if row is None:
                return
            normalized = _normalize_job(dict(row.data or {}) | (patch or {}))
            self._write_job_row(session, normalized, existing=row)

    def delete_job(self, job_id: str) -> None:
        jid = str(job_id or '').strip()
        if not jid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(JobRow, jid)
            if row is not None:
                session.delete(row)

    def bulk_upsert_jobs(self, payloads: list[dict]) -> int:
        count = 0
        with session_scope(self.db_path) as session:
            for raw in payloads or []:
                normalized = _normalize_job(raw)
                if not normalized.get('id'):
                    continue
                if self.job_block_reason(normalized) is not None:
                    continue
                self._write_job_row(session, normalized)
                count += 1
        return count

    def query_jobs(
        self,
        *,
        status: str = '',
        region: str = '',
        company: str = '',
        q: str = '',
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        reported: bool = False,
        created_by: str = '',
        page: int = 1,
        page_size: int = 20,
    ) -> dict:
        """Server-side filtered + paginated job listing.

        Returns {jobs: [...light dicts...], total, page, page_size,
        counts: {status -> n}} where counts respect every filter EXCEPT
        status (so the status pills can show switch targets). `jobs` omits the
        heavy `description`/`note` fields — fetch a single job for those.
        """
        from sqlalchemy import func, or_

        def _base_conditions(include_status: bool):
            conds = []
            if include_status and status:
                conds.append(JobRow.status == status)
            if reported:
                # Reported jobs are flagged=True in the JSON data column.
                conds.append(JobRow.data['flagged'].as_boolean() == True)  # noqa: E712
            if created_by:
                # Restrict to jobs this user uploaded (job_adder scoping).
                conds.append(JobRow.created_by_user_id == created_by)
            if region and region.upper() not in ('', 'ALL', 'ANY'):
                conds.append(JobRow.region == region.upper())
            if company:
                conds.append(func.lower(JobRow.company) == company.strip().lower())
            if q:
                like = f"%{q.strip().lower()}%"
                conds.append(or_(
                    func.lower(JobRow.company).like(like),
                    func.lower(JobRow.job_title).like(like),
                ))
            if date_from is not None:
                conds.append(JobRow.submitted_at >= date_from)
            if date_to is not None:
                conds.append(JobRow.submitted_at < date_to)
            return conds

        page = max(1, int(page or 1))
        page_size = max(1, min(int(page_size or 20), 200))

        with session_scope(self.db_path) as session:
            # Page of rows (status-filtered), newest first.
            stmt = select(JobRow)
            for c in _base_conditions(include_status=True):
                stmt = stmt.where(c)
            stmt = stmt.order_by(JobRow.submitted_at.desc().nullslast())
            total = session.scalar(
                select(func.count()).select_from(stmt.subquery())
            ) or 0
            rows = session.scalars(
                stmt.offset((page - 1) * page_size).limit(page_size)
            ).all()

            # Status counts across the same filters EXCEPT status.
            count_stmt = select(JobRow.status, func.count()).group_by(JobRow.status)
            for c in _base_conditions(include_status=False):
                count_stmt = count_stmt.where(c)
            counts = {'approved': 0, 'pending': 0, 'rejected': 0, 'deleted': 0}
            for st, n in session.execute(count_stmt).all():
                counts[str(st)] = int(n)
            counts['total'] = sum(counts.get(k, 0) for k in ('approved', 'pending', 'rejected', 'deleted'))

            jobs = []
            for row in rows:
                d = _normalize_job(dict(row.data or {}))
                reports = d.get('reports', []) or []
                jobs.append({
                    'id': d.get('id'),
                    'company': d.get('company', ''),
                    'job_title': d.get('job_title', ''),
                    'link': d.get('link', ''),
                    'region': d.get('region', 'ANY'),
                    'status': d.get('status', 'approved'),
                    'submitted_at': d.get('submitted_at', ''),
                    'approved_at': d.get('approved_at', ''),
                    'flagged': bool(d.get('flagged', False)),
                    'report_locked': bool(d.get('report_locked', False)),
                    'reports': reports,
                    'reports_count': len(reports),
                    # Who added it ('' for jobs pulled by the sync poller).
                    'source': d.get('source', ''),
                    'created_by_user_id': d.get('created_by_user_id', ''),
                    'created_by_username': d.get('created_by_username', ''),
                })

        return {
            'jobs': jobs,
            'total': int(total),
            'page': page,
            'page_size': page_size,
            'counts': counts,
        }

    def export_recent_jobs(
        self,
        *,
        limit: int = 100,
        since: datetime | None = None,
        status: str = 'approved',
        region: str = '',
    ) -> list[dict]:
        """Recent jobs for the external read-only feed (machine-to-machine).

        Newest-first by submitted_at, capped at `limit` (1..1000). Returns FULL
        normalized job dicts (incl. description); the caller projects whichever
        public subset it wants. `status=''` means any status. `since` is a naive
        UTC datetime — only jobs submitted at/after it are returned.
        """
        limit = max(1, min(int(limit or 100), 1000))
        with session_scope(self.db_path) as session:
            stmt = select(JobRow)
            if status:
                stmt = stmt.where(JobRow.status == status)
            if region and region.upper() not in ('', 'ALL', 'ANY'):
                stmt = stmt.where(JobRow.region == region.upper())
            if since is not None:
                stmt = stmt.where(JobRow.submitted_at >= since)
            stmt = stmt.order_by(JobRow.submitted_at.desc().nullslast()).limit(limit)
            rows = session.scalars(stmt).all()
            return [_normalize_job(dict(row.data or {})) for row in rows]

    def bulk_update_jobs(self, patches_by_id: dict[str, dict]) -> int:
        if not patches_by_id:
            return 0
        count = 0
        with session_scope(self.db_path) as session:
            for jid, patch in patches_by_id.items():
                row = session.get(JobRow, str(jid).strip())
                if row is None:
                    continue
                normalized = _normalize_job(dict(row.data or {}) | (patch or {}))
                self._write_job_row(session, normalized, existing=row)
                count += 1
        return count

    def find_duplicate_job(self, company: str, job_title: str, exclude_job_id: str = '') -> dict | None:
        company_key = _job_compare_key(company)
        title_key = _job_compare_key(job_title)
        if not company_key or not title_key:
            return None
        with session_scope(self.db_path) as session:
            stmt = select(JobRow).where(JobRow.company_key == company_key, JobRow.title_key == title_key)
            if exclude_job_id:
                stmt = stmt.where(JobRow.id != str(exclude_job_id).strip())
            row = session.scalar(stmt.limit(1))
            return _normalize_job(dict(row.data or {})) if row else None

    def find_recent_company_job(
        self, company: str, region: str, within_days: int = COMPANY_DEDUP_DAYS, exclude_job_id: str = '',
    ) -> dict | None:
        """Most recent ACTIVE (approved/pending) job for the same company + region
        added within `within_days` (default one month). Used to enforce one job
        per company per region per month. Rejected/deleted jobs don't hold the slot.

        Company matching uses `_company_fold_key`, which folds visually-confusable
        characters (e.g. 'Jorie AI' == 'Jorie Al'). The region + status + recency
        filters narrow the candidate set in SQL; the fold compare runs in Python
        over that small set, so no stored key/index changes are needed."""
        fold = _company_fold_key(company)
        if not fold:
            return None
        region_key = _normalize_market_region(region)
        cutoff = datetime.utcnow() - timedelta(days=max(1, int(within_days or COMPANY_DEDUP_DAYS)))
        with session_scope(self.db_path) as session:
            # Scan only id+company (not the heavy data JSON) for the fold compare.
            stmt = (
                select(JobRow.id, JobRow.company)
                .where(
                    JobRow.region == region_key,
                    JobRow.status.in_(('approved', 'pending')),
                    JobRow.submitted_at.is_not(None),
                    JobRow.submitted_at >= cutoff,
                )
                .order_by(JobRow.submitted_at.desc())
            )
            if exclude_job_id:
                stmt = stmt.where(JobRow.id != str(exclude_job_id).strip())
            # Newest-first; take the first whose folded company name matches.
            match_id = next(
                (jid for jid, comp in session.execute(stmt)
                 if _company_fold_key(comp or '') == fold),
                None,
            )
            if not match_id:
                return None
            row = session.get(JobRow, match_id)
            return _normalize_job(dict(row.data or {})) if row else None

    def find_job_by_url(self, url: str, exclude_job_id: str = '') -> dict | None:
        normalized = normalize_job_url(url)
        if not normalized:
            return None
        with session_scope(self.db_path) as session:
            stmt = select(JobRow).where(JobRow.normalized_url == normalized)
            if exclude_job_id:
                stmt = stmt.where(JobRow.id != str(exclude_job_id).strip())
            row = session.scalar(stmt.limit(1))
            return _normalize_job(dict(row.data or {})) if row else None

    def claim_next_pending_job_for_scrape(self) -> dict | None:
        with session_scope(self.db_path) as session:
            row = session.scalar(
                select(JobRow).where(JobRow.scrape_status == 'queued').order_by(JobRow.submitted_at).limit(1)
            )
            if row is None:
                return None
            data = dict(row.data or {})
            if not str(data.get('link', '')).strip():
                return None
            data['scrape_status'] = 'processing'
            data['scrape_started_at'] = datetime.utcnow().isoformat() + 'Z'
            normalized = _normalize_job(data)
            self._write_job_row(session, normalized, existing=row)
            return normalized

    def complete_job_scrape(self, job_id: str, patch: dict) -> None:
        self.update_job(job_id, patch)

    @staticmethod
    def _write_job_row(session: Session, normalized: dict, *, existing: JobRow | None = None) -> None:
        row = existing or session.get(JobRow, normalized['id'])
        if row is None:
            row = JobRow(id=normalized['id'])
            session.add(row)
        row.data = normalized
        row.company = normalized.get('company', '')
        row.job_title = normalized.get('job_title', '')
        row.region = normalized.get('region', 'ANY')
        row.status = normalized.get('status', 'approved')
        row.normalized_url = normalize_job_url(normalized.get('link', ''))
        row.company_key = _job_compare_key(normalized.get('company', ''))
        row.title_key = _job_compare_key(normalized.get('job_title', ''))
        row.scrape_status = normalized.get('scrape_status', 'done')
        row.submitted_at = _parse_iso_datetime(normalized.get('submitted_at', ''))
        row.created_by_user_id = str(normalized.get('created_by_user_id', '')).strip()

    def add_job_report(self, job_id: str, report: dict) -> None:
        jid = str(job_id or '').strip()
        if not jid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(JobRow, jid)
            if row is None:
                return
            data = dict(row.data or {})
            reports = list(data.get('reports', []) or [])
            reports.append(report)
            normalized = _normalize_job(data | {'reports': reports, 'flagged': True})
            self._write_job_row(session, normalized, existing=row)

    def clear_job_reports(self, job_id: str) -> None:
        jid = str(job_id or '').strip()
        if not jid:
            return
        with session_scope(self.db_path) as session:
            row = session.get(JobRow, jid)
            if row is None:
                return
            normalized = _normalize_job(dict(row.data or {}) | {'reports': [], 'flagged': False, 'report_locked': True})
            self._write_job_row(session, normalized, existing=row)

    # ---- openai usage logs ----

    def record_openai_call(self, user_id: str, kind: str = '', details: dict | None = None) -> None:
        cleaned = str(user_id or '').strip()
        if not cleaned:
            return
        details = details if isinstance(details, dict) else {}
        entry = _normalize_openai_call({
            **details,
            'user_id': cleaned,
            'kind': kind,
            'recorded_at': datetime.utcnow().isoformat() + 'Z',
        })
        with session_scope(self.db_path) as session:
            session.add(OpenAICallRow(
                user_id=entry['user_id'],
                recorded_at=_parse_iso_datetime(entry['recorded_at']) or datetime.utcnow(),
                data=entry,
            ))

    def get_openai_calls(self) -> list[dict]:
        with session_scope(self.db_path) as session:
            rows = session.scalars(select(OpenAICallRow).order_by(OpenAICallRow.recorded_at)).all()
            return [_normalize_openai_call(dict(row.data or {})) for row in rows]
