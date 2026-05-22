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
    # `wallClockMin` and `estDurationMin` measure DIFFERENT physical
    # quantities and the column names now say which:
    #   - estDurationMin = slicer's predicted ACTIVE extrusion time
    #     (toolhead moving; ignores pauses, filament changes).
    #   - wallClockMin   = user-observed elapsed time from start to
    #     finish (includes pauses). Typed by the user at completion.
    # Earlier this column was called `actDurationMin` — vague, since
    # "actual" could mean either "actual active" or "actual elapsed."
    # See migration block below for existing DBs.
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_prints (
            id                TEXT PRIMARY KEY,
            modelId           TEXT NOT NULL,
            status            TEXT NOT NULL,
            startedAt         INTEGER,
            completedAt       INTEGER,
            estDurationMin    INTEGER,
            wallClockMin      INTEGER,
            printer           TEXT,
            notes             TEXT,
            syncedToSpoolman  INTEGER NOT NULL DEFAULT 0,
            createdAt         INTEGER NOT NULL
        )
        """
    )

    # In-place rename for databases that predate this rename. SQLite
    # supports ALTER TABLE RENAME COLUMN since 3.25 (2018). The check
    # is idempotent: only renames when the old name is present and the
    # new name is not.
    cols = {row["name"] for row in cur.execute("PRAGMA table_info(custom_prints)")}
    if "actDurationMin" in cols and "wallClockMin" not in cols:
        cur.execute(
            "ALTER TABLE custom_prints RENAME COLUMN actDurationMin TO wallClockMin"
        )

    # Centauri-integration additions. Forward-only, idempotent. The
    # Centauri code adds these columns here (not in custom_centauri/) so
    # that all custom_prints schema lives in one place.
    #   - `source` distinguishes manual ("Log a print" dialog) from
    #     centauri ("printed-from-Centauri" auto-detected events).
    #   - `centauriEventId` is a soft FK to centauri_print_event.id,
    #     letting us drill from a print log entry back to the raw
    #     printer event and vice versa.
    if "source" not in cols:
        cur.execute(
            "ALTER TABLE custom_prints ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'"
        )
    if "centauriEventId" not in cols:
        cur.execute("ALTER TABLE custom_prints ADD COLUMN centauriEventId INTEGER")
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
