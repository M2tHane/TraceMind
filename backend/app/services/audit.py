"""Query and MCP call logs for administrators.

Query logs keep the question text only for platform libraries; personal-library queries
record metadata (who, when, which library, latency, result count) without the text.
MCP call logs never store free text: strings become their length, lists their size, and
uploaded file names keep only the extension. Logging failures never break the request.
"""
from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from loguru import logger

from app.config import settings
from app.db import Session, generate_id
from app.models import McpCallLog, QueryLog
from app.services.auth import Principal

# Tests that do not exercise auditing turn it off so they never write to a real database.
ENABLED = True
_SAFE_STRING_KEYS = {"method", "scope", "category", "status", "objective", "on_duplicate", "query_rewrite"}
_ID_SUFFIX = "_id"


def summarize_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key, value in arguments.items():
        if value is None:
            continue
        if isinstance(value, bool | int | float):
            summary[key] = value
        elif isinstance(value, str):
            if key.endswith(_ID_SUFFIX) and value.isdecimal():
                summary[key] = value
            elif key in _SAFE_STRING_KEYS and len(value) <= 40:
                summary[key] = value
            elif key == "filename":
                summary[key] = {"extension": PurePosixPath(value).suffix.lower()[:10]}
            else:
                summary[key] = {"chars": len(value)}
        elif isinstance(value, list):
            ids = all(isinstance(item, str) and item.isdecimal() for item in value)
            summary[key] = value[:20] if ids and key.endswith("_ids") else {"items": len(value)}
        elif isinstance(value, dict):
            summary[key] = {"keys": sorted(map(str, value))[:20]}
    return summary


async def log_query(principal: Principal | None, *, source: str, action: str, knowledge_base_id: int | None,
                    kb_scope: str, query: str, method: str = "", result_count: int = 0, latency_ms: float = 0,
                    error: str | None = None) -> None:
    if not ENABLED:
        return
    try:
        async with Session() as db, db.begin():
            db.add(QueryLog(id=generate_id(), tenant_id=settings.tenant_id,
                            user_id=principal.id if principal else None,
                            username=principal.username if principal else "", source=source, action=action,
                            knowledge_base_id=knowledge_base_id, kb_scope=kb_scope,
                            query=query[:4000] if kb_scope == "platform" else None, query_chars=len(query),
                            method=method[:200], result_count=result_count, latency_ms=int(latency_ms),
                            status="error" if error else "ok", error=(error or None) and error[:1000]))
    except Exception:  # noqa: BLE001 - auditing must not fail the user's request.
        logger.opt(exception=True).warning("Query log write failed")


async def log_mcp_call(principal: Principal | None, *, tool: str, arguments: dict[str, Any], transport: str,
                       latency_ms: float, error: str | None = None) -> None:
    if not ENABLED:
        return
    try:
        async with Session() as db, db.begin():
            db.add(McpCallLog(id=generate_id(), tenant_id=settings.tenant_id,
                              user_id=principal.id if principal else None,
                              username=principal.username if principal else "",
                              token_id=principal.token_id if principal else None, transport=transport, tool=tool,
                              arguments=summarize_arguments(arguments), status="error" if error else "ok",
                              error=(error or None) and error[:1000], latency_ms=int(latency_ms)))
    except Exception:  # noqa: BLE001 - auditing must not fail the tool call.
        logger.opt(exception=True).warning("MCP call log write failed")
