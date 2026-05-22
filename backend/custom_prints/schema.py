import sqlite3


def ensure_prints_tables(conn: sqlite3.Connection) -> None:
    """Forward-only migration for the prints concept.

    Two tables — `custom_prints` and `custom_print_filaments`. The split
    keeps multi-spool prints honest (color swaps, AMS-equivalents) even
    though v1 UI only ever shows a single filament row.

    Foreign-key relationships are intentionally soft (no FK constraint):
    - `modelId` -> upstream `models.id`. SQLite doesn't enforce FKs by
      default, and deleting the model row shouldn't cascade-delete
      print history (history is the record that the print happened).
    - `spoolId` -> Spoolman, lives in a different DB entirely.
    """
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_prints (
            id                TEXT PRIMARY KEY,
            modelId           TEXT NOT NULL,
            status            TEXT NOT NULL,
            startedAt         INTEGER,
            completedAt       INTEGER,
            estDurationMin    INTEGER,
            actDurationMin    INTEGER,
            printer           TEXT,
            notes             TEXT,
            syncedToSpoolman  INTEGER NOT NULL DEFAULT 0,
            createdAt         INTEGER NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_print_filaments (
            id              TEXT PRIMARY KEY,
            printId         TEXT NOT NULL,
            spoolId         INTEGER NOT NULL,
            estWeightG      REAL,
            usedWeightG     REAL,
            estLengthMm     REAL,
            usedLengthMm    REAL,
            spoolLabel      TEXT,
            filamentColor   TEXT,
            consumedAt      INTEGER
        )
        """
    )
    # Index for the global history view + per-model history fetches.
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_prints_modelId "
        "ON custom_prints(modelId)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_prints_createdAt "
        "ON custom_prints(createdAt DESC)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_print_filaments_printId "
        "ON custom_print_filaments(printId)"
    )
    conn.commit()
