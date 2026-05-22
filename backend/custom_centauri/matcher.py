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


def run_all_signals(db: DbFactory, event_id: int, gcode_filename: str) -> int:
    """Phase-2 dispatcher — only filename for now. Returns total candidates."""
    return match_filename(db, event_id, gcode_filename)
