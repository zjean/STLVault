"""Parse a slicer's `.gcode.3mf` for the Phase-4 attach flow.

A `.gcode.3mf` is a ZIP with this shape (OrcaSlicer / Bambu Studio /
Elegoo Slicer all converge on it):

    Metadata/
      model_settings.config   ← XML describing plates + objects + parts
      slice_info.config       ← XML with slicer metadata
      plate_<N>.gcode         ← the actual gcode per plate
      plate_<N>.png           ← preview PNG per plate
      _rels/.rels             ← OPC plumbing
    3D/
      3dmodel.model           ← the 3MF mesh body
      Objects/<name>.stl      ← per-object STL exports (when slicer kept them)
    [Content_Types].xml

Different slicers ship slightly different mesh paths; some include the
user's original `.stl` files under `3D/Objects/` or `Metadata/`, others
only embed the 3MF mesh body. We MD5 every file that looks like a mesh
(by path or extension) so the source-hash matcher can probe against
both `centauri_model_hash.sourceMd5` and `embeddedMd5`.

This module is **read-only** and best-effort: malformed inputs return an
empty result rather than raising. The caller decides whether an empty
parse is interesting (no archived path → enrichment couldn't happen).
"""
from __future__ import annotations

import hashlib
import io
import logging
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from typing import Optional


log = logging.getLogger(__name__)


# Cap per-file decompression to defend against zip-bombs. Mesh files in
# the wild run a few MB; 32 MB is generous and still safe.
MESH_FILE_MAX_BYTES = 32 * 1024 * 1024
PREVIEW_FILE_MAX_BYTES = 4 * 1024 * 1024
CONFIG_FILE_MAX_BYTES = 2 * 1024 * 1024

# Paths inside a .gcode.3mf that we treat as candidate mesh files. The
# patterns are intentionally permissive — different slicer versions
# move files around, and the cost of MD5-ing one extra file is trivial
# compared to missing a real mesh.
_MESH_PATH_RE = re.compile(
    r"(?:^|/)(?:3D/Objects/|Metadata/.*\.stl$|3D/3dmodel\.model$)",
    re.IGNORECASE,
)
_MESH_EXT_RE = re.compile(r"\.(stl|obj|3mf|ply|model)$", re.IGNORECASE)


@dataclass
class MeshEntry:
    """One mesh-like file found inside the .gcode.3mf."""

    zip_path: str
    md5: str
    size: int


@dataclass
class Gcode3mfMeta:
    """Everything Phase 4 wants from a `.gcode.3mf` upload."""

    plate_count: int = 0
    embedded_mesh_count: int = 0
    transforms_identity: Optional[bool] = None
    whole_file_md5: str = ""
    meshes: list[MeshEntry] = field(default_factory=list)
    plate_preview_png: Optional[bytes] = None

    def is_empty(self) -> bool:
        return (
            self.plate_count == 0
            and self.embedded_mesh_count == 0
            and not self.meshes
        )


