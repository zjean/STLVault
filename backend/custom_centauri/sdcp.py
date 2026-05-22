"""SDCP v3 wire protocol for the Elegoo Centauri Carbon.

Vendored (not depended) — the upstream lib is a single-maintainer Apache-2.0
repo with no release cadence, and the surface we need is ~300 lines of JSON
envelope handling. Keeping it in-tree means upstream churn doesn't break us.

Vendored from: https://github.com/bjan/pycentauri @ 5c96e7d1aca2d819b52d5380c597aefc4ccd718f
License: Apache-2.0 (compatible with STLVault's MIT)
Last vendored: 2026-05-22

When the printer's firmware changes the wire format, update this file and
re-record the date + upstream SHA. Behaviour-preserving edits are fine; the
defensive parser (`parse_message`) accepts unknown fields rather than crashing.

Protocol summary
----------------
- WebSocket: ws://<host>:3030/websocket
- Every outbound request needs the printer's MainboardID (learned from the
  first Attributes push, or from UDP discovery via M99999 broadcast).
- Status pushes are gated behind a Cmd 512 SUBSCRIBE with a time period.
- Inbound messages are routed by ``Topic`` (status / attributes / response /
  notice).
"""

from __future__ import annotations

import json
import secrets
import time
import uuid
from enum import IntEnum
from typing import Any


class Cmd(IntEnum):
    """SDCP command codes we use. Names come from the Elegoo C++ SDK."""

    GET_PRINTER_STATUS = 0
    GET_PRINTER_ATTRIBUTES = 1
    LIST_FILES = 258
    GET_HISTORY = 320
    SUBSCRIBE = 512


# Print status codes from PrintInfo.Status. These are the ones we route on.
# The full set is in pycentauri/models.py PrintStatus; we copy only what
# the state machine actually needs.
class PrintStatus:
    IDLE = 0
    PAUSED = 6
    STOPPED = 8
    COMPLETED = 9
    PRINTING = 13
    ERROR = 14


# A transition into one of these from PRINTING means the job ended.
TERMINAL_STATUSES = frozenset({PrintStatus.COMPLETED, PrintStatus.STOPPED, PrintStatus.ERROR})


def terminal_outcome(status: int) -> str | None:
    """Map a terminal PrintStatus code to the event outcome string we persist.

    Returns one of 'completed' / 'failed' / 'cancelled', or None when the
    status is not terminal.
    """
    if status == PrintStatus.COMPLETED:
        return "completed"
    if status == PrintStatus.ERROR:
        return "failed"
    if status == PrintStatus.STOPPED:
        return "cancelled"
    return None


DEFAULT_PUSH_PERIOD_MS = 5000


class MessageType(IntEnum):
    UNKNOWN = 0
    RESPONSE = 1
    STATUS = 2
    ATTRIBUTES = 3
    NOTICE = 4


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_request_id() -> str:
    return secrets.token_hex(8)


def _new_envelope_id() -> str:
    return uuid.uuid4().hex


def build_request(
    cmd: int,
    data: dict[str, Any] | None,
    mainboard_id: str,
    *,
    request_id: str | None = None,
    envelope_id: str | None = None,
) -> dict[str, Any]:
    """Build a fully-formed SDCP request packet.

    The packet structure mirrors what ``ElegooFdmCCMessageAdapter`` emits:

        {
          "Id": "<mainboard id or uuid>",
          "Data": {
            "Cmd": <int>, "Data": {}, "RequestID": "<hex>",
            "MainboardID": "<serial>", "TimeStamp": <ms>, "From": 1
          },
          "Topic": "sdcp/request/<mainboard id>"
        }
    """
    if not mainboard_id:
        raise ValueError("mainboard_id is required for SDCP commands")
    return {
        "Id": envelope_id or mainboard_id,
        "Data": {
            "Cmd": int(cmd),
            "Data": data or {},
            "RequestID": request_id or _new_request_id(),
            "MainboardID": mainboard_id,
            "TimeStamp": _now_ms(),
            "From": 1,
        },
        "Topic": f"sdcp/request/{mainboard_id}",
    }


def build_subscribe(mainboard_id: str, period_ms: int = DEFAULT_PUSH_PERIOD_MS) -> dict[str, Any]:
    """Cmd 512 — request status pushes every `period_ms` milliseconds."""
    return build_request(Cmd.SUBSCRIBE, {"TimePeriod": int(period_ms)}, mainboard_id)


