import sqlite3


def ensure_spoolman_settings_table(conn: sqlite3.Connection) -> None:
    """Single-row settings table — id is pinned to 1.

    Mirrors the custom_bambu_credentials pattern: a settings singleton per
    install, no per-user rows because STLVault is single-user today.
    """
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_spoolman_settings (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            base_url    TEXT,
            api_key     TEXT,
            enabled     INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL
        )
        """
    )
    conn.commit()
