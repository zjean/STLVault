"""Plain SQL repo over `custom_prints` + `custom_print_filaments`.

No ORM — the rest of the fork uses raw sqlite3 (app.py, custom_auth,
custom_importers), so we match. Each function takes a connection;
the caller owns commit/close to keep transactions composable.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


STATUS_PRINTING = "printing"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"
ALL_STATUSES = {STATUS_PRINTING, STATUS_COMPLETED, STATUS_FAILED, STATUS_CANCELLED}

DEFAULT_PRINTER = "Elegoo Centauri Carbon"


@dataclass
class PrintFilamentInput:
    spoolId: int
    estWeightG: Optional[float] = None
    usedWeightG: Optional[float] = None
    estLengthMm: Optional[float] = None
    usedLengthMm: Optional[float] = None
    # Snapshot fields (label + color) are filled by the route layer after
    # querying Spoolman, not by the caller.


def now_ms() -> int:
    return int(time.time() * 1000)


def _row_to_print(row: sqlite3.Row, filaments: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "modelId": row["modelId"],
        "status": row["status"],
        "startedAt": row["startedAt"],
        "completedAt": row["completedAt"],
        "estDurationMin": row["estDurationMin"],
        "actDurationMin": row["actDurationMin"],
        "printer": row["printer"],
        "notes": row["notes"],
        "syncedToSpoolman": bool(row["syncedToSpoolman"]),
        "createdAt": row["createdAt"],
        "filaments": filaments,
    }


def _row_to_filament(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "printId": row["printId"],
        "spoolId": row["spoolId"],
        "estWeightG": row["estWeightG"],
        "usedWeightG": row["usedWeightG"],
        "estLengthMm": row["estLengthMm"],
        "usedLengthMm": row["usedLengthMm"],
        "spoolLabel": row["spoolLabel"],
        "filamentColor": row["filamentColor"],
        "consumedAt": row["consumedAt"],
    }


def insert_print(
    conn: sqlite3.Connection,
    *,
    model_id: str,
    status: str,
    filaments: List[Dict[str, Any]],
    started_at: Optional[int] = None,
    completed_at: Optional[int] = None,
    est_duration_min: Optional[int] = None,
    act_duration_min: Optional[int] = None,
    printer: Optional[str] = None,
    notes: Optional[str] = None,
) -> str:
    """Inserts a print row + its filament children. Returns the print id.

    `filaments` items are dicts shaped like:
        { spoolId, estWeightG?, usedWeightG?, estLengthMm?,
          usedLengthMm?, spoolLabel?, filamentColor? }
    Caller is responsible for commit.
    """
    if status not in ALL_STATUSES:
        raise ValueError(f"Invalid status: {status}")

    print_id = str(uuid.uuid4())
    now = now_ms()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO custom_prints
            (id, modelId, status, startedAt, completedAt, estDurationMin,
             actDurationMin, printer, notes, syncedToSpoolman, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (
            print_id,
            model_id,
            status,
            started_at,
            completed_at,
            est_duration_min,
            act_duration_min,
            printer or DEFAULT_PRINTER,
            notes,
            now,
        ),
    )
    for f in filaments:
        cur.execute(
            """
            INSERT INTO custom_print_filaments
                (id, printId, spoolId, estWeightG, usedWeightG,
                 estLengthMm, usedLengthMm, spoolLabel, filamentColor,
                 consumedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                str(uuid.uuid4()),
                print_id,
                f["spoolId"],
                f.get("estWeightG"),
                f.get("usedWeightG"),
                f.get("estLengthMm"),
                f.get("usedLengthMm"),
                f.get("spoolLabel"),
                f.get("filamentColor"),
            ),
        )
    return print_id


def get_print(conn: sqlite3.Connection, print_id: str) -> Optional[Dict[str, Any]]:
    cur = conn.cursor()
    row = cur.execute(
        "SELECT * FROM custom_prints WHERE id = ?", (print_id,)
    ).fetchone()
    if row is None:
        return None
    filaments = [
        _row_to_filament(r)
        for r in cur.execute(
            "SELECT * FROM custom_print_filaments WHERE printId = ? "
            "ORDER BY id ASC",
            (print_id,),
        ).fetchall()
    ]
    return _row_to_print(row, filaments)


def list_prints_for_model(
    conn: sqlite3.Connection, model_id: str
) -> List[Dict[str, Any]]:
    cur = conn.cursor()
    rows = cur.execute(
        "SELECT * FROM custom_prints WHERE modelId = ? "
        "ORDER BY COALESCE(completedAt, startedAt, createdAt) DESC, createdAt DESC",
        (model_id,),
    ).fetchall()
    if not rows:
        return []
    return _hydrate_filaments(conn, rows)


