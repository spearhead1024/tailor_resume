"""Company intelligence (startup / size / age) — read, correct, re-check.

Results are produced by the company-intel worker (core/company_intel.py). Admins can
override a company's employee count / founded year / public flag; an override is
locked so the worker never overwrites it, until an admin asks for a re-check.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user, require_admin, storage
from core.company_intel import finalize

router = APIRouter(prefix="/api/companies", tags=["companies"])


@router.get("/{key}")
def get_company(key: str, user: dict = Depends(get_current_user)):
    c = storage.get_company(key)
    if c is None:
        raise HTTPException(status_code=404, detail="Company not found")
    c.pop("job_company_keys", None)
    return c


@router.patch("/{key}")
def override_company(key: str, body: dict, user: dict = Depends(require_admin)):
    """Body: any of {employees: int|null, founded: int|null, public: bool}."""
    cur = storage.get_company(key)
    if cur is None:
        raise HTTPException(status_code=404, detail="Company not found")
    data = {k: v for k, v in cur.items()
            if k not in {"key", "name", "status", "checked_at", "job_company_keys"}}
    who = user.get("username") or "admin"
    if "employees" in body:
        emp = body.get("employees")
        if emp in (None, ""):
            data.update(employees=None, size_label="", size_lt100=None)
        else:
            try:
                emp = int(emp)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="employees must be a whole number")
            if emp < 1:
                raise HTTPException(status_code=400, detail="employees must be at least 1")
            data.update(employees=emp, employees_plus=False, size_source=f"set by {who}")
    if "founded" in body:
        yr = body.get("founded")
        if yr in (None, ""):
            data.update(founded=None, founded_exact=False)
        else:
            try:
                yr = int(yr)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="founded must be a year")
            if not 1800 <= yr <= 2100:
                raise HTTPException(status_code=400, detail="founded must be a valid year")
            data.update(founded=yr, founded_exact=True, founded_source=f"set by {who}")
    if "public" in body:
        data["public"] = bool(body.get("public"))
    data["locked"] = True
    data["confidence"] = "high"
    data["sources"] = [s for s in (data.get("sources") or []) if not str(s).startswith("set by")] + [f"set by {who}"]
    storage.save_company(key, finalize(data), "done")
    out = storage.get_company(key) or {}
    out.pop("job_company_keys", None)
    return out


@router.post("/{key}/recheck")
def recheck_company(key: str, user: dict = Depends(require_admin)):
    """Drop any manual lock and queue the company for a fresh automatic check."""
    if not storage.set_company_pending(key):
        raise HTTPException(status_code=404, detail="Company not found")
    return {"ok": True}
