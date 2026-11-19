"""AI job check — the same screener VPS1 runs (Resume-Generator-v2 core/resume_engine.py
analyze_job_posting + verdict_from_analysis, and its job-adder auto-vetting).

One OpenAI call per job reads company + title + description and answers six things: the work mode
(remote / onsite / hybrid / travel / in_person / unspecified — "never assume remote"), is it software
development, is it paid, does it need a security clearance, its main tech stack, and a reason under 50
characters. The verdict is NOT the model's — it is fixed code (verdict_from_analysis):

  not_fit      not software, unpaid, clearance, or onsite / hybrid / travel / in-person
  fit          explicitly remote
  needs_check  the posting never says where the work is

What happens with it (VPS1's rules):
  * A job a job_adder adds waits as 'pending' (ai_auto) until checked. 'fit' approves it on the spot;
    'not_fit' / 'needs_check' stay pending for an admin (Jobs → Pending). The tech stack is saved for
    every verdict.
  * Other jobs this server adds (admins, Easy Bids) are live at once; the check only fills in their
    tech stack and verdict. Synced VPS1 jobs carry VPS1's own verdict and stack (core/job_sync.py).
  * A temporary failure (quota, rate limit, network, bad key) records nothing about the job: it is
    retried later. Any other failure marks the job 'needs_check' / "Auto-review failed".
  * Unlike VPS1 (which waited for 10 jobs, so 9 could wait forever) each job is checked as soon as it
    is added, one call at a time, by one background thread.

Every call is logged with its tokens and USD cost (storage.record_openai_call, kind 'analyze_job').
The key is OPENAI_API_KEY from the project's root .env; the model JOB_AI_MODEL (default gpt-4.1,
VPS1's default). Settings → "AI job check" turns the whole thing off.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger("job_ai")

_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_MODEL = "gpt-4.1"
AUTO_ACTOR = "AI check"          # approved_by_username of a job the check approved
BACKFILL_DAYS = 14               # jobs added this recently get a tech stack without anyone asking
_TIMEOUT_S = 60

# USD per 1M tokens: (input, cached input, output). A model not listed has its cost left unknown.
_PRICES = {
    "gpt-4.1": (2.00, 0.50, 8.00),
    "gpt-4.1-mini": (0.40, 0.10, 1.60),
    "gpt-4.1-nano": (0.10, 0.025, 0.40),
    "gpt-4o": (2.50, 1.25, 10.00),
    "gpt-4o-mini": (0.15, 0.075, 0.60),
}

# ── VPS1's screener, word for word ───────────────────────────────────────────
JOB_ANALYSIS_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['work_mode', 'is_software_development', 'is_paid', 'requires_security_clearance', 'main_stack', 'reason'],
    'properties': {
        'work_mode': {'type': 'string', 'enum': ['remote', 'onsite', 'hybrid', 'travel', 'in_person', 'unspecified']},
        'is_software_development': {'type': 'boolean'},
        'is_paid': {'type': 'boolean'},
        'requires_security_clearance': {'type': 'boolean'},
        'main_stack': {'type': 'array', 'items': {'type': 'string'}},
        'reason': {'type': 'string'},
    },
}

DEVELOPER_MESSAGE = (
    'You are a strict screener for a remote software-development job board. '
    'Given a job posting (company, role, description), classify its work arrangement, confirm it is paid software development, and extract its main technology stack. '
    'Apply these criteria exactly. '
    '(1) work_mode: classify the location / work arrangement into exactly one of these values. '
    '"remote": the posting explicitly states the role is fully remote (occasional post-hire travel of roughly 10 percent or less still counts as remote). '
    '"onsite": office-based, on-site, or requires relocation. '
    '"hybrid": a mix of remote and in-office work. '
    '"travel": significant or mandatory travel is required. '
    '"in_person": otherwise remote but requires mandatory in-person interviews or mandatory in-person onboarding. '
    '"unspecified": the posting does NOT mention location, remote, onsite, hybrid, travel, or any in-person requirement at all. '
    'Important: only use "remote" when remoteness is explicitly stated. Never assume remote. '
    'If nothing in the posting addresses location or remote policy, you MUST use "unspecified" (do not default to onsite or remote). '
    '(2) is_software_development: true only if the core work is software engineering, programming, or development. '
    'Set false for non-engineering roles such as sales, marketing, recruiting, manual-only QA, support, design-only, or data entry. '
    '(3) is_paid: true for a normal salaried or contract-paid position. Set false if it is unpaid, volunteer, credit-only, or compensated solely in equity or tokens with no salary. '
    '(4) requires_security_clearance: true if the role requires (or strongly prefers) a government/defense security clearance or similar vetting — '
    'for example "active Secret/Top Secret clearance", "TS/SCI", "Public Trust", "ability to obtain a clearance", "polygraph", or clearance-driven citizenship/eligibility requirements. Otherwise false. '
    '(5) main_stack: the primary programming languages and core frameworks the role centers on, as a short list of canonical names '
    '(for example "Java", "Python", "C#", "JavaScript", "TypeScript", "Go", "React", "Node.js", ".NET"). '
    'Include only technologies clearly central to the role; omit incidental mentions and vague categories. '
    '(6) reason: a very short explanation, strictly under 50 characters, as a brief phrase rather than a full sentence, '
    'naming the single deciding factor (for example "Onsite role", "Hybrid schedule", "Travel required", "Remote not stated", "Unpaid", "Not software dev", "Clearance required"). '
    'Return only JSON matching the schema.'
)

# Work modes that make a posting a hard "not a fit" for the remote software board.
DISQUALIFYING_WORK_MODES = {'onsite', 'hybrid', 'travel', 'in_person'}


def verdict_from_analysis(analysis: dict) -> str:
    """'fit' | 'not_fit' | 'needs_check' — VPS1's mapping, unchanged."""
    analysis = analysis or {}
    work_mode = str(analysis.get('work_mode') or 'unspecified').strip().lower()
    is_software = bool(analysis.get('is_software_development'))
    is_paid = bool(analysis.get('is_paid'))
    requires_clearance = bool(analysis.get('requires_security_clearance'))
    if not is_software or not is_paid or requires_clearance or work_mode in DISQUALIFYING_WORK_MODES:
        return 'not_fit'
    if work_mode == 'remote':
        return 'fit'
    return 'needs_check'


