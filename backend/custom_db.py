"""Shared SQLite pragma wrapper for fork-only routes.

Each fork route module receives the upstream `get_db_conn` factory at startup
via `set_db_conn_factory(get_db_conn)` (or the `configure(...)` equivalent).
Upstream's factory does not set `busy_timeout` or `journal_mode`, so concurrent
writers (Centauri WebSocket ingest + history backfill + FastAPI request
handlers) race the single SQLite writer lock; the loser raises
`OperationalError: database is locked`. The Centauri ingest callback catches
that as a generic `Exception` and logs it, but the event is silently dropped.

Routes wrap their factory through `with_pragmas()` so every connection they
hand out has a 5-second busy_timeout. WAL is applied once per process the
first time a wrapped connection opens; it persists at the DB-file level so the
upstream factory benefits too on subsequent connects.
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Any, Callable

log = logging.getLogger(__name__)

BUSY_TIMEOUT_MS = 5000

_wal_applied = False


def with_pragmas(
    factory: Callable[..., sqlite3.Connection],
) -> Callable[..., sqlite3.Connection]:
    """Wrap an SQLite connection factory to apply fork pragmas.

    Per connection:
      - `busy_timeout = 5000` (ms). Default is 0 (raise immediately on lock
        contention). 5s is long enough to ride out the Centauri history
        backfill's 50-event burst on a fresh install without wedging request
        handlers.

    Once per process, idempotent at the DB-file level:
      - `journal_mode = WAL`. Lets readers not block on writers. If already
        WAL the PRAGMA is a no-op.
    """

    def _wrapped(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        global _wal_applied
        conn = factory(*args, **kwargs)
        try:
            conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        except sqlite3.Error:
            log.exception("custom_db: failed to set busy_timeout")
        if not _wal_applied:
            try:
                row = conn.execute("PRAGMA journal_mode = WAL").fetchone()
                mode = (row[0] if row else "") or ""
                if str(mode).lower() == "wal":
                    _wal_applied = True
                    log.info("custom_db: journal_mode=WAL active")
                else:
                    # Don't keep retrying every connect if WAL is unsupported
                    # (e.g. networked filesystem). Log once and move on.
                    _wal_applied = True
                    log.warning(
                        "custom_db: journal_mode=WAL requested but SQLite reports %r",
                        mode,
                    )
            except sqlite3.Error:
                _wal_applied = True
                log.exception("custom_db: failed to set journal_mode=WAL")
        return conn

    return _wrapped
