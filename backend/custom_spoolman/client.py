"""Thin synchronous client for the Spoolman REST API.

Uses `requests` to stay consistent with the rest of the fork (custom_importers,
custom_routes — all sync). FastAPI handles sync route handlers in a thread pool
so this doesn't block the event loop.

We only wrap the endpoints STLVault actually needs:
    GET   /spool?archived=false
    GET   /spool/{id}
    PUT   /spool/{id}/use
    GET   /info               (health check + version)

Wire format is normalised to STLVault-friendly shapes (`SpoolSummary`) at the
route layer, not here — this module stays as close to Spoolman's raw API as
possible so future endpoints are cheap to add.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests


DEFAULT_TIMEOUT = 8.0  # seconds; Spoolman is local/LAN — be impatient


class SpoolmanError(Exception):
    """Raised for any non-2xx Spoolman response or network failure.

    `status` is the HTTP code if we got a response, else 0.
    `message` is a user-displayable string.
    """

    def __init__(self, message: str, status: int = 0, body: Any = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body


@dataclass(frozen=True)
class SpoolmanClient:
    base_url: str           # e.g. "http://localhost:7912/api/v1"
    api_key: Optional[str] = None
    timeout: float = DEFAULT_TIMEOUT

    def _headers(self) -> Dict[str, str]:
        h = {"Accept": "application/json"}
        if self.api_key:
            # Spoolman itself ships no auth — but reverse proxies in front of
            # it commonly add Bearer or Basic. Forward whatever the user
            # pasted as-is; let the proxy reject if malformed.
            key = self.api_key.strip()
            if key.lower().startswith(("bearer ", "basic ")):
                h["Authorization"] = key
            else:
                h["Authorization"] = f"Bearer {key}"
        return h

    def _url(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{path}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        try:
            r = requests.request(
                method,
                self._url(path),
                params=params,
                json=json,
                headers=self._headers(),
                timeout=self.timeout,
            )
        except requests.exceptions.ConnectionError:
            # requests wraps urllib3's verbose pool error message; surface the
            # actionable bit only — "connection refused", "host unreachable",
            # etc., are all the user can do anything about.
            raise SpoolmanError(
                f"Cannot reach Spoolman at {self.base_url} — is it running?"
            )
        except requests.exceptions.Timeout:
            raise SpoolmanError(f"Spoolman at {self.base_url} timed out")
        except requests.exceptions.RequestException as e:
            raise SpoolmanError(f"Spoolman request failed: {e}")

        if r.status_code >= 400:
            try:
                body = r.json()
                msg = body.get("message") or body.get("detail") or r.text
            except Exception:
                body = r.text
                msg = r.text or f"HTTP {r.status_code}"
            raise SpoolmanError(
                f"Spoolman returned {r.status_code}: {msg}",
                status=r.status_code,
                body=body,
            )

        if not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            raise SpoolmanError(f"Spoolman returned non-JSON: {r.text[:200]}")

    # ---- info / health ----

    def info(self) -> Dict[str, Any]:
        """GET /info — returns {version: "..."}; used for the Test button."""
        return self._request("GET", "/info")

    # ---- spools ----

    def list_spools(self, *, archived: bool = False) -> List[Dict[str, Any]]:
        # Spoolman's filter param: allow_archived=false hides archived.
        # On older versions the field is just `archived`; we send the
        # commonly-supported form and let the server ignore unknowns.
        return self._request(
            "GET", "/spool", params={"allow_archived": str(archived).lower()}
        )

    def get_spool(self, spool_id: int) -> Dict[str, Any]:
        return self._request("GET", f"/spool/{spool_id}")

    def use_spool(
        self,
        spool_id: int,
        *,
        use_weight: Optional[float] = None,
        use_length: Optional[float] = None,
    ) -> Dict[str, Any]:
        """PUT /spool/{id}/use — Spoolman INCREMENTS used_weight; NOT idempotent.

        Spoolman 0.23 rejects requests that include BOTH `use_weight` and
        `use_length` ("Only specify either use_weight or use_length.").
        When both are given we prefer weight — Spoolman derives remaining
        weight from it, which is what the user actually sees in inventory.

        Callers must guard against double-fire (STLVault uses the
        `syncedToSpoolman` flag on the prints row).
        """
        if use_weight is None and use_length is None:
            raise ValueError("use_weight or use_length must be provided")
        body: Dict[str, Any] = {}
        if use_weight is not None:
            body["use_weight"] = use_weight
        elif use_length is not None:
            body["use_length"] = use_length
        return self._request("PUT", f"/spool/{spool_id}/use", json=body)
