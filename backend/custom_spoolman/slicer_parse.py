"""Best-effort extraction of weight / length / duration / colour from a
sliced file produced by Elegoo Slicer, OrcaSlicer, Bambu Studio, PrusaSlicer.

Two file formats:
  - `.gcode`: regex over the comment header (first ~50KB is plenty)
  - `.3mf`: zip containing `Metadata/slice_info.config` (XML) and/or
            `Metadata/plate_1.gcode` we can recurse into

Parse failure is non-fatal — the caller treats missing fields as "user types
the number manually." No exceptions escape this module for malformed input.
"""
from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from typing import Optional


# Read at most this many bytes from the gcode header before giving up.
# Slicer metadata is always in the first few KB; this caps memory and time
# on a 200MB gcode file.
GCODE_HEADER_BYTES = 64 * 1024

# Cap the inner .3mf config we'll decompress. Real `slice_info.config`
# files are a few KB. 1 MB is generous; anything larger is either
# corrupted or a decompression-bomb attempt and we'd rather truncate
# than load it into memory.
THREEMF_CONFIG_MAX_BYTES = 1 * 1024 * 1024


@dataclass(frozen=True)
class SliceMetadata:
    est_weight_g: Optional[float] = None
    est_length_mm: Optional[float] = None
    est_duration_min: Optional[int] = None
    filament_color_hex: Optional[str] = None  # without leading '#'

    def is_empty(self) -> bool:
        return (
            self.est_weight_g is None
            and self.est_length_mm is None
            and self.est_duration_min is None
            and self.filament_color_hex is None
        )


# --- gcode header regexes ---------------------------------------------------
# Orca/Bambu/Elegoo: "; total filament used [g] = 41.30"
# Prusa:             "; filament used [g] = 41.30" or "; total filament used = ..."
# Length variants:   "; filament used [mm] = 13902.5" / "; total filament length [mm]"
# Time:              "; estimated printing time (normal mode) = 1h 35m 12s"
#                    "; estimated printing time = 1h 35m"
# Color:             "; filament_colour = #1A1A1A" or "; filament_color = ..."

_RE_WEIGHT = re.compile(
    r"^;\s*(?:total\s+)?filament\s+used\s*\[g\]\s*=\s*([\d.]+)",
    re.IGNORECASE | re.MULTILINE,
)
_RE_LENGTH = re.compile(
    r"^;\s*(?:total\s+)?filament\s+(?:used|length)\s*\[mm\]\s*=\s*([\d.]+)",
    re.IGNORECASE | re.MULTILINE,
)
_RE_TIME = re.compile(
    r"^;\s*estimated\s+printing\s+time(?:\s*\([^)]*\))?\s*=\s*"
    r"(?:(\d+)\s*d\s*)?(?:(\d+)\s*h\s*)?(?:(\d+)\s*m\s*)?(?:(\d+)\s*s)?",
    re.IGNORECASE | re.MULTILINE,
)
_RE_COLOR = re.compile(
    r"^;\s*filament_colou?r\s*=\s*#?([0-9A-Fa-f]{6})",
    re.IGNORECASE | re.MULTILINE,
)


def _parse_gcode_header(text: str) -> SliceMetadata:
    weight = None
    length = None
    minutes = None
    color = None

    m = _RE_WEIGHT.search(text)
    if m:
        try:
            weight = float(m.group(1))
        except ValueError:
            pass

    m = _RE_LENGTH.search(text)
    if m:
        try:
            length = float(m.group(1))
        except ValueError:
            pass

    m = _RE_TIME.search(text)
    if m:
        d, h, mi, s = (int(g) if g else 0 for g in m.groups())
        total_s = d * 86400 + h * 3600 + mi * 60 + s
        if total_s > 0:
            minutes = max(1, round(total_s / 60))

    m = _RE_COLOR.search(text)
    if m:
        # Take the first filament's colour — Carbon is single-extruder so
        # this is what the user cares about. Multi-colour 3MF carries multiple
        # `filament_colour` entries but we only need one as a UI hint.
        color = m.group(1).lower()

    return SliceMetadata(
        est_weight_g=weight,
        est_length_mm=length,
        est_duration_min=minutes,
        filament_color_hex=color,
    )


