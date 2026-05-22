"""STLVault-native print log routes.

Calls Spoolman to deduct used filament from the spool's `used_weight`.

What triggers a deduction:
- ANY print whose body carries `usedWeightG` or `usedLengthMm` on at
  least one filament leg — regardless of status. A failed print at
  60% that ate 28g of filament still left 28g off the spool; the
  status describes the OUTCOME (was the object usable?), not whether
  material was consumed.
- A `completed` print with NO recorded consumption is rejected (400).
  The user asserted the object came off the bed without telling us
  the weight — that's a slip, not a valid record. Use 'cancelled'
  for prints that didn't consume material.

Sync semantics:
- Print row is written first with `syncedToSpoolman=0`.
- Spoolman `PUT /spool/{id}/use` is called per filament row.
- Each successful per-row call stamps `consumedAt` and commits BEFORE
  the next row's call is attempted. On any failure mid-batch we
  return early; succeeded rows stay marked so a retry skips them.
- On full success → flip `syncedToSpoolman=1` and commit.
- The print-row flag plus the per-filament `consumedAt` together form
  the idempotency guard against double-consume on retry.

Known narrow recovery hole: if the Python process is killed *between*
the Spoolman 200 and the SQLite commit that stamps `consumedAt`, the
row reverts and the next /resync re-deducts that one spool. Closing
this hole would require Spoolman to expose an undo verb, which it
does not — so we accept it and document it.

Deleting a synced print does NOT reverse Spoolman consumption — the
UI shows a warning + a link to the spool in Spoolman.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from custom_prints import repo as prints_repo
from custom_spoolman import settings as ss
from custom_spoolman.client import SpoolmanClient, SpoolmanError


log = logging.getLogger(__name__)


router = APIRouter(tags=["prints"])


_db_conn_factory = None


def set_db_conn_factory(factory) -> None:
    global _db_conn_factory
    _db_conn_factory = factory


def _get_db():
    if _db_conn_factory is None:
        raise RuntimeError(
            "custom_routes.prints: db conn factory not configured; "
            "app.py must call set_db_conn_factory(get_db_conn) at startup"
        )
    return _db_conn_factory()


def _client_or_none() -> Optional[SpoolmanClient]:
    """Returns a configured Spoolman client, or None if not configured.

    Print rows can still be CREATED without Spoolman — they just won't
    be synced. The completion + resync paths require it.
    """
    conn = _get_db()
    try:
        s = ss.read(conn)
    finally:
        conn.close()
    if not ss.is_configured(s):
        return None
    return SpoolmanClient(base_url=s.base_url, api_key=s.api_key)


def _require_client() -> SpoolmanClient:
    c = _client_or_none()
    if c is None:
        raise HTTPException(
            status_code=409,
            detail="Spoolman is not configured. Set a base URL in Settings → Spoolman.",
        )
    return c


# --- pydantic shapes ---


class FilamentIn(BaseModel):
    spoolId: int
    estWeightG: Optional[float] = None
    usedWeightG: Optional[float] = None
    estLengthMm: Optional[float] = None
    usedLengthMm: Optional[float] = None


class CreatePrintBody(BaseModel):
    status: str = Field(
        default=prints_repo.STATUS_COMPLETED,
        description="One of 'printing', 'completed', 'failed', 'cancelled'.",
    )
    filaments: List[FilamentIn] = Field(
        default_factory=list,
        description="Multi-spool by design; UI typically sends one row.",
    )
    startedAt: Optional[int] = None
    completedAt: Optional[int] = None
    estDurationMin: Optional[int] = None
    actDurationMin: Optional[int] = None
    printer: Optional[str] = None
    notes: Optional[str] = None


class CompletePrintBody(BaseModel):
    filaments: List[FilamentIn] = Field(
        default_factory=list,
        description="If empty, completes using whatever est values "
                    "were stored when the print was started.",
    )
    completedAt: Optional[int] = None
    actDurationMin: Optional[int] = None
    notes: Optional[str] = None
    status: str = Field(default=prints_repo.STATUS_COMPLETED)


class PatchPrintBody(BaseModel):
    status: Optional[str] = None
    completedAt: Optional[int] = None
    actDurationMin: Optional[int] = None
    notes: Optional[str] = None


# --- helpers ---


def _hydrate_filament_snapshots(
    filaments: List[FilamentIn], client: Optional[SpoolmanClient]
) -> List[Dict[str, Any]]:
    """Best-effort: fetch label + color from Spoolman for the audit trail.

    If Spoolman is unreachable we still proceed — the snapshot fields
    are nice-to-have, not load-bearing for the print row itself.
    """
    out: List[Dict[str, Any]] = []
    for f in filaments:
        item: Dict[str, Any] = {
            "spoolId": f.spoolId,
            "estWeightG": f.estWeightG,
            "usedWeightG": f.usedWeightG,
            "estLengthMm": f.estLengthMm,
            "usedLengthMm": f.usedLengthMm,
        }
        if client is not None:
            try:
                spool = client.get_spool(f.spoolId)
                fil = (spool or {}).get("filament") or {}
                vendor = fil.get("vendor") or {}
                parts = [vendor.get("name"), fil.get("name")]
                label = " ".join(p for p in parts if p) or None
                item["spoolLabel"] = label
                item["filamentColor"] = fil.get("color_hex")
            except SpoolmanError as e:
                log.warning(
                    "prints: spool snapshot fetch failed for #%s: %s",
                    f.spoolId,
                    e.message,
                )
        out.append(item)
    return out


def _attempt_consume(
    conn,
    *,
    print_id: str,
    filaments: List[Dict[str, Any]],
    client: SpoolmanClient,
) -> Dict[str, Any]:
    """PUT /spool/{id}/use for each filament that hasn't been consumed yet.

    Returns:
        {
          "synced": bool,
          "spoolUpdates": [{spoolId, remainingWeight}],
          "error": str | None,
          "failedSpoolId": int | None
        }

    Idempotency: callers MUST refuse to invoke this for a print whose
    ``syncedToSpoolman`` flag is already 1. WITHIN a single call, this
    function skips filament rows whose ``consumedAt`` is non-null —
    that's the per-row idempotency guard against partial-success
    retries (one of two filaments succeeded, the other failed; the
    user retries and we must not re-deduct the first one).

    Each successful call commits its ``consumedAt`` marker
    immediately. Recovery model: if the Python process crashes after
    Spoolman 200s but before ``conn.commit()`` lands, the row is
    silently rolled back and the next /resync re-deducts that one
    spool. We accept this narrow window — full transactional sync
    would require Spoolman to expose an undo verb, which it does not.
    """
    updates: List[Dict[str, Any]] = []
    at = prints_repo.now_ms()
    for f in filaments:
        if f.get("consumedAt") is not None:
            # Already deducted in a prior partial-success pass.
            # Surface as a no-op "update" so the UI sees a consistent
            # shape, but don't hit Spoolman.
            continue
        used_w = f.get("usedWeightG")
        used_l = f.get("usedLengthMm")
        if used_w is None and used_l is None:
            # Nothing to deduct — happens if the user logs a failed/cancelled
            # print with no actual consumption.
            continue
        try:
            updated = client.use_spool(
                f["spoolId"], use_weight=used_w, use_length=used_l
            )
        except SpoolmanError as e:
            # Commit any per-row markers that landed before this failure
            # so a /resync doesn't re-deduct succeeded rows.
            conn.commit()
            return {
                "synced": False,
                "spoolUpdates": updates,
                "error": e.message,
                "failedSpoolId": f["spoolId"],
            }
        # Stamp consumedAt by row id, not (printId, spoolId), so the same
        # spool used twice in one print is handled correctly.
        prints_repo.mark_filament_consumed_by_id(conn, f["id"], at_ms=at)
        conn.commit()
        updates.append(
            {
                "spoolId": f["spoolId"],
                "remainingWeight": (updated or {}).get("remaining_weight"),
            }
        )
    return {
        "synced": True,
        "spoolUpdates": updates,
        "error": None,
        "failedSpoolId": None,
    }


def _has_any_used(filaments) -> bool:
    """True if any leg has a non-null used weight or used length.

    Accepts either dicts (post-hydration, post-DB-read) or pydantic
    ``FilamentIn`` objects (raw request bodies) — handles both shapes
    so the call site can validate before paying the hydration cost.
    """
    def used_of(f):
        if hasattr(f, "usedWeightG"):
            return f.usedWeightG, f.usedLengthMm
        return f.get("usedWeightG"), f.get("usedLengthMm")

    for f in filaments:
        w, l = used_of(f)
        if w is not None or l is not None:
            return True
    return False


# --- routes ---


@router.get("/api/models/{model_id}/prints")
def list_for_model(model_id: str) -> List[Dict[str, Any]]:
    conn = _get_db()
    try:
        return prints_repo.list_prints_for_model(conn, model_id)
    finally:
        conn.close()


@router.post("/api/models/{model_id}/prints")
def create_for_model(model_id: str, body: CreatePrintBody) -> Dict[str, Any]:
    if body.status not in prints_repo.ALL_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")

    needs_consume = _has_any_used(body.filaments)

    # A completed print without recorded consumption is malformed: the user
    # asserted the print produced an object but didn't tell us how much
    # filament it took. Don't silently swallow this and mark the row as
    # synced; force the user to either provide a weight or pick a different
    # status (failed/cancelled) that doesn't carry the "material was
    # consumed" implication.
    if body.status == prints_repo.STATUS_COMPLETED and not needs_consume:
        raise HTTPException(
            status_code=400,
            detail=(
                "A completed print must record actual material consumption "
                "(usedWeightG or usedLengthMm) on at least one filament. "
                "For prints that consumed nothing, use status 'cancelled'."
            ),
        )

    client = _client_or_none()
    filaments_hydrated = _hydrate_filament_snapshots(body.filaments, client)

    conn = _get_db()
    try:
        # Insert the row first — even if Spoolman sync fails later, we keep
        # the local record.
        print_id = prints_repo.insert_print(
            conn,
            model_id=model_id,
            status=body.status,
            filaments=filaments_hydrated,
            started_at=body.startedAt,
            completed_at=body.completedAt,
            est_duration_min=body.estDurationMin,
            act_duration_min=body.actDurationMin,
            printer=body.printer,
            notes=body.notes,
        )
        conn.commit()

        sync_result: Dict[str, Any] = {
            "synced": False,
            "spoolUpdates": [],
            "error": None,
        }
        # Consumption is driven by `usedWeightG`/`usedLengthMm`, NOT by
        # status — a failed print that ate 28g of filament still left 28g
        # off the spool, so Spoolman needs to know. Status describes
        # outcome (object usable / not / stopped), which is orthogonal to
        # whether material was consumed.
        if needs_consume:
            if client is None:
                sync_result["error"] = (
                    "Spoolman not configured — print logged locally only."
                )
            else:
                # Re-read so _attempt_consume sees the persisted filament
                # rows including their generated ids (the request-body
                # shape doesn't carry ids; mark_filament_consumed_by_id
                # needs them).
                persisted = prints_repo.get_print(conn, print_id)
                sync_result = _attempt_consume(
                    conn,
                    print_id=print_id,
                    filaments=persisted["filaments"],
                    client=client,
                )
                if sync_result["synced"]:
                    prints_repo.mark_synced(conn, print_id)
                conn.commit()

        row = prints_repo.get_print(conn, print_id)
    finally:
        conn.close()

    return {"print": row, "sync": sync_result}


@router.get("/api/prints/{print_id}")
def get_one(print_id: str) -> Dict[str, Any]:
    conn = _get_db()
    try:
        row = prints_repo.get_print(conn, print_id)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Print not found")
    return row


@router.patch("/api/prints/{print_id}")
def patch_one(print_id: str, body: PatchPrintBody) -> Dict[str, Any]:
    conn = _get_db()
    try:
        existing = prints_repo.get_print(conn, print_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Print not found")
        changed = prints_repo.update_print_fields(
            conn,
            print_id,
            status=body.status,
            completed_at=body.completedAt,
            act_duration_min=body.actDurationMin,
            notes=body.notes,
        )
        if changed:
            conn.commit()
        return prints_repo.get_print(conn, print_id)
    finally:
        conn.close()


@router.delete("/api/prints/{print_id}")
def delete_one(print_id: str) -> Dict[str, Any]:
    """Local-only delete. Spoolman consumption is NOT reversed —
    the UI warns the user about this before they confirm.
    """
    conn = _get_db()
    try:
        existing = prints_repo.get_print(conn, print_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Print not found")
        prints_repo.delete_print(conn, print_id)
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "wasSynced": existing["syncedToSpoolman"]}


@router.post("/api/prints/{print_id}/complete")
def complete_one(print_id: str, body: CompletePrintBody) -> Dict[str, Any]:
    """Transition a 'printing' row to a terminal status (completed /
    failed / cancelled), optionally updating used weight/length per
    filament, and run the Spoolman consume call for any filament that
    actually consumed material.

    Consumption is driven by `usedWeightG`/`usedLengthMm` — a failed
    print at 60% can have eaten 28g of filament; that material left
    the spool and Spoolman needs to know. Status describes whether
    the printed object was usable, which is independent.
    """
    if body.status not in prints_repo.ALL_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {body.status}")

    client = _client_or_none()

    conn = _get_db()
    try:
        existing = prints_repo.get_print(conn, print_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Print not found")
        if existing["syncedToSpoolman"]:
            raise HTTPException(
                status_code=409,
                detail="Print already synced to Spoolman; cannot re-complete.",
            )

        # Update used* on each filament row if the body included it.
        for f in body.filaments:
            prints_repo.update_filament_used_by_spool(
                conn,
                print_id,
                spool_id=f.spoolId,
                used_weight_g=f.usedWeightG,
                used_length_mm=f.usedLengthMm,
            )

        # Update the parent row's status + timestamps.
        prints_repo.update_print_fields(
            conn,
            print_id,
            status=body.status,
            completed_at=body.completedAt or prints_repo.now_ms(),
            act_duration_min=body.actDurationMin,
            notes=body.notes,
        )
        conn.commit()

        # Re-read so we have the post-update filament rows for the consume call.
        updated = prints_repo.get_print(conn, print_id)
        needs_consume = _has_any_used(updated["filaments"])

        # A completed print without any recorded consumption is malformed:
        # the user said "the object came off the bed" but didn't tell us
        # how much filament it took. Reject rather than silently mark
        # synced. (The terminal row state remains whatever the update set
        # it to — we just refuse to advance the sync state from this body.)
        if body.status == prints_repo.STATUS_COMPLETED and not needs_consume:
            raise HTTPException(
                status_code=400,
                detail=(
                    "A completed print must record actual material consumption "
                    "(usedWeightG or usedLengthMm) on at least one filament. "
                    "For prints that consumed nothing, use status 'cancelled'."
                ),
            )

        sync_result: Dict[str, Any] = {
            "synced": False,
            "spoolUpdates": [],
            "error": None,
        }
        if needs_consume:
            if client is None:
                sync_result["error"] = (
                    "Spoolman not configured — print completed locally only."
                )
            else:
                sync_result = _attempt_consume(
                    conn,
                    print_id=print_id,
                    filaments=updated["filaments"],
                    client=client,
                )
                if sync_result["synced"]:
                    prints_repo.mark_synced(conn, print_id)
                conn.commit()

        return {"print": prints_repo.get_print(conn, print_id), "sync": sync_result}
    finally:
        conn.close()


@router.post("/api/prints/{print_id}/resync")
def resync_one(print_id: str) -> Dict[str, Any]:
    """Retry the Spoolman consume call for a print that's logged but
    not synced. Same idempotency guard: refuses to re-consume an
    already-synced print.
    """
    client = _require_client()
    conn = _get_db()
    try:
        existing = prints_repo.get_print(conn, print_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Print not found")
        if existing["syncedToSpoolman"]:
            raise HTTPException(
                status_code=409, detail="Already synced — nothing to retry."
            )
        if not _has_any_used(existing["filaments"]):
            raise HTTPException(
                status_code=400,
                detail="No filament usage recorded on this print; nothing to consume.",
            )
        sync_result = _attempt_consume(
            conn,
            print_id=print_id,
            filaments=existing["filaments"],
            client=client,
        )
        if sync_result["synced"]:
            prints_repo.mark_synced(conn, print_id)
        conn.commit()
        return {"print": prints_repo.get_print(conn, print_id), "sync": sync_result}
    finally:
        conn.close()


# --- global history + rollups (PR 3) ---


@router.get("/api/prints")
def list_all(
    limit: int = 200,
    offset: int = 0,
    status: Optional[str] = None,
    spoolId: Optional[int] = None,
    modelId: Optional[str] = None,
    sinceMs: Optional[int] = None,
    untilMs: Optional[int] = None,
) -> List[Dict[str, Any]]:
    if status is not None and status not in prints_repo.ALL_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
    conn = _get_db()
    try:
        return prints_repo.list_prints(
            conn,
            limit=max(1, min(limit, 500)),
            offset=max(0, offset),
            status=status,
            spool_id=spoolId,
            model_id=modelId,
            since_ms=sinceMs,
            until_ms=untilMs,
        )
    finally:
        conn.close()


@router.get("/api/prints/stats/rollup")
def rollup(sinceMs: int, untilMs: Optional[int] = None) -> Dict[str, Any]:
    """Totals for completed prints within the window.

    Returns {count, totalMinutes, totalWeightG}. Computed in SQL — see
    custom_prints/repo.py::rollup_window.
    """
    conn = _get_db()
    try:
        return prints_repo.rollup_window(
            conn, since_ms=sinceMs, until_ms=untilMs
        )
    finally:
        conn.close()
