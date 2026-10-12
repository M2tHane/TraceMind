"""Create the initial schema. SQL files are the frozen migration source."""
from pathlib import Path

from alembic import op

revision = "001_initial"
down_revision = None
branch_labels = None
depends_on = None


def execute_file(name: str) -> None:
    path = Path(__file__).resolve().parents[1] / "sql" / "001_initial" / name
    for statement in path.read_text(encoding="utf-8").split(";"):
        if statement.strip():
            op.execute(statement.strip())


def upgrade() -> None:
    execute_file("upgrade.sql")


def downgrade() -> None:
    execute_file("downgrade.sql")