def parse_gcode_bytes(blob: bytes) -> SliceMetadata:
    head = blob[:GCODE_HEADER_BYTES]
    try:
        text = head.decode("utf-8", errors="replace")
    except Exception:
        return SliceMetadata()
    return _parse_gcode_header(text)


def parse_3mf_bytes(blob: bytes) -> SliceMetadata:
    """A `.3mf` is a zip. Try `Metadata/slice_info.config` (XML) first; if
    absent or unparseable, fall back to scanning embedded `plate_*.gcode`.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        return SliceMetadata()

    with zf:
        names = set(zf.namelist())

        # Prefer slice_info.config — it carries the slicer's canonical
        # estimates in a structured form across Bambu/Orca/Elegoo.
        if "Metadata/slice_info.config" in names:
            try:
                # Use zf.open(...).read(N) (NOT zf.read(name) which is
                # unbounded) to cap memory in case of a zip-bomb input.
                with zf.open("Metadata/slice_info.config") as fh:
                    cfg = fh.read(THREEMF_CONFIG_MAX_BYTES)
                md = _parse_slice_info_config(cfg)
                if not md.is_empty():
                    return md
            except Exception:
                pass

        # Fall back to the first plate gcode in the archive.
        plate_gcodes = sorted(
            n for n in names if n.startswith("Metadata/") and n.endswith(".gcode")
        )
        for name in plate_gcodes:
            try:
                with zf.open(name) as fh:
                    head = fh.read(GCODE_HEADER_BYTES)
                md = _parse_gcode_header(head.decode("utf-8", errors="replace"))
                if not md.is_empty():
                    return md
            except Exception:
                continue

    return SliceMetadata()


def _parse_slice_info_config(blob: bytes) -> SliceMetadata:
    """slice_info.config is XML-ish:
        <config>
          <plate>
            <metadata key="weight" value="41.30"/>
            <metadata key="filament_length" value="13902.5"/>
            <metadata key="prediction" value="5712"/>      <!-- seconds -->
            <filament id="1" tray_info_idx="..." type="PLA" color="#1A1A1A"/>
          </plate>
        </config>
    """
    try:
        root = ET.fromstring(blob)
    except ET.ParseError:
        return SliceMetadata()

    weight = None
    length = None
    minutes = None
    color = None

    # First <plate> wins — single-plate exports are the common case.
    plate = root.find("plate") or root
    for md in plate.findall("metadata"):
        key = (md.get("key") or "").strip().lower()
        val = (md.get("value") or "").strip()
        if not val:
            continue
        if key in ("weight", "total_weight"):
            try:
                weight = float(val)
            except ValueError:
                pass
        elif key in ("filament_length", "total_filament_length"):
            try:
                length = float(val)
            except ValueError:
                pass
        elif key in ("prediction", "estimated_time"):
            try:
                # Bambu/Orca write this in seconds.
                secs = int(float(val))
                if secs > 0:
                    minutes = max(1, round(secs / 60))
            except ValueError:
                pass

    fil = plate.find("filament")
    if fil is not None:
        c = (fil.get("color") or "").strip().lstrip("#")
        if len(c) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in c):
            color = c.lower()

    return SliceMetadata(
        est_weight_g=weight,
        est_length_mm=length,
        est_duration_min=minutes,
        filament_color_hex=color,
    )


def parse_file_bytes(filename: str, blob: bytes) -> SliceMetadata:
    """Dispatch by extension; unknown extensions return empty."""
    lower = filename.lower()
    if lower.endswith(".gcode") or lower.endswith(".gco") or lower.endswith(".g"):
        return parse_gcode_bytes(blob)
    if lower.endswith(".3mf"):
        return parse_3mf_bytes(blob)
    return SliceMetadata()
