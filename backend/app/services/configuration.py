"""Tenant-scoped runtime settings and encrypted, immutable chat credentials."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, settings
from app.db import Session
from app.models import KnowledgeBase, ModelProfile, ServiceConfiguration
from app.services.providers import ProviderError

PROFILE_FIELDS = ("id", "name", "model", "protocol", "base_url", "max_tokens",
                  "timeout_seconds", "json_mode")


def _cipher() -> Fernet:
    # Publish a fully-written 0600 key atomically; never replace an existing key.
    folder = settings.data_dir / ".secrets"
    if folder.is_symlink():
        raise ProviderError("密钥目录不能是符号链接")
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    path = folder / "configuration.key"
    if not path.exists():
        with tempfile.NamedTemporaryFile(dir=folder, delete=False) as temporary:
            candidate = Path(temporary.name)
            try:
                temporary.write(Fernet.generate_key())
                temporary.flush()
                os.fsync(temporary.fileno())
                try:
                    os.link(candidate, path)
                except FileExistsError:
                    # A concurrent initializer published its complete key first.
                    if not path.is_file():
                        raise ProviderError("配置加密密钥不可用") from None
            finally:
                candidate.unlink()
    if path.is_symlink():
        raise ProviderError("配置加密密钥不能是符号链接")
    path.chmod(0o600)
    try:
        return Fernet(path.read_bytes())
    except (ValueError, OSError):
        raise ProviderError("配置加密密钥不可用，请恢复原密钥文件，勿重新生成") from None


def encrypt_secret(secret: str) -> str:
    return _cipher().encrypt(secret.encode("utf-8")).decode("ascii") if secret else ""


def decrypt_secret(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        return _cipher().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError):
        raise ProviderError("无法解密服务配置，请恢复原密钥文件或重新保存 API Key") from None


def index_snapshot(config: Settings) -> dict[str, Any]:
    return {name: getattr(config, name) for name in
            ("embedding_base_url", "milvus_uri", "milvus_collection")}


async def bootstrap_configuration(db: AsyncSession) -> None:
    # The marker row makes importing env one-time, even after profile archival.
    await db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": settings.tenant_id})
    existing = await db.scalar(select(ServiceConfiguration).where(
        ServiceConfiguration.tenant_id == settings.tenant_id))
    if existing is not None:
        return
    config = {
        "embedding": {"model": settings.embedding_model, "base_url": settings.embedding_base_url.rstrip("/"),
                      "dimensions": settings.embedding_dimensions},
        "rerank": {"model": settings.rerank_model, "base_url": settings.rerank_base_url.rstrip("/"),
                   "protocol": settings.rerank_protocol},
        "mineru": {"base_url": settings.mineru_base_url.rstrip("/")},
        "milvus": {"uri": settings.milvus_uri.rstrip("/"), "collection": settings.milvus_collection},
    }
    db.add(ServiceConfiguration(tenant_id=settings.tenant_id, config=config, secrets_ciphertext={
        "embedding": encrypt_secret(settings.embedding_api_key),
        "rerank": encrypt_secret(settings.rerank_api_key),
    }))
    db.add(ModelProfile(tenant_id=settings.tenant_id, name=settings.chat_model,
                        model=settings.chat_model, protocol=settings.chat_protocol,
                        base_url=settings.chat_base_url.rstrip("/"),
                        api_key_ciphertext=encrypt_secret(settings.chat_api_key),
                        is_default=True, enabled=True, is_deleted=False,
                        max_tokens=settings.max_output_tokens,
                        timeout_seconds=int(settings.model_timeout), json_mode=settings.json_mode))
    await db.execute(update(KnowledgeBase).where(
        KnowledgeBase.tenant_id == settings.tenant_id, KnowledgeBase.index_config == {},
    ).values(index_config=index_snapshot(settings)))
    await db.flush()


async def configuration_row(db: AsyncSession, lock: bool = False) -> ServiceConfiguration:
    statement = select(ServiceConfiguration).where(ServiceConfiguration.tenant_id == settings.tenant_id)
    if lock:
        statement = statement.with_for_update()
    row = await db.scalar(statement)
    if row is None:
        raise HTTPException(503, "服务配置尚未初始化，请重启后端完成初始化")
    return row


async def profile_row(db: AsyncSession, profile_id: int, lock: bool = False) -> ModelProfile:
    statement = select(ModelProfile).where(ModelProfile.tenant_id == settings.tenant_id,
                                           ModelProfile.id == profile_id, ModelProfile.is_deleted.is_(False))
    if lock:
        statement = statement.with_for_update()
    row = await db.scalar(statement)
    if row is None:
        raise HTTPException(404, "模型配置不存在")
    return row


def public_snapshot(snapshot: dict) -> dict:
    # Allowlist, not recursive redaction: unknown secret fields cannot escape.
    return {name: str(snapshot[name]) if name == "id" else snapshot[name]
            for name in PROFILE_FIELDS if name in snapshot}


def snapshot_profile(profile: ModelProfile) -> dict:
    return {**public_snapshot({name: getattr(profile, name) for name in PROFILE_FIELDS}),
            "api_key_ciphertext": profile.api_key_ciphertext}


def profile_json(profile: ModelProfile) -> dict:
    return {**public_snapshot(snapshot_profile(profile)), "api_key_set": bool(profile.api_key_ciphertext),
            "enabled": profile.enabled, "is_default": profile.is_default,
            "updated_at": profile.updated_at.isoformat() if profile.updated_at else None}


async def get_chat_snapshot(db: AsyncSession, profile_id: int | None = None) -> dict:
    if profile_id is not None:
        row = await profile_row(db, profile_id)
    else:
        row = await db.scalar(select(ModelProfile).where(ModelProfile.tenant_id == settings.tenant_id,
                              ModelProfile.is_default.is_(True), ModelProfile.is_deleted.is_(False)))
    if row is None or not row.enabled:
        raise HTTPException(409, "请选择一个已启用的对话模型")
    return snapshot_profile(row)


async def resolve_settings(model_config: dict | None = None, db: AsyncSession | None = None) -> Settings:
    if db is None:
        async with Session() as session:
            return await resolve_settings(model_config, session)
    row = await configuration_row(db)
    snapshot = model_config if model_config is not None else await get_chat_snapshot(db)
    overrides: dict[str, Any] = {}
    for service, fields in row.config.items():
        for name, val in fields.items():
            attr = f"{service}_{name}"
            if attr in Settings.model_fields:
                overrides[attr] = val
    for service in ("embedding", "rerank"):
        overrides[f"{service}_api_key"] = decrypt_secret(row.secrets_ciphertext.get(service, ""))
    overrides.update(chat_model=snapshot["model"], chat_protocol=snapshot["protocol"],
                     chat_base_url=snapshot["base_url"],
                     chat_api_key=decrypt_secret(snapshot["api_key_ciphertext"]),
                     max_output_tokens=snapshot["max_tokens"], model_timeout=snapshot["timeout_seconds"],
                     json_mode=snapshot["json_mode"])
    return settings.model_copy(update=overrides)
