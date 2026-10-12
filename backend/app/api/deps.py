"""Request authentication: browser session cookie or personal access token (Bearer)."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.services.auth import SESSION_COOKIE, Principal, bearer, resolve_api_token, resolve_session

# Endpoints a session with a pending forced password change may still use.
_PASSWORD_CHANGE_PATHS = ("/api/auth/me", "/api/auth/password", "/api/auth/logout")


async def current_principal(request: Request, db: Annotated[AsyncSession, Depends(get_db)]) -> Principal:
    cached = getattr(request.state, "principal", None)
    if cached is not None:
        return cached
    raw = bearer(request.headers.get("authorization"))
    principal = await resolve_api_token(db, raw) if raw else None
    if principal is None and not raw:
        cookie = request.cookies.get(SESSION_COOKIE, "")
        principal = await resolve_session(db, cookie) if cookie else None
    if principal is None:
        raise HTTPException(401, "请先登录")
    if (principal.via == "session" and principal.must_change_password
            and request.url.path not in _PASSWORD_CHANGE_PATHS):
        raise HTTPException(403, "请先修改初始密码")
    request.state.principal = principal
    return principal


async def require_admin(principal: Annotated[Principal, Depends(current_principal)]) -> Principal:
    if not principal.is_admin:
        raise HTTPException(403, "需要管理员权限")
    return principal


CurrentUser = Annotated[Principal, Depends(current_principal)]
AdminUser = Annotated[Principal, Depends(require_admin)]
