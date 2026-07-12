"""Pydantic request/response models. Kept loose (Any/dict) for fields that mirror
the JSON blobs stored in SQLite — the storage layer normalizes shapes anyway."""
from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field


# -------- Auth --------

class LoginRequest(BaseModel):
    identifier: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user: dict


class RegisterRequest(BaseModel):
    full_name: str
    email: str
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    new_password: str
    current_password: str = ''


# -------- Jobs --------

class JobUpsertRequest(BaseModel):
    payload: dict


# -------- Profiles --------

class ProfileUpsertRequest(BaseModel):
    payload: dict


# -------- Resumes --------

class GenerateResumeRequest(BaseModel):
    profile_id: str
    job_id: str | None = None
    job_description: str = ""
    target_role: str = ""
    default_prompt: str = ""
    use_ai: bool = True
    model: str = ""


class UpdateResumeRequest(BaseModel):
    profile_id: str
    job_description: str = ""
    target_role: str = ""
    current_resume: dict
    fix_prompt: str
    default_prompt: str = ""
    model: str = ""


class SaveResumeRequest(BaseModel):
    payload: dict


class GenerateAnswersRequest(BaseModel):
    resume: dict
    job_description: str
    questions: list[str]
    target_role: str = ""
    model: str = ""


# -------- Users / settings --------

class UserUpsertRequest(BaseModel):
    payload: dict


class SettingsUpsertRequest(BaseModel):
    payload: dict
