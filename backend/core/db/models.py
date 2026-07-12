from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, DateTime, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Base class for all ORM models."""


def _utcnow() -> datetime:
    return datetime.utcnow()


class ProfileRow(Base):
    __tablename__ = 'profiles'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), default='', index=True)
    email: Mapped[str] = mapped_column(String(255), default='', index=True)
    region: Mapped[str] = mapped_column(String(16), default='ANY', index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, default=None)
    created_by_user_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    created_by_username: Mapped[str] = mapped_column(String(128), default='')
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class JobRow(Base):
    __tablename__ = 'jobs'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    company: Mapped[str] = mapped_column(String(255), default='', index=True)
    job_title: Mapped[str] = mapped_column(String(255), default='', index=True)
    region: Mapped[str] = mapped_column(String(16), default='ANY', index=True)
    status: Mapped[str] = mapped_column(String(32), default='approved', index=True)
    normalized_url: Mapped[str] = mapped_column(String(2048), default='', index=True)
    company_key: Mapped[str] = mapped_column(String(255), default='', index=True)
    title_key: Mapped[str] = mapped_column(String(255), default='', index=True)
    scrape_status: Mapped[str] = mapped_column(String(32), default='done', index=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, default=None, index=True)
    created_by_user_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class GeneratedResumeRow(Base):
    __tablename__ = 'generated_resumes'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    job_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    job_company: Mapped[str] = mapped_column(String(255), default='', index=True)
    job_title: Mapped[str] = mapped_column(String(255), default='', index=True)
    created_by_user_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    created_by_username: Mapped[str] = mapped_column(String(128), default='')
    created_at_ts: Mapped[Optional[datetime]] = mapped_column(DateTime, default=None, index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class UserRow(Base):
    __tablename__ = 'users'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), default='', index=True)
    email: Mapped[str] = mapped_column(String(255), default='', index=True)
    status: Mapped[str] = mapped_column(String(32), default='pending', index=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    parent_admin_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class TemplateRow(Base):
    __tablename__ = 'templates'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), default='')
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class SettingsRow(Base):
    __tablename__ = 'settings'

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class TeamRow(Base):
    """A caller team (e.g. "Vaccine Team"). Membership lives on the user (`team_id`); a team
    manager is a user with the 'manager' role whose team_id points here."""
    __tablename__ = 'teams'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), default='', index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class OpenAICallRow(Base):
    __tablename__ = 'openai_calls'

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(64), default='', index=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class DeviceSessionRow(Base):
    """One row per (user, device fingerprint). Created on login.

    `revoked` lets admins force a logout from a specific device without
    deleting the row (audit-friendly). `fingerprint` is a stable hash of
    user-agent + a salt, so the same browser+OS combines login_count.
    """
    __tablename__ = 'device_sessions'

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    user_agent: Mapped[str] = mapped_column(String(512), default='')
    browser: Mapped[str] = mapped_column(String(64), default='')
    os: Mapped[str] = mapped_column(String(64), default='')
    device_type: Mapped[str] = mapped_column(String(32), default='desktop', index=True)
    ip: Mapped[str] = mapped_column(String(64), default='')
    login_count: Mapped[int] = mapped_column(Integer, default=1)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow, index=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, default=None)
