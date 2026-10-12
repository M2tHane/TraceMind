"""Add per-user memories, retrieval tuning runs and document replacement metadata."""
from pathlib import Path

from alembic import op

revision = "003_memory_retrieval"
down_revision = "002_configuration"
branch_labels = None
depends_on = None


def execute_file(name: str) -> None:
    path = Path(__file__).resolve().parents[1] / "sql" / "003_memory_retrieval" / name
    for statement in path.read_text(encoding="utf-8").split(";"):
        if statement.strip():
            op.execute(statement.strip())


def upgrade() -> None:
    execute_file("upgrade.sql")


def downgrade() -> None:
    execute_file("downgrade.sql")
