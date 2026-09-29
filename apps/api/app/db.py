from contextlib import contextmanager
from pathlib import Path
import os

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[3]
DB_PATH = Path(os.getenv("DATABASE_PATH", str(ROOT / ".localdata/workbench.sqlite3")))
if not DB_PATH.is_absolute():
    DB_PATH = ROOT / DB_PATH
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def make_engine(path):
    db_engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False, "timeout": 5})

    @event.listens_for(db_engine, "connect")
    def configure(dbapi_conn, _):
        dbapi_conn.isolation_level = None
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    @event.listens_for(db_engine, "begin")
    def begin(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE" if conn.info.get("write_transaction") else "BEGIN")

    return db_engine


engine = make_engine(DB_PATH)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session():
    with SessionLocal() as session:
        yield session


@contextmanager
def write_session():
    with engine.connect() as connection:
        connection.info["write_transaction"] = True
        try:
            with sessionmaker(bind=connection, expire_on_commit=False)() as session:
                with session.begin():
                    yield session
        finally:
            connection.info.pop("write_transaction", None)