def is_transient_ai_error(exc: BaseException) -> bool:
    """True for failures that say nothing about the job (quota, rate limit, auth/config, network,
    5xx): no verdict is recorded and the job is retried later. (VPS1's rule.)"""
    msg = str(exc or '').lower()
    cause = getattr(exc, '__cause__', None)
    status = getattr(exc, 'status_code', None) or getattr(cause, 'status_code', None)
    if status in (401, 403, 408, 409, 429) or (isinstance(status, int) and status >= 500):
        return True
    return any(k in msg for k in ('insufficient_quota', 'credit_balance_exhausted', 'no credits', 'rate limit', 'rate_limit',
                                  'error code: 429', 'connection', 'timed out', 'timeout', 'temporarily unavailable',
                                  'service unavailable', 'api key', 'no openai key'))


def friendly_ai_error(exc: BaseException | str) -> str:
    msg = str(exc or '')
    low = msg.lower()
    if 'insufficient_quota' in low or 'credit_balance_exhausted' in low or 'no credits' in low:
        return 'The OpenAI account has no credits left — add credits at platform.openai.com (Settings → Billing).'
    if 'error code: 429' in low or 'rate limit' in low or 'rate_limit' in low:
        return 'OpenAI rate limit — the check retries in a few minutes.'
    if 'no openai key' in low:
        return 'No OpenAI key — put OPENAI_API_KEY in the project .env file.'
    if 'error code: 401' in low or 'api key' in low:
        return 'The OpenAI key is missing or invalid — check OPENAI_API_KEY in the project .env file.'
    return f'AI check failed: {msg[:300]}'


