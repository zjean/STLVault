"""Forward-only migrations for the Centauri Carbon integration.

Soft FKs throughout (no REFERENCES). Mirrors `custom_prints/schema.py`:
SQLite doesn't enforce FKs by default in this codebase, and we treat
historical event rows as ground truth even when models are deleted.

Naming convention: camelCase columns matching the rest of `custom_*`.
"""

from __future__ import annotations

import sqlite3


def ensure_centauri_tables(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()

    # Singleton settings row. Multi-printer would replace this with a
    # `centauri_printer` keyed table; out of scope for v1.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS centauri_settings (
            id                  INTEGER PRIMARY KEY CHECK (id = 1),
            printerIp           TEXT,
            printerName         TEXT,
            printerUuid         TEXT,
            autoConfirmEnabled  INTEGER NOT NULL DEFAULT 1,
            lastConnectedAt     INTEGER
        )
        """
    )

    # Raw printer-event log. One row per terminal job transition.
    # Idempotent on (printerId, sdcpJobId) so reconnect-and-replay is safe.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS centauri_print_event (
            id                       INTEGER PRIMARY KEY AUTOINCREMENT,
            printerId                TEXT NOT NULL,
            sdcpJobId                TEXT NOT NULL,
            gcodeFilename            TEXT NOT NULL,
            startedAt                INTEGER NOT NULL,
            endedAt                  INTEGER,
            outcome                  TEXT NOT NULL
                                     CHECK (outcome IN ('completed','failed','cancelled')),
            estTimeMin               INTEGER,
            actTimeMin               INTEGER,
            estFilamentG             REAL,
            actFilamentG             REAL,
            plateCount               INTEGER,
            embeddedMeshCount        INTEGER,
            plateTransformsIdentity  INTEGER,
            thumbnailPath            TEXT,
            archived3mfPath          TEXT,
            rawPayload               TEXT,
            createdAt                INTEGER NOT NULL,
            UNIQUE (printerId, sdcpJobId)
        )
        """
    )

    # Matcher output. Many candidates per event when signals overlap.
    # Soft FK to centauri_print_event.id.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS centauri_match_candidate (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            eventId     INTEGER NOT NULL,
            modelId     TEXT NOT NULL,
            signal      TEXT NOT NULL,
            confidence  REAL NOT NULL,
            reason      TEXT
        )
        """
    )

    # Review decisions. One per event (PK = eventId — review is terminal).
    # Phase-1 actions: 'confirm' | 'dismiss'. Phase-2/3 add: 'reassign' |
    # 'create' | 'reserve' | 'auto'.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS centauri_review (
            eventId           INTEGER PRIMARY KEY,
            reviewedAt        INTEGER NOT NULL,
            action            TEXT NOT NULL,
            reason            TEXT,
            resultingPrintId  TEXT,
            resultingModelId  TEXT
        )
        """
    )

    # Side table for model MD5s — keeps the matcher's hash signal possible
    # without modifying the upstream `models` table (which would conflict
    # on upstream sync per CLAUDE.md). Populated by the Phase-2 backfill +
    # per-upload computation.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS centauri_model_hash (
            modelId      TEXT PRIMARY KEY,
            sourceMd5    TEXT NOT NULL,
            embeddedMd5  TEXT,
            computedAt   INTEGER NOT NULL
        )
        """
    )

    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_centauri_event_startedAt "
        "ON centauri_print_event(startedAt DESC)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_centauri_event_outcome "
        "ON centauri_print_event(outcome)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_centauri_match_eventId "
        "ON centauri_match_candidate(eventId)"
    )

    # Seed the singleton settings row.
    cur.execute("INSERT OR IGNORE INTO centauri_settings (id) VALUES (1)")
    conn.commit()
