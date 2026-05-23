import base64
import logging
import re
from dataclasses import dataclass
from typing import List, Optional

import requests

from custom_auth import bambu_auth
from custom_auth.bambu_auth import BambuAuthExpiredError, BambuAuthNotConfiguredError


log = logging.getLogger(__name__)


BAMBU_API_BASE = "https://api.bambulab.com"

_MODEL_PAGE_RE = re.compile(r"/models/(\d+)")

_REQUEST_TIMEOUT = 15.0  # seconds
_DOWNLOAD_TIMEOUT = 120.0  # 3MF files can be tens of MB


class MakerworldUrlError(ValueError):
    """The pasted URL doesn't look like a Makerworld model page."""


class BambuApiError(Exception):
    """Bambu/Makerworld upstream HTTP failure that isn't an auth problem.

    Mirrors the shape of `SpoolmanError` so routes can map all external
    HTTP failures to a single 502 instead of leaking raw
    `requests.HTTPError` / `RequestException` as a 500. `status` may be
    None for non-HTTP failures (timeout, connection refused).
    """

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _raise_bambu(r: requests.Response, what: str) -> None:
    """Wrap response.raise_for_status() to produce a BambuApiError."""
    try:
        r.raise_for_status()
    except requests.HTTPError as e:
        raise BambuApiError(
            f"{what}: Bambu returned HTTP {r.status_code}",
            status=r.status_code,
        ) from e


@dataclass(frozen=True)
class DownloadedFile:
    content: bytes
    name: Optional[str]  # filename Bambu suggests, if any


@dataclass(frozen=True)
class LikedDesign:
    design_id: int
    model_id: str
    title: str
    slug: str
    cover_url: str
    creator_handle: str
    is_printable: bool
    nsfw: bool

    @property
    def web_url(self) -> str:
        # Slugged form avoids a redirect when the user clicks the Source link
        # in DetailPanel; Bambu redirects bare /models/<id> → /models/<id>-<slug>.
        s = self.slug.strip("-") or str(self.design_id)
        return f"https://makerworld.com/en/models/{self.design_id}-{s}"


