"""Parse OrcaSlicer-generated `.gcode` files for event enrichment.

The Centauri Carbon stores sliced `.gcode` (not `.gcode.3mf`) and serves
them at `http://<printer><TaskName>` once we know the TaskName via SDCP
Cmd 321 `GET_HISTORY_TASK_DETAIL`. The interesting fields are spread
across the file — top header, mid-body print summary, bottom config
block — so we slurp the full text once and pull what we need.

Returned shape from `parse(text)`:

    {
        "estFilamentG": float | None,
        "estTimeMin":   int   | None,
        "printerModel": str   | None,
        "inputFilenameBase": str | None,  # original model name pre-slice
        "slicer":       str   | None,
    }

`input_filename_base` is the user-visible model filename *before* the
slicer prefixed it with `ECC_<nozzle>_..._<duration>.gcode`. Extracted
by treating the slicer's own `filename_format` template as a regex and
applying it to the actual on-printer filename. When the template is
missing or the filename doesn't fit it, we return None — the existing
filename normaliser in matcher.py is the fallback.

All parsing is best-effort; malformed input yields partial results, not
exceptions.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx


log = logging.getLogger(__name__)

# OrcaSlicer writes these as `; <key> = <value>` lines in the gcode body
# / CONFIG_BLOCK. The total-filament line wins over the per-extruder one
# (single-extruder prints have both, multi-extruder prints only have
# `total filament used` and we want the sum either way).
_FILAMENT_TOTAL_RE = re.compile(
    r"^;\s*total\s+filament\s+used\s*\[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_FILAMENT_FALLBACK_RE = re.compile(
    r"^;\s*filament\s+used\s*\[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
# Example: `; estimated printing time (normal mode) = 6m 32s`
# Also seen: `... = 1h 2m 33s` / `... = 23s`.
_TIME_RE = re.compile(
    r"^;\s*estimated\s+printing\s+time\s*\([^)]+\)\s*=\s*(.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_PRINTER_MODEL_RE = re.compile(
    r"^;\s*printer_model\s*=\s*(.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_SLICER_RE = re.compile(
    r"^;\s*generated\s+by\s+(.+?)\s+on\s+",
    re.IGNORECASE | re.MULTILINE,
)
_FILENAME_FORMAT_RE = re.compile(
    r"^;\s*filename_format\s*=\s*(.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def _duration_to_minutes(raw: str) -> int | None:
    """Convert OrcaSlicer's "1h 2m 3s" style duration to whole minutes.

    Always rounds toward zero — matches the existing convention in
    `client.py` where `est_time_min = int(total_ticks / 1000 / 60)`. We
    keep it consistent so the inbox time chip stays stable across the
    two sources (status push vs. gcode parse).
    """
    parts = re.findall(r"(\d+)\s*(h|m|s)", raw, flags=re.IGNORECASE)
    if not parts:
        return None
    total_s = 0
    for value, unit in parts:
        n = int(value)
        if unit.lower() == "h":
            total_s += n * 3600
        elif unit.lower() == "m":
            total_s += n * 60
        elif unit.lower() == "s":
            total_s += n
    if total_s == 0:
        return None
    return total_s // 60


# Bracketed substitution tokens used in filename_format. Examples seen
# on the Centauri: `{nozzle_diameter[0]}`, `{input_filename_base}`,
# `{filament_type[0]}`, `{layer_height}`, `{print_time}`. We only need
# to extract `input_filename_base` (or its older alias `input_filename`);
# everything else just has to consume *something* non-greedily.
_TOKEN_RE = re.compile(r"\{([^{}]+)\}")


def _template_to_regex(template: str) -> re.Pattern[str] | None:
    """Convert a filename_format template into a non-greedy regex.

    Tokens become named groups so we can pick out `input_filename_base`
    after a match. Literal characters are escaped. Returns None if the
    template has no tokens (nothing to extract).
    """
    last = 0
    parts: list[str] = []
    has_token = False
    for m in _TOKEN_RE.finditer(template):
        parts.append(re.escape(template[last : m.start()]))
        token = m.group(1)
        # Strip `[0]` style suffix — we don't need the indexed value, we
        # just need to consume it.
        group_name = re.sub(r"[^A-Za-z0-9_]", "_", token).strip("_") or "tok"
        parts.append(f"(?P<{group_name}>.+?)")
        has_token = True
        last = m.end()
    parts.append(re.escape(template[last:]))
    if not has_token:
        return None
    try:
        # Anchored — the whole on-printer filename has to match the template.
        return re.compile("^" + "".join(parts) + "$")
    except re.error:
        return None


def extract_input_filename_base(filename: str, template: str | None) -> str | None:
    """Pull the user-visible model name out of a sliced filename.

    `filename` is the leaf of the printer-side path (e.g.
    `ECC_0.4_insert tipo v2_PLA0.12_6m32s.gcode`).
    `template` is the slicer's `filename_format` config value.

    Returns None when the template is missing, contains no recognisable
    `input_filename_base` / `input_filename` token, or the actual
    filename doesn't fit the template (user overrode the export name).
    """
    if not template:
        return None
    rx = _template_to_regex(template)
    if rx is None:
        return None
    m = rx.fullmatch(filename)
    if not m:
        return None
    for key in ("input_filename_base", "input_filename"):
        try:
            v = m.group(key)
        except (IndexError, KeyError):
            v = None
        if v:
            return v.strip()
    return None


def parse(text: str, filename: str | None = None) -> dict[str, Any]:
    """Extract the matcher-relevant fields from a sliced gcode file.

    `filename` is the on-printer leaf (used to derive
    `input_filename_base` via the embedded template). When None, we
    skip that extraction.
    """
    result: dict[str, Any] = {
        "estFilamentG": None,
        "estTimeMin": None,
        "printerModel": None,
        "inputFilenameBase": None,
        "slicer": None,
    }
    if not text:
        return result

    m = _FILAMENT_TOTAL_RE.search(text) or _FILAMENT_FALLBACK_RE.search(text)
    if m:
        try:
            result["estFilamentG"] = float(m.group(1))
        except ValueError:
            pass

    m = _TIME_RE.search(text)
    if m:
        result["estTimeMin"] = _duration_to_minutes(m.group(1))

    m = _PRINTER_MODEL_RE.search(text)
    if m:
        result["printerModel"] = m.group(1).strip()

    m = _SLICER_RE.search(text)
    if m:
        result["slicer"] = m.group(1).strip()

    if filename:
        m = _FILENAME_FORMAT_RE.search(text)
        if m:
            result["inputFilenameBase"] = extract_input_filename_base(
                filename, m.group(1)
            )

    return result


async def fetch(
    printer_ip: str,
    task_name: str,
    *,
    timeout: float = 15.0,
) -> str | None:
    """Download a sliced gcode file by its printer-side path.

    `task_name` is the value returned by SDCP Cmd 321 (e.g.
    `/local/ECC_0.4_insert tipo v2_PLA0.12_6m32s.gcode`). The printer
    serves the file at `http://<ip><task_name>` over plain HTTP. Returns
    the file text, or None on any failure — the enrichment path is
    optional and should not block event ingestion.

    The default timeout is generous because typical sliced gcode is 1–10
    MB and printer WiFi latency varies. Tune via the keyword arg.
    """
    if not task_name:
        return None
    # Build the URL by URL-escaping the path component. httpx's URL
    # builder does this for us when we pass the path as a parameter.
    url = f"http://{printer_ip}{task_name}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
    except httpx.HTTPError as e:
        log.warning("centauri gcode fetch failed (%s): %s", url, e)
        return None
    if r.status_code != 200:
        log.warning("centauri gcode fetch %s → %s", url, r.status_code)
        return None
    # gcode is ASCII; OrcaSlicer claims utf-8. Use replace so a stray
    # non-utf8 byte doesn't sink the parse.
    try:
        return r.content.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return None
