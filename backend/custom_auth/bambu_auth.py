import base64
import binascii
import json
import logging
import time
from dataclasses import dataclass
from typing import Optional

import requests

from .bambu_credentials import Credentials, read, upsert, with_new_tokens


log = logging.getLogger(__name__)


BAMBU_API_BASE = "https://api.bambulab.com"

_SEND_CODE_PATH = "/v1/user-service/user/sendemailcode"
_LOGIN_PATH = "/v1/user-service/user/login"
_REFRESH_PATH = "/v1/user-service/user/refreshtoken"

_REQUEST_TIMEOUT = 15.0
_EXPIRY_SLACK_MS = 60_000  # treat the token as expired this far before its real expiry


# ----- exception types -----


class BambuAuthError(Exception):
    """Base for auth-core errors."""


class BambuAuthUpstreamError(BambuAuthError):
    """Bambu's auth API returned a non-2xx response we should surface to
    the user (typically rate-limit or invalid-code)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class BambuAuthNotConfiguredError(BambuAuthError):
    """No credentials row exists. User has never signed in."""


class BambuAuthExpiredError(BambuAuthError):
    """Stored access token is expired and refresh failed. User must
    re-sign-in via Settings."""


# ----- helpers -----


def _now_ms() -> int:
    return int(time.time() * 1000)


def _redact_token(s: Optional[str]) -> str:
    if not s:
        return "<empty>"
    return f"<token len={len(s)}>"


def _b64url_decode(s: str) -> bytes:
    """Decode base64url with padding tolerance — JWT segments routinely
    omit padding."""
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + ("=" * pad))


def parse_jwt_exp_ms(token: str) -> Optional[int]:
    """Pull `exp` (unix seconds) out of a JWT payload and return it as
    unix milliseconds. Returns None if the token isn't a JWT or has no
    exp claim. Does NOT verify the signature — we trust whatever Bambu
    gave us; if they reject it later, the route returns 401 anyway."""
    if not token:
        return None
    parts = token.split(".")
    if len(parts) < 2:
        return None
    try:
        payload_bytes = _b64url_decode(parts[1])
        payload = json.loads(payload_bytes)
    except (binascii.Error, ValueError, json.JSONDecodeError):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return None
    return int(exp) * 1000


def save_pasted_token(
    db_conn,
    *,
    access_token: str,
    refresh_token: Optional[str],
    account_email: Optional[str],
    expires_at_ms: Optional[int] = None,
) -> Credentials:
    """Persist a token the user obtained out-of-band (e.g. by signing
    into bambulab.com via social login and copying the access token from
    DevTools). Computes expiry from the JWT `exp` claim if the caller
    didn't supply one. Falls back to "30 days from now" if the token
    isn't a recognisable JWT — the user knows when it was minted, and
    a wrong-low expiry just triggers an earlier re-paste prompt rather
    than failing silently."""
    if not access_token or not access_token.strip():
        raise BambuAuthUpstreamError(400, "Access token cannot be empty")

    if expires_at_ms is None:
        expires_at_ms = parse_jwt_exp_ms(access_token)
    if expires_at_ms is None:
        # Conservative fallback: 30 days. Bambu tokens are 90 days but
        # we'd rather under-estimate than have the user wonder why
        # imports started 401-ing with no warning.
        log.warning(
            "bambu_auth: could not parse JWT exp from pasted token, defaulting to 30d"
        )
        expires_at_ms = _now_ms() + 30 * 24 * 60 * 60 * 1000

    creds = Credentials(
        account_email=account_email,
        access_token=access_token.strip(),
        refresh_token=(refresh_token or "").strip() or None,
        access_expires_at=expires_at_ms,
        updated_at=_now_ms(),
    )
    upsert(db_conn, creds)
    log.info(
        "bambu_auth: pasted-token sign-in for %s (expires_at=%d, refresh=%s)",
        account_email or "<unknown>",
        creds.access_expires_at,
        "yes" if creds.refresh_token else "no",
    )
    return creds


def _parse_login_response(payload: dict, *, account_email: Optional[str]) -> Credentials:
    access_token = payload.get("accessToken") or ""
    refresh_token = payload.get("refreshToken")
    expires_in = payload.get("expiresIn")

    if not access_token or expires_in is None:
        raise BambuAuthUpstreamError(
            500,
            f"Bambu login response missing accessToken/expiresIn (keys: {sorted(payload)})",
        )

    now = _now_ms()
    return Credentials(
        account_email=account_email,
        access_token=access_token,
        refresh_token=refresh_token,
        access_expires_at=now + int(expires_in) * 1000,
        updated_at=now,
    )


# ----- public API -----


def send_code(email: str, *, session: Optional[requests.Session] = None) -> None:
    """Trigger Bambu's email-code send for the given account. Bambu's
    response is usually 200 even for unknown accounts (anti-enumeration);
    on 4xx we surface it as BambuAuthUpstreamError so the route can
    relay it (typical cause: rate limit)."""
    log.info("bambu_auth: sign-in send_code requested for %s", email)
    sess = session or requests.Session()
    try:
        r = sess.post(
            BAMBU_API_BASE + _SEND_CODE_PATH,
            json={"account": email},
            timeout=_REQUEST_TIMEOUT,
        )
        if r.status_code >= 400:
            log.warning(
                "bambu_auth: send_code HTTP %d for %s: %s",
                r.status_code,
                email,
                r.text[:300],
            )
            raise BambuAuthUpstreamError(
                r.status_code,
                _upstream_message(r) or f"Bambu returned HTTP {r.status_code}",
            )
        log.info("bambu_auth: send_code OK for %s", email)
    finally:
        if session is None:
            sess.close()


def login(
    email: str,
    code: str,
    *,
    db_conn,
    session: Optional[requests.Session] = None,
) -> Credentials:
    """Exchange (email, 6-digit code) for a token pair. On success the
    Credentials row is upserted; the credentials object is returned for
    callers that want to inspect expiry/etc. without re-reading."""
    log.info("bambu_auth: login attempt for %s (code redacted)", email)
    sess = session or requests.Session()
    try:
        r = sess.post(
            BAMBU_API_BASE + _LOGIN_PATH,
            json={"account": email, "code": code},
            timeout=_REQUEST_TIMEOUT,
        )
        if r.status_code >= 400:
            log.warning(
                "bambu_auth: login HTTP %d for %s: %s",
                r.status_code,
                email,
                r.text[:300],
            )
            raise BambuAuthUpstreamError(
                r.status_code,
                _upstream_message(r) or f"Bambu returned HTTP {r.status_code}",
            )
        creds = _parse_login_response(r.json(), account_email=email)
    finally:
        if session is None:
            sess.close()

    upsert(db_conn, creds)
    log.info(
        "bambu_auth: sign-in succeeded for %s (access %s, refresh %s, expires_at=%d)",
        email,
        _redact_token(creds.access_token),
        _redact_token(creds.refresh_token),
        creds.access_expires_at,
    )
    return creds


def try_refresh(
    refresh_token: str,
    *,
    session: Optional[requests.Session] = None,
) -> Optional[dict]:
    """Attempt to trade a refresh token for a new pair. Documented to
    return {accessToken, refreshToken, expiresIn, refreshExpiresIn} but
    currently 401s universally (per Doridian/OpenBambuAPI). Returns the
    parsed dict on 2xx, None on any non-2xx so the caller knows to
    escalate to re-login. Logs at DEBUG so when Bambu *does* re-enable
    the endpoint, the transition shows up in logs without a code change.
    """
    sess = session or requests.Session()
    try:
        r = sess.post(
            BAMBU_API_BASE + _REFRESH_PATH,
            json={"refreshToken": refresh_token},
            timeout=_REQUEST_TIMEOUT,
        )
        log.debug(
            "bambu_auth: try_refresh HTTP %d (body_len=%d)",
            r.status_code,
            len(r.content),
        )
        if r.status_code >= 400:
            return None
        return r.json()
    except requests.RequestException as e:
        log.warning("bambu_auth: try_refresh network error: %s", e)
        return None
    finally:
        if session is None:
            sess.close()


def get_valid_access_token(db_conn) -> str:
    """Return an access token that's good for at least the next 60s.
    Reads the credentials row; if expired, attempts try_refresh; on
    refresh-failure raises BambuAuthExpiredError so the caller can
    surface the re-sign-in flow."""
    creds = read(db_conn)
    if creds is None:
        log.info("bambu_auth: no credentials row; user must sign in")
        raise BambuAuthNotConfiguredError("No Bambu credentials configured")

    now = _now_ms()
    if creds.access_expires_at > now + _EXPIRY_SLACK_MS:
        return creds.access_token

    log.info(
        "bambu_auth: access token expired (expires_at=%d, now=%d); attempting refresh",
        creds.access_expires_at,
        now,
    )
    if not creds.refresh_token:
        log.info("bambu_auth: no refresh token stored; re-login required")
        raise BambuAuthExpiredError("No refresh token; user must sign in again")

    refreshed = try_refresh(creds.refresh_token)
    if refreshed is None:
        log.info("bambu_auth: refresh failed; re-login required")
        raise BambuAuthExpiredError("Refresh failed; user must sign in again")

    new_access = refreshed.get("accessToken")
    new_refresh = refreshed.get("refreshToken")
    new_expires_in = refreshed.get("expiresIn")
    if not new_access or new_expires_in is None:
        log.warning(
            "bambu_auth: refresh response missing fields (keys: %s); re-login required",
            sorted(refreshed),
        )
        raise BambuAuthExpiredError("Refresh response malformed; user must sign in again")

    rotated = with_new_tokens(
        creds,
        access_token=new_access,
        refresh_token=new_refresh,
        access_expires_at=now + int(new_expires_in) * 1000,
        updated_at=now,
    )
    upsert(db_conn, rotated)
    log.info("bambu_auth: silent refresh succeeded (good problem!)")
    return new_access


# ----- status (used by /auth/status route) -----


@dataclass(frozen=True)
class AuthStatus:
    signed_in: bool
    signed_in_as: Optional[str]
    access_expires_at: Optional[int]
    expired: bool


def get_status(db_conn) -> AuthStatus:
    creds = read(db_conn)
    if creds is None:
        return AuthStatus(
            signed_in=False,
            signed_in_as=None,
            access_expires_at=None,
            expired=False,
        )
    now = _now_ms()
    return AuthStatus(
        signed_in=True,
        signed_in_as=creds.account_email,
        access_expires_at=creds.access_expires_at,
        expired=creds.access_expires_at <= now + _EXPIRY_SLACK_MS,
    )


# ----- internal -----


def _upstream_message(r: requests.Response) -> Optional[str]:
    """Pull a human-readable error message out of a Bambu 4xx response.
    Bambu typically returns {code, error, message}. Falls back to the raw
    body truncated."""
    try:
        data = r.json()
    except ValueError:
        return r.text[:200] if r.text else None
    if isinstance(data, dict):
        msg = data.get("message") or data.get("error")
        if msg:
            return str(msg)
    return None
