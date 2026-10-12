"""Shared test setup."""
from __future__ import annotations

import os

import pytest

from app.services import audit


@pytest.fixture(autouse=True)
def _audit_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Audit logs open their own database session. Only real-database suites keep them on."""
    if not any(os.environ.get(flag) == "1" for flag in ("RAG_DB_TEST", "RAG_E2E_TEST")):
        monkeypatch.setattr(audit, "ENABLED", False)
