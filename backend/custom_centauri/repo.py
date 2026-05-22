"""SQLite persistence for Centauri events + reviews + settings.

Sync-only DB layer (matches the rest of the backend — SQLite + sqlite3.Connection
with row_factory=sqlite3.Row). Connection-factory injection so tests and the
app share the same construction pattern as `custom_prints/repo.py`.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any, Callable


DbFactory = Callable[[], sqlite3.Connection]


# --------------------------------------------------------------------- settings


def get_settings(db: DbFactory) -> dict[str, Any]:
    conn = db()
    try:
        row = conn.execute(
            "SELECT printerIp, printerName, printerUuid, "
            "       autoConfirmEnabled, lastConnectedAt "
            "FROM centauri_settings WHERE id = 1"
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return {
            "printerIp": None,
            "printerName": None,
            "printerUuid": None,
            "autoConfirmEnabled": True,
            "lastConnectedAt": None,
        }
    return {
        "printerIp": row["printerIp"],
        "printerName": row["printerName"],
        "printerUuid": row["printerUuid"],
        "autoConfirmEnabled": bool(row["autoConfirmEnabled"]),
        "lastConnectedAt": row["lastConnectedAt"],
    }


def update_settings(
    db: DbFactory,
    *,
    printer_ip: str | None = ...,
    printer_name: str | None = ...,
    printer_uuid: str | None = ...,
    auto_confirm_enabled: bool | None = ...,
) -> dict[str, Any]:
    """Partial update. Sentinel `...` means "leave alone"; None overwrites."""
    sets: list[str] = []
    args: list[Any] = []
    if printer_ip is not ...:
        sets.append("printerIp = ?")
        args.append(printer_ip)
    if printer_name is not ...:
        sets.append("printerName = ?")
        args.append(printer_name)
    if printer_uuid is not ...:
        sets.append("printerUuid = ?")
        args.append(printer_uuid)
    if auto_confirm_enabled is not ...:
        sets.append("autoConfirmEnabled = ?")
        args.append(1 if auto_confirm_enabled else 0)
    if not sets:
        return get_settings(db)
    conn = db()
    try:
        conn.execute(f"UPDATE centauri_settings SET {', '.join(sets)} WHERE id = 1", args)
        conn.commit()
    finally:
        conn.close()
    return get_settings(db)


def touch_last_connected(db: DbFactory) -> None:
    conn = db()
    try:
        conn.execute(
            "UPDATE centauri_settings SET lastConnectedAt = ? WHERE id = 1",
            (int(time.time()),),
        )
        conn.commit()
    finally:
        conn.close()


# ----------------------------------------------------------------------- events


def insert_event(db: DbFactory, event: dict[str, Any]) -> int | None:
    """Insert a print event idempotently on (printerId, sdcpJobId).

    Returns the new row id, or None if the row already existed (no side
    effects beyond logging in the caller — matches the design's
    "ON CONFLICT DO NOTHING RETURNING" semantics).
    """
    conn = db()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO centauri_print_event (
                printerId, sdcpJobId, gcodeFilename,
                startedAt, endedAt, outcome,
                estTimeMin, actTimeMin, estFilamentG, actFilamentG,
                plateCount, embeddedMeshCount, plateTransformsIdentity,
                thumbnailPath, archived3mfPath, rawPayload,
                createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (printerId, sdcpJobId) DO NOTHING
            """,
            (
                event["printerId"],
                event["sdcpJobId"],
                event["gcodeFilename"],
                event["startedAt"],
                event["endedAt"],
                event["outcome"],
                event.get("estTimeMin"),
                event.get("actTimeMin"),
                event.get("estFilamentG"),
                event.get("actFilamentG"),
                event.get("plateCount"),
                event.get("embeddedMeshCount"),
                event.get("plateTransformsIdentity"),
                event.get("thumbnailPath"),
                event.get("archived3mfPath"),
                event.get("rawPayload"),
                int(time.time()),
            ),
        )
        conn.commit()
        # lastrowid is 0 (not None) on the ON CONFLICT no-op path in
        # SQLite. Guard against that.
        if cur.rowcount == 0:
            return None
        return int(cur.lastrowid)
    finally:
        conn.close()


def list_events(
    db: DbFactory,
    *,
    reviewed: bool | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List events, newest-first.

    `reviewed=False` returns only events without a review row (the inbox).
    `reviewed=True` returns only reviewed events (history/audit).
    `reviewed=None` returns everything.
    """
    where = ""
    if reviewed is True:
        where = "WHERE EXISTS (SELECT 1 FROM centauri_review WHERE eventId = e.id)"
    elif reviewed is False:
        where = "WHERE NOT EXISTS (SELECT 1 FROM centauri_review WHERE eventId = e.id)"

    conn = db()
    try:
        rows = conn.execute(
            f"""
            SELECT e.* FROM centauri_print_event e
            {where}
            ORDER BY e.startedAt DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_event(r) for r in rows]


