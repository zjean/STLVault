"""Centauri Carbon WebSocket client + event-ingestion loop.

Design contract (per docs/plans/2026-05-22-centauri-integration-design.md):

- One persistent WebSocket per running backend.
- The client is restartable: changing the printer IP in Settings tears down
  the existing connection and brings up a new one against the new host.
- Exponential reconnect backoff (1s → 60s cap). The rest of the backend
  must not fail when the printer is offline.
- On a `printing → completed | failed | cancelled` transition we emit a
  `centauri_print_event` row through the ingestion callback. Idempotent on
  `(printerId, sdcpJobId)`.

Phase-1 scope: no file download (the SDCP spec doesn't publicly document
one). Filament weight and embedded source files are deferred to Phase 2;
we capture filename + time + outcome + the printer's task thumbnail URL.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.client import connect as ws_connect

from . import sdcp, gcode_meta


# Archive retention: bounded by both count + age. Numbers from the
# design doc — intersection wins (the smaller-window of the two).
ARCHIVE_KEEP_COUNT = 50
ARCHIVE_KEEP_DAYS = 30

# History backfill: how many of the printer's most-recent jobs to scan
# per WS handshake. The Cmd 320 GET_HISTORY response returns task UUIDs
# in newest-first order; we walk this prefix and only enrich rows that
# weren't already in the DB. Repeating the scan on reconnect is cheap
# (the dedup check is a single indexed SELECT), so the cap exists only
# to bound the *first* backfill's runtime.
HISTORY_BACKFILL_LIMIT = 50

log = logging.getLogger(__name__)


WS_PORT = 3030
WS_PATH = "/websocket"
DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_PUSH_PERIOD_MS = sdcp.DEFAULT_PUSH_PERIOD_MS

# Reconnect backoff schedule. Caps at 60s, then plateaus there.
_BACKOFF_SECONDS = (1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0)


@dataclass
class PrinterStatusSnapshot:
    """A point-in-time view exposed to /api/centauri/status callers."""

    connected: bool = False
    printer_ip: str | None = None
    mainboard_id: str | None = None
    last_connected_at: int | None = None  # epoch seconds
    last_error: str | None = None
    current_status_code: int | None = None  # PrintInfo.Status
    current_filename: str | None = None
    current_progress: int | None = None
    current_task_id: str | None = None


@dataclass
class JobState:
    """In-memory tracker for the currently-running job.

    We only know a job exists once a PRINTING status push arrives. The
    `started_at` is the wall-clock moment we first saw PRINTING — close
    enough to the actual job start that the few-second skew (push period)
    doesn't matter for the print-history view.
    """

    task_id: str
    filename: str
    started_at: int  # epoch seconds
    last_progress: int | None = None
    last_status_code: int | None = sdcp.PrintStatus.PRINTING
    est_time_min: int | None = None
    raw_payload: dict[str, Any] = field(default_factory=dict)


# Callback signature: (event_dict) -> None. Sync callback because writes
# to SQLite are sync anyway. Keep the dict shape stable — it's the
# contract between the client and the ingestion module.
IngestionCallback = Callable[[dict[str, Any]], None]


class CentauriClient:
    """Long-running SDCP client.

    Lifecycle:
      client = CentauriClient(ingest_callback)
      await client.start()         # idempotent
      await client.set_printer_ip(ip)
      await client.stop()
    """

    def __init__(
        self,
        ingest: IngestionCallback,
        *,
        upload_dir: Path | str | None = None,
        exists_check: Callable[[str, str], bool] | None = None,
    ) -> None:
        self._ingest = ingest
        # Archive root for enriched event payloads. When None, archiving
        # is disabled (the enrichment still extracts metadata, it just
        # doesn't keep a copy of the gcode).
        self._upload_dir = Path(upload_dir) if upload_dir else None
        # Cheap "is this (printer_id, task_id) already in the DB?" probe
        # used by the history backfill to avoid Cmd 321 + HTTP fetch on
        # already-known UUIDs. Without it the backfill silently disables
        # itself — the unique-key dedup inside ingest still keeps
        # correctness but wastes a lot of LAN traffic.
        self._exists_check: Callable[[str, str], bool] | None = exists_check
        self._printer_ip: str | None = None
        self._mainboard_id: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._stop_requested = False
        self._snapshot = PrinterStatusSnapshot()
        self._job: JobState | None = None
        self._restart_event = asyncio.Event()
        # Active websocket — assigned during _session, cleared on close.
        # send_request() reaches in here rather than receiving the ws as
        # an argument so callers (the terminal-transition ingest path)
        # don't need to know about the connection lifecycle.
        self._ws = None
        # RequestID → Future map for in-flight Cmd requests. _handle_frame
        # resolves a future when the matching RESPONSE frame arrives.
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # Pending enrichment tasks scheduled from _on_status. Tracked so
        # stop() can drain them rather than letting them fire-and-forget
        # into a torn-down event loop.
        self._enrich_tasks: set[asyncio.Task[None]] = set()

    # ------------------------------------------------------------------ API

    async def start(self, printer_ip: str | None = None) -> None:
        """Begin the connection loop. Idempotent."""
        if printer_ip is not None:
            self._printer_ip = printer_ip
        if self._task is not None and not self._task.done():
            return
        self._stop_requested = False
        self._task = asyncio.create_task(self._run_loop(), name="centauri-client")

    async def stop(self) -> None:
        self._stop_requested = True
        self._restart_event.set()
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        # Drain enrichment tasks so we don't lose an event whose
        # gcode-fetch was mid-flight when the user hit Ctrl+C.
        # Bounded wait — anything still in-flight after 3s gets dropped,
        # the event will reappear via the printer's history reconcile.
        if self._enrich_tasks:
            with contextlib.suppress(asyncio.TimeoutError, Exception):
                await asyncio.wait_for(
                    asyncio.gather(*self._enrich_tasks, return_exceptions=True),
                    timeout=3.0,
                )

    async def set_printer_ip(self, ip: str | None) -> None:
        """Update the configured IP and bounce the connection.

        The status snapshot is cleared to a neutral "reconnecting" state
        — connected=False, last_error=None — so the UI doesn't briefly
        render a stale red error between the old session ending and the
        new one establishing. The frontend treats (connected=False,
        last_error=None, printerIp set) as the connecting state.
        """
        self._printer_ip = ip or None
        self._snapshot.connected = False
        self._snapshot.last_error = None
        self._snapshot.printer_ip = ip or None
        self._restart_event.set()
        if not self._task or self._task.done():
            await self.start(ip)

    def snapshot(self) -> PrinterStatusSnapshot:
        # Defensive copy so callers can't mutate our state.
        return PrinterStatusSnapshot(
            connected=self._snapshot.connected,
            printer_ip=self._snapshot.printer_ip,
            mainboard_id=self._snapshot.mainboard_id,
            last_connected_at=self._snapshot.last_connected_at,
            last_error=self._snapshot.last_error,
            current_status_code=self._snapshot.current_status_code,
            current_filename=self._snapshot.current_filename,
            current_progress=self._snapshot.current_progress,
            current_task_id=self._snapshot.current_task_id,
        )

    async def test_connection(self, ip: str, *, timeout: float = 5.0) -> dict[str, Any]:
        """One-shot probe. Used by the Settings "Test connection" button."""
        url = f"ws://{ip}:{WS_PORT}{WS_PATH}"
        try:
            async with await asyncio.wait_for(
                ws_connect(url, max_size=None), timeout=timeout
            ) as ws:
                # Wait briefly for the spontaneous Attributes push. If
                # nothing arrives we still consider the connect a success
                # — paused/errored printers don't push Attributes until
                # asked.
                deadline = asyncio.get_running_loop().time() + timeout
                mainboard_id: str | None = None
                try:
                    while asyncio.get_running_loop().time() < deadline:
                        remaining = deadline - asyncio.get_running_loop().time()
                        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                        msg = sdcp.parse_message(raw)
                        if msg.mainboard_id:
                            mainboard_id = msg.mainboard_id
                            break
                except (asyncio.TimeoutError, StopAsyncIteration):
                    pass
                return {
                    "ok": True,
                    "mainboard_id": mainboard_id,
                    "error": None,
                }
        except asyncio.TimeoutError:
            return {"ok": False, "mainboard_id": None, "error": "Connect timed out"}
        except OSError as e:
            return {"ok": False, "mainboard_id": None, "error": f"Network error: {e}"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "mainboard_id": None, "error": f"{type(e).__name__}: {e}"}

    # -------------------------------------------------------------- internals

    async def _run_loop(self) -> None:
        """Outer loop: reconnect with exponential backoff, restart on IP change."""
        attempt = 0
        while not self._stop_requested:
            if not self._printer_ip:
                # No IP configured — sleep until set_printer_ip wakes us.
                self._snapshot = PrinterStatusSnapshot(
                    connected=False,
                    last_error="Printer IP not configured",
                )
                await self._wait_for_restart()
                continue

            self._restart_event.clear()
            try:
                await self._session(self._printer_ip)
                attempt = 0  # successful session — reset backoff
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("centauri session ended: %s", e)
                self._snapshot.connected = False
                self._snapshot.last_error = f"{type(e).__name__}: {e}"

            if self._stop_requested:
                break

            backoff = _BACKOFF_SECONDS[min(attempt, len(_BACKOFF_SECONDS) - 1)]
            attempt += 1
            # Sleep until backoff elapses OR a restart is requested.
            await self._sleep_or_restart(backoff)

    async def _wait_for_restart(self) -> None:
        try:
            await self._restart_event.wait()
        finally:
            self._restart_event.clear()

    async def _sleep_or_restart(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._restart_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
        finally:
            self._restart_event.clear()

    async def _session(self, host: str) -> None:
        """One connection: open, subscribe, read until close or restart.

        Bootstrap order matters. The Centauri Carbon does NOT reliably push
        Attributes / Status spontaneously to a freshly-connected client when
        the printer is idle. Without those pushes we never learn the
        mainboard ID, never subscribe, and never see job transitions.

        So on connect we:
          1. Resolve the mainboard ID. If unknown, run a brief UDP
             discovery against the configured host to learn it.
          2. Send Cmd 1 GET_PRINTER_ATTRIBUTES to confirm the printer
             accepts us as a client and to refresh our cached attributes.
          3. Send Cmd 512 SUBSCRIBE to start receiving status pushes.
        """
        url = f"ws://{host}:{WS_PORT}{WS_PATH}"
        log.info("centauri: connecting to %s", url)
        async with await asyncio.wait_for(
            ws_connect(url, max_size=None), timeout=DEFAULT_CONNECT_TIMEOUT
        ) as ws:
            now = int(time.time())
            # Expose the live ws to send_request(). Cleared on the way
            # out so post-disconnect callers fail closed rather than
            # writing into a torn-down connection.
            self._ws = ws
            # Reset the once-per-session backfill guard so each
            # reconnect re-scans the printer's history. Already-known
            # UUIDs are skipped cheaply via _exists_check; only genuine
            # new rows pay for Cmd 321 + HTTP fetch.
            self._backfill_done_this_session = False
            self._snapshot = PrinterStatusSnapshot(
                connected=True,
                printer_ip=host,
                mainboard_id=self._mainboard_id,
                last_connected_at=now,
            )

            # 1. Make sure we have the mainboard ID. Use unicast UDP probe
            # against the configured host — broadcast is unreliable on
            # WiFi networks. Falls back to broadcast if unicast doesn't
            # answer (some firmware revs ignore unicast).
            if not self._mainboard_id:
                try:
                    from .discovery import discover as udp_discover
                    from .discovery import probe_one

                    p = await probe_one(host, timeout=2.0)
                    if p is None or not p.mainboard_id:
                        # fall back to broadcast
                        found = await udp_discover(timeout=2.5)
                        p = next(
                            (f for f in found if f.host == host and f.mainboard_id),
                            None,
                        )
                    if p and p.mainboard_id:
                        self._mainboard_id = p.mainboard_id
                        self._snapshot.mainboard_id = p.mainboard_id
                        log.info(
                            "centauri: learned mainboard %s via UDP probe",
                            self._mainboard_id,
                        )
                    else:
                        log.warning(
                            "centauri: no mainboard ID from UDP probe — "
                            "subscribe will wait for spontaneous Attributes push"
                        )
                except Exception:  # noqa: BLE001
                    log.exception("centauri: UDP probe on connect failed")

            # 2 + 3 + 4. Bootstrap the conversation. Cmd 1 (Attributes)
            # confirms the printer accepts us as a client; Cmd 0
            # (GET_PRINTER_STATUS) forces an immediate Status push
            # regardless of state changes; Cmd 512 SUBSCRIBE asks for
            # periodic Status pushes thereafter. Idle printers tend to
            # ignore SUBSCRIBE silently — the explicit Cmd 0 is what
            # actually gets us a first Status frame, after which the
            # subscribe cadence takes over for transitions.
            if self._mainboard_id:
                try:
                    attrs_pkt = sdcp.build_request(
                        sdcp.Cmd.GET_PRINTER_ATTRIBUTES, None, self._mainboard_id
                    )
                    await ws.send(sdcp.encode(attrs_pkt))
                    status_pkt = sdcp.build_request(
                        sdcp.Cmd.GET_PRINTER_STATUS, None, self._mainboard_id
                    )
                    await ws.send(sdcp.encode(status_pkt))
                    sub_pkt = sdcp.build_subscribe(
                        self._mainboard_id, period_ms=DEFAULT_PUSH_PERIOD_MS
                    )
                    await ws.send(sdcp.encode(sub_pkt))
                    log.info(
                        "centauri: sent attrs + status + subscribe (mb=%s)",
                        self._mainboard_id,
                    )
                except Exception:  # noqa: BLE001
                    log.exception("centauri: failed to send bootstrap packets")

                # Kick off the history backfill concurrently with the
                # read loop. Done as a tracked task so a disconnect mid-
                # backfill is cancellable; the loop runs in the same
                # event-loop slice that handles the Cmd 320/321 responses
                # so `send_request` resolves cleanly. Failures are
                # logged-and-swallowed — live ingestion stays primary.
                self._spawn_backfill()

            # Read loop. Late-arriving Attributes pushes can still teach
            # us the mainboard ID, in which case we re-send the subscribe.
            subscribed = self._mainboard_id is not None
            restart_task = asyncio.create_task(self._restart_event.wait())
            try:
                while not self._stop_requested:
                    recv_task = asyncio.create_task(ws.recv())
                    done, _ = await asyncio.wait(
                        {recv_task, restart_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if restart_task in done:
                        recv_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await recv_task
                        log.info("centauri: restart requested, closing session")
                        return
                    try:
                        raw = recv_task.result()
                    except websockets.ConnectionClosed:
                        log.info("centauri: ws closed by peer")
                        return

                    self._handle_frame(raw)

                    if not subscribed and self._mainboard_id:
                        pkt = sdcp.build_subscribe(
                            self._mainboard_id, period_ms=DEFAULT_PUSH_PERIOD_MS
                        )
                        await ws.send(sdcp.encode(pkt))
                        subscribed = True
            finally:
                restart_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await restart_task
                # Tear down the connection-scoped state so a later
                # send_request() against a dead ws fails fast instead of
                # awaiting a future that nothing will ever resolve.
                self._ws = None
                for fut in self._pending.values():
                    if not fut.done():
                        fut.cancel()
                self._pending.clear()

    def _handle_frame(self, raw: Any) -> None:
        msg = sdcp.parse_message(raw)
        # Verbose RX log so wire-level issues are diagnosable without
        # tcpdump. Demote to DEBUG once the protocol is stable.
        if isinstance(raw, (bytes, bytearray)):
            preview = raw[:200].decode("utf-8", "replace")
        else:
            preview = str(raw)[:200]
        log.info(
            "centauri rx: type=%s mb=%s rid=%s topic=%r",
            msg.type.name,
            msg.mainboard_id,
            msg.request_id,
            msg.raw.get("Topic"),
        )
        log.debug("centauri rx body: %s", preview)

        if msg.mainboard_id and not self._mainboard_id:
            self._mainboard_id = msg.mainboard_id
            self._snapshot.mainboard_id = msg.mainboard_id

        # Dispatch RESPONSE frames to waiters. We let frames flow through
        # to the rest of the handler too in case the printer ever bundles
        # state changes with a response (it doesn't today, but the parser
        # is defensive).
        if (
            msg.type == sdcp.MessageType.RESPONSE
            and msg.request_id
            and msg.request_id in self._pending
        ):
            fut = self._pending.pop(msg.request_id)
            if not fut.done():
                fut.set_result(msg.raw)

        if msg.type == sdcp.MessageType.STATUS and msg.status is not None:
            self._on_status(msg.status)

    async def send_request(
        self,
        cmd: int,
        data: dict[str, Any] | None = None,
        *,
        timeout: float = 5.0,
    ) -> dict[str, Any] | None:
        """Send an SDCP request and await its matching RESPONSE frame.

        Returns the full response envelope, or None if we're not
        connected, the mainboard ID isn't known yet, or the printer
        didn't answer within `timeout`. Never raises — callers are
        expected to treat enrichment as best-effort.
        """
        if self._ws is None or self._mainboard_id is None:
            return None
        request_id = sdcp._new_request_id()
        pkt = sdcp.build_request(cmd, data, self._mainboard_id, request_id=request_id)
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = fut
        try:
            await self._ws.send(sdcp.encode(pkt))
        except Exception:  # noqa: BLE001
            self._pending.pop(request_id, None)
            log.exception("centauri: send_request send failed (cmd=%s)", cmd)
            return None
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            log.warning("centauri: send_request timeout (cmd=%s)", cmd)
            return None
        except Exception:  # noqa: BLE001
            self._pending.pop(request_id, None)
            return None

    def _on_status(self, status_payload: dict[str, Any]) -> None:
        """Drive the per-job state machine off PrintInfo.Status transitions."""
        code = sdcp.print_status_code(status_payload)
        pi = sdcp.extract_print_info(status_payload) or {}

        self._snapshot.current_status_code = code
        self._snapshot.current_filename = pi.get("Filename")
        progress = pi.get("Progress")
        self._snapshot.current_progress = (
            int(progress) if isinstance(progress, (int, float)) else None
        )
        task_id = pi.get("TaskId")
        self._snapshot.current_task_id = str(task_id) if task_id else None

        # State machine: open a job on PRINTING, close on terminal transition.
        if code == sdcp.PrintStatus.PRINTING:
            if self._job is None or (task_id and self._job.task_id != str(task_id)):
                # New job (or first job we've seen this session).
                filename = pi.get("Filename") or "<unknown>"
                # Use TotalTicks (ms) if present for est_time_min.
                total_ticks = pi.get("TotalTicks")
                est_min = None
                if isinstance(total_ticks, (int, float)) and total_ticks > 0:
                    est_min = int(total_ticks / 1000 / 60)
                self._job = JobState(
                    task_id=str(task_id) if task_id else f"unknown-{int(time.time())}",
                    filename=str(filename),
                    started_at=int(time.time()),
                    est_time_min=est_min,
                    raw_payload=dict(status_payload),
                )
                log.info("centauri: job started %s (%s)", self._job.task_id, self._job.filename)
            else:
                self._job.last_progress = self._snapshot.current_progress
                self._job.last_status_code = code

        elif code is not None and code in sdcp.TERMINAL_STATUSES and self._job is not None:
            outcome = sdcp.terminal_outcome(code)
            if outcome is None:
                return
            job = self._job
            self._job = None
            current_ticks = pi.get("CurrentTicks")
            act_min = None
            if isinstance(current_ticks, (int, float)) and current_ticks > 0:
                act_min = int(current_ticks / 1000 / 60)
            event = {
                "printerId": self._mainboard_id or "unknown",
                "sdcpJobId": job.task_id,
                "gcodeFilename": job.filename,
                "startedAt": job.started_at,
                "endedAt": int(time.time()),
                "outcome": outcome,
                "estTimeMin": job.est_time_min,
                "actTimeMin": act_min,
                # File-derived fields stay None in Phase 1.
                "estFilamentG": None,
                "actFilamentG": None,
                "plateCount": None,
                "embeddedMeshCount": None,
                "plateTransformsIdentity": None,
                "thumbnailPath": None,
                "archived3mfPath": None,
                "rawPayload": json.dumps(status_payload),
            }
            log.info(
                "centauri: job %s ended (%s) — scheduling enrichment",
                job.task_id,
                outcome,
            )
            # Don't block the read loop. Spawn enrichment; it'll emit
            # the event when (or whether) enrichment succeeds.
            self._spawn_enrichment(event, job.task_id)

    def _spawn_enrichment(
        self,
        event: dict[str, Any],
        task_id: str,
        *,
        prefetched_detail: dict[str, Any] | None = None,
    ) -> None:
        """Fork a background task that enriches + ingests the event.

        Tracked in `_enrich_tasks` so stop() can wait on outstanding
        enrichment before tearing the loop down. `prefetched_detail`
        lets the backfill path skip the inner Cmd 321 round-trip — it
        passes the dict it already fetched.
        """
        loop = asyncio.get_running_loop()
        t = loop.create_task(
            self._enrich_and_ingest(event, task_id, prefetched_detail=prefetched_detail),
            name=f"centauri-enrich-{task_id}",
        )
        self._enrich_tasks.add(t)
        t.add_done_callback(self._enrich_tasks.discard)

    def _spawn_backfill(self) -> None:
        """Fork the history-backfill task once per session.

        Tracked alongside enrichment tasks in `_enrich_tasks` so stop()
        drains it. Guarded against double-spawning per session — the
        backfill itself dedupes against the DB, so an extra run is
        harmless, but spinning up the work for nothing wastes a Cmd 320
        round-trip.
        """
        if getattr(self, "_backfill_done_this_session", False):
            return
        if self._exists_check is None:
            # No way to dedupe → can't bound the HTTP cost. Skip.
            log.debug("centauri backfill: no exists_check wired, skipping")
            return
        self._backfill_done_this_session = True
        loop = asyncio.get_running_loop()
        t = loop.create_task(
            self._backfill_history(), name="centauri-backfill"
        )
        self._enrich_tasks.add(t)
        t.add_done_callback(self._enrich_tasks.discard)

    async def _backfill_history(self) -> None:
        """Walk the printer's recent history and ingest any unseen jobs.

        1. Cmd 320 GET_HISTORY → task UUIDs newest-first.
        2. For each UUID, fast existence check against the DB —
           skip if already known.
        3. Otherwise Cmd 321 once to learn TaskName + MD5 + timestamps,
           build the event dict, and hand off to _enrich_and_ingest
           with the Cmd 321 result pre-supplied so it skips its inner
           Cmd 321 call.

        Bounded by HISTORY_BACKFILL_LIMIT — only the newest N task UUIDs
        are processed per reconnect. Re-runs cost one Cmd 320 + N tiny
        DB lookups; the expensive Cmd 321 + HTTP fetch only happens for
        genuinely-new rows.
        """
        if self._ingest is None or self._mainboard_id is None or self._exists_check is None:
            return
        resp = await self.send_request(int(sdcp.Cmd.GET_HISTORY), None, timeout=5.0)
        if not resp:
            log.warning("centauri backfill: Cmd 320 timed out, skipping")
            return
        data = resp.get("Data", {}).get("Data", {}) if isinstance(resp, dict) else {}
        task_ids = data.get("HistoryData") if isinstance(data, dict) else None
        if not isinstance(task_ids, list) or not task_ids:
            log.info("centauri backfill: no history returned by printer")
            return
        log.info(
            "centauri backfill: %d task(s) in printer history, scanning up to %d",
            len(task_ids),
            HISTORY_BACKFILL_LIMIT,
        )
        new_count = 0
        skipped_count = 0
        printer_id = self._mainboard_id or "unknown"
        for task_id in task_ids[:HISTORY_BACKFILL_LIMIT]:
            if self._stop_requested or self._ws is None:
                break
            task_id_s = str(task_id)
            try:
                if self._exists_check(printer_id, task_id_s):
                    skipped_count += 1
                    continue
            except Exception:  # noqa: BLE001
                log.exception(
                    "centauri backfill: exists_check failed for %s", task_id_s
                )
                continue
            try:
                ingested = await self._backfill_one(task_id_s)
                if ingested:
                    new_count += 1
            except Exception:  # noqa: BLE001
                log.exception("centauri backfill: task %s failed", task_id_s)
        log.info(
            "centauri backfill: done (new=%d, already-known=%d)",
            new_count,
            skipped_count,
        )

    async def _backfill_one(self, task_id: str) -> bool:
        """Ingest one printer-side task UUID. Returns True on success.

        Caller has already verified the task isn't in the DB. We hit
        Cmd 321 once for the metadata and pass the detail dict through
        to the enrichment task so it doesn't repeat the call.
        """
        resp = await self.send_request(
            int(sdcp.Cmd.GET_HISTORY_TASK_DETAIL),
            {"Id": [task_id]},
            timeout=4.0,
        )
        if not resp:
            return False
        inner = resp.get("Data", {}).get("Data", {}) if isinstance(resp, dict) else {}
        details = inner.get("HistoryDetailList") if isinstance(inner, dict) else None
        if not isinstance(details, list) or not details:
            return False
        d = details[0]
        if not isinstance(d, dict):
            return False

        task_status = d.get("TaskStatus")
        error_reason = d.get("ErrorStatusReason")
        outcome = sdcp.history_outcome(
            int(task_status) if isinstance(task_status, (int, float)) else -1,
            int(error_reason) if isinstance(error_reason, (int, float)) else None,
        )
        if outcome is None:
            log.debug(
                "centauri backfill: skipping task %s — unmapped TaskStatus=%r",
                task_id,
                task_status,
            )
            return False

        task_name = d.get("TaskName")
        begin = d.get("BeginTime")
        end = d.get("EndTime")
        dur_s = d.get("PrintDuration")
        dur_min = None
        if isinstance(dur_s, (int, float)) and dur_s > 0:
            dur_min = int(dur_s / 60)
        # Cmd 321 reports a single PrintDuration. Treat it as the
        # actual run-length; the slicer's estimate comes from the
        # gcode header during enrichment.
        filename = (
            str(task_name).rsplit("/", 1)[-1]
            if isinstance(task_name, str)
            else f"<unknown {task_id[:8]}>"
        )
        # Sanity-check timestamps. The printer occasionally returns
        # pre-NTP values (small positive ints from before clock sync)
        # for older history rows. The UI shows these as "--" in the
        # printer's own list; we'd rather show the row at created-at
        # time than render a 1970 date. Threshold = 2020-01-01.
        SANE_EPOCH = 1_577_836_800
        def _coerce_epoch(v: Any, fallback: int) -> int:
            if isinstance(v, (int, float)) and int(v) >= SANE_EPOCH:
                return int(v)
            return fallback
        now_s = int(time.time())
        started_at = _coerce_epoch(begin, fallback=_coerce_epoch(end, now_s))
        ended_at: int | None = _coerce_epoch(end, fallback=0) or None
        event = {
            "printerId": self._mainboard_id or "unknown",
            "sdcpJobId": task_id,
            "gcodeFilename": filename,
            "startedAt": started_at,
            "endedAt": ended_at,
            "outcome": outcome,
            "estTimeMin": None,
            "actTimeMin": dur_min,
            "estFilamentG": None,
            "actFilamentG": None,
            "plateCount": None,
            "embeddedMeshCount": None,
            "plateTransformsIdentity": None,
            "thumbnailPath": None,
            "archived3mfPath": None,
            "rawPayload": json.dumps(d),
        }
        self._spawn_enrichment(event, task_id, prefetched_detail=d)
        return True

    async def _enrich_and_ingest(
        self,
        event: dict[str, Any],
        task_id: str,
        *,
        prefetched_detail: dict[str, Any] | None = None,
    ) -> None:
        """Best-effort enrichment path.

        Step 1: Cmd 321 → printer-side TaskName + MD5 + plate info.
                Skipped when `prefetched_detail` is supplied (backfill
                already paid for the round-trip).
        Step 2: HTTP GET the gcode by TaskName.
        Step 3: Parse OrcaSlicer header → filament weight, time,
                input_filename_base.
        Step 4: Archive the gcode under
                ${UPLOAD_DIR}/centauri/<printer>/<startedAt>_<task>.gcode
                and prune the per-printer directory to the retention
                window.
        Step 5: Merge fields into the event dict and call self._ingest.

        Any step can fail. On failure the event is still emitted with
        whatever enrichment we managed (potentially none) — keeping the
        inbox correct is more important than the filament-weight badge.
        """
        # Step 1 — Cmd 321 (skipped if caller already has the detail dict)
        task_name: str | None = None
        printer_md5: str | None = None
        if prefetched_detail is not None:
            tn = prefetched_detail.get("TaskName")
            if isinstance(tn, str):
                task_name = tn
            m = prefetched_detail.get("MD5")
            if isinstance(m, str):
                printer_md5 = m
        else:
            try:
                resp = await self.send_request(
                    int(sdcp.Cmd.GET_HISTORY_TASK_DETAIL),
                    {"Id": [task_id]},
                    timeout=4.0,
                )
                if resp:
                    inner = resp.get("Data", {}).get("Data", {}) if isinstance(resp, dict) else {}
                    details = inner.get("HistoryDetailList") if isinstance(inner, dict) else None
                    if isinstance(details, list) and details:
                        d = details[0]
                        if isinstance(d, dict):
                            tn = d.get("TaskName")
                            if isinstance(tn, str):
                                task_name = tn
                            m = d.get("MD5")
                            if isinstance(m, str):
                                printer_md5 = m
            except Exception:  # noqa: BLE001
                log.exception("centauri: Cmd 321 failed for task %s", task_id)

        # Step 2 — HTTP fetch
        gcode_text: str | None = None
        if task_name and self._printer_ip:
            gcode_text = await gcode_meta.fetch(self._printer_ip, task_name)

        # Step 3 — parse
        parsed: dict[str, Any] = {}
        if gcode_text:
            leaf = os.path.basename(task_name) if task_name else None
            parsed = gcode_meta.parse(gcode_text, filename=leaf)

        # Step 4 — archive + prune
        archived_path: str | None = None
        if gcode_text and self._upload_dir is not None:
            try:
                archived_path = await asyncio.to_thread(
                    self._archive_gcode,
                    gcode_text,
                    event["printerId"],
                    event["startedAt"],
                    task_id,
                )
            except Exception:  # noqa: BLE001
                log.exception("centauri: gcode archive failed for task %s", task_id)

        # Step 5 — merge + emit. We deliberately don't overwrite the
        # estTimeMin we already got from the live Status payload — that
        # one matches the runtime clock used elsewhere in the UI. Use
        # the parsed value only as a fallback.
        if parsed.get("estFilamentG") is not None:
            event["estFilamentG"] = parsed["estFilamentG"]
        if event.get("estTimeMin") is None and parsed.get("estTimeMin") is not None:
            event["estTimeMin"] = parsed["estTimeMin"]
        if archived_path:
            event["archivedGcodePath"] = archived_path
        if printer_md5:
            event["gcodeMd5"] = printer_md5
        if task_name:
            event["taskName"] = task_name
        if parsed.get("inputFilenameBase"):
            event["inputFilenameBase"] = parsed["inputFilenameBase"]

        try:
            self._ingest(event)
        except Exception:  # noqa: BLE001
            log.exception("centauri: ingest callback failed")

    def _archive_gcode(
        self,
        text: str,
        printer_id: str,
        started_at: int,
        task_id: str,
    ) -> str:
        """Write the gcode under the per-printer archive dir, then prune.

        Returns the absolute path. Pruning enforces the design's
        intersection of `keep at most N` and `prune older than D days`.
        Runs in a worker thread (called via asyncio.to_thread) — this is
        the only filesystem work in the enrichment path.
        """
        assert self._upload_dir is not None  # caller guards
        dest_dir = self._upload_dir / "centauri" / printer_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        # Filename uses startedAt + a 12-char task prefix — sortable +
        # short enough to glance at, with the task_id appended so
        # operators can grep prints to disk artefacts.
        leaf = f"{started_at}_{task_id[:12]}.gcode"
        path = dest_dir / leaf
        path.write_text(text, encoding="utf-8", errors="replace")

        # Prune. Sort by mtime descending; keep first N, drop those
        # older than the cutoff anyway.
        cutoff = time.time() - ARCHIVE_KEEP_DAYS * 86400
        entries = sorted(
            (p for p in dest_dir.glob("*.gcode") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for i, p in enumerate(entries):
            if i >= ARCHIVE_KEEP_COUNT or p.stat().st_mtime < cutoff:
                with contextlib.suppress(OSError):
                    p.unlink()
        return str(path)
