"""Spoolman proxy + settings routes. Fork-only.

Wired in app.py:
    from custom_spoolman.schema import ensure_spoolman_settings_table
    from custom_routes import spoolman as spoolman_routes
    ensure_spoolman_settings_table(conn)
    spoolman_routes.set_db_conn_factory(get_db_conn)
    spoolman_routes.set_upload_dir(UPLOAD_DIR)
    app.include_router(spoolman_routes.router)

URL prefix `/api/spoolman` makes the fork-only surface obvious.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

# Cap parse-slice uploads at 100 MB. .gcode files for an hour-long print
# sit around 5–20 MB; .3mf around 1–5 MB. 100 MB is generous for the
# legitimate case and small enough to bound memory under abuse.
PARSE_SLICE_MAX_BYTES = 100 * 1024 * 1024

# Only accept canonical UUID-shape model ids. Matches the format produced
# by uuid.uuid4() in app.py. Pre-empts partial-prefix matches against
# unintended files in UPLOAD_DIR.
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

from custom_spoolman import settings as ss
from custom_spoolman.client import SpoolmanClient, SpoolmanError
from custom_spoolman.slicer_parse import parse_file_bytes
from custom_prints import repo as prints_repo


log = logging.getLogger(__name__)


router = APIRouter(prefix="/api/spoolman", tags=["spoolman"])


# --- DI: db conn factory + upload dir (injected from app.py at startup) ---

_db_conn_factory = None
_upload_dir: Optional[Path] = None


def set_db_conn_factory(factory) -> None:
    global _db_conn_factory
    _db_conn_factory = factory


def set_upload_dir(path: Path) -> None:
    global _upload_dir
    _upload_dir = path


def _get_db():
    if _db_conn_factory is None:
        raise RuntimeError(
            "custom_routes.spoolman: db conn factory not configured; "
            "app.py must call set_db_conn_factory(get_db_conn) at startup"
        )
    return _db_conn_factory()


def _load_settings() -> Optional[ss.SpoolmanSettings]:
    conn = _get_db()
    try:
        return ss.read(conn)
    finally:
        conn.close()


def _require_client() -> SpoolmanClient:
    s = _load_settings()
    if not ss.is_configured(s):
        raise HTTPException(
            status_code=409,
            detail="Spoolman is not configured. Set a base URL in Settings → Spoolman.",
        )
    return SpoolmanClient(base_url=s.base_url, api_key=s.api_key)


# --- request / response shapes ---


class SettingsBody(BaseModel):
    baseUrl: Optional[str] = None
    apiKey: Optional[str] = None
    enabled: bool = False


class TestBody(BaseModel):
    # Optional one-shot override so the user can test *before* saving.
    baseUrl: Optional[str] = None
    apiKey: Optional[str] = None


def _settings_to_dto(s: Optional[ss.SpoolmanSettings]) -> Dict[str, Any]:
    if s is None:
        return {"baseUrl": None, "enabled": False, "hasApiKey": False}
    return {
        "baseUrl": s.base_url,
        "enabled": s.enabled,
        "hasApiKey": bool(s.api_key and s.api_key.strip()),
    }


def _spool_to_summary(spool: Dict[str, Any]) -> Dict[str, Any]:
    """Server-side shape for the UI picker. Single source of truth for
    field names so the frontend doesn't depend on Spoolman's wire format.
    """
    filament = spool.get("filament") or {}
    vendor = filament.get("vendor") or {}
    name = filament.get("name") or "Unnamed filament"
    vendor_name = vendor.get("name")
    material = filament.get("material")
    label_parts = [vendor_name, name] if vendor_name else [name]
    label = " ".join(p for p in label_parts if p)

    return {
        "id": spool.get("id"),
        "label": label,
        "filamentName": name,
        "vendorName": vendor_name,
        "material": material,
        "colorHex": filament.get("color_hex"),
        "remainingWeight": spool.get("remaining_weight"),
        "usedWeight": spool.get("used_weight"),
        "remainingLength": spool.get("remaining_length"),
        "location": spool.get("location"),
        "lotNr": spool.get("lot_nr"),
        "archived": bool(spool.get("archived")),
    }


# --- routes ---


@router.get("/settings")
def get_settings():
    return _settings_to_dto(_load_settings())


@router.put("/settings")
def put_settings(body: SettingsBody):
    base_url = (body.baseUrl or "").strip() or None
    # An "enabled but no base URL" row is unusable — surface that intent
    # in the DB rather than persisting a misleading state the user can
    # later trip over while debugging.
    enabled = bool(body.enabled) and base_url is not None
    # Preserve existing api_key if the field is sent empty AND a key exists
    # (so the UI doesn't need to round-trip the secret).
    api_key = body.apiKey
    conn = _get_db()
    try:
        if api_key is None:
            existing = ss.read(conn)
            api_key = existing.api_key if existing else None
        else:
            api_key = api_key.strip() or None
        saved = ss.upsert(
            conn, base_url=base_url, api_key=api_key, enabled=enabled
        )
    finally:
        conn.close()
    return _settings_to_dto(saved)


@router.post("/test")
def test_connection(body: TestBody):
    """Try GET /info on the configured (or overridden) Spoolman.

    Returns {ok, version} on success or {ok:false, error} on failure
    (never raises 500 — the UI relies on shape stability).
    """
    base_url = (body.baseUrl or "").strip() if body.baseUrl else None
    api_key = body.apiKey
    if not base_url:
        s = _load_settings()
        if not s or not s.base_url:
            return {"ok": False, "error": "No base URL configured."}
        base_url = s.base_url
        if api_key is None:
            api_key = s.api_key
    client = SpoolmanClient(base_url=base_url, api_key=api_key)
    try:
        info = client.info()
        version = (info or {}).get("version") or "(unknown)"
        return {"ok": True, "version": version}
    except SpoolmanError as e:
        return {"ok": False, "error": e.message, "status": e.status}


@router.get("/spools")
def list_spools() -> List[Dict[str, Any]]:
    client = _require_client()
    try:
        raw = client.list_spools(archived=False)
    except SpoolmanError as e:
        raise HTTPException(status_code=502, detail=e.message)
    summaries = [_spool_to_summary(s) for s in raw if not s.get("archived")]
    # Stable order: by vendor → filament name → remaining weight desc.
    summaries.sort(
        key=lambda s: (
            (s.get("vendorName") or "").lower(),
            (s.get("filamentName") or "").lower(),
            -(s.get("remainingWeight") or 0),
        )
    )
    return summaries


@router.get("/spools/{spool_id}")
def get_spool(spool_id: int) -> Dict[str, Any]:
    client = _require_client()
    try:
        return client.get_spool(spool_id)
    except SpoolmanError as e:
        status = 404 if e.status == 404 else 502
        raise HTTPException(status_code=status, detail=e.message)


@router.post("/parse-slice")
def parse_slice(
    file: Optional[UploadFile] = File(None),
    modelId: Optional[str] = None,
):
    """Parse a slicer file for weight/length/time/colour estimates.

    Two ways in:
      1. multipart upload of a fresh `.gcode` / `.3mf` (the user dragged it
         into the Log dialog).
      2. `?modelId=<id>` — re-parse whatever file STLVault has stored for
         this model. Useful when the stored model file IS the sliced one.
    """
    if file is None and not modelId:
        raise HTTPException(
            status_code=400, detail="Provide either a file upload or modelId."
        )

    if file is not None:
        try:
            # Read with a hard cap (+1 byte to detect overflow without
            # loading the whole oversized payload into memory).
            blob = file.file.read(PARSE_SLICE_MAX_BYTES + 1)
        finally:
            file.file.close()
        if len(blob) > PARSE_SLICE_MAX_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Slicer file exceeds {PARSE_SLICE_MAX_BYTES // (1024 * 1024)} MB cap.",
            )
        md = parse_file_bytes(file.filename or "", blob)
        return _slice_md_to_dto(md, source=file.filename or "(uploaded)")

    # modelId path: reuse the storage layout from app.py (file name starts
    # with model id). We do NOT import app to avoid a circular dep; instead
    # the caller passed us the upload dir at startup.
    if not _UUID_RE.match(modelId):
        raise HTTPException(status_code=400, detail="Invalid modelId shape.")
    if _upload_dir is None:
        raise HTTPException(
            status_code=500, detail="Upload directory not configured."
        )
    matched = None
    # Match by exact UUID-prefix + dot to dodge partial-prefix collisions
    # against any unrelated files that might end up in UPLOAD_DIR.
    needle = f"{modelId}."
    for fname in os.listdir(_upload_dir):
        if fname.startswith(needle):
            matched = fname
            break
    if not matched:
        raise HTTPException(status_code=404, detail="Model file not found on disk.")
    path = _upload_dir / matched
    try:
        size = os.path.getsize(path)
        if size > PARSE_SLICE_MAX_BYTES:
            # File is on disk and big — parse only the head we need. The
            # gcode-header regex is bounded inside slicer_parse, but a
            # huge .3mf zip-header is rejected here so we never load it
            # into memory.
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Stored file exceeds {PARSE_SLICE_MAX_BYTES // (1024 * 1024)} "
                    "MB cap — upload a sliced file instead."
                ),
            )
        with open(path, "rb") as fh:
            blob = fh.read(PARSE_SLICE_MAX_BYTES)
    except HTTPException:
        raise
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Cannot read model file: {e}")
    md = parse_file_bytes(matched, blob)
    return _slice_md_to_dto(md, source=matched)


def _slice_md_to_dto(md, *, source: str) -> Dict[str, Any]:
    return {
        "source": source,
        "estWeightG": md.est_weight_g,
        "estLengthMm": md.est_length_mm,
        "estDurationMin": md.est_duration_min,
        "filamentColorHex": md.filament_color_hex,
        "empty": md.is_empty(),
    }


@router.get("/reconciliation")
def reconciliation() -> Dict[str, Any]:
    """STLVault vs. Spoolman per-spool consumption gap.

    For every spool that EITHER side has touched, returns:
        {
          id, label, colorHex, material,
          stlvaultLoggedG,   # SUM(usedWeightG) of synced+consumed prints
          spoolmanUsedG,     # current used_weight in Spoolman
          gapG,              # spoolmanUsedG - stlvaultLoggedG
          archived
        }

    A positive gap means Spoolman shows more usage than STLVault has
    logged — typically: forgotten prints, failed-print purges not
    logged, material consumed by another tool, or material the user
    deducted manually in Spoolman. A negative gap means STLVault
    logged more than Spoolman has used — usually only possible if
    someone reset Spoolman's `used_weight` directly.

    This is the operational consequence of the integration being a
    self-reported ledger: the gap surfaces the work the user has to
    remember to do, instead of leaving it as a private worry.
    """
    client = _require_client()

    # Pull STLVault's per-spool synced totals.
    conn = _get_db()
    try:
        stlvault_per_spool = prints_repo.per_spool_consumption(conn, synced_only=True)
    finally:
        conn.close()

    # Pull Spoolman's full spool list once — cheaper than per-spool GETs.
    try:
        raw_spools = client.list_spools(archived=True)  # include archived for gap calc
    except SpoolmanError as e:
        raise HTTPException(status_code=502, detail=e.message)

    spoolman_by_id: Dict[int, Dict[str, Any]] = {
        s["id"]: s for s in raw_spools if s.get("id") is not None
    }

    # Union of spool ids STLVault knows about OR Spoolman has.
    all_ids = set(stlvault_per_spool.keys()) | set(spoolman_by_id.keys())

    rows: List[Dict[str, Any]] = []
    totals = {"stlvaultLoggedG": 0.0, "spoolmanUsedG": 0.0}
    for sid in all_ids:
        stl = stlvault_per_spool.get(sid, 0.0)
        spool = spoolman_by_id.get(sid)
        spm_used = float((spool or {}).get("used_weight") or 0.0)
        filament = (spool or {}).get("filament") or {}
        vendor = filament.get("vendor") or {}
        name = filament.get("name")
        vendor_name = vendor.get("name")
        label_parts = [vendor_name, name] if vendor_name else [name]
        label = " ".join(p for p in label_parts if p) or (
            f"Spool #{sid} (deleted in Spoolman)"
            if spool is None
            else f"Spool #{sid}"
        )
        rows.append(
            {
                "id": sid,
                "label": label,
                "colorHex": filament.get("color_hex"),
                "material": filament.get("material"),
                "stlvaultLoggedG": round(stl, 2),
                "spoolmanUsedG": round(spm_used, 2),
                "gapG": round(spm_used - stl, 2),
                "archived": bool((spool or {}).get("archived")),
                "presentInSpoolman": spool is not None,
            }
        )
        totals["stlvaultLoggedG"] += stl
        totals["spoolmanUsedG"] += spm_used

    # Order: largest absolute gap first — that's what the user wants to see.
    rows.sort(key=lambda r: abs(r["gapG"]), reverse=True)

    return {
        "rows": rows,
        "totals": {
            "stlvaultLoggedG": round(totals["stlvaultLoggedG"], 2),
            "spoolmanUsedG": round(totals["spoolmanUsedG"], 2),
            "gapG": round(totals["spoolmanUsedG"] - totals["stlvaultLoggedG"], 2),
        },
    }
