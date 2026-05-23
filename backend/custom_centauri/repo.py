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
                archivedGcodePath, gcodeMd5, taskName, inputFilenameBase,
                createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                event.get("archivedGcodePath"),
                event.get("gcodeMd5"),
                event.get("taskName"),
                event.get("inputFilenameBase"),
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


def event_exists(db: DbFactory, printer_id: str, sdcp_job_id: str) -> bool:
    """Fast existence probe used by the history backfill.

    Cheaper than calling `insert_event` and catching the no-op — avoids
    a write transaction. Hits the existing UNIQUE index, so it's a
    single indexed lookup.
    """
    conn = db()
    try:
        row = conn.execute(
            "SELECT 1 FROM centauri_print_event "
            "WHERE printerId = ? AND sdcpJobId = ? LIMIT 1",
            (printer_id, sdcp_job_id),
        ).fetchone()
    finally:
        conn.close()
    return row is not None


def list_events(
    db: DbFactory,
    *,
    reviewed: bool | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List events, newest-first.

    `reviewed=False` returns events still actionable from the inbox: no
    review row, OR a non-terminal review (currently only `action='reserve'`
    — a user-deferred decision that's awaiting a future upload to link).
    `reviewed=True` returns terminally-reviewed events (confirm/dismiss/auto).
    `reviewed=None` returns everything.
    """
    where = ""
    if reviewed is True:
        where = (
            "WHERE EXISTS ("
            "  SELECT 1 FROM centauri_review WHERE eventId = e.id"
            "    AND action != 'reserve'"
            ")"
        )
    elif reviewed is False:
        where = (
            "WHERE NOT EXISTS ("
            "  SELECT 1 FROM centauri_review WHERE eventId = e.id"
            "    AND action != 'reserve'"
            ")"
        )

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
        "archivedGcodePath": _safe_col(row, "archivedGcodePath"),
        "gcodeMd5": _safe_col(row, "gcodeMd5"),
        "taskName": _safe_col(row, "taskName"),
        "inputFilenameBase": _safe_col(row, "inputFilenameBase"),
        "rawPayloadParsed": parsed_raw,
        "createdAt": row["createdAt"],
    }


def _safe_col(row: sqlite3.Row, name: str) -> Any:
    """Lookup a column that may not exist on an old row factory.

    Belt-and-braces — `ensure_centauri_tables` runs the forward
    migration at startup, but this guard means a pre-migration unit
    test or a partial migration won't crash the listing path.
    """
    try:
        return row[name]
    except (IndexError, KeyError):
        return None


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
    """Inbox badge count.

    Reserves count as unreviewed — they're a deferred decision, still
    pending action from the user even though a review row exists.
    """
    conn = db()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM centauri_print_event e "
            "WHERE NOT EXISTS ("
            "  SELECT 1 FROM centauri_review WHERE eventId = e.id"
            "    AND action != 'reserve'"
            ")"
        ).fetchone()
    finally:
        conn.close()
    return int(row["c"]) if row else 0


# ---------------------------------------------------------------------- reserves


def list_recent_reserves(db: DbFactory, since_days: int = 30) -> list[dict[str, Any]]:
    """Reserved events newer than `since_days`, newest-first.

    Used by the upload-page post-upload dialog ("Link to a recent print?").
    Joins event + review so callers get the reserve's age plus the print
    metadata in one round-trip.
    """
    cutoff = int(time.time()) - since_days * 86_400
    conn = db()
    try:
        rows = conn.execute(
            """
            SELECT e.*, r.reviewedAt AS reservedAt, r.reason AS reserveReason
            FROM centauri_print_event e
            JOIN centauri_review r ON r.eventId = e.id
            WHERE r.action = 'reserve'
              AND r.reviewedAt >= ?
            ORDER BY r.reviewedAt DESC
            """,
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    out: list[dict[str, Any]] = []
    for r in rows:
        ev = _row_to_event(r)
        ev["reservedAt"] = r["reservedAt"]
        out.append(ev)
    return out


# ---------------------------------------------------------------------- auto-confirm


_HIGH_CONFIDENCE_SIGNALS = ("printer_filename", "source_hash")


def get_auto_confirm_candidate(db: DbFactory, event_id: int) -> tuple[str, str] | None:
    """Return (model_id, anchor_signal) that should auto-confirm, or None.

    Eligible when:
      - at least one high-confidence signal fired:
          * `printer_filename` — slicer-template-extracted name match, OR
          * `source_hash` — embedded mesh MD5 matches a model's hash row
            (Phase-4; needs `.gcode.3mf` attached to this event), AND
      - all candidate rows across every signal point to the same single
        model_id (nothing disagrees).

    The basic `filename` signal can't fire on Centauri-side filenames
    in practice — the printer stores prefix-heavy `.gcode`
    (`ECC_0.4_<name>_PLA0.12_4h25m.gcode`) which the simple stem
    normaliser doesn't decode. So we anchor the gate on the two
    higher-confidence signals and treat any other signal (including
    `filename`) as confirmatory rather than required.

    Multi-hit candidates write multiple rows with different model_ids,
    so the "len(model_ids) == 1" check rejects them.

    Returns the anchor signal alongside the model id so the caller can
    write a meaningful audit reason on the review row.
    """
    conn = db()
    try:
        rows = conn.execute(
            "SELECT signal, modelId FROM centauri_match_candidate WHERE eventId = ?",
            (event_id,),
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return None
    anchor = next(
        (r["signal"] for r in rows if r["signal"] in _HIGH_CONFIDENCE_SIGNALS),
        None,
    )
    if anchor is None:
        return None
    model_ids = {r["modelId"] for r in rows}
    if len(model_ids) != 1:
        return None
    return next(iter(model_ids)), anchor


def list_recent_auto_matched(
    db: DbFactory, hours: int = 24
) -> list[dict[str, Any]]:
    """Auto-confirmed events newer than `hours` ago, newest-first.

    Feeds the inbox's "Recently auto-matched" panel where the user can
    undo within the 24-hour window from the design.
    """
    cutoff = int(time.time()) - hours * 3600
    conn = db()
    try:
        rows = conn.execute(
            """
            SELECT e.*,
                   r.reviewedAt AS autoMatchedAt,
                   r.resultingPrintId,
                   r.resultingModelId
            FROM centauri_print_event e
            JOIN centauri_review r ON r.eventId = e.id
            WHERE r.action = 'auto'
              AND r.reviewedAt >= ?
            ORDER BY r.reviewedAt DESC
            """,
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    out: list[dict[str, Any]] = []
    for r in rows:
        ev = _row_to_event(r)
        ev["autoMatchedAt"] = r["autoMatchedAt"]
        ev["resultingPrintId"] = r["resultingPrintId"]
        ev["resultingModelId"] = r["resultingModelId"]
        out.append(ev)
    return out


def delete_print_log(db: DbFactory, print_id: str) -> bool:
    """Delete a `custom_prints` row by id. Returns True if a row was deleted.

    Used by the auto-confirm undo path. Idempotent — missing rows return
    False rather than raising. We deliberately don't touch Spoolman:
    auto-confirmed prints land with `syncedToSpoolman=0` so there's no
    spool to unwind.
    """
    conn = db()
    try:
        cur = conn.execute(
            "DELETE FROM custom_prints WHERE id = ?", (print_id,)
        )
        conn.commit()
        return (cur.rowcount or 0) > 0
    finally:
        conn.close()


def clear_review(db: DbFactory, event_id: int) -> bool:
    """Remove the review row so the event re-enters the inbox.

    Used by undo. Returns True if a row was deleted.
    """
    conn = db()
    try:
        cur = conn.execute(
            "DELETE FROM centauri_review WHERE eventId = ?", (event_id,)
        )
        conn.commit()
        return (cur.rowcount or 0) > 0
    finally:
        conn.close()


# --------------------------------------------------------- event-mesh (Phase 4)


def replace_event_meshes(
    db: DbFactory, event_id: int, meshes: list[dict[str, Any]]
) -> int:
    """Replace the mesh-row set for an event. Returns the inserted count.

    `meshes` items: `{ zipPath, md5, sizeBytes }`. Idempotent — a second
    attach call wipes the prior rows so a re-upload doesn't leak ghosts.
    Cleared if `meshes` is empty (e.g. attached file parsed empty).
    """
    now = int(time.time())
    conn = db()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM centauri_event_mesh WHERE eventId = ?", (event_id,)
        )
        for m in meshes:
            cur.execute(
                """
                INSERT INTO centauri_event_mesh
                    (eventId, zipPath, md5, sizeBytes, createdAt)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    m["zipPath"],
                    m["md5"],
                    int(m.get("sizeBytes", 0)),
                    now,
                ),
            )
        conn.commit()
        return len(meshes)
    finally:
        conn.close()


