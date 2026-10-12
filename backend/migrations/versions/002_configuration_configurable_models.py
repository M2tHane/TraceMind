"""Add configurable models and public message snapshots without changing existing records."""
from pathlib import Path

from alembic import op

revision = "002_configuration"
down_revision = "001_initial"
branch_labels = None
depends_on = None


def execute_file(name: str) -> None:
    path = Path(__file__).resolve().parents[1] / "sql" / "002_configuration" / name
    for statement in path.read_text(encoding="utf-8").split(";"):
        if statement.strip():
            op.execute(statement.strip())


def upgrade() -> None:
    execute_file("upgrade.sql")


def downgrade() -> None:
    execute_file("downgrade.sql")
