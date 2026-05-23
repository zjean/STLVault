"""Match a Centauri print event to a STLVault model.

Phase-2 ships only the filename signal — see docs/plans/2026-05-22-centauri-
integration-design.md "Matching logic" for the full design. Recent-slicer-
open + source-hash signals land in subsequent phases.

The matcher writes one `centauri_match_candidate` row per (event, model,
signal) triple. It is **synchronous** and runs immediately after an event
row is inserted, so the inbox never shows a freshly-arrived event with
zero candidates.

Confidence thresholds are first-guess; recalibrate after two weeks of
real-printer data per the design's I3 finding.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from typing import Callable, Iterable


DbFactory = Callable[[], sqlite3.Connection]

log = logging.getLogger(__name__)


# --- filename normalisation -------------------------------------------------
#
# 4-step rule from the design doc:
#   1. lowercase
#   2. strip extension (.stl / .3mf)
#   3. strip ONE trailing version marker:
#        - `[-_]v\d+(\.\d+)?`   → `_v1`, `-v2.3`
#        - `[-_]\d+`            → bare trailing number `_2`
#        - `[-_]?\([^)]*\)`     → trailing paren-block `(1)` / `_(scaled)`
#   4. collapse repeated whitespace / underscores
#
# Stripping is single-pass on purpose: `vase_v1_scaled` normalises to
# `vase_scaled`, preserving `scaled` as a signal of intent. Removing too
# much conflates intent-different files.

_EXT_RE = re.compile(r"\.(stl|3mf)$", re.IGNORECASE)
_VERSION_SUFFIX_RES = [
    re.compile(r"[-_]v\d+(\.\d+)?$"),
    re.compile(r"[-_]\d+$"),
    re.compile(r"[-_]?\([^)]*\)$"),
]
_WS_RUN_RE = re.compile(r"[\s_]+")


def normalise_filename_stem(name: str) -> str:
    """Apply the design's 4-step normalisation to a model/file name.

    Returns the lowercased stem with one trailing version-marker stripped
    and runs of whitespace+underscore collapsed to a single underscore.
    """
    s = name.strip().lower()
    s = _EXT_RE.sub("", s)
    # Strip exactly one trailing version marker (longest match wins).
    best: tuple[int, str] | None = None
    for rx in _VERSION_SUFFIX_RES:
        m = rx.search(s)
        if m:
            if best is None or (m.end() - m.start()) > best[0]:
                best = (m.end() - m.start(), s[: m.start()])
    if best is not None:
        s = best[1]
    s = _WS_RUN_RE.sub("_", s)
    return s.strip("_")


# --- matcher ----------------------------------------------------------------

# First-guess thresholds — recalibrate after live data.
CONFIDENCE_FILENAME_SINGLE = 0.7
CONFIDENCE_FILENAME_MULTI = 0.4
# `printer_filename` is the slicer-template-extracted input filename
# (see gcode_meta.extract_input_filename_base). It's a strictly better
# signal than the generic filename stem because the slicer prefixes its
# output with `ECC_<nozzle>_..._<duration>.gcode` — meaning the generic
# normaliser sees `ecc_0.4_dragon_pla0.12_4h25m` and finds nothing,
# while the printer_filename signal sees `dragon` and matches cleanly.
CONFIDENCE_PRINTER_FILENAME_SINGLE = 0.8
CONFIDENCE_PRINTER_FILENAME_MULTI = 0.5
# `source_hash` matches the exact bytes of an STL/3MF file. It is the
# strongest available signal because a hash collision implies the user
# clicked the same source file in their slicer that they uploaded to
# STLVault. Multi-hit (two models with the same source) is rare but
# possible if a model was duplicated — we still rate it highly.
CONFIDENCE_SOURCE_HASH_SINGLE = 0.9
CONFIDENCE_SOURCE_HASH_MULTI = 0.65


def match_filename(db: DbFactory, event_id: int, gcode_filename: str) -> int:
    """Run the filename signal for `event_id`. Returns number of candidates written.

    Looks up every model whose normalised name equals the event's
    normalised gcode filename. Multi-hit gets the lower confidence;
    single-hit gets the higher.

    Idempotent on (eventId, modelId, signal) — re-running just rewrites
    the same rows (we delete + reinsert per signal).
    """
    needle = normalise_filename_stem(gcode_filename)
    if not needle:
        return 0

    conn = db()
    try:
        # Pull every model name once and normalise in Python — the
        # library scale (hundreds of models) doesn't justify a stored-
        # function approach. If this gets slow we cache normalised
        # names alongside `centauri_model_hash`.
        rows = conn.execute("SELECT id, name FROM models").fetchall()
        matches = [r for r in rows if normalise_filename_stem(r["name"]) == needle]

        # Clear any prior filename candidates for this event so re-runs
        # don't accumulate stale rows.
        conn.execute(
            "DELETE FROM centauri_match_candidate "
            "WHERE eventId = ? AND signal = 'filename'",
            (event_id,),
        )
        if not matches:
            conn.commit()
            return 0

        confidence = (
            CONFIDENCE_FILENAME_SINGLE if len(matches) == 1 else CONFIDENCE_FILENAME_MULTI
        )
        reason = f"normalised stem {needle!r} matches {len(matches)} model(s)"
        for m in matches:
            conn.execute(
                """
                INSERT INTO centauri_match_candidate (
                    eventId, modelId, signal, confidence, reason
                ) VALUES (?, ?, 'filename', ?, ?)
                """,
                (event_id, m["id"], confidence, reason),
            )
        conn.commit()
        log.info(
            "centauri matcher: event %s — %d filename hit(s) for %r",
            event_id,
            len(matches),
            gcode_filename,
        )
        return len(matches)
    finally:
        conn.close()


def list_candidates(db: DbFactory, event_id: int) -> list[dict]:
    """Return candidate models for an event, joined with model names.

    Ordered by confidence DESC. Used by the inbox detail view and the
    list view's suggestion strip.
    """
    conn = db()
    try:
        rows = conn.execute(
            """
            SELECT c.id, c.eventId, c.modelId, c.signal, c.confidence, c.reason,
                   m.name AS modelName, m.thumbnail AS modelThumbnail
            FROM centauri_match_candidate c
            LEFT JOIN models m ON m.id = c.modelId
            WHERE c.eventId = ?
            ORDER BY c.confidence DESC, c.id ASC
            """,
            (event_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r["id"],
            "eventId": r["eventId"],
            "modelId": r["modelId"],
            "signal": r["signal"],
            "confidence": r["confidence"],
            "reason": r["reason"],
            "modelName": r["modelName"],
            "modelThumbnail": r["modelThumbnail"],
        }
        for r in rows
    ]


def match_printer_filename(
    db: DbFactory, event_id: int, input_filename_base: str
) -> int:
    """Run the printer_filename signal — match against `inputFilenameBase`.

    Same DELETE-+-INSERT idempotency as `match_filename`, but writes
    under `signal='printer_filename'` so this can coexist with the
    generic filename hits and so the inbox can colour them differently
    later.
    """
    needle = normalise_filename_stem(input_filename_base)
    if not needle:
        return 0
    conn = db()
    try:
        rows = conn.execute("SELECT id, name FROM models").fetchall()
        matches = [r for r in rows if normalise_filename_stem(r["name"]) == needle]
        conn.execute(
            "DELETE FROM centauri_match_candidate "
            "WHERE eventId = ? AND signal = 'printer_filename'",
            (event_id,),
        )
        if not matches:
            conn.commit()
            return 0
        confidence = (
            CONFIDENCE_PRINTER_FILENAME_SINGLE
            if len(matches) == 1
            else CONFIDENCE_PRINTER_FILENAME_MULTI
        )
        reason = (
            f"slicer template input_filename_base {needle!r} "
            f"matches {len(matches)} model(s)"
        )
        for m in matches:
            conn.execute(
                """
                INSERT INTO centauri_match_candidate (
                    eventId, modelId, signal, confidence, reason
                ) VALUES (?, ?, 'printer_filename', ?, ?)
                """,
                (event_id, m["id"], confidence, reason),
            )
        conn.commit()
        log.info(
            "centauri matcher: event %s — %d printer_filename hit(s) for %r",
            event_id,
            len(matches),
            input_filename_base,
        )
        return len(matches)
    finally:
        conn.close()


def match_source_hash(db: DbFactory, event_id: int) -> int:
    """Cross-reference per-event mesh MD5s against `centauri_model_hash`.

    Lit by Phase-4 attach-3mf — when the user drops a .gcode.3mf onto
    an event card, the parser writes one centauri_event_mesh row per
    embedded mesh; this signal then asks "does any of those MD5s match
    a model's source or embedded hash?"

    A single inner-file collision is enough to fire — the user could
    have multiple meshes per plate, and any of them matching a known
    model is meaningful. We dedupe at the (event, model) level so a
    .gcode.3mf with three copies of the same STL doesn't write three
    candidate rows for the same model.

    Idempotent on (eventId, signal): re-running drops prior source_hash
    rows. Empty centauri_event_mesh (no .gcode.3mf attached yet) → no
    candidates.
    """
    conn = db()
    try:
        # Fetch the event's mesh hashes once.
        meshes = conn.execute(
            "SELECT DISTINCT md5 FROM centauri_event_mesh WHERE eventId = ?",
            (event_id,),
        ).fetchall()
        if not meshes:
            conn.execute(
                "DELETE FROM centauri_match_candidate "
                "WHERE eventId = ? AND signal = 'source_hash'",
                (event_id,),
            )
            conn.commit()
            return 0

        # Match each mesh MD5 against centauri_model_hash. A model can
        # match via its sourceMd5 (raw upload) or embeddedMd5 (the mesh
        # body when uploaded as .3mf). De-dup at the (modelId, matched-on)
        # level so we report each model once with the best evidence.
        md5_list = [row["md5"] for row in meshes]
        placeholders = ",".join("?" * len(md5_list))
        rows = conn.execute(
            f"""
            SELECT modelId, sourceMd5, embeddedMd5
            FROM centauri_model_hash
            WHERE sourceMd5 IN ({placeholders})
               OR embeddedMd5 IN ({placeholders})
            """,
            md5_list + md5_list,
        ).fetchall()

        hits: dict[str, str] = {}  # modelId → matched-on ('source' | 'embedded')
        md5_set = set(md5_list)
        for r in rows:
            mid = r["modelId"]
            if mid in hits:
                continue
            if r["sourceMd5"] in md5_set:
                hits[mid] = "source"
            elif r["embeddedMd5"] in md5_set:
                hits[mid] = "embedded"

        conn.execute(
            "DELETE FROM centauri_match_candidate "
            "WHERE eventId = ? AND signal = 'source_hash'",
            (event_id,),
        )
        if not hits:
            conn.commit()
            return 0

        confidence = (
            CONFIDENCE_SOURCE_HASH_SINGLE
            if len(hits) == 1
            else CONFIDENCE_SOURCE_HASH_MULTI
        )
        for model_id, matched_on in hits.items():
            reason = (
                f"mesh MD5 collides with model.{matched_on}Md5 "
                f"({len(hits)} model{'s' if len(hits) != 1 else ''} matched)"
            )
            conn.execute(
                """
                INSERT INTO centauri_match_candidate (
                    eventId, modelId, signal, confidence, reason
                ) VALUES (?, ?, 'source_hash', ?, ?)
                """,
                (event_id, model_id, confidence, reason),
            )
        conn.commit()
        log.info(
            "centauri matcher: event %s — %d source_hash hit(s)",
            event_id,
            len(hits),
        )
        return len(hits)
    finally:
        conn.close()


def run_all_signals(db: DbFactory, event_id: int, event: dict) -> int:
    """Phase-2.2 dispatcher (extended for Phase-4 source_hash).

    Accepts the full event dict so each signal can pluck what it needs.
    Signals run independently and write disjoint candidate-rows; the
    UI's "top candidate" is the highest-confidence hit across all
    signals.

    Backward-compat: callers used to pass `gcode_filename` as a string
    — now they pass the event dict. The ingest callback in
    custom_routes/centauri.py is the only in-tree caller and has been
    updated alongside this change.

    `source_hash` runs unconditionally — it's a fast indexed lookup over
    the event's mesh rows and quietly no-ops when no .gcode.3mf has
    been attached yet.
    """
    total = match_filename(db, event_id, event.get("gcodeFilename", ""))
    base = event.get("inputFilenameBase")
    if base:
        total += match_printer_filename(db, event_id, base)
    total += match_source_hash(db, event_id)
    return total
