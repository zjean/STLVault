"""Forward-only migrations for the Centauri Carbon integration.

Soft FKs throughout (no REFERENCES). Mirrors `custom_prints/schema.py`:
SQLite doesn't enforce FKs by default in this codebase, and we treat
historical event rows as ground truth even when models are deleted.

Naming convention: camelCase columns matching the rest of `custom_*`.
"""

from __future__ import annotations

import sqlite3


_ENRICHMENT_COLUMNS = (
    # Phase-2.2 — per-event gcode enrichment via SDCP Cmd 321 + HTTP
    # fetch of the sliced .gcode the printer keeps under /local/.
    ("archivedGcodePath", "TEXT"),
    ("gcodeMd5", "TEXT"),
    ("taskName", "TEXT"),
    ("inputFilenameBase", "TEXT"),
)


def _add_enrichment_columns(conn: sqlite3.Connection) -> None:
    """Forward-migrate the print-event table to carry gcode enrichment.

    Idempotent. Mirrors the pattern in custom_prints/schema.py — new
    nullable columns are safe to append without rewriting historic rows.
    """
    cur = conn.cursor()
    existing = {row[1] for row in cur.execute("PRAGMA table_info(centauri_print_event)")}
    for name, sqltype in _ENRICHMENT_COLUMNS:
        if name not in existing:
            cur.execute(
                f"ALTER TABLE centauri_print_event ADD COLUMN {name} {sqltype}"
            )
    conn.commit()


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

    # Phase-4 — per-event mesh MD5s extracted from a user-attached
    # `.gcode.3mf`. One row per mesh-like inner file the parser found.
    # Soft FK to centauri_print_event.id; cascade-by-convention (cleared
    # alongside the event row when an event is purged). Composite index
    # on md5 powers the source-hash matcher's lookup against
    # centauri_model_hash without a full table scan.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS centauri_event_mesh (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            eventId     INTEGER NOT NULL,
            zipPath     TEXT NOT NULL,
            md5         TEXT NOT NULL,
            sizeBytes   INTEGER NOT NULL,
            createdAt   INTEGER NOT NULL,
            UNIQUE (eventId, zipPath)
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_centauri_event_mesh_md5 "
        "ON centauri_event_mesh(md5)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_centauri_event_mesh_eventId "
        "ON centauri_event_mesh(eventId)"
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

    # Phase-2.2 enrichment columns. Lives in its own function so the
    # migration is greppable when we add the next wave of fields.
    _add_enrichment_columns(conn)
