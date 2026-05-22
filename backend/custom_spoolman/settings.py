import sqlite3
import time
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class SpoolmanSettings:
    base_url: Optional[str]
    api_key: Optional[str]
    enabled: bool
    updated_at: int  # unix ms


def _row_to_settings(row) -> SpoolmanSettings:
    return SpoolmanSettings(
        base_url=row["base_url"] if isinstance(row, sqlite3.Row) else row[0],
        api_key=row["api_key"] if isinstance(row, sqlite3.Row) else row[1],
        enabled=bool(row["enabled"] if isinstance(row, sqlite3.Row) else row[2]),
        updated_at=row["updated_at"] if isinstance(row, sqlite3.Row) else row[3],
    )


def read(conn: sqlite3.Connection) -> Optional[SpoolmanSettings]:
    cur = conn.cursor()
    cur.execute(
        "SELECT base_url, api_key, enabled, updated_at "
        "FROM custom_spoolman_settings WHERE id = 1"
    )
    row = cur.fetchone()
    return _row_to_settings(row) if row is not None else None


def upsert(
    conn: sqlite3.Connection,
    *,
    base_url: Optional[str],
    api_key: Optional[str],
    enabled: bool,
) -> SpoolmanSettings:
    now = int(time.time() * 1000)
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO custom_spoolman_settings (id, base_url, api_key, enabled, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            base_url   = excluded.base_url,
            api_key    = excluded.api_key,
            enabled    = excluded.enabled,
            updated_at = excluded.updated_at
        """,
        (base_url, api_key, 1 if enabled else 0, now),
    )
    conn.commit()
    return SpoolmanSettings(
        base_url=base_url, api_key=api_key, enabled=enabled, updated_at=now
    )


def is_configured(s: Optional[SpoolmanSettings]) -> bool:
    return bool(s and s.enabled and s.base_url and s.base_url.strip())
