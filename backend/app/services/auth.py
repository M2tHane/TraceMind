"""Accounts, password hashing, browser sessions and personal access tokens.

Passwords use salted scrypt (stdlib). Session and API tokens are random 256-bit values;
only their SHA-256 digests are stored, so a database dump cannot be replayed as a login.
Accounts are created by administrators; there is no self-registration.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import generate_id
from app.models import ApiToken, User, UserSession

SESSION_COOKIE = "rag_session"
SESSION_TTL = timedelta(days=7)
TOKEN_PREFIX = "rwb_"
ROLES = ("admin", "employee")
_USERNAME_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{2,63}")
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}
_FAILURES: dict[str, deque[float]] = defaultdict(deque)
_LOCK_WINDOW, _LOCK_LIMIT = 15 * 60, 5


class AuthError(ValueError):
    """Caller-safe authentication/account failure mapped onto an HTTP status."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Principal:
    id: int
    username: str
    display_name: str
    role: str
    must_change_password: bool = False
    via: str = "session"
    token_id: int | None = None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def memory_namespace(self) -> str:
        return f"user:{self.id}"

    def public(self) -> dict:
        return {"id": str(self.id), "username": self.username, "display_name": self.display_name,
                "role": self.role, "must_change_password": self.must_change_password}


def principal_of(user: User, via: str = "session", token_id: int | None = None) -> Principal:
    return Principal(id=user.id, username=user.username, display_name=user.display_name or user.username,
                     role=user.role, must_change_password=user.must_change_password, via=via, token_id=token_id)


def normalize_username(username: str) -> str:
    value = (username or "").strip().lower()
    if not _USERNAME_RE.fullmatch(value):
        raise AuthError("用户名须为 3-64 位小写字母、数字或 _ . -，且以字母或数字开头")
    return value


def validate_password(password: str, username: str = "") -> str:
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        raise AuthError("密码长度须为 10-128 个字符")
    if username and username.lower() in password.lower():
        raise AuthError("密码不能包含用户名")
    if len(set(password)) < 5:
        raise AuthError("密码过于简单，请混合使用不同字符")
    return password


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, maxmem=64 * 1024 * 1024, **_SCRYPT)
    encode = lambda raw: base64.b64encode(raw).decode()  # noqa: E731
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${encode(salt)}${encode(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                                dklen=32, maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(digest, base64.b64decode(expected))
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = hash_password("timing-equalizer-password")


def token_digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _throttle_key(username: str, client: str) -> str:
    return f"{username.lower()}|{client}"


def check_throttle(username: str, client: str) -> None:
    attempts = _FAILURES[_throttle_key(username, client)]
    while attempts and attempts[0] < time.monotonic() - _LOCK_WINDOW:
        attempts.popleft()
    if len(attempts) >= _LOCK_LIMIT:
        raise AuthError("登录失败次数过多，请 15 分钟后再试", 429)


def record_failure(username: str, client: str) -> None:
    _FAILURES[_throttle_key(username, client)].append(time.monotonic())


def clear_failures(username: str, client: str) -> None:
    _FAILURES.pop(_throttle_key(username, client), None)


async def authenticate(db: AsyncSession, username: str, password: str, client: str = "") -> User:
    check_throttle(username, client)
    user = await db.scalar(select(User).where(User.tenant_id == settings.tenant_id,
                                              User.username == (username or "").strip().lower()))
    # Always run one scrypt so response time does not reveal whether the account exists.
    valid = verify_password(password or "", user.password_hash if user else _DUMMY_HASH)
    if user is None or not valid:
        record_failure(username, client)
        raise AuthError("用户名或密码错误", 401)
    if user.status != "active":
        raise AuthError("账号已停用，请联系管理员", 403)
    clear_failures(username, client)
    user.last_login_at = datetime.now(UTC)
    return user


async def create_session(db: AsyncSession, user: User, user_agent: str = "") -> str:
    raw = secrets.token_urlsafe(32)
    db.add(UserSession(id=generate_id(), tenant_id=settings.tenant_id, user_id=user.id, token_hash=token_digest(raw),
                       expires_at=datetime.now(UTC) + SESSION_TTL, user_agent=user_agent[:300]))
    return raw


async def resolve_session(db: AsyncSession, raw: str) -> Principal | None:
    if not raw or len(raw) > 200:
        return None
    now = datetime.now(UTC)
    row = (await db.execute(select(UserSession, User).join(User, User.id == UserSession.user_id).where(
        UserSession.tenant_id == settings.tenant_id, User.tenant_id == settings.tenant_id,
        UserSession.token_hash == token_digest(raw), UserSession.expires_at > now, User.status == "active",
    ))).first()
    if row is None:
        return None
    session, user = row
    if session.last_seen_at is None or now - session.last_seen_at > timedelta(minutes=1):
        session.last_seen_at = now
    return principal_of(user)


async def revoke_session(db: AsyncSession, raw: str) -> None:
    await db.execute(update(UserSession).where(UserSession.tenant_id == settings.tenant_id,
                                               UserSession.token_hash == token_digest(raw))
                     .values(expires_at=datetime.now(UTC)))


async def revoke_user_sessions(db: AsyncSession, user_id: int, keep_raw: str | None = None) -> None:
    statement = update(UserSession).where(UserSession.tenant_id == settings.tenant_id, UserSession.user_id == user_id,
                                          UserSession.expires_at > datetime.now(UTC))
    if keep_raw:
        statement = statement.where(UserSession.token_hash != token_digest(keep_raw))
    await db.execute(statement.values(expires_at=datetime.now(UTC)))


async def create_api_token(db: AsyncSession, user_id: int, name: str, expires_days: int | None) -> tuple[ApiToken, str]:
    if not name.strip() or len(name) > 100:
        raise AuthError("令牌名称须为 1-100 个字符")
    if expires_days is not None and not 1 <= expires_days <= 3650:
        raise AuthError("有效期须为 1-3650 天")
    active = (await db.scalars(select(ApiToken.id).where(
        ApiToken.tenant_id == settings.tenant_id, ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None)))).all()
    if len(active) >= 20:
        raise AuthError("每个账号最多 20 个有效令牌，请先撤销不用的令牌", 409)
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = ApiToken(id=generate_id(), tenant_id=settings.tenant_id, user_id=user_id, name=name.strip(),
                   prefix=raw[:12], token_hash=token_digest(raw),
                   expires_at=datetime.now(UTC) + timedelta(days=expires_days) if expires_days else None)
    db.add(row)
    await db.flush()
    return row, raw


async def resolve_api_token(db: AsyncSession, raw: str) -> Principal | None:
    if not raw or not raw.startswith(TOKEN_PREFIX) or len(raw) > 200:
        return None
    now = datetime.now(UTC)
    row = (await db.execute(select(ApiToken, User).join(User, User.id == ApiToken.user_id).where(
        ApiToken.tenant_id == settings.tenant_id, User.tenant_id == settings.tenant_id,
        ApiToken.token_hash == token_digest(raw), ApiToken.revoked_at.is_(None), User.status == "active",
    ))).first()
    if row is None:
        return None
    token, user = row
    if token.expires_at is not None and token.expires_at <= now:
        return None
    if token.last_used_at is None or now - token.last_used_at > timedelta(minutes=1):
        token.last_used_at = now
    # Tokens act for automation: a pending forced password change does not block them.
    return principal_of(user, via="token", token_id=token.id)


def bearer(authorization: str | None) -> str:
    if authorization and authorization[:7].lower() == "bearer ":
        return authorization[7:].strip()
    return ""
