"""Editable model profiles; credentials are write-only and encrypted at rest."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.api.library import ResourceID
from app.config import settings
from app.configuration_schemas import ProfileCreate, ProfilePatch, TestRequest
from app.db import get_db
from app.models import ModelProfile
from app.services.configuration import (
    configuration_row,
    encrypt_secret,
    profile_json,
    profile_row,
    resolve_settings,
    snapshot_profile,
)
from app.services.providers import ProviderError, Providers

router = APIRouter()
Database = Annotated[AsyncSession, Depends(get_db)]


@router.get("/model-profiles")
async def list_profiles(db: Database) -> list[dict]:
    rows = (await db.scalars(select(ModelProfile).where(
        ModelProfile.tenant_id == settings.tenant_id, ModelProfile.is_deleted.is_(False),
    ).order_by(ModelProfile.is_default.desc(), ModelProfile.id))).all()
    return [profile_json(row) for row in rows]


async def clear_default(db: AsyncSession) -> None:
    await db.execute(update(ModelProfile).where(
        ModelProfile.tenant_id == settings.tenant_id, ModelProfile.is_default.is_(True),
    ).values(is_default=False))
    await db.flush()


@router.post("/model-profiles", status_code=201, dependencies=[Depends(require_admin)])
async def create_profile(request: ProfileCreate, db: Database) -> dict:
    await configuration_row(db, lock=True)
    fields = request.model_dump(exclude={"api_key"})
    if request.is_default and not request.enabled:
        raise HTTPException(409, "默认模型必须启用")
    if request.is_default:
        await clear_default(db)
    row = ModelProfile(tenant_id=settings.tenant_id, **fields,
                       api_key_ciphertext=encrypt_secret(request.api_key))
    db.add(row)
    await db.flush()
    return profile_json(row)


@router.patch("/model-profiles/{profile_id}", dependencies=[Depends(require_admin)])
async def patch_profile(profile_id: ResourceID, request: ProfilePatch, db: Database) -> dict:
    await configuration_row(db, lock=True)
    row = await profile_row(db, profile_id, lock=True)
    fields = request.model_dump(exclude_unset=True)
    enabled = fields.get("enabled", row.enabled)
    is_default = fields.get("is_default", row.is_default)
    if row.is_default and (not enabled or not is_default):
        raise HTTPException(409, "请先把另一个模型设为默认，再停用或移除默认状态")
    if is_default and not enabled:
        raise HTTPException(409, "默认模型必须启用")
    if fields.get("is_default"):
        await clear_default(db)
    if "api_key" in fields:
        row.api_key_ciphertext = encrypt_secret(fields.pop("api_key"))
    for name, val in fields.items():
        setattr(row, name, val)
    await db.flush()
    await db.refresh(row)
    return profile_json(row)


@router.delete("/model-profiles/{profile_id}", status_code=204, dependencies=[Depends(require_admin)])
async def delete_profile(profile_id: ResourceID, db: Database) -> Response:
    await configuration_row(db, lock=True)
    row = await profile_row(db, profile_id, lock=True)
    if row.is_default:
        raise HTTPException(409, "请先把另一个模型设为默认，再删除此模型")
    row.is_deleted, row.enabled = True, False
    # Queued jobs carry their own encrypted snapshot; profile no longer needs a credential.
    row.api_key_ciphertext = ""
    await db.flush()
    return Response(status_code=204)


@router.post("/model-profiles/{profile_id}/test", dependencies=[Depends(require_admin)])
async def test_profile(profile_id: ResourceID, request: TestRequest, db: Database) -> dict:
    row = await profile_row(db, profile_id)
    if not request.confirm:
        raise HTTPException(400, "模型测试可能产生费用，请明确确认后再测试")
    config = await resolve_settings(snapshot_profile(row), db)
    await db.rollback()
    provider = Providers(config)
    identity = {"model": config.chat_model, "protocol": config.chat_protocol}
    try:
        result = await provider.probe_chat()
        return {"success": True, "detail": "模型返回有效响应", **identity, **result}
    except ProviderError as exc:
        return {"success": False, "detail": str(exc), **identity,
                "latency_ms": 0, "usage": {"total_tokens": 0}}
    finally:
        await provider.close()
