"""Map VPS_1's API shapes onto the shapes VPS_2's Profiles / Users / Applied tabs already render, and
tag every row `source: 'VPS_1'`. Local rows are tagged `source: 'VPS_2'` at the router. Read-only:
these carry no fields the edit forms write back (and the frontend hides edit/delete for VPS_1 rows).

Kept apart from vps1_client (transport) so the field mapping is easy to eyeball against both schemas.
"""
from __future__ import annotations

SOURCE_LOCAL = "VPS_2"
SOURCE_REMOTE = "VPS_1"


def tag_local(rows: list[dict]) -> list[dict]:
    """Stamp the origin on locally-stored rows without mutating the stored dicts."""
    return [{**r, "source": SOURCE_LOCAL} for r in rows]


# VPS_1 sends these; everything else on a VPS_1 profile (tech_stacks, work_history, expected_salary,
# …) only exists because an admin filled it in here — see storage.patch_vps1_profile.
_VPS1_PROFILE_FIELDS = ("name", "email", "phone", "location", "region",
                        "has_uploaded_resume", "uploaded_resume_filename")


def profile(p: dict) -> dict:
    """A VPS_1 profile (snapshot + any local admin edits already merged) → the loose dict
    Profiles.tsx renders.

    Passes every field THROUGH rather than whitelisting: the admin-only fields are the whole point of
    letting them edit a VPS_1 profile, and a whitelist would silently hide the values they just typed.
    Only `id` (namespaced so a VPS_1 uuid can't collide with a local id) and `source` are imposed.
    """
    out = {k: v for k, v in (p or {}).items() if k != "id"}
    for k in _VPS1_PROFILE_FIELDS:               # keep the shape stable even when VPS_1 omits one
        out.setdefault(k, "")
    out["id"] = f"vps1:{p.get('id', '')}"
    out["source"] = SOURCE_REMOTE
    return out


def user(u: dict) -> dict:
    """VPS_1 UserSummary → the dict Users.tsx renders. VPS_1 has a single `role`; the local table
    reads `roles` (a list), so wrap it. Team/bid_method/assigned profiles don't exist on VPS_1."""
    role = str(u.get("role", "") or "").strip()
    return {
        "id": f"vps1:{u.get('id', '')}",
        "username": u.get("username", ""),
        "full_name": u.get("full_name", ""),
        "email": u.get("email", ""),
        "roles": [role] if role else [],
        "is_admin": role == "admin",
        "status": u.get("status", ""),
        "team_id": "",
        "assigned_profile_ids": [],
        "source": SOURCE_REMOTE,
    }


def applied_row(a: dict) -> dict:
    """VPS_1 ApplicationSummary → an Applied-tab row (same keys resumes.search emits). VPS_1 has no
    `saved_resume_id` in our sense; use the generated_resume_id so the row is still identifiable."""
    return {
        "saved_resume_id": f"vps1:{a.get('generated_resume_id') or a.get('id', '')}",
        "job_id": a.get("job_id", ""),
        "job_company": a.get("company", ""),
        "job_title": a.get("job_title", ""),
        "job_link": a.get("job_link", ""),
        "job_region": a.get("region", ""),
        "profile_id": f"vps1:{a.get('profile_id', '')}",
        "profile_name": a.get("profile_name", ""),
        "bidder": a.get("username", ""),
        "applied_at": a.get("created_at", ""),
        "created_at": a.get("created_at", ""),
        "status": a.get("current_status", ""),
        "source": SOURCE_REMOTE,
    }
