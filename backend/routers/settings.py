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
    storage.save_app_settings(body.payload)
    return storage.get_app_settings()
