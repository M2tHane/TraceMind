"""Shared test setup."""
from __future__ import annotations

import os

import pytest

from app.services import audit

# Fixtures that run a test in a throwaway tenant and delete it afterwards.
ISOLATED_TENANT_FIXTURES = {"tenant", "workspace", "world"}


@pytest.fixture(autouse=True)
def _audit_off(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Audit logs open their own session on ``settings.tenant_id``.

    Outside an isolated tenant that is the developer's real tenant, so offline tests (which mock the
    database) would leave query and MCP logs in it. Only isolated real-database tests keep auditing on.
    """
    if not any(os.environ.get(flag) == "1" for flag in ("RAG_DB_TEST", "RAG_E2E_TEST")) \
            or not ISOLATED_TENANT_FIXTURES & set(request.fixturenames):
        monkeypatch.setattr(audit, "ENABLED", False)
