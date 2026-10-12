"""Add accounts, sessions, API tokens, audit logs and platform/personal scopes."""
from pathlib import Path

from alembic import op

revision = "004_accounts"
down_revision = "003_memory_retrieval"
branch_labels = None
depends_on = None


def execute_file(name: str) -> None:
    path = Path(__file__).resolve().parents[1] / "sql" / "004_accounts" / name
    for statement in path.read_text(encoding="utf-8").split(";"):
        if statement.strip():
            op.execute(statement.strip())


def upgrade() -> None:
    execute_file("upgrade.sql")


def downgrade() -> None:
    execute_file("downgrade.sql")
