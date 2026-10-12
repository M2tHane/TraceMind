"""Editable service settings and explicitly confirmed, bounded probes."""
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.system import _check_milvus, _check_mineru, _database_available, safe_base_url
from app.configuration_schemas import SettingsPatch, TestRequest
from app.db import get_db
from app.services.configuration import (
    configuration_row,
    encrypt_secret,
    get_chat_snapshot,
    resolve_settings,
)
from app.services.providers import ProviderError, Providers

router = APIRouter()
Database = Annotated[AsyncSession, Depends(get_db)]


async def settings_json(db: AsyncSession) -> dict:
    config = await resolve_settings(db=db)
    profile = await get_chat_snapshot(db)
    return {
        "chat": {"model": config.chat_model, "base_url": safe_base_url(config.chat_base_url),
                 "configured": bool(config.chat_api_key), "profile_id": profile["id"],
                 "protocol": config.chat_protocol},
        "embedding": {"model": config.embedding_model, "base_url": safe_base_url(config.embedding_base_url),
                      "configured": bool(config.embedding_api_key), "dimensions": config.embedding_dimensions},
        "rerank": {"model": config.rerank_model, "base_url": safe_base_url(config.rerank_base_url),
                   "configured": bool(config.rerank_api_key), "protocol": config.rerank_protocol},
        "mineru": {"base_url": safe_base_url(config.mineru_base_url)},
        "milvus": {"uri": safe_base_url(config.milvus_uri), "collection": config.milvus_collection},
        "storage": {"backend": "PostgreSQL + Milvus", "local_only": True},
        "config_file": "backend/.env", "editable": True,
    }


@router.get("/settings")
async def get_settings(db: Database) -> dict:
    return await settings_json(db)


@router.patch("/settings")
async def patch_settings(request: SettingsPatch, db: Database) -> dict:
    row = await configuration_row(db, lock=True)
    config = {name: dict(fields) for name, fields in row.config.items()}
    secrets = dict(row.secrets_ciphertext)
    for service, fields in request.model_dump(exclude_unset=True).items():
        if "api_key" in fields:
            secrets[service] = encrypt_secret(fields.pop("api_key"))
        config[service] = {**config.get(service, {}), **fields}
    row.config, row.secrets_ciphertext = config, secrets
    await db.flush()
    return await settings_json(db)


@router.post("/settings/test/{service}")
async def test_service(service: Literal["embedding", "rerank", "mineru", "milvus", "postgres"],
                       request: TestRequest, db: Database) -> dict:
    if service in {"embedding", "rerank"} and not request.confirm:
        raise HTTPException(400, "模型测试可能产生费用，请明确确认后再测试")
    started = time.monotonic()
    if service == "postgres":
        success = await _database_available(db)
        return {"success": success, "detail": "数据库连接正常" if success else "数据库连接失败",
                "latency_ms": round((time.monotonic() - started) * 1000)}
    config = await resolve_settings(db=db)
    await db.rollback()
    if service in {"mineru", "milvus"}:
        result = await (_check_mineru(config) if service == "mineru" else _check_milvus(config))
        return {"success": result["status"] == "ok", "detail": result["detail"],
                "latency_ms": round((time.monotonic() - started) * 1000)}
    provider = Providers(config)
    try:
        usage = None
        if service == "embedding":
            _, metadata = await provider.embed(["Connectivity test"])
            usage = {"total_tokens": metadata.get("total_tokens", 0)}
        else:
            await provider.rerank("connectivity", [{"id": "probe", "text": "Connectivity test"}])
        result = {"success": True, "detail": "模型返回有效响应",
                  "latency_ms": round((time.monotonic() - started) * 1000)}
        if usage is not None:
            result["usage"] = usage
        return result
    except ProviderError as exc:
        return {"success": False, "detail": str(exc),
                "latency_ms": round((time.monotonic() - started) * 1000)}
    finally:
        await provider.close()
