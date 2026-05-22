"""LAN discovery for the original Elegoo Centauri Carbon.

The printer listens on UDP port 3000 and answers the magic probe string
``M99999`` with a JSON payload describing itself. This is NOT mDNS — the
design doc said mDNS, but the actual protocol is a UDP broadcast.

Vendored from: https://github.com/bjan/pycentauri @ 5c96e7d1aca2d819b52d5380c597aefc4ccd718f
License: Apache-2.0
"""

from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import dataclass
from typing import Any

DISCOVERY_PORT = 3000
DISCOVERY_PROBE = b"M99999"
DEFAULT_TIMEOUT = 3.0


@dataclass(slots=True)
class DiscoveredPrinter:
    host: str
    mainboard_id: str | None
    name: str | None
    machine_name: str | None
    firmware_version: str | None


def _parse_response(data: bytes, host: str) -> DiscoveredPrinter | None:
    try:
        obj = json.loads(data.decode("utf-8", "replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    inner_raw = obj.get("Data")
    inner: dict[str, Any] = inner_raw if isinstance(inner_raw, dict) else {}
    return DiscoveredPrinter(
        host=host,
        mainboard_id=inner.get("MainboardID") or obj.get("MainboardID"),
        name=inner.get("Name"),
        machine_name=inner.get("MachineName"),
        firmware_version=inner.get("FirmwareVersion"),
    )


class _DiscoveryProtocol(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.results: dict[str, DiscoveredPrinter] = {}

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        host = addr[0]
        if host in self.results:
            return
        parsed = _parse_response(data, host)
        if parsed is not None:
            self.results[host] = parsed


async def discover(
    *,
    timeout: float = DEFAULT_TIMEOUT,
    broadcast_address: str = "255.255.255.255",
    port: int = DISCOVERY_PORT,
    retries: int = 3,
) -> list[DiscoveredPrinter]:
    """Broadcast M99999 and collect responders. Returns one entry per host.

    Use `probe_one(host)` instead if you already know the printer's IP and
    just want its mainboard ID — unicast is more reliable than broadcast
    on WiFi networks where mDNS-style broadcast can be dropped.
    """
    loop = asyncio.get_running_loop()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", 0))
    sock.setblocking(False)

    transport, protocol = await loop.create_datagram_endpoint(
        _DiscoveryProtocol,
        sock=sock,
    )
    try:
        tries = max(1, retries)
        interval = timeout / max(tries, 1) / 2
        for _ in range(tries):
            transport.sendto(DISCOVERY_PROBE, (broadcast_address, port))
            await asyncio.sleep(interval)
        remaining = max(0.0, timeout - interval * tries)
        if remaining:
            await asyncio.sleep(remaining)
    finally:
        transport.close()

    return list(protocol.results.values())


async def probe_one(
    host: str,
    *,
    timeout: float = 2.0,
    port: int = DISCOVERY_PORT,
    retries: int = 2,
) -> DiscoveredPrinter | None:
    """Unicast M99999 to a known IP. Returns its DiscoveredPrinter or None.

    Bypasses broadcast (which routers happily drop) when you already
    know the printer's IP. The Centauri Carbon answers unicast probes
    on the same UDP port. Used by the WS client on connect to learn
    the mainboard ID without depending on flaky LAN broadcast.
    """
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", 0))
    sock.setblocking(False)
    transport, protocol = await loop.create_datagram_endpoint(
        _DiscoveryProtocol, sock=sock
    )
    try:
        tries = max(1, retries)
        interval = timeout / max(tries, 1) / 2
        for _ in range(tries):
            transport.sendto(DISCOVERY_PROBE, (host, port))
            await asyncio.sleep(interval)
        remaining = max(0.0, timeout - interval * tries)
        if remaining:
            await asyncio.sleep(remaining)
    finally:
        transport.close()
    # Prefer the result matching `host`; some routers SNAT-rewrite source addrs.
    if host in protocol.results:
        return protocol.results[host]
    if protocol.results:
        return next(iter(protocol.results.values()))
    return None