def encode(packet: dict[str, Any]) -> str:
    return json.dumps(packet, separators=(",", ":"))


def _classify(topic: str, payload: dict[str, Any]) -> MessageType:
    if "sdcp/status" in topic or "Status" in payload:
        return MessageType.STATUS
    if "sdcp/attributes" in topic or "Attributes" in payload:
        return MessageType.ATTRIBUTES
    if "sdcp/response" in topic:
        return MessageType.RESPONSE
    if "sdcp/notice" in topic:
        return MessageType.NOTICE
    return MessageType.UNKNOWN


class ParsedMessage:
    """Flattened view of an incoming SDCP frame.

    ``raw`` is always the unparsed top-level dict; the typed slots are
    populated for the common message kinds and left None otherwise. Unknown
    payloads come back as ``type=UNKNOWN`` so callers can log without crashing.
    """

    __slots__ = ("attributes", "inner", "mainboard_id", "raw", "request_id", "status", "type")

    def __init__(
        self,
        *,
        type: MessageType,
        raw: dict[str, Any],
        inner: dict[str, Any] | None = None,
        status: dict[str, Any] | None = None,
        attributes: dict[str, Any] | None = None,
        request_id: str | None = None,
        mainboard_id: str | None = None,
    ) -> None:
        self.type = type
        self.raw = raw
        self.inner = inner
        self.status = status
        self.attributes = attributes
        self.request_id = request_id
        self.mainboard_id = mainboard_id


def parse_message(raw: str | bytes | dict[str, Any]) -> ParsedMessage:
    """Parse an incoming SDCP frame. Never raises on malformed input."""
    if isinstance(raw, dict):
        obj = raw
    else:
        text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else raw
        text = text.lstrip()
        # Some SDCP variants prefix messages with a decimal length.
        if text and text[0].isdigit():
            first_brace = text.find("{")
            if first_brace > 0:
                text = text[first_brace:]
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return ParsedMessage(type=MessageType.UNKNOWN, raw={"_raw": str(raw)[:200]})
        if not isinstance(obj, dict):
            return ParsedMessage(type=MessageType.UNKNOWN, raw={"_raw": obj})

    topic = obj.get("Topic") or ""
    msg_type = _classify(topic if isinstance(topic, str) else "", obj)

    data = obj.get("Data") if isinstance(obj.get("Data"), dict) else None
    mainboard_id = obj.get("MainboardID")
    if mainboard_id is None and data is not None:
        mainboard_id = data.get("MainboardID")
    request_id = data.get("RequestID") if data is not None else None

    status_payload: dict[str, Any] | None = None
    attributes_payload: dict[str, Any] | None = None

    if msg_type == MessageType.STATUS:
        if isinstance(obj.get("Status"), dict):
            status_payload = obj["Status"]
        elif data is not None and isinstance(data.get("Status"), dict):
            status_payload = data["Status"]
        elif data is not None:
            status_payload = {k: v for k, v in data.items() if k != "MainboardID"}

    if msg_type == MessageType.ATTRIBUTES:
        if isinstance(obj.get("Attributes"), dict):
            attributes_payload = obj["Attributes"]
        elif data is not None and isinstance(data.get("Attributes"), dict):
            attributes_payload = data["Attributes"]
        elif data is not None:
            attributes_payload = {k: v for k, v in data.items() if k != "MainboardID"}
        if mainboard_id is None and attributes_payload is not None:
            mainboard_id = attributes_payload.get("MainboardID")

    return ParsedMessage(
        type=msg_type,
        raw=obj,
        inner=data,
        status=status_payload,
        attributes=attributes_payload,
        request_id=str(request_id) if request_id is not None else None,
        mainboard_id=str(mainboard_id) if mainboard_id is not None else None,
    )


def extract_print_info(status_payload: dict[str, Any]) -> dict[str, Any] | None:
    """Pull the PrintInfo block out of a Status payload. None if absent."""
    pi = status_payload.get("PrintInfo")
    return pi if isinstance(pi, dict) else None


def print_status_code(status_payload: dict[str, Any]) -> int | None:
    """Read PrintInfo.Status (the per-job status code)."""
    pi = extract_print_info(status_payload)
    if pi is None:
        return None
    code = pi.get("Status")
    return int(code) if isinstance(code, (int, float)) else None
