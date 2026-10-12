"""Drop the unused memories.scope and memories.reviewed_by columns.

The downgrade re-adds the columns (scope defaults to 'personal', reviewed_by is empty);
values dropped by the upgrade are not restored.
"""
from pathlib import Path

from alembic import op

revision = "006_drop_memory_scope"
down_revision = "005_memory_consolidation"
branch_labels = None
depends_on = None


def execute_file(name: str) -> None:
    path = Path(__file__).resolve().parents[1] / "sql" / "006_drop_memory_scope" / name
    for statement in path.read_text(encoding="utf-8").split(";"):
        if statement.strip():
            op.execute(statement.strip())


def upgrade() -> None:
    execute_file("upgrade.sql")


def downgrade() -> None:
    execute_file("downgrade.sql")