# ── key / model / client ─────────────────────────────────────────────────────
def _key() -> str:
    """OPENAI_API_KEY from the project's root .env (re-read each call, so a new key works without a
    restart), else the process environment."""
    try:
        from dotenv import dotenv_values
        val = str(dotenv_values(_ROOT / ".env").get("OPENAI_API_KEY") or "").strip()
        if val:
            return val
    except Exception:
        pass
    return str(os.environ.get("OPENAI_API_KEY") or "").strip()


def model_name() -> str:
    return str(os.environ.get("JOB_AI_MODEL") or "").strip() or DEFAULT_MODEL


def key_present() -> bool:
    return bool(_key())


def _cost(model: str, usage: dict) -> dict:
    price = _PRICES.get(model) or next((p for m, p in _PRICES.items() if model.startswith(m + "-")), None)
    if not price:
        return {"total_cost_usd": None}
    cached = int(usage.get("cached_input_tokens") or 0)
    fresh = max(0, int(usage.get("input_tokens") or 0) - cached)
    out = int(usage.get("output_tokens") or 0)
    inp, cin, outp = fresh * price[0] / 1e6, cached * price[1] / 1e6, out * price[2] / 1e6
    return {"input_cost_usd": round(inp, 6), "cached_input_cost_usd": round(cin, 6),
            "output_cost_usd": round(outp, 6), "total_cost_usd": round(inp + cin + outp, 6)}


def analyze_posting(company: str, role: str, description: str, *, user_id: str = "system") -> dict:
    """One screener call → the raw analysis dict. Raises on failure (see is_transient_ai_error).
    The call is logged with its tokens and cost either way."""
    key = _key()
    if not key:
        raise RuntimeError("No OpenAI key")
    from openai import OpenAI
    from auth import storage

    model = model_name()
    payload = {'company': str(company or '').strip(), 'role': str(role or '').strip(),
               'job_description': str(description or '').strip()}
    flow_id = f"job_analyze_{uuid.uuid4().hex[:12]}"
    started = time.perf_counter()
    entry = {"flow_id": flow_id, "call_kind": "analyze_job", "model": model,
             "schema_name": "job_posting_analysis_v1", "developer_message_chars": len(DEVELOPER_MESSAGE)}
    try:
        client = OpenAI(api_key=key, timeout=_TIMEOUT_S, max_retries=1)
        response = client.responses.create(
            model=model,
            input=[{'role': 'developer', 'content': DEVELOPER_MESSAGE},
                   {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)}],
            text={'format': {'type': 'json_schema', 'name': 'job_posting_analysis_v1', 'strict': True,
                             'schema': JOB_ANALYSIS_SCHEMA}},
        )
        text = str(getattr(response, 'output_text', '') or '')
        parsed = json.loads(text)
        u = getattr(response, 'usage', None)
        usage = {
            "input_tokens": int(getattr(u, "input_tokens", 0) or 0),
            "output_tokens": int(getattr(u, "output_tokens", 0) or 0),
            "total_tokens": int(getattr(u, "total_tokens", 0) or 0),
            "cached_input_tokens": int(getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0) or 0),
        }
        entry.update(status="success", response_id=str(getattr(response, "id", "") or ""),
                     output_text=text[:2000], output_text_chars=len(text), usage=usage, cost=_cost(model, usage))
        return parsed
    except Exception as exc:
        entry.update(status="error", output_text=str(exc)[:1000])
        raise
    finally:
        entry["duration_ms"] = int((time.perf_counter() - started) * 1000)
        try:
            storage.record_openai_call(user_id or "system", "analyze_job", entry)
        except Exception:
            log.exception("could not log the OpenAI call")


