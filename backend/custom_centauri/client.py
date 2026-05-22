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
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

import websockets
from websockets.asyncio.client import connect as ws_connect

from . import sdcp

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

    def __init__(self, ingest: IngestionCallback) -> None:
        self._ingest = ingest
        self._printer_ip: str | None = None
        self._mainboard_id: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._stop_requested = False
        self._snapshot = PrinterStatusSnapshot()
        self._job: JobState | None = None
        self._restart_event = asyncio.Event()

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
        """One connection: open, subscribe, read until close or restart."""
        url = f"ws://{host}:{WS_PORT}{WS_PATH}"
        log.info("centauri: connecting to %s", url)
        async with await asyncio.wait_for(
            ws_connect(url, max_size=None), timeout=DEFAULT_CONNECT_TIMEOUT
        ) as ws:
            now = int(time.time())
            self._snapshot = PrinterStatusSnapshot(
                connected=True,
                printer_ip=host,
                mainboard_id=self._mainboard_id,
                last_connected_at=now,
            )

            # Subscribe lazily — we need the mainboard_id first.
            subscribed = False
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

    def _handle_frame(self, raw: Any) -> None:
        msg = sdcp.parse_message(raw)

        if msg.mainboard_id and not self._mainboard_id:
            self._mainboard_id = msg.mainboard_id
            self._snapshot.mainboard_id = msg.mainboard_id

        if msg.type == sdcp.MessageType.STATUS and msg.status is not None:
            self._on_status(msg.status)

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
                "centauri: job %s ended (%s) — emitting event",
                job.task_id,
                outcome,
            )
            try:
                self._ingest(event)
            except Exception:  # noqa: BLE001
                log.exception("centauri: ingest callback failed")
