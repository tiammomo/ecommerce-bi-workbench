"""Enforce integer precision on previously initialized SQLite workspaces.

Triggers avoid rebuilding foreign-key-linked tables on a live local workspace.
New workspaces additionally receive equivalent named CHECK constraints in 0001.
"""

from alembic import op
from sqlalchemy import Integer
from app.models import Base

revision = "0002_precision"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    for table in Base.metadata.tables.values():
        columns = [
            column.name
            for column in table.columns
            if isinstance(column.type, Integer) and column.name.endswith(("_minor", "_scaled"))
        ]
        if not columns:
            continue
        invalid = " OR ".join(
            f"(NEW.{name} IS NOT NULL AND (typeof(NEW.{name}) != 'integer' OR NEW.{name} < -100000000000000 OR NEW.{name} > 100000000000000))"
            for name in columns
        )
        for action in ("INSERT", "UPDATE"):
            op.execute(
                f"CREATE TRIGGER IF NOT EXISTS guard_{table.name}_{action.lower()} BEFORE {action} ON {table.name} WHEN {invalid} BEGIN SELECT RAISE(ABORT, 'scaled values require bounded integer storage'); END"
            )


def downgrade():
    for table in Base.metadata.tables.values():
        for action in ("insert", "update"):
            op.execute(f"DROP TRIGGER IF EXISTS guard_{table.name}_{action}")
