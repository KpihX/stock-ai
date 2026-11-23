"""Minimal JWT auth for the single admin account."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Query, status
from fastapi.security import OAuth2PasswordBearer

from ..config import get_secret
from . import db

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)
ALGORITHM = "HS256"


def _key() -> str:
    return (
        get_secret("JWT_SECRET", required=False)
        or "stockline-hackathon-development-secret-key-2026"
    )


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 200_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt, expected = stored.split("$", 2)
    except ValueError:
        return False
    if scheme != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 200_000)
    return hmac.compare_digest(digest.hex(), expected)


def create_token(username: str, role: str = "manager") -> str:
    payload = {
        "sub": username,
        "role": role,
        "iat": datetime.now(UTC),
        "exp": datetime.now(UTC) + timedelta(hours=12),
    }
    return jwt.encode(payload, _key(), algorithm=ALGORITHM)


def get_claims(
    bearer_token: str | None = Depends(oauth2),
    token: str | None = Query(default=None),
) -> dict[str, str]:
    raw_token = bearer_token or token
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = jwt.decode(raw_token, _key(), algorithms=[ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from exc
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    role = payload.get("role") or (
        "admin" if username == os.environ.get("STOCKLINE_ADMIN_USER") else "manager"
    )
    return {"username": str(username), "role": str(role)}


def verify_token(claims: Annotated[dict[str, str], Depends(get_claims)]) -> str:
    return claims["username"]


def require_admin(claims: Annotated[dict[str, str], Depends(get_claims)]) -> str:
    if claims.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return claims["username"]


async def check_credentials(username: str, password: str) -> str | None:
    expected_user = os.environ.get("STOCKLINE_ADMIN_USER")
    expected_password = os.environ.get("STOCKLINE_ADMIN_PASSWORD")
    if (
        expected_user
        and expected_password
        and username == expected_user
        and password == expected_password
    ):
        return "admin"
    manager = await db.fetch_manager(username)
    if manager and manager["is_active"] and verify_password(password, manager["password_hash"]):
        return "manager"
    return None
