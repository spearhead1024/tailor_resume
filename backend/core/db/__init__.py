from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from .models import Base


_engines: dict[Path, Engine] = {}
_sessionmakers: dict[Path, sessionmaker] = {}
_lock = RLock()


def _enable_sqlite_pragmas(dbapi_conn, _conn_record) -> None:
    cursor = dbapi_conn.cursor()
    cursor.execute('PRAGMA journal_mode=WAL')
    cursor.execute('PRAGMA foreign_keys=ON')
    cursor.execute('PRAGMA synchronous=NORMAL')
    cursor.close()


def _add_missing_columns(engine: Engine) -> None:
    """create_all() makes missing TABLES but never adds a column to an existing one,
    so a column added to a model later would be missing on a live DB. Add each such
    column (SQLite ALTER TABLE ADD COLUMN — additive only: nothing is dropped or
    changed). A NOT NULL column needs a server_default, or SQLite refuses it."""
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            have = {row[1] for row in conn.exec_driver_sql(f'PRAGMA table_info("{table.name}")')}
            if not have:
                continue
            for col in table.columns:
                if col.name in have:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(dialect=engine.dialect)}'
                if col.server_default is not None:
                    arg = col.server_default.arg
                    # a plain string default is a literal; a text() / func default is SQL
                    ddl += " DEFAULT " + ("'" + arg.replace("'", "''") + "'" if isinstance(arg, str) else f"({getattr(arg, 'text', arg)})")
                elif not col.nullable:
                    continue    # can't add NOT NULL without a default — leave it to a real migration
                if not col.nullable:
                    ddl += ' NOT NULL'
                try:
                    conn.exec_driver_sql(ddl)
                except OperationalError as exc:
                    # Every pm2 process runs this at start; on a deploy that adds a column, another one
                    # may have added it a moment ago. That's the outcome we wanted — not a crash.
                    if "duplicate column" not in str(exc).lower():
                        raise


def get_engine(db_path: Path) -> Engine:
    db_path = db_path.resolve()
    with _lock:
        engine = _engines.get(db_path)
        if engine is not None:
            return engine
        db_path.parent.mkdir(parents=True, exist_ok=True)
        engine = create_engine(
            f'sqlite:///{db_path}',
            future=True,
            connect_args={'check_same_thread': False, 'timeout': 30},
        )
        event.listen(engine, 'connect', _enable_sqlite_pragmas)
        Base.metadata.create_all(engine)
        _add_missing_columns(engine)
        _engines[db_path] = engine
        _sessionmakers[db_path] = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        return engine


def get_sessionmaker(db_path: Path) -> sessionmaker:
    get_engine(db_path)
    return _sessionmakers[db_path.resolve()]


@contextmanager
def session_scope(db_path: Path) -> Iterator[Session]:
    factory = get_sessionmaker(db_path)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