def list_event_meshes(db: DbFactory, event_id: int) -> list[dict[str, Any]]:
    """Return all mesh rows for an event, ordered by insert order."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT id, zipPath, md5, sizeBytes "
            "FROM centauri_event_mesh WHERE eventId = ? ORDER BY id ASC",
            (event_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r["id"],
            "zipPath": r["zipPath"],
            "md5": r["md5"],
            "sizeBytes": r["sizeBytes"],
        }
        for r in rows
    ]


def set_event_archived_3mf(
    db: DbFactory,
    event_id: int,
    *,
    archived_path: str | None,
    plate_count: int | None,
    embedded_mesh_count: int | None,
    transforms_identity: int | None,
) -> None:
    """Persist the .gcode.3mf attachment metadata onto the event row.

    All fields nullable: the parser may come up empty on a malformed
    upload, in which case we still want to set `archivedPath` (so we
    don't re-archive) but leave the count fields untouched. Callers
    pass `None` to skip.
    """
    sets: list[str] = []
    params: list[Any] = []
    if archived_path is not None:
        sets.append("archived3mfPath = ?")
        params.append(archived_path)
    if plate_count is not None:
        sets.append("plateCount = ?")
        params.append(plate_count)
    if embedded_mesh_count is not None:
        sets.append("embeddedMeshCount = ?")
        params.append(embedded_mesh_count)
    if transforms_identity is not None:
        sets.append("plateTransformsIdentity = ?")
        params.append(transforms_identity)
    if not sets:
        return
    params.append(event_id)
    conn = db()
    try:
        conn.execute(
            f"UPDATE centauri_print_event SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        conn.commit()
    finally:
        conn.close()


def list_recently_auto_matched_models(
    db: DbFactory, *, since_seconds: int
) -> dict[str, int]:
    """Map `modelId → most-recent reviewedAt (unix seconds)` for prints the
    ingest path auto-confirmed inside the window.

    Powers the Recent view's "auto-matched" chip — by returning a flat
    map keyed by model id, the frontend can decorate model rows in O(1)
    without per-row API calls.

    Window: the same 7-day undo horizon as the inbox's auto-matched
    panel, by default — the chip's user value is "this got logged
    without me touching it, recently", which expires at the same time
    the undo affordance does.
    """
    cutoff = int(time.time()) - max(1, int(since_seconds))
    conn = db()
    try:
        rows = conn.execute(
            """
            SELECT resultingModelId AS modelId, MAX(reviewedAt) AS lastAutoAt
            FROM centauri_review
            WHERE action = 'auto'
              AND resultingModelId IS NOT NULL
              AND reviewedAt >= ?
            GROUP BY resultingModelId
            """,
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    return {row["modelId"]: int(row["lastAutoAt"]) for row in rows}


def expire_old_reserves(db: DbFactory, max_age_days: int = 30) -> int:
    """Flip reserves older than `max_age_days` to dismiss with audit reason.

    Returns the number of rows flipped. Idempotent — only touches rows
    still at `action='reserve'`. Run on backend startup; the cost is a
    single indexed scan so we don't need a separate scheduled job.
    """
    cutoff = int(time.time()) - max_age_days * 86_400
    now = int(time.time())
    conn = db()
    try:
        cur = conn.execute(
            """
            UPDATE centauri_review
            SET action = 'dismiss',
                reason = 'reserve_expired',
                reviewedAt = ?
            WHERE action = 'reserve'
              AND reviewedAt < ?
            """,
            (now, cutoff),
        )
        conn.commit()
        return int(cur.rowcount or 0)
    finally:
        conn.close()


# ------------------------------------------- print-log entries (writes for confirm)


def create_print_log_from_event(
    db: DbFactory,
    event: dict[str, Any],
    model_id: str,
    *,
    spool_id: int | None = None,
) -> str:
    """Write a `custom_prints` row for a confirmed event.

    Maps the centauri event outcome to the existing custom_prints
    status taxonomy used by ModelPrintsSection:
      'completed' → 'completed'  (green check)
      'failed'    → 'failed'     (red X)
      'cancelled' → 'cancelled'  (grey slash — fallback branch in the UI
                                  IIFE, intentional)
    Timing comes from the event. Filament rows:
      - spool_id=None   → no filament row (legacy / auto-confirm path)
      - spool_id=<int>  → one custom_print_filaments row pinning this
                          print to that spool, with estWeightG seeded
                          from `event.estFilamentG` if known. The user
                          can later resync to deduct against Spoolman.
    """
    print_id = str(uuid.uuid4())
    now = int(time.time())
    started_ms = (event["startedAt"] or now) * 1000
    completed_ms = (event["endedAt"] or now) * 1000

    outcome = event.get("outcome", "completed")
    status = outcome if outcome in {"completed", "failed", "cancelled"} else "completed"
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
        if spool_id is not None:
            # Label / colour are unknown at this layer (we'd have to hit
            # Spoolman from inside the repo, which crosses an architectural
            # boundary). Leave them NULL; the row UI falls back to
            # "Spool #N" until the next /api/spoolman/spools refresh
            # backfills the snapshot, and the existing resync path will
            # populate them on first deduction.
            conn.execute(
                """
                INSERT INTO custom_print_filaments
                    (id, printId, spoolId, estWeightG, usedWeightG,
                     estLengthMm, usedLengthMm, spoolLabel, filamentColor,
                     consumedAt)
                VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
                """,
                (
                    str(uuid.uuid4()),
                    print_id,
                    spool_id,
                    event.get("estFilamentG"),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return print_id