def parse(blob: bytes) -> Gcode3mfMeta:
    """Parse a `.gcode.3mf` byte blob. Never raises on malformed input.

    The whole-file MD5 is always computed (cheap, ~ms for tens of MB) so
    the caller can persist it even when the inner parse comes up empty.
    """
    whole_md5 = hashlib.md5(blob, usedforsecurity=False).hexdigest()
    out = Gcode3mfMeta(whole_file_md5=whole_md5)

    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        log.info("gcode3mf: not a valid zip (size=%d)", len(blob))
        return out

    with zf:
        names = zf.namelist()

        # 1) Parse model_settings.config for plate + object counts.
        cfg_path = next(
            (n for n in names if n.lower().endswith("metadata/model_settings.config")),
            None,
        )
        if cfg_path is not None:
            try:
                with zf.open(cfg_path) as fh:
                    cfg_bytes = fh.read(CONFIG_FILE_MAX_BYTES + 1)
                if len(cfg_bytes) > CONFIG_FILE_MAX_BYTES:
                    log.info("gcode3mf: model_settings.config truncated at %d bytes", CONFIG_FILE_MAX_BYTES)
                    cfg_bytes = cfg_bytes[:CONFIG_FILE_MAX_BYTES]
                out.plate_count, out.embedded_mesh_count, out.transforms_identity = (
                    _parse_model_settings(cfg_bytes)
                )
            except (KeyError, zipfile.BadZipFile) as e:
                log.info("gcode3mf: model_settings parse failed: %s", e)

        # 2) MD5 every mesh-like inner file.
        for n in names:
            if _looks_like_mesh(n):
                try:
                    with zf.open(n) as fh:
                        data = fh.read(MESH_FILE_MAX_BYTES + 1)
                except (KeyError, zipfile.BadZipFile):
                    continue
                if len(data) > MESH_FILE_MAX_BYTES:
                    log.info(
                        "gcode3mf: mesh %s exceeds %d bytes, skipped",
                        n,
                        MESH_FILE_MAX_BYTES,
                    )
                    continue
                out.meshes.append(
                    MeshEntry(
                        zip_path=n,
                        md5=hashlib.md5(data, usedforsecurity=False).hexdigest(),
                        size=len(data),
                    )
                )

        # 3) Extract the first plate preview if present (Metadata/plate_1.png
        #    or similar). Used to seed the new model's thumbnail in the
        #    create-from-this-print flow.
        preview = next(
            (
                n
                for n in names
                if re.search(r"metadata/plate_1\.png$", n, re.IGNORECASE)
            ),
            None,
        )
        if preview is not None:
            try:
                with zf.open(preview) as fh:
                    png = fh.read(PREVIEW_FILE_MAX_BYTES + 1)
                if len(png) <= PREVIEW_FILE_MAX_BYTES:
                    out.plate_preview_png = png
            except (KeyError, zipfile.BadZipFile):
                pass

    return out


def _looks_like_mesh(zip_path: str) -> bool:
    return bool(_MESH_PATH_RE.search(zip_path) or _MESH_EXT_RE.search(zip_path))


def _parse_model_settings(blob: bytes) -> tuple[int, int, Optional[bool]]:
    """Extract (plate_count, embedded_mesh_count, transforms_identity)."""
    try:
        root = ET.fromstring(blob)
    except ET.ParseError:
        return 0, 0, None

    # Plates: <plate> elements at any depth. Slicers vary on nesting.
    plate_count = sum(1 for _ in root.iter() if _local_name(_tag(_)) == "plate")
    # Embedded objects: <object> elements.
    embedded = sum(1 for _ in root.iter() if _local_name(_tag(_)) == "object")

    # transforms_identity: True if NO model_instance carries a non-identity
    # scale/rotation matrix. Per the followup doc this is a `.gcode.3mf`-
    # only concept; the printer-side `.gcode` is already transformed.
    transforms_identity: Optional[bool] = None
    for inst in (n for n in root.iter() if _local_name(_tag(n)) == "model_instance"):
        m = None
        for child in inst:
            if _local_name(_tag(child)) == "metadata":
                key = child.attrib.get("key", "").lower()
                value = child.attrib.get("value", "")
                if key in ("matrix", "transform") and value.strip():
                    m = value
                    break
        if m is None:
            if transforms_identity is None:
                transforms_identity = True
            continue
        if _is_identity_matrix(m):
            if transforms_identity is None:
                transforms_identity = True
        else:
            transforms_identity = False
            break

    return plate_count, embedded, transforms_identity


def _tag(el: ET.Element) -> str:
    return el.tag if isinstance(el.tag, str) else ""


def _local_name(tag: str) -> str:
    # Strip XML namespace if any (`{ns}local` → `local`).
    return tag.split("}", 1)[-1] if "}" in tag else tag


_IDENTITY_TOKENS = ("1 0 0 0 1 0 0 0 1 0 0 0", "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1")


def _is_identity_matrix(s: str) -> bool:
    """OrcaSlicer / Bambu emit transforms as space-separated floats.

    A genuine identity is rare in user output (slicers always plate-place
    at least once) but it's worth recognising — when present, the print
    came from a single un-transformed mesh and source-hash matching is
    semantically safe.
    """
    nums = s.split()
    try:
        vals = [float(n) for n in nums]
    except ValueError:
        return False
    joined = " ".join(f"{v:g}" for v in vals)
    return joined in _IDENTITY_TOKENS
