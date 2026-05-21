import logging
import re
from typing import List, Optional

import requests


log = logging.getLogger(__name__)


BAMBU_API_BASE = "https://api.bambulab.com"

_MODEL_PAGE_RE = re.compile(r"/models/(\d+)")

_REQUEST_TIMEOUT = 15.0  # seconds


class MakerworldUrlError(ValueError):
    """The pasted URL doesn't look like a Makerworld model page."""


def _parse_design_id(url: str) -> int:
    m = _MODEL_PAGE_RE.search(url)
    if m is None:
        raise MakerworldUrlError(
            f"Not a Makerworld model URL (expected '/models/<numeric-id>'): {url!r}"
        )
    return int(m.group(1))


class MakerworldImporter:
    """Importer for makerworld.com model pages.

    Talks to api.bambulab.com directly — makerworld.com itself is behind a
    Cloudflare browser challenge that plain requests can't pass. See
    docs/plans/2026-05-21-makerworld-importer-design.md for the full probe
    findings.

    Holds no auth state itself; the authenticated half (importfromId)
    pulls a fresh access token via bambu_auth.get_valid_access_token() on
    each call.
    """

    def __init__(self) -> None:
        self.session: Optional[requests.Session] = None

    # ----- anonymous half (no Bambu account needed) -----

    def getModelOptions(self, url: str) -> List[dict]:
        """Given a Makerworld model URL, return the list of print profiles
        as STLModelCollection-shaped dicts:
            {parentId, id, name, folder, previewPath, typeName}
        """
        design_id = _parse_design_id(url)
        self.session = requests.Session()
        try:
            design = self._get_design(design_id)
            instances = self._get_instances(design_id)

            model_id = design.get("modelId") or ""
            title = (design.get("title") or "").strip() or f"Makerworld {design_id}"
            cover_url = design.get("coverUrl") or ""

            options: List[dict] = []
            for inst in instances:
                inst_id = inst.get("id") or inst.get("profileId")
                if inst_id is None:
                    log.warning("makerworld: instance missing id, skipping: %r", inst)
                    continue
                inst_title = (inst.get("title") or "").strip() or f"profile {inst_id}"
                inst_cover = (inst.get("cover") or "").strip() or cover_url
                # File name shown in the modal and used as the eventual model
                # row name. Combine the design title with the instance title
                # so the user can disambiguate multiple profiles of one model.
                display_name = f"{title} — {inst_title}.3mf"
                options.append(
                    {
                        "parentId": model_id,
                        "id": str(inst_id),
                        "name": display_name,
                        "folder": None,
                        "previewPath": inst_cover,
                        "typeName": "3mf",
                    }
                )
            return options
        finally:
            self.session.close()
            self.session = None

    def _get_design(self, design_id: int) -> dict:
        assert self.session is not None
        url = f"{BAMBU_API_BASE}/v1/design-service/design/{design_id}"
        r = self.session.get(url, timeout=_REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        # Bambu's API returns 200 with id=0 for unknown designs in some
        # ranges (e.g. designs that exist on the public URL but not via the
        # JSON API). Treat that as "not found".
        if not data or data.get("id") in (0, None):
            raise MakerworldUrlError(
                f"Makerworld design {design_id} not found via api.bambulab.com"
            )
        return data

    def _get_instances(self, design_id: int) -> List[dict]:
        assert self.session is not None
        url = f"{BAMBU_API_BASE}/v1/design-service/design/{design_id}/instances"
        r = self.session.get(url, timeout=_REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        hits = data.get("hits") or []
        if not hits:
            log.info("makerworld: design %d has no instances (raw uploads only?)", design_id)
        return hits
