"""STLVault-native print log routes.

Calls Spoolman at completion time to deduct used filament from the
spool's `used_weight`. Sync semantics:

- Print row is written first with `syncedToSpoolman=0`.
- Spoolman `PUT /spool/{id}/use` is called per filament row.
- On full success → flip the flag to 1, store `consumedAt`, return
  the new remaining-weight echoed back from Spoolman.
- On any failure → row stays, flag stays 0, the response includes
  `syncError` so the UI can show a retry affordance. The print is
  considered "logged locally" not "consumed."
- The flag is the idempotency guard against double-consume on retry.

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
    """PUT /spool/{id}/use for each filament that has a usedWeightG.

    Returns:
        {
          "synced": bool,
          "spoolUpdates": [{spoolId, remainingWeight}],
          "error": str | None,
          "failedSpoolId": int | None
        }

    Idempotency: the caller must guard with `syncedToSpoolman`.
    On partial failure we mark whichever spools succeeded and leave
    the print row unsynced — the user retries the whole thing.
    """
    updates: List[Dict[str, Any]] = []
    at = prints_repo.now_ms()
    for f in filaments:
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
            return {
                "synced": False,
                "spoolUpdates": updates,
                "error": e.message,
                "failedSpoolId": f["spoolId"],
            }
        prints_repo.mark_filament_consumed(
            conn, print_id, f["spoolId"], at_ms=at
        )
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


def _has_any_used(filaments: List[Dict[str, Any]]) -> bool:
    return any(
        (f.get("usedWeightG") is not None or f.get("usedLengthMm") is not None)
        for f in filaments
    )


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
        if (
            body.status == prints_repo.STATUS_COMPLETED
            and _has_any_used(filaments_hydrated)
        ):
            if client is None:
                sync_result["error"] = (
                    "Spoolman not configured — print logged locally only."
                )
            else:
                sync_result = _attempt_consume(
                    conn,
                    print_id=print_id,
                    filaments=filaments_hydrated,
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
    """Transition a 'printing' row to 'completed' (or failed/cancelled),
    optionally updating used weight/length, and run the Spoolman consume
    call for completed status.
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
            prints_repo.update_filament_used(
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
        sync_result: Dict[str, Any] = {
            "synced": False,
            "spoolUpdates": [],
            "error": None,
        }
        if (
            body.status == prints_repo.STATUS_COMPLETED
            and _has_any_used(updated["filaments"])
        ):
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


# --- global history (PR 3 will add filters + rollups on top) ---


@router.get("/api/prints")
def list_all(
    limit: int = 200,
    offset: int = 0,
    status: Optional[str] = None,
    spoolId: Optional[int] = None,
    modelId: Optional[str] = None,
) -> List[Dict[str, Any]]:
    conn = _get_db()
    try:
        return prints_repo.list_prints(
            conn,
            limit=max(1, min(limit, 500)),
            offset=max(0, offset),
            status=status,
            spool_id=spoolId,
            model_id=modelId,
        )
    finally:
        conn.close()
