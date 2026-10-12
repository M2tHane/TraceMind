"""Read-only, secret-free local environment diagnostics and bundled examples."""
# ruff: noqa: BLE001 -- Diagnostic boundaries must never expose raw connection exceptions.
from __future__ import annotations

import asyncio
import traceback
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from loguru import logger
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.config import ROOT, Settings, settings
from app.db import get_db
from app.services.configuration import resolve_settings

router = APIRouter()
EXAMPLE_NAMES = ("attention.pdf", "rag.pdf", "react.pdf", "lora.pdf")


def _log_failure(operation: str, error: BaseException) -> None:
    safe_error = RuntimeError(f"{operation} ({type(error).__name__})")
    stack = " > ".join(f"{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__))
    logger.opt(exception=(RuntimeError, safe_error, None)).error(
        "System diagnostic failed: operation={}, stack={}", operation, stack, exc_info=True
    )


def safe_base_url(base_url: str) -> str:
    """Expose an HTTP(S) endpoint without credentials, query strings or fragments."""
    try:
        if any(ord(char) < 32 or ord(char) == 127 for char in base_url):
            return ""
        parts = urlsplit(base_url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return ""
        host = parts.hostname
        if ":" in host:
            host = f"[{host}]"
        if parts.port is not None:
            host = f"{host}:{parts.port}"
        return urlunsplit((parts.scheme, host, parts.path.rstrip("/"), "", ""))
    except ValueError:
        return ""


async def _database_available(db: AsyncSession) -> bool:
    try:
        await asyncio.wait_for(db.execute(text("SELECT 1")), timeout=5)
        return True
    except Exception as error:
        _log_failure("database_health", error)
        try:
            await db.rollback()
        except Exception as rollback_error:
            _log_failure("database_health_rollback", rollback_error)
        return False


@router.get("/health")
async def health(response: Response, db: Annotated[AsyncSession, Depends(get_db)]) -> dict[str, str]:
    if await _database_available(db):
        return {"status": "ok", "database": "connected"}
    response.status_code = 503
    return {"status": "degraded", "database": "unavailable"}


async def _check_mineru(config: Settings = settings) -> dict[str, str]:
    base_url = safe_base_url(config.mineru_base_url)
    if not base_url:
        return {"name": "MinerU", "status": "failed", "detail": "未配置有效的 MinerU 服务地址"}
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False) as client:
            response = await client.get(base_url.rstrip("/") + "/health")
            if response.status_code != 200:
                return {"name": "MinerU", "status": "failed", "detail": "MinerU 健康检查未通过，请检查服务"}
        return {"name": "MinerU", "status": "ok", "detail": "健康检查通过；未上传文件或执行解析"}
    except Exception as error:
        _log_failure("mineru_health", error)
        return {"name": "MinerU", "status": "failed", "detail": "无法连接 MinerU，请检查地址与服务状态"}


def _milvus_version(config: Settings = settings) -> None:
    # A read-only connectivity probe. Never use VectorStore.ensure() here: it can create a collection.
    from pymilvus import MilvusClient

    client = MilvusClient(uri=config.milvus_uri, timeout=5)
    try:
        client.get_server_version(timeout=5)
    finally:
        client.close()


async def _check_milvus(config: Settings = settings) -> dict[str, str]:
    if not config.milvus_uri.strip():
        return {"name": "Milvus", "status": "not_configured", "detail": "未配置向量存储，已跳过连接检查"}
    try:
        await asyncio.wait_for(asyncio.to_thread(_milvus_version, config), timeout=12)
        return {"name": "Milvus", "status": "ok", "detail": "连接检查通过；未创建、修改或加载集合"}
    except Exception as error:
        _log_failure("milvus_health", error)
        return {"name": "Milvus", "status": "failed", "detail": "无法连接 Milvus，请检查向量存储服务"}


@router.post("/settings/check", dependencies=[Depends(require_admin)])
async def check_settings(db: Annotated[AsyncSession, Depends(get_db)]) -> dict[str, list[dict[str, str]]]:
    database_ok = await _database_available(db)
    checks = [{"name": "PostgreSQL", "status": "ok" if database_ok else "failed",
               "detail": "数据库连接正常" if database_ok else "无法连接数据库，请检查后端配置与服务"}]
    config = await resolve_settings(db=db)
    checks.append(await _check_mineru(config))
    checks.append(await _check_milvus(config))
    for name, secret in (("对话模型", config.chat_api_key),
                         ("向量模型", config.embedding_api_key),
                         ("重排序模型", config.rerank_api_key)):
        configured = bool(secret.strip())
        checks.append({"name": name, "status": "configured" if configured else "not_configured",
                       "detail": "密钥已配置；未调用模型，不代表调用已验证" if configured
                       else "密钥未配置；未调用模型"})
    return {"checks": checks}


def example_pdf(name: str) -> Path:
    """Resolve only a known bundled PDF; arbitrary filenames and symlinks are denied."""
    if name not in EXAMPLE_NAMES:
        raise HTTPException(404, "示例 PDF 不存在")
    root = (ROOT / "examples" / "pdfs").resolve()
    path = root / name
    if path.is_symlink() or path.resolve().parent != root or not path.is_file():
        raise HTTPException(404, "示例 PDF 尚未安装，请检查示例文件目录")
    return path


@router.get("/examples", dependencies=[Depends(require_admin)])
async def list_examples() -> list[dict[str, str]]:
    examples = []
    for name in EXAMPLE_NAMES:
        try:
            example_pdf(name)
        except HTTPException:
            continue  # Uninstalled examples are intentionally not advertised as available downloads.
        except OSError as error:
            _log_failure("list_examples", error)
            raise HTTPException(500, "读取示例文件失败，请检查文件权限") from None
        examples.append({"name": name, "url": f"/api/examples/{name}"})
    return examples


@router.get("/examples/{name}", dependencies=[Depends(require_admin)])
async def get_example(name: str) -> FileResponse:
    try:
        return FileResponse(example_pdf(name), media_type="application/pdf", filename=name,
                            headers={"X-Content-Type-Options": "nosniff"})
    except HTTPException:
        raise
    except OSError as error:
        _log_failure("get_example", error)
        raise HTTPException(500, "读取示例 PDF 失败，请检查文件权限") from None
