"""Migration SQL files are split on ';', so a semicolon inside a literal would break a statement."""
import re
from pathlib import Path

import pytest

SQL_FILES = sorted((Path(__file__).resolve().parents[1] / "migrations" / "sql").glob("*/*.sql"))


@pytest.mark.parametrize("path", SQL_FILES, ids=lambda path: f"{path.parent.name}/{path.name}")
def test_no_semicolons_inside_string_literals(path: Path) -> None:
    literals = re.findall(r"'(?:[^']|'')*'", path.read_text(encoding="utf-8"))
    assert not [literal for literal in literals if ";" in literal]


def test_model_comments_contain_no_semicolons() -> None:
    from app.models import Base

    offenders = [f"{table.name}.{column.name}" for table in Base.metadata.tables.values()
                 for column in table.columns if column.comment and ";" in column.comment]
    offenders += [table.name for table in Base.metadata.tables.values() if table.comment and ";" in table.comment]
    assert offenders == []
