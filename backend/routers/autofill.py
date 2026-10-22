"""Application-form autofill for the extension's side panel.

GET  /api/autofill/data?profile_id=   values the scanner fills + learned answers/labels
POST /api/autofill/learn              "Remember answers": store what the bidder filled by hand
GET/PATCH/DELETE /api/autofill/answers   admin review of a profile's learned answers

Question matching uses question_key(): lowercase alphanumerics, single spaces,
without "required"/"optional". extension/content/autofill.js has the same
function — keep the two in sync.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user, has_role, storage
from routers.resumes import _check_profile_access

router = APIRouter(prefix="/api/autofill", tags=["autofill"])

_COUNTRY_BY_REGION = {"US": "United States"}
_MAX_ANSWER_LEN = 500       # longer text is a job-specific essay, not a reusable answer


def question_key(text: str) -> str:
    words = re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).split()
    return " ".join(w for w in words if w not in ("required", "optional"))[:300]


def _profile_or_404(profile_id: str) -> dict:
    profile = next((p for p in storage.get_profiles() if p.get("id") == profile_id), None)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


def _require_bidder(user: dict, profile_id: str) -> dict:
    if not has_role(user, "admin", "bidder"):
        raise HTTPException(status_code=403, detail="Forbidden")
    if not profile_id:
        raise HTTPException(status_code=400, detail="profile_id is required")
    _check_profile_access(user, profile_id)
    return _profile_or_404(profile_id)


def profile_values(p: dict) -> dict[str, str]:
    """Every profile value a form field can be mapped to, keyed by field name."""
    s = lambda x: str(x or "").strip()  # noqa: E731
    name = s(p.get("name"))
    parts = name.split()
    region = s(p.get("region")).upper()
    loc = [x.strip() for x in s(p.get("location")).split(",") if x.strip()]
    city = loc[0] if loc else ""
    state, country = "", _COUNTRY_BY_REGION.get(region, "")
    if region == "US" or len(loc) >= 3:
        state = re.sub(r"\s*\d{5}(-\d{4})?$", "", loc[1]).strip() if len(loc) > 1 else ""
        if len(loc) >= 3:
            country = loc[-1]
    elif len(loc) == 2:
        country = loc[1]      # "Berlin, Germany"
    street, zip_code = s(p.get("address")), s(p.get("zip_code"))
    if city and city.lower() in street.lower():
        full = " ".join(x for x in (street, zip_code if zip_code and zip_code not in street else "") if x)
    else:
        full = ", ".join(x for x in (street, city, " ".join(x for x in (state, zip_code) if x)) if x)
    work = next((w for w in (p.get("work_history") or []) if s(w.get("company_name"))), {}) or {}
    edu = (p.get("education_history") or [{}])[0] or {}
    grad = re.findall(r"(?:19|20)\d{2}", s(edu.get("duration")))
    years = p.get("total_years_of_experience")
    return {
        "full_name": name,
        "first_name": parts[0] if parts else "",
        "last_name": parts[-1] if len(parts) > 1 else "",
        "email": s(p.get("email")),
        "phone": s(p.get("phone")),
        "street": street,
        "city": city,
        "state": state,
        "zip": zip_code,
        "country": country,
        "address_full": full,
        "location": s(p.get("location")),
        "linkedin": s(p.get("linkedin")),
        "github": s(p.get("github")),
        "portfolio": s(p.get("portfolio")) or s(p.get("github")),
        "current_company": s(work.get("company_name")),
        "current_title": s(work.get("legacy_role")),
        "university": s(edu.get("university")),
        "degree": s(edu.get("degree")),
        "graduation_year": grad[-1] if grad else "",
        "years_experience": str(years) if years not in (None, "") else "",
        "expected_salary": s(p.get("expected_salary")),
    }


@router.get("/data")
def autofill_data(profile_id: str, user: dict = Depends(get_current_user)):
    profile = _require_bidder(user, profile_id)
    return {
        "values": profile_values(profile),
        "answers": [{"question_key": a["question_key"], "question": a["question"], "answer": a["answer"]}
                    for a in storage.autofill_answers(profile_id)],
        "labels": storage.autofill_labels(),
    }


@router.post("/learn")
def autofill_learn(body: dict, user: dict = Depends(get_current_user)):
    """Body: {profile_id, fields: [{question, value, field?}]} — the form's filled
    fields as the bidder left them. `field` is set when the scanner already knew
    the field (nothing to learn). A value equal to one of the profile's own values
    teaches the shared label map; anything else becomes this profile's answer."""
    body = body or {}
    profile_id = str(body.get("profile_id") or "").strip()
    profile = _require_bidder(user, profile_id)
    values = profile_values(profile)
    # Short/numeric values ("8", "2019") are too ambiguous to teach a label from.
    by_value = {v.lower(): k for k, v in values.items() if len(v) >= 3 and not v.isdigit()}
    labels = storage.autofill_labels()
    answers, learned_labels = 0, 0
    for f in (body.get("fields") or [])[:150]:
        if not isinstance(f, dict) or f.get("field"):
            continue
        key = question_key(f.get("question"))
        value = str(f.get("value") or "").strip()
        if len(key) < 2 or not value or len(value) > _MAX_ANSWER_LEN:
            continue
        known = by_value.get(value.lower())
        if known:
            if labels.get(key) != known:
                storage.save_autofill_label(key, known)
                learned_labels += 1
            continue
        storage.save_autofill_answer(profile_id, key, str(f.get("question") or "").strip(), value,
                                     username=user.get("username", ""))
        answers += 1
    return {"ok": True, "answers": answers, "labels": learned_labels}


@router.get("/answers")
def list_answers(profile_id: str, user: dict = Depends(get_current_user)):
    _require_bidder(user, profile_id)
    return storage.autofill_answers(profile_id)


@router.patch("/answers")
def edit_answer(body: dict, user: dict = Depends(get_current_user)):
    if not has_role(user, "admin"):
        raise HTTPException(status_code=403, detail="Forbidden")
    body = body or {}
    profile_id = str(body.get("profile_id") or "").strip()
    key = str(body.get("question_key") or "").strip()
    answer = str(body.get("answer") or "").strip()
    if not profile_id or not key or not answer:
        raise HTTPException(status_code=400, detail="profile_id, question_key and answer are required")
    current = next((a for a in storage.autofill_answers(profile_id) if a["question_key"] == key), None)
    if not current:
        raise HTTPException(status_code=404, detail="Answer not found")
    storage.save_autofill_answer(profile_id, key, current["question"], answer, username=user.get("username", ""))
    return {"ok": True}


@router.delete("/answers")
def delete_answer(profile_id: str, question_key: str, user: dict = Depends(get_current_user)):
    if not has_role(user, "admin"):
        raise HTTPException(status_code=403, detail="Forbidden")
    if not storage.delete_autofill_answer(profile_id, question_key):
        raise HTTPException(status_code=404, detail="Answer not found")
    return {"ok": True}
