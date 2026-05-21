import logging
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from custom_auth.bambu_auth import (
    BambuAuthExpiredError,
    BambuAuthNotConfiguredError,
)
from custom_importers._persist import persist_imported_model
from custom_importers.makerworld import (
    MakerworldImporter,
    MakerworldUrlError,
)


log = logging.getLogger(__name__)


router = APIRouter(prefix="/api/makerworld", tags=["makerworld"])


class OptionsBody(BaseModel):
    url: str


class ImportBody(BaseModel):
    id: str
    name: str
    parentId: str
    previewPath: Optional[str] = None
    folderId: str = "1"
    typeName: str = "3mf"
    sourceUrl: Optional[str] = None


# Same injection pattern as bambu_auth router — app.py supplies the
# factory at startup so the route can open a fresh DB connection per
# request without circular-importing app.py.
_db_conn_factory = None
_upload_dir: Optional[Path] = None


def configure(*, db_conn_factory, upload_dir: Path) -> None:
    global _db_conn_factory, _upload_dir
    _db_conn_factory = db_conn_factory
    _upload_dir = upload_dir


def _get_db():
    if _db_conn_factory is None:
        raise RuntimeError("custom_routes.makerworld: configure() not called")
    return _db_conn_factory()


def _now_ms() -> int:
    return int(time.time() * 1000)


@router.post("/options")
def get_options(body: OptionsBody):
    importer = MakerworldImporter()
    try:
        options = importer.getModelOptions(body.url)
    except MakerworldUrlError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return options


@router.post("/importid")
def import_model_by_id(body: ImportBody):
    importer = MakerworldImporter()
    conn = _get_db()
    try:
        try:
            downloaded, thumbnail = importer.importfromId(
                profile_id=body.id,
                model_id=body.parentId,
                preview_path=body.previewPath,
                db_conn=conn,
            )
        except (BambuAuthExpiredError, BambuAuthNotConfiguredError) as e:
            log.info("makerworld import: bambu_auth_expired (%s)", e)
            raise HTTPException(
                status_code=401,
                detail={"error": "bambu_auth_expired"},
            )

        if _upload_dir is None:
            raise RuntimeError("custom_routes.makerworld: upload_dir not configured")

        # Prefer the user-supplied display name (it came from /options and
        # already includes the design + profile title). Fall back to the
        # filename Bambu suggested if our display name is empty.
        model_name = body.name or downloaded.name or f"makerworld-{body.id}.3mf"

        model = persist_imported_model(
            downloaded.content,
            name=model_name,
            folder_id=body.folderId,
            ext=body.typeName,
            description="Imported from Makerworld",
            thumbnail=thumbnail,
            upload_dir=_upload_dir,
            db_conn=conn,
            now_ms=_now_ms(),
            source_url=body.sourceUrl,
        )
        return model
    finally:
        conn.close()
