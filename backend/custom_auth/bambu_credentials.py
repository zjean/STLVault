import sqlite3
from dataclasses import dataclass, replace
from typing import Optional


@dataclass(frozen=True)
class Credentials:
    account_email: Optional[str]
    access_token: str
    refresh_token: Optional[str]
    access_expires_at: int  # unix milliseconds
    updated_at: int  # unix milliseconds


def read(conn: sqlite3.Connection) -> Optional[Credentials]:
    cur = conn.cursor()
    cur.execute(
        "SELECT account_email, access_token, refresh_token, access_expires_at, updated_at "
        "FROM custom_bambu_credentials WHERE id = 1"
    )
    row = cur.fetchone()
    if row is None:
        return None
    return Credentials(
        account_email=row["account_email"] if isinstance(row, sqlite3.Row) else row[0],
        access_token=row["access_token"] if isinstance(row, sqlite3.Row) else row[1],
        refresh_token=row["refresh_token"] if isinstance(row, sqlite3.Row) else row[2],
        access_expires_at=row["access_expires_at"] if isinstance(row, sqlite3.Row) else row[3],
        updated_at=row["updated_at"] if isinstance(row, sqlite3.Row) else row[4],
    )


def upsert(conn: sqlite3.Connection, creds: Credentials) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO custom_bambu_credentials
            (id, account_email, access_token, refresh_token, access_expires_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            account_email     = excluded.account_email,
            access_token      = excluded.access_token,
            refresh_token     = excluded.refresh_token,
            access_expires_at = excluded.access_expires_at,
            updated_at        = excluded.updated_at
        """,
        (
            creds.account_email,
            creds.access_token,
            creds.refresh_token,
            creds.access_expires_at,
            creds.updated_at,
        ),
    )
    conn.commit()


def delete(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("DELETE FROM custom_bambu_credentials WHERE id = 1")
    conn.commit()


def with_new_tokens(
    existing: Credentials,
    *,
    access_token: str,
    refresh_token: Optional[str],
    access_expires_at: int,
    updated_at: int,
) -> Credentials:
    return replace(
        existing,
        access_token=access_token,
        refresh_token=refresh_token,
        access_expires_at=access_expires_at,
        updated_at=updated_at,
    )
