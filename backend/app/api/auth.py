"""Login, logout, current account, password change and personal access tokens."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi import Path as PathParam
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import owned, scoped, serialize
from app.api.deps import CurrentUser
from app.db import get_db
from app.models import ApiToken, User
from app.schemas import InputModel
from app.services.auth import (
    SESSION_COOKIE,
    SESSION_TTL,
    AuthError,
    authenticate,
    create_api_token,
    create_session,
    hash_password,
    principal_of,
    revoke_session,
    revoke_user_sessions,
    validate_password,
    verify_password,
)

router = APIRouter(prefix="/auth")
DB = Annotated[AsyncSession, Depends(get_db)]


class LoginInput(InputModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class PasswordInput(InputModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)


class TokenInput(InputModel):
    name: str = Field(min_length=1, max_length=100)
    expires_days: int | None = Field(default=None, ge=1, le=3650)


def _client(request: Request) -> str:
    return request.client.host if request.client else ""


def token_json(row: ApiToken) -> dict[str, Any]:
    return serialize(row, exclude={"token_hash", "user_id"})


@router.post("/login")
async def login(body: LoginInput, request: Request, response: Response, db: DB) -> dict[str, Any]:
    try:
        user = await authenticate(db, body.username, body.password, _client(request))
    except AuthError as error:
        raise HTTPException(error.status, str(error)) from None
    raw = await create_session(db, user, request.headers.get("user-agent", ""))
    response.set_cookie(SESSION_COOKIE, raw, max_age=int(SESSION_TTL.total_seconds()), httponly=True,
                        samesite="lax", secure=request.url.scheme == "https", path="/")
    return principal_of(user).public()


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: DB) -> Response:
    raw = request.cookies.get(SESSION_COOKIE)
    if raw:
        await revoke_session(db, raw)
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.status_code = 204
    return response


@router.get("/me")
async def me(principal: CurrentUser) -> dict[str, Any]:
    return {**principal.public(), "via": principal.via}


@router.post("/password")
async def change_password(body: PasswordInput, request: Request, principal: CurrentUser, db: DB) -> dict[str, Any]:
    user = await owned(db, User, principal.id, lock=True)
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "当前密码不正确")
    if body.new_password == body.current_password:
        raise HTTPException(400, "新密码不能与当前密码相同")
    try:
        validate_password(body.new_password, user.username)
    except AuthError as error:
        raise HTTPException(error.status, str(error)) from None
    user.password_hash, user.must_change_password = hash_password(body.new_password), False
    # Other browsers signed in with the old password are signed out.
    await revoke_user_sessions(db, user.id, keep_raw=request.cookies.get(SESSION_COOKIE))
    await db.flush()
    return principal_of(user).public()


@router.get("/tokens")
async def list_tokens(principal: CurrentUser, db: DB) -> list[dict[str, Any]]:
    rows = (await db.scalars(scoped(ApiToken).where(ApiToken.user_id == principal.id)
                             .order_by(ApiToken.id.desc()))).all()
    return [token_json(row) for row in rows]


@router.post("/tokens", status_code=201)
async def new_token(body: TokenInput, principal: CurrentUser, db: DB) -> dict[str, Any]:
    if principal.via != "session":
        raise HTTPException(403, "请在浏览器登录后创建令牌")
    try:
        row, raw = await create_api_token(db, principal.id, body.name, body.expires_days)
    except AuthError as error:
        raise HTTPException(error.status, str(error)) from None
    await db.refresh(row)
    return {**token_json(row), "token": raw}


@router.delete("/tokens/{token_id}")
async def revoke_token(token_id: Annotated[int, PathParam(gt=0, le=2**63 - 1)], principal: CurrentUser,
                       db: DB) -> dict[str, Any]:
    row = await db.scalar(scoped(ApiToken).where(ApiToken.id == token_id, ApiToken.user_id == principal.id)
                          .with_for_update())
    if row is None:
        raise HTTPException(404, "资源不存在")
    row.revoked_at = row.revoked_at or datetime.now(UTC)
    await db.flush()
    await db.refresh(row)
    return token_json(row)