def _clean_stack(raw) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for s in raw or []:
        name = " ".join(str(s or "").split())[:40]
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out[:12]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_job(job_id: str, *, user: dict | None = None, approve_fit: bool | None = None) -> dict:
    """Run the screener on one job and save the verdict + tech stack on it. approve_fit (default: the
    job is waiting for the check, ai_auto) approves a 'fit' job that is still pending.
    Returns {id, ai_status, ai_reason, tech_stack, status} — raises on an AI failure."""
    from auth import storage

    job = storage.get_job_by_id(job_id)
    if not job:
        raise LookupError("Job not found")
    analysis = analyze_posting(job.get("company", ""), job.get("job_title", ""), job.get("description", ""),
                               user_id=(user or {}).get("id") or job.get("created_by_user_id") or "system")
    verdict = verdict_from_analysis(analysis)
    reason = str(analysis.get("reason") or "").strip()
    if len(reason) > 50:
        reason = reason[:49].rstrip() + "…"
    patch = {
        "analyzed": True, "ai_status": verdict, "ai_reason": reason, "ai_error": "",
        "ai_work_mode": str(analysis.get("work_mode") or ""),
        "tech_stack": _clean_stack(analysis.get("main_stack")),
        "ai_checked_at": _now(), "ai_auto": False,
    }
    fresh = storage.get_job_by_id(job_id) or job
    if approve_fit is None:
        approve_fit = bool(fresh.get("ai_auto"))
    # A job reported meanwhile stays for a person (VPS1 re-checks the same before approving).
    if approve_fit and verdict == "fit" and fresh.get("status") == "pending" and not fresh.get("flagged"):
        patch.update(status="approved", approved_at=_now(), approved_by_user_id="",
                     approved_by_username=AUTO_ACTOR)
    storage.update_job(job_id, patch)
    return {"id": job_id, "ai_status": verdict, "ai_reason": reason, "tech_stack": patch["tech_stack"],
            "status": patch.get("status", fresh.get("status", ""))}


# ── settings + the background worker ────────────────────────────────────────
def enabled() -> bool:
    """Settings → AI job check is on AND a key is set. Off: nothing is sent to OpenAI and a
    job_adder's job goes live at once, as before."""
    from auth import storage
    try:
        on = bool(storage.get_app_settings().get("ai_job_check", True))
    except Exception:
        on = True
    return on and key_present()


_wake = threading.Event()
_state = {"last_error": "", "last_error_at": "", "paused_until": 0.0, "running": False}
_started = False
_lock = threading.Lock()


def kick() -> None:
    """A job was added: check it now (no-op when the worker isn't running)."""
    _wake.set()


def status() -> dict:
    return {"enabled": enabled(), "key_present": key_present(), "model": model_name(),
            "last_error": _state["last_error"], "last_error_at": _state["last_error_at"],
            "retry_at": (datetime.fromtimestamp(_state["paused_until"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                         if _state["paused_until"] > time.time() else "")}


def _due(limit: int = 20) -> list[str]:
    """Jobs waiting for the check, those that hold a pending job first (oldest first), then jobs
    added in the last BACKFILL_DAYS that have no tech stack yet."""
    from auth import storage
    return storage.jobs_due_for_ai(limit=limit, since=datetime.utcnow() - timedelta(days=BACKFILL_DAYS))


def run_due() -> int:
    """Check every due job, one call at a time. Stops at the first temporary error (and pauses five
    minutes) instead of burning more failing calls — VPS1's rule."""
    from auth import storage
    done = 0
    if not enabled() or time.time() < _state["paused_until"]:
        return 0
    for jid in _due():
        try:
            check_job(jid)
            done += 1
            _state["last_error"] = ""
        except LookupError:
            continue
        except Exception as exc:
            if is_transient_ai_error(exc):
                _state.update(last_error=friendly_ai_error(exc), last_error_at=_now(),
                              paused_until=time.time() + 300)
                log.warning("AI check paused 5 min: %s", exc)
                break
            log.warning("AI check failed for %s: %s", jid, exc)
            storage.update_job(jid, {"analyzed": True, "ai_status": "needs_check", "ai_reason": "Auto-review failed",
                                     "ai_error": str(exc)[:300], "ai_checked_at": _now(), "ai_auto": False})
    return done


def _loop() -> None:
    while True:
        _wake.wait(timeout=60)
        _wake.clear()
        try:
            _state["running"] = True
            while run_due():           # more may have arrived while this batch ran
                pass
        except Exception:
            log.exception("AI check loop")
        finally:
            _state["running"] = False


def start() -> None:
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="job-ai", daemon=True).start()
    kick()
