"""Compute MD5s for existing STLVault models so the source_hash matcher
signal can fire against them.

Phase 4.x — orthogonal to the rest of Phase 4. Without this, the new
source_hash signal only matches against models *created* via the
create-from-print flow (which writes its hash row inline). Run this once
after upgrading and existing-library matches start working.

Strategy:
  - Walk the `models` table.
  - For each model, locate the file on disk (`${UPLOAD_DIR}/<modelId>.*`
    — the upstream upload route names files by model id).
  - MD5 the bytes → `sourceMd5`.
  - For `.3mf` / `.gcode.3mf` sources, additionally parse and MD5 the
    first embedded mesh → `embeddedMd5`.
  - INSERT OR REPLACE into `centauri_model_hash`.

Synchronous and direct — typical libraries are hundreds of models and
MD5 of a 50 MB STL takes a fraction of a second. For pathological
libraries (10k+ models, multi-GB STLs) the route handler can be flipped
to a background task later, but the simple version meets users where
they are.
"""
from __future__ import annotations

import hashlib
import logging
import sqlite3
import time
from pathlib import Path
from typing import Callable

from custom_centauri import gcode3mf_meta


DbFactory = Callable[[], sqlite3.Connection]

log = logging.getLogger(__name__)


def backfill_all(db: DbFactory, upload_dir: Path) -> dict:
    """Run the backfill. Returns `{processed, skipped_existing, missing_file, errors}`.

    - `processed` — fresh hash row written (new or replaced).
    - `skipped_existing` — model already had an up-to-date hash row;
      re-using it is cheaper than re-MD5-ing the source.
    - `missing_file` — model id in DB but no matching file on disk.
      Tolerated: log + count, don't fail the batch.
    - `errors` — IO / parse errors on this model. Continue past.
    """
    upload_dir = Path(upload_dir).resolve()
    stats = {"processed": 0, "skipped_existing": 0, "missing_file": 0, "errors": 0}

    conn = db()
    try:
        # Pre-fetch the existing-hash set so we can skip in one pass.
        existing = {
            row["modelId"]
            for row in conn.execute("SELECT modelId FROM centauri_model_hash")
        }
        models = conn.execute("SELECT id FROM models").fetchall()
    finally:
        conn.close()

    for m in models:
        model_id = m["id"]
        if model_id in existing:
            stats["skipped_existing"] += 1
            continue

        path = _find_source_file(upload_dir, model_id)
        if path is None:
            log.info("hash_backfill: no on-disk file for model %s", model_id)
            stats["missing_file"] += 1
            continue

        is_3mf_family = path.name.lower().endswith((".3mf", ".gcode.3mf"))
        embedded_md5: str | None = None
        # 3mf-family sources need the whole blob in memory because the
        # parser constructs an io.BytesIO over it. Plain .stl (the common
        # case, and the one most likely to be large — high-poly miniatures
        # routinely hit 100+ MB) gets streamed in 1 MB chunks so the MD5
        # doesn't hold the whole file in memory.
        if is_3mf_family:
            try:
                blob = path.read_bytes()
            except OSError as e:
                log.warning("hash_backfill: read failed for %s (%s)", path, e)
                stats["errors"] += 1
                continue
            source_md5 = hashlib.md5(blob, usedforsecurity=False).hexdigest()
            try:
                meta = gcode3mf_meta.parse(blob)
                if meta.meshes:
                    embedded_md5 = meta.meshes[0].md5
            except Exception:  # noqa: BLE001
                # Parser is best-effort; matching can still use sourceMd5.
                log.exception(
                    "hash_backfill: gcode3mf parse failed for %s", path
                )
        else:
            md5 = hashlib.md5(usedforsecurity=False)
            try:
                with path.open("rb") as fh:
                    for chunk in iter(lambda: fh.read(1 << 20), b""):
                        md5.update(chunk)
            except OSError as e:
                log.warning("hash_backfill: read failed for %s (%s)", path, e)
                stats["errors"] += 1
                continue
            source_md5 = md5.hexdigest()

        conn = db()
        try:
            conn.execute(
                """
                INSERT OR REPLACE INTO centauri_model_hash
                    (modelId, sourceMd5, embeddedMd5, computedAt)
                VALUES (?, ?, ?, ?)
                """,
                (model_id, source_md5, embedded_md5, int(time.time())),
            )
            conn.commit()
        finally:
            conn.close()

        stats["processed"] += 1

    log.info("hash_backfill: %s", stats)
    return stats


def _find_source_file(upload_dir: Path, model_id: str) -> Path | None:
    """Locate a model's source file by id-prefix match.

    The upstream upload route names files `<modelId><ext>`. We glob for
    that pattern. If multiple match (shouldn't happen in practice but
    nothing in the upstream schema prevents it), pick the largest — the
    biggest file is most likely the source rather than a thumbnail
    sidecar.
    """
    candidates = sorted(
        (p for p in upload_dir.glob(f"{model_id}*") if p.is_file()),
        key=lambda p: p.stat().st_size,
        reverse=True,
    )
    return candidates[0] if candidates else None
