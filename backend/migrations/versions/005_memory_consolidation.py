"""Remove platform memories and add scheduled memory consolidation runs.

The downgrade drops the runs table only: deleted platform memories and their events are not restored.
"""
from pathlib import Path

from alembic import op

revision = "005_memory_consolidation"
down_revision = "004_accounts"
branch_labels = None
depends_on = None


def execute_file(name: str) -> None:
    path = Path(__file__).resolve().parents[1] / "sql" / "005_memory_consolidation" / name
    for statement in path.read_text(encoding="utf-8").split(";"):
        if statement.strip():
            op.execute(statement.strip())


def upgrade() -> None:
    execute_file("upgrade.sql")


def downgrade() -> None:
    # Deleted platform memories cannot be restored: this only removes the consolidation runs table.
    execute_file("downgrade.sql")