def list_prints(
    conn: sqlite3.Connection,
    *,
    limit: int = 200,
    offset: int = 0,
    status: Optional[str] = None,
    spool_id: Optional[int] = None,
    model_id: Optional[str] = None,
    since_ms: Optional[int] = None,
    until_ms: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Server-side filter for the global history view (used in PR 3)."""
    cur = conn.cursor()
    where: List[str] = []
    params: List[Any] = []
    if status:
        where.append("p.status = ?")
        params.append(status)
    if model_id:
        where.append("p.modelId = ?")
        params.append(model_id)
    if since_ms is not None:
        where.append("COALESCE(p.completedAt, p.startedAt, p.createdAt) >= ?")
        params.append(since_ms)
    if until_ms is not None:
        where.append("COALESCE(p.completedAt, p.startedAt, p.createdAt) < ?")
        params.append(until_ms)
    if spool_id is not None:
        where.append(
            "p.id IN (SELECT printId FROM custom_print_filaments "
            "WHERE spoolId = ?)"
        )
        params.append(spool_id)
    sql = "SELECT p.* FROM custom_prints p"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += (
        " ORDER BY COALESCE(p.completedAt, p.startedAt, p.createdAt) DESC, "
        "p.createdAt DESC LIMIT ? OFFSET ?"
    )
    params.extend([limit, offset])
    rows = cur.execute(sql, params).fetchall()
    if not rows:
        return []
    return _hydrate_filaments(conn, rows)


def _hydrate_filaments(
    conn: sqlite3.Connection, print_rows: List[sqlite3.Row]
) -> List[Dict[str, Any]]:
    print_ids = [r["id"] for r in print_rows]
    placeholders = ",".join(["?"] * len(print_ids))
    cur = conn.cursor()
    fil_rows = cur.execute(
        f"SELECT * FROM custom_print_filaments WHERE printId IN ({placeholders}) "
        "ORDER BY id ASC",
        print_ids,
    ).fetchall()
    by_print: Dict[str, List[Dict[str, Any]]] = {pid: [] for pid in print_ids}
    for f in fil_rows:
        by_print[f["printId"]].append(_row_to_filament(f))
    return [_row_to_print(p, by_print[p["id"]]) for p in print_rows]


def update_print_fields(
    conn: sqlite3.Connection,
    print_id: str,
    *,
    status: Optional[str] = None,
    completed_at: Optional[int] = None,
    act_duration_min: Optional[int] = None,
    notes: Optional[str] = None,
) -> bool:
    """Partial update for PATCH. Returns True if a row changed."""
    sets: List[str] = []
    vals: List[Any] = []
    if status is not None:
        if status not in ALL_STATUSES:
            raise ValueError(f"Invalid status: {status}")
        sets.append("status = ?")
        vals.append(status)
    if completed_at is not None:
        sets.append("completedAt = ?")
        vals.append(completed_at)
    if act_duration_min is not None:
        sets.append("actDurationMin = ?")
        vals.append(act_duration_min)
    if notes is not None:
        sets.append("notes = ?")
        vals.append(notes)
    if not sets:
        return False
    cur = conn.cursor()
    cur.execute(
        f"UPDATE custom_prints SET {', '.join(sets)} WHERE id = ?",
        (*vals, print_id),
    )
    return cur.rowcount > 0


def update_filament_used(
    conn: sqlite3.Connection,
    print_id: str,
    *,
    spool_id: int,
    used_weight_g: Optional[float],
    used_length_mm: Optional[float],
) -> None:
    """Set the `used*` columns on the filament row matching (printId, spoolId).

    Used at completion time when the user confirms the actual consumed
    amount (which may differ from the slicer estimate).
    """
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE custom_print_filaments
        SET usedWeightG = ?, usedLengthMm = ?
        WHERE printId = ? AND spoolId = ?
        """,
        (used_weight_g, used_length_mm, print_id, spool_id),
    )


def mark_filament_consumed(
    conn: sqlite3.Connection, print_id: str, spool_id: int, *, at_ms: int
) -> None:
    cur = conn.cursor()
    cur.execute(
        "UPDATE custom_print_filaments SET consumedAt = ? "
        "WHERE printId = ? AND spoolId = ?",
        (at_ms, print_id, spool_id),
    )


def mark_synced(conn: sqlite3.Connection, print_id: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "UPDATE custom_prints SET syncedToSpoolman = 1 WHERE id = ?",
        (print_id,),
    )


def delete_print(conn: sqlite3.Connection, print_id: str) -> bool:
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM custom_print_filaments WHERE printId = ?", (print_id,)
    )
    cur.execute("DELETE FROM custom_prints WHERE id = ?", (print_id,))
    return cur.rowcount > 0


def rollup_window(
    conn: sqlite3.Connection, *, since_ms: int, until_ms: Optional[int] = None
) -> Dict[str, Any]:
    """Aggregate totals for a time window. Used by the history view in PR 3."""
    cur = conn.cursor()
    where = "COALESCE(p.completedAt, p.startedAt, p.createdAt) >= ?"
    params: List[Any] = [since_ms]
    if until_ms is not None:
        where += " AND COALESCE(p.completedAt, p.startedAt, p.createdAt) < ?"
        params.append(until_ms)
    row = cur.execute(
        f"""
        SELECT
            COUNT(DISTINCT p.id)                         AS count,
            COALESCE(SUM(p.actDurationMin),
                     SUM(p.estDurationMin), 0)           AS total_minutes,
            COALESCE(SUM(f.usedWeightG),
                     SUM(f.estWeightG), 0)               AS total_weight_g
        FROM custom_prints p
        LEFT JOIN custom_print_filaments f ON f.printId = p.id
        WHERE p.status = 'completed' AND {where}
        """,
        params,
    ).fetchone()
    return {
        "count": int(row["count"] or 0),
        "totalMinutes": int(row["total_minutes"] or 0),
        "totalWeightG": float(row["total_weight_g"] or 0),
    }
