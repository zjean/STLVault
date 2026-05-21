import logging
import sqlite3

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from custom_auth import bambu_auth as ba
from custom_auth import bambu_credentials


log = logging.getLogger(__name__)


router = APIRouter(prefix="/api/makerworld/auth", tags=["bambu-auth"])


# Minimal request shapes. We don't validate the email format ourselves
# (would require pulling in the email-validator dep) — Bambu rejects
# malformed addresses downstream, which is the source of truth anyway.


class SendCodeBody(BaseModel):
    email: str


class LoginBody(BaseModel):
    email: str
    code: str


# The DB connection accessor is injected lazily to avoid a circular import
# with backend/app.py. set_db_conn_factory() is called once from app.py at
# startup; routes use the factory to obtain a per-request connection.
_db_conn_factory = None


def set_db_conn_factory(factory) -> None:
    global _db_conn_factory
    _db_conn_factory = factory


def _get_db():
    if _db_conn_factory is None:
        raise RuntimeError(
            "custom_routes.bambu_auth: db conn factory not configured; "
            "app.py must call set_db_conn_factory(get_db_conn) at startup"
        )
    return _db_conn_factory()


@router.post("/send-code")
def send_code(body: SendCodeBody):
    try:
        ba.send_code(body.email)
    except ba.BambuAuthUpstreamError as e:
        raise HTTPException(status_code=400, detail=e.message)
    return {"ok": True}


@router.post("/login")
def login(body: LoginBody):
    conn = _get_db()
    try:
        creds = ba.login(body.email, body.code, db_conn=conn)
    except ba.BambuAuthUpstreamError as e:
        raise HTTPException(status_code=400, detail=e.message)
    finally:
        conn.close()
    return {
        "signedInAs": creds.account_email,
        "accessExpiresAt": creds.access_expires_at,
    }


@router.get("/status")
def status():
    conn = _get_db()
    try:
        st = ba.get_status(conn)
    finally:
        conn.close()
    return {
        "signedIn": st.signed_in,
        "signedInAs": st.signed_in_as,
        "accessExpiresAt": st.access_expires_at,
        "expired": st.expired,
    }


@router.post("/sign-out")
def sign_out():
    conn = _get_db()
    try:
        bambu_credentials.delete(conn)
        log.info("bambu_auth: sign-out (credentials deleted)")
    finally:
        conn.close()
    return {"ok": True}
