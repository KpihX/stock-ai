"""Minimal JWT auth for the single admin account."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from ..config import get_secret

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
ALGORITHM = "HS256"


def _key() -> str:
    return (
        get_secret("JWT_SECRET", required=False)
        or "stockline-hackathon-development-secret-key-2026"
    )


def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "iat": datetime.now(UTC),
        "exp": datetime.now(UTC) + timedelta(hours=12),
    }
    return jwt.encode(payload, _key(), algorithm=ALGORITHM)


def verify_token(token: str = Depends(oauth2)) -> str:
    try:
        payload = jwt.decode(token, _key(), algorithms=[ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from exc
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return username


def check_credentials(username: str, password: str) -> bool:
    expected_user = os.environ.get("STOCKLINE_ADMIN_USER")
    if not expected_user:
        raise RuntimeError("STOCKLINE_ADMIN_USER is not configured")
    expected_password = os.environ.get("STOCKLINE_ADMIN_PASSWORD")
    if not expected_password:
        raise RuntimeError("STOCKLINE_ADMIN_PASSWORD is not configured")
    return username == expected_user and password == expected_password
