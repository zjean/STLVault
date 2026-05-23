"""Centauri Carbon REST + SSE routes. Fork-only.

Wired in app.py:
    from custom_centauri.schema import ensure_centauri_tables
    from custom_centauri.client import CentauriClient
    from custom_routes import centauri as centauri_routes
    ensure_centauri_tables(conn)
    centauri_routes.configure(db_conn_factory=get_db_conn)
    app.include_router(centauri_routes.router)
    # plus start/stop hooks (see Settings PUT handler)

URL prefix `/api/centauri` makes the fork-only surface obvious.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Callable

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from custom_centauri import matcher, repo
from custom_centauri.client import CentauriClient
from custom_centauri.discovery import discover

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/centauri", tags=["centauri"])


# --- DI ---------------------------------------------------------------------

_db_conn_factory: Callable[..., Any] | None = None
_client: CentauriClient | None = None
# In-process broadcast bus for SSE subscribers. Each subscriber gets a queue;
# publishers fan-out by iterating. List instead of set so order is stable.
_subscribers: list[asyncio.Queue[dict[str, Any]]] = []


def configure(*, db_conn_factory: Callable[..., Any], client: CentauriClient) -> None:
    global _db_conn_factory, _client
    _db_conn_factory = db_conn_factory
    _client = client


def _db():
    if _db_conn_factory is None:
        raise RuntimeError("centauri routes not configured (db factory missing)")
    return _db_conn_factory()


def _need_client() -> CentauriClient:
    if _client is None:
        raise RuntimeError("centauri routes not configured (client missing)")
    return _client


def _publish(event: dict[str, Any]) -> None:
    """Fan a payload out to every SSE subscriber. Best-effort, drops if full."""
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            log.debug("centauri SSE: dropping event, subscriber queue full")


# --- ingestion bridge -------------------------------------------------------

def make_ingest_callback() -> Callable[[dict[str, Any]], None]:
    """Build the sync callback the CentauriClient calls per finished job.

    Persists the event then publishes a "new-event" SSE so the inbox
    badge updates without a poll.
    """

    def _ingest(event: dict[str, Any]) -> None:
        if _db_conn_factory is None:
            log.warning("centauri ingest: db factory not configured, dropping event")
            return
        try:
            row_id = repo.insert_event(_db_conn_factory, event)
        except Exception:  # noqa: BLE001
            log.exception("centauri ingest: insert failed")
            return
        if row_id is None:
            log.debug(
                "centauri ingest: event %s already present, skipping side effects",
                event.get("sdcpJobId"),
            )
            return
        # Run the matcher synchronously so the inbox never shows a fresh
        # event with zero candidates.
        try:
            n = matcher.run_all_signals(_db_conn_factory, row_id, event)
            log.info("centauri matcher: event %s — %d candidate(s)", row_id, n)
        except Exception:  # noqa: BLE001
            log.exception("centauri matcher: failed (event=%s)", row_id)

        # Phase-3 auto-confirm gate. Fires when:
        #   - autoConfirmEnabled toggle is on (default), AND
        #   - both `filename` and `printer_filename` signals fired, AND
        #   - they agree on a single model_id.
        # Anything ambiguous (multi-hit, signals disagreeing, only one
        # signal firing) falls through to the inbox. Spool-resolution
        # is deferred to Phase 3b — auto-matched prints land with
        # syncedToSpoolman=0 and rely on the existing Spoolman retry
        # surface, same as manual confirms today.
        try:
            settings = repo.get_settings(_db_conn_factory)
            if settings.get("autoConfirmEnabled"):
                target_model_id = repo.get_auto_confirm_candidate(
                    _db_conn_factory, row_id
                )
                if target_model_id:
                    # Verify the model still exists — soft FK so possible
                    # for the matcher's cached candidate row to outlive
                    # the model.
                    conn = _db_conn_factory()
                    try:
                        exists = conn.execute(
                            "SELECT 1 FROM models WHERE id = ?",
                            (target_model_id,),
                        ).fetchone()
                    finally:
                        conn.close()
                    if exists:
                        ev_row = repo.get_event(_db_conn_factory, row_id)
                        if ev_row is not None:
                            print_id = repo.create_print_log_from_event(
                                _db_conn_factory, ev_row, target_model_id
                            )
                            repo.upsert_review(
                                _db_conn_factory,
                                row_id,
                                action="auto",
                                reason="printer_filename single-hit; no signal disagreed",
                                resulting_print_id=print_id,
                                resulting_model_id=target_model_id,
                            )
                            log.info(
                                "centauri ingest: auto-confirmed event %s "
                                "against model %s (print %s)",
                                row_id,
                                target_model_id,
                                print_id,
                            )
                            _publish(
                                {
                                    "type": "event.auto",
                                    "eventId": row_id,
                                    "modelId": target_model_id,
                                    "printId": print_id,
                                }
                            )
                            return
        except Exception:  # noqa: BLE001
            log.exception(
                "centauri ingest: auto-confirm gate failed (event=%s)", row_id
            )

        _publish({"type": "event.new", "eventId": row_id})

    return _ingest


# --- models -----------------------------------------------------------------


class SettingsIn(BaseModel):
    printerIp: str | None = Field(default=None, description="LAN address, e.g. 192.168.1.50")
    printerName: str | None = None
    printerUuid: str | None = None
    autoConfirmEnabled: bool | None = None


class TestConnectionIn(BaseModel):
    ip: str


class ReviewIn(BaseModel):
    # 'reserve' is non-terminal — the event stays in the inbox but is
    # marked "awaiting a future upload to link against" and is also
    # surfaced on the upload page so the user can complete the link
    # without re-finding the inbox card.
    action: str = Field(pattern=r"^(confirm|dismiss|reserve)$")
    modelId: str | None = None
    reason: str | None = None
    # Optional spool attribution on the confirm path. When supplied, the
    # write-through to custom_prints creates a filament row pinning this
    # print to that spool so Spoolman sync can later deduct against it.
    # Unset → behaviour as before (print logged with no filament rows;
    # user can still edit via the existing print row UI).
    spoolId: int | None = None


# --- /status ----------------------------------------------------------------


@router.get("/status")
def get_status() -> dict[str, Any]:
    client = _need_client()
    snap = client.snapshot()
    return {
        "connected": snap.connected,
        "printerIp": snap.printer_ip,
        "mainboardId": snap.mainboard_id,
        "lastConnectedAt": snap.last_connected_at,
        "lastError": snap.last_error,
        "currentStatusCode": snap.current_status_code,
        "currentFilename": snap.current_filename,
        "currentProgress": snap.current_progress,
        "currentTaskId": snap.current_task_id,
    }


# --- /settings --------------------------------------------------------------


@router.get("/settings")
def get_settings() -> dict[str, Any]:
    return repo.get_settings(_db)


@router.put("/settings")
async def put_settings(body: SettingsIn) -> dict[str, Any]:
    # Treat omitted fields as "leave alone"; explicit null overwrites.
    sent = body.model_dump(exclude_unset=True)
    updated = repo.update_settings(
        _db,
        printer_ip=sent.get("printerIp", ...),
        printer_name=sent.get("printerName", ...),
        printer_uuid=sent.get("printerUuid", ...),
        auto_confirm_enabled=sent.get("autoConfirmEnabled", ...),
    )
    # Bounce the client connection if the IP changed.
    if "printerIp" in sent:
        await _need_client().set_printer_ip(updated["printerIp"])
    _publish({"type": "settings.changed"})
    return updated


# --- /test-connection -------------------------------------------------------


@router.post("/test-connection")
async def test_connection(body: TestConnectionIn) -> dict[str, Any]:
    if not body.ip.strip():
        raise HTTPException(status_code=400, detail="printer IP is required")
    return await _need_client().test_connection(body.ip.strip())


# --- /discover --------------------------------------------------------------


@router.post("/discover")
async def discover_printers() -> list[dict[str, Any]]:
    """UDP M99999 broadcast. Returns one entry per responding printer."""
    found = await discover()
    return [
        {
            "host": p.host,
            "mainboardId": p.mainboard_id,
            "name": p.name,
            "machineName": p.machine_name,
            "firmwareVersion": p.firmware_version,
        }
        for p in found
    ]


# --- /events ----------------------------------------------------------------
#
# Route ordering matters here: FastAPI resolves in declaration order, so
# the literal `/events/stream` MUST be declared before the parameterised
# `/events/{event_id}` — otherwise "stream" gets matched as a (non-int)
# event_id and the framework returns 422 before our handler runs.


@router.get("/events/stream")
async def events_stream() -> StreamingResponse:
    """Server-Sent Events stream for inbox badge + status changes.

    Emits JSON-encoded payloads:
      {"type":"event.new","eventId":...}
      {"type":"event.reviewed","eventId":...,"action":"confirm"|"dismiss"}
      {"type":"status","connected":...}
      {"type":"settings.changed"}
      {"type":"inbox.count","count":N}
    """
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
    _subscribers.append(queue)

    async def stream():
        try:
            initial = {"type": "inbox.count", "count": repo.count_unreviewed(_db)}
            yield f"data: {json.dumps(initial)}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=20.0)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            try:
                _subscribers.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/events")
def list_events(reviewed: bool | None = None, limit: int = 100) -> list[dict[str, Any]]:
    events = repo.list_events(_db, reviewed=reviewed, limit=min(max(limit, 1), 500))
    # Embed candidates + review per event so the inbox can render the
    # "Reserved" badge for action='reserve' events without follow-up
    # fetches. List sizes are bounded (≤ a handful candidates per event,
    # one review row per event) so a single round-trip beats per-event
    # lookups from the UI.
    for ev in events:
        ev["candidates"] = matcher.list_candidates(_db, ev["id"])
        ev["review"] = repo.get_review(_db, ev["id"])
    return events


@router.get("/events/recent-auto")
def list_recent_auto(hours: int = 168) -> list[dict[str, Any]]:
    """Auto-confirmed events still inside the undo window.

    Default mirrors UNDO_WINDOW_SECONDS (7 days). Surfaces the
    "Recently auto-matched" panel in the inbox; each entry carries the
    resulting print + model ids so the UI can link to the model row and
    offer an Undo button until `autoMatchedAt + hours`.

    Declared BEFORE the parameterised `/events/{event_id}` so FastAPI's
    in-order route resolution matches the literal first — otherwise
    "recent-auto" gets parsed as a non-int event_id and the framework
    returns 422 before our handler runs. Same gotcha noted on
    `/events/stream` above.
    """
    hrs = max(1, min(int(hours), 168))  # clamp 1h..7d
    events = repo.list_recent_auto_matched(_db, hours=hrs)
    for ev in events:
        ev["candidates"] = matcher.list_candidates(_db, ev["id"])
        ev["review"] = repo.get_review(_db, ev["id"])
    return events


@router.get("/auto-matched-models")
def list_auto_matched_models(hours: int = 168) -> dict[str, int]:
    """Map `modelId → most-recent autoMatchedAt (unix seconds)` for the
    Recent view's chip.

    Empty when Spoolman/Centauri haven't auto-confirmed anything inside
    the window — frontend treats absence as "no chip", failure as the
    same (best-effort). Clamps the window to `[1h, 7d]` to match the
    inbox panel's undo horizon (`UNDO_WINDOW_SECONDS`).
    """
    hrs = max(1, min(int(hours), 168))
    return repo.list_recently_auto_matched_models(
        _db, since_seconds=hrs * 3600
    )


@router.get("/events/{event_id}")
def get_event(event_id: int) -> dict[str, Any]:
    ev = repo.get_event(_db, event_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")
    return {
        "event": ev,
        "review": repo.get_review(_db, event_id),
        "candidates": matcher.list_candidates(_db, event_id),
    }


@router.get("/events/{event_id}/thumbnail")
async def event_thumbnail(event_id: int) -> StreamingResponse:
    """Proxy the printer's history-thumbnail PNG.

    The Centauri exposes `/board-resource/history_image/<task_id>.png` over
    HTTP on port 80. Proxying through STLVault keeps the frontend on a
    single origin (same-origin /api/*) and lets us cache + fall back
    cleanly.
    """
    ev = repo.get_event(_db, event_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")
    settings = repo.get_settings(_db)
    ip = settings.get("printerIp")
    if not ip:
        raise HTTPException(status_code=503, detail="printer not configured")
    url = f"http://{ip}/board-resource/history_image/{ev['sdcpJobId']}.png"
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            r = await http.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"printer fetch failed: {e}") from e
    if r.status_code != 200:
        raise HTTPException(status_code=404, detail="thumbnail not available")
    return StreamingResponse(iter([r.content]), media_type="image/png")


@router.get("/events/{event_id}/gcode")
def event_gcode(event_id: int):
    """Serve the archived `.gcode` we pulled off the printer for this event.

    Path is what the enrichment step wrote (Phase 2.2). The serving filename
    uses `gcodeFilename` so a manual save preserves the original name from
    the printer instead of our internal "<startedAt>_<task_prefix>.gcode"
    archive leaf. 404 if enrichment never ran (legacy events) or the file
    was pruned by the archive's keep-N / older-than-D policy.

    Safety: the archived path is always written by `_archive_gcode` under
    `${FILE_STORAGE}/centauri/<printer_id>/...`. We reject any value that
    resolves outside the upload root so a poisoned DB column can't read
    arbitrary files.
    """
    from pathlib import Path
    from fastapi.responses import FileResponse
    import os

    ev = repo.get_event(_db, event_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")
    archived = ev.get("archivedGcodePath")
    if not archived:
        raise HTTPException(status_code=404, detail="no archived gcode for this event")

    upload_root = Path(os.getenv("FILE_STORAGE", "./app/uploads")).resolve()
    try:
        path = Path(archived).resolve()
        path.relative_to(upload_root)
    except (ValueError, OSError) as e:
        log.warning("centauri gcode serve: rejected path %r (%s)", archived, e)
        raise HTTPException(status_code=404, detail="gcode file not found") from None
    if not path.is_file():
        raise HTTPException(status_code=404, detail="gcode file not found")

    download_name = ev.get("gcodeFilename") or path.name
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        filename=download_name,
    )


UNDO_WINDOW_SECONDS = 7 * 24 * 3600  # 7 days; matches the design's revisit horizon


@router.post("/events/{event_id}/undo")
def undo_auto(event_id: int) -> dict[str, Any]:
    """Roll back an auto-confirmed event within the undo window.

    Deletes the print log, clears the review row so the event reappears
    in the inbox, and publishes `event.new` so the UI refreshes. 410
    Gone once the window has elapsed — the print log stays in history
    where the user can manage it the same as any manual print.
    """
    ev = repo.get_event(_db, event_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")
    review = repo.get_review(_db, event_id)
    if review is None or review["action"] != "auto":
        raise HTTPException(
            status_code=400,
            detail="event is not auto-confirmed; nothing to undo",
        )
    age = int(time.time()) - int(review["reviewedAt"])
    if age > UNDO_WINDOW_SECONDS:
        raise HTTPException(
            status_code=410,
            detail="undo window has expired (7 days); manage the print log directly",
        )
    print_id = review.get("resultingPrintId")
    if print_id:
        repo.delete_print_log(_db, str(print_id))
    repo.clear_review(_db, event_id)
    _publish({"type": "event.new", "eventId": event_id})
    return {"ok": True, "eventId": event_id, "deletedPrintId": print_id}


@router.get("/reserves")
def list_reserves(since_days: int = 30) -> list[dict[str, Any]]:
    """Reserved events newer than `since_days` (default 30).

    Feeds the upload-page "Link to a recent print?" dialog. Each event
    carries its candidate strip so the frontend can auto-tick reserves
    that already had a candidate matching the just-uploaded model.
    """
    since = max(1, min(int(since_days), 365))
    events = repo.list_recent_reserves(_db, since_days=since)
    for ev in events:
        ev["candidates"] = matcher.list_candidates(_db, ev["id"])
        ev["review"] = repo.get_review(_db, ev["id"])
    return events


@router.post("/events/{event_id}/review")
def review_event(event_id: int, body: ReviewIn) -> dict[str, Any]:
    ev = repo.get_event(_db, event_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="event not found")

    if body.action == "confirm":
        if not body.modelId:
            raise HTTPException(
                status_code=400, detail="modelId is required for confirm"
            )
        # Validate the model exists. Soft check against the upstream
        # models table.
        conn = _db()
        try:
            row = conn.execute(
                "SELECT 1 FROM models WHERE id = ?", (body.modelId,)
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise HTTPException(status_code=404, detail="model not found")
        print_id = repo.create_print_log_from_event(
            _db, ev, body.modelId, spool_id=body.spoolId
        )
        review = repo.upsert_review(
            _db,
            event_id,
            action="confirm",
            resulting_print_id=print_id,
            resulting_model_id=body.modelId,
        )
    elif body.action == "dismiss":
        review = repo.upsert_review(
            _db,
            event_id,
            action="dismiss",
            reason=body.reason,
        )
    elif body.action == "reserve":
        # Non-terminal — the event remains visible in the inbox under
        # "Reserved", and is surfaced again on the upload page so the user
        # can link a freshly-uploaded model to this print.
        review = repo.upsert_review(
            _db,
            event_id,
            action="reserve",
            reason=body.reason,
        )
    else:
        # Defensive; pattern validates this but be explicit.
        raise HTTPException(status_code=400, detail=f"unknown action: {body.action}")

    _publish({"type": "event.reviewed", "eventId": event_id, "action": body.action})
    return review


# (SSE handler lives at the top of the /events block — must be declared
# before the parameterised /events/{event_id} so the literal route wins.)