def _parse_liked(hit: dict) -> LikedDesign:
    creator = hit.get("designCreator") or {}
    return LikedDesign(
        design_id=int(hit.get("id") or 0),
        model_id=str(hit.get("modelId") or ""),
        title=str(hit.get("title") or "").strip() or f"design {hit.get('id')}",
        slug=str(hit.get("slug") or ""),
        cover_url=str(hit.get("cover") or ""),
        creator_handle=str(creator.get("handle") or creator.get("name") or ""),
        is_printable=bool(hit.get("isPrintable", True)),
        nsfw=bool(hit.get("nsfw", False)),
    )


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
        try:
            r = self.session.get(url, timeout=_REQUEST_TIMEOUT)
        except requests.RequestException as e:
            raise BambuApiError(f"design {design_id}: {e}") from e
        _raise_bambu(r, f"design {design_id}")
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
        try:
            r = self.session.get(url, timeout=_REQUEST_TIMEOUT)
        except requests.RequestException as e:
            raise BambuApiError(f"instances {design_id}: {e}") from e
        _raise_bambu(r, f"instances {design_id}")
        data = r.json()
        hits = data.get("hits") or []
        if not hits:
            log.info("makerworld: design %d has no instances (raw uploads only?)", design_id)
        return hits

    # ----- authenticated browse (needs a Bambu account) -----

    def list_liked(
        self, *, limit: int, offset: int, db_conn
    ) -> tuple:
        """List the signed-in user's liked Makerworld designs.

        Returns (designs, total, hidden_count). Same auth-error contract
        as importfromId — caller routes BambuAuthExpiredError to HTTP 401
        with {error: 'bambu_auth_expired'}.
        """
        token = bambu_auth.get_valid_access_token(db_conn)
        url = (
            f"{BAMBU_API_BASE}/v1/design-service/my/design/like"
            f"?limit={limit}&offset={offset}"
        )
        with requests.Session() as s:
            try:
                r = s.get(
                    url,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=_REQUEST_TIMEOUT,
                )
            except requests.RequestException as e:
                raise BambuApiError(f"/my/design/like: {e}") from e
            if r.status_code == 401:
                log.info("makerworld: /my/design/like 401 — token rejected")
                raise BambuAuthExpiredError(
                    "Bambu Cloud rejected the access token; user must sign in again"
                )
            _raise_bambu(r, "/my/design/like")
            data = r.json()
        hits = [_parse_liked(h) for h in (data.get("hits") or [])]
        return (
            hits,
            int(data.get("total") or 0),
            int(data.get("hiddenCnt") or 0),
        )

    # ----- authenticated download (needs a Bambu account) -----

    def importfromId(
        self,
        profile_id: str,
        model_id: str,
        preview_path: Optional[str],
        *,
        db_conn,
    ):
        """Download the .3mf bytes for a given (profileId, modelId) pair
        and return (DownloadedFile, thumbnail_data_url).

        Raises BambuAuthExpiredError if the user's stored credentials
        won't authenticate; the route catches that and returns HTTP 401
        with {error: 'bambu_auth_expired'} so the frontend can surface
        the re-sign-in banner. Raises BambuAuthNotConfiguredError if
        the user has never signed in.
        """
        token = bambu_auth.get_valid_access_token(db_conn)

        self.session = requests.Session()
        try:
            presigned, suggested_name = self._get_presigned_url(
                profile_id=profile_id, model_id=model_id, token=token
            )
            content = self._download_s3(presigned)
            thumbnail = self._make_thumbnail(preview_path) if preview_path else ""
            log.info(
                "makerworld: imported profileId=%s (modelId=%s) as %r (%d bytes)",
                profile_id,
                model_id,
                suggested_name,
                len(content),
            )
            return DownloadedFile(content=content, name=suggested_name), thumbnail
        finally:
            self.session.close()
            self.session = None

    def _get_presigned_url(
        self, *, profile_id: str, model_id: str, token: str
    ) -> tuple:
        """Call the authenticated profile endpoint. Returns (url, name).
        On 401 (token revoked between our expiry check and now), raises
        BambuAuthExpiredError so the route maps to bambu_auth_expired."""
        assert self.session is not None
        url = (
            f"{BAMBU_API_BASE}/v1/iot-service/api/user/profile/{profile_id}"
            f"?model_id={model_id}"
        )
        try:
            r = self.session.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=_REQUEST_TIMEOUT,
            )
        except requests.RequestException as e:
            raise BambuApiError(f"profile {profile_id}: {e}") from e
        if r.status_code == 401:
            log.info(
                "makerworld: profile endpoint returned 401 (token revoked mid-flight?)"
            )
            raise BambuAuthExpiredError(
                "Bambu Cloud rejected the access token; user must sign in again"
            )
        _raise_bambu(r, f"profile {profile_id}")
        data = r.json()
        presigned = data.get("url")
        if not presigned:
            raise RuntimeError(
                f"Bambu profile response missing 'url' (keys: {sorted(data)})"
            )
        return presigned, data.get("name")

    def _download_s3(self, presigned_url: str) -> bytes:
        """Fetch the presigned S3 URL exactly as given — no redirect-follow,
        no query-string re-encoding (signatures break on either)."""
        assert self.session is not None
        try:
            r = self.session.get(
                presigned_url,
                allow_redirects=False,
                timeout=_DOWNLOAD_TIMEOUT,
                stream=True,
            )
        except requests.RequestException as e:
            raise BambuApiError(f"S3 download: {e}") from e
        if 300 <= r.status_code < 400:
            raise BambuApiError(
                f"Unexpected redirect from S3 presigned URL (HTTP {r.status_code}); "
                "signature may be invalid or Bambu changed their flow",
                status=r.status_code,
            )
        _raise_bambu(r, "S3 download")
        return r.content

    def _make_thumbnail(self, url: str) -> str:
        """Fetch a preview image and return a data:image/png;base64,... URL
        suitable for inlining into the model row's thumbnail column.
        Returns '' on any failure (thumbnails are nice-to-have, not
        required for import to succeed)."""
        assert self.session is not None
        if not url or len(url) < 5:
            return ""
        try:
            r = self.session.get(url, allow_redirects=True, timeout=_REQUEST_TIMEOUT)
            r.raise_for_status()
            encoded = base64.b64encode(r.content).decode("ascii")
            # Bambu's CDN serves JPEG and PNG both; image/png is fine as a
            # data: prefix for browser rendering — browsers sniff content.
            return "data:image/png;base64," + encoded
        except requests.RequestException as e:
            log.warning("makerworld: thumbnail fetch failed for %s: %s", url, e)
            return ""
