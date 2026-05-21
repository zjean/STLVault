import sqlite3


def ensure_bambu_credentials_table(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_bambu_credentials (
            id                INTEGER PRIMARY KEY CHECK (id = 1),
            account_email     TEXT,
            access_token      TEXT NOT NULL,
            refresh_token     TEXT,
            access_expires_at INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL
        )
        """
    )
    conn.commit()
