"""App settings (admin only)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from auth import get_current_user, require_admin, storage
from schemas import SettingsUpsertRequest

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings(user: dict = Depends(get_current_user)):
    return storage.get_app_settings()


@router.put("")
def save_settings(body: SettingsUpsertRequest, user: dict = Depends(require_admin)):
    """Partial update: only the keys sent are changed. The page used to send the whole
    settings document as it was when the page was opened, so an admin with a stale
    Settings tab who saved e.g. the prompt silently restored old values of every other
    field — that is how the title blacklist (lead/staff/devops/principal) kept vanishing."""
    current = storage.get_app_settings()
    current.update(body.payload or {})
    storage.save_app_settings(current)
    return storage.get_app_settings()