def get_event(db: DbFactory, event_id: int) -> dict[str, Any] | None:
    conn = db()
    try:
        row = conn.execute(
            "SELECT * FROM centauri_print_event WHERE id = ?", (event_id,)
        ).fetchone()
    finally:
        conn.close()
    return _row_to_event(row) if row else None


def _row_to_event(row: sqlite3.Row) -> dict[str, Any]:
    raw = row["rawPayload"]
    parsed_raw: dict[str, Any] | None
    try:
        parsed_raw = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        parsed_raw = None
    return {
        "id": row["id"],
        "printerId": row["printerId"],
        "sdcpJobId": row["sdcpJobId"],
        "gcodeFilename": row["gcodeFilename"],
        "startedAt": row["startedAt"],
        "endedAt": row["endedAt"],
        "outcome": row["outcome"],
        "estTimeMin": row["estTimeMin"],
        "actTimeMin": row["actTimeMin"],
        "estFilamentG": row["estFilamentG"],
        "actFilamentG": row["actFilamentG"],
        "plateCount": row["plateCount"],
        "embeddedMeshCount": row["embeddedMeshCount"],
        "plateTransformsIdentity": (
            bool(row["plateTransformsIdentity"])
            if row["plateTransformsIdentity"] is not None
            else None
        ),
        "thumbnailPath": row["thumbnailPath"],
        "archived3mfPath": row["archived3mfPath"],
        "rawPayloadParsed": parsed_raw,
        "createdAt": row["createdAt"],
    }


# ---------------------------------------------------------------------- reviews


def get_review(db: DbFactory, event_id: int) -> dict[str, Any] | None:
    conn = db()
    try:
        row = conn.execute(
            "SELECT * FROM centauri_review WHERE eventId = ?", (event_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "eventId": row["eventId"],
        "reviewedAt": row["reviewedAt"],
        "action": row["action"],
        "reason": row["reason"],
        "resultingPrintId": row["resultingPrintId"],
        "resultingModelId": row["resultingModelId"],
    }


def upsert_review(
    db: DbFactory,
    event_id: int,
    action: str,
    *,
    reason: str | None = None,
    resulting_print_id: str | None = None,
    resulting_model_id: str | None = None,
) -> dict[str, Any]:
    """Idempotent per event_id — `INSERT ... ON CONFLICT DO UPDATE`.

    Phase-1 callers use `action='confirm' | 'dismiss'`. Phase 2 adds
    `reassign | create | reserve | auto`.
    """
    now = int(time.time())
    conn = db()
    try:
        conn.execute(
            """
            INSERT INTO centauri_review (
                eventId, reviewedAt, action, reason,
                resultingPrintId, resultingModelId
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(eventId) DO UPDATE SET
                reviewedAt        = excluded.reviewedAt,
                action            = excluded.action,
                reason            = excluded.reason,
                resultingPrintId  = excluded.resultingPrintId,
                resultingModelId  = excluded.resultingModelId
            """,
            (event_id, now, action, reason, resulting_print_id, resulting_model_id),
        )
        conn.commit()
    finally:
        conn.close()
    review = get_review(db, event_id)
    assert review is not None
    return review


def count_unreviewed(db: DbFactory) -> int:
    conn = db()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM centauri_print_event e "
            "WHERE NOT EXISTS (SELECT 1 FROM centauri_review WHERE eventId = e.id)"
        ).fetchone()
    finally:
        conn.close()
    return int(row["c"]) if row else 0


# ------------------------------------------- print-log entries (writes for confirm)


def create_print_log_from_event(
    db: DbFactory, event: dict[str, Any], model_id: str
) -> str:
    """Write a `custom_prints` row for a confirmed event.

    Phase-1 confirm writes a minimal row — status='logged', source='centauri',
    timing from the event, no filament rows yet (filament weight is
    file-derived and we don't have it in Phase 1). User can edit/log
    filament manually via the existing ModelPrintsSection editor.
    """
    print_id = str(uuid.uuid4())
    now = int(time.time())
    started_ms = (event["startedAt"] or now) * 1000
    completed_ms = (event["endedAt"] or now) * 1000

    # custom_prints uses 'logged' / 'started' / 'completed' status values
    # (see custom_prints/schema.py). 'logged' matches manual entries.
    status = "logged"
    conn = db()
    try:
        conn.execute(
            """
            INSERT INTO custom_prints (
                id, modelId, status, startedAt, completedAt,
                estDurationMin, wallClockMin, printer, notes,
                syncedToSpoolman, createdAt, source, centauriEventId
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'centauri', ?)
            """,
            (
                print_id,
                model_id,
                status,
                started_ms,
                completed_ms,
                event.get("estTimeMin"),
                event.get("actTimeMin"),
                "Centauri Carbon",
                f"Auto-imported from printer (job {event['sdcpJobId']})",
                now,
                event["id"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return print_id
