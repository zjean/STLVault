import json
import logging
import os
import sqlite3
import uuid
from pathlib import Path
from typing import Optional


log = logging.getLogger(__name__)


def persist_imported_model(
    file_bytes: bytes,
    *,
    name: str,
    folder_id: str,
    ext: str,
    description: str,
    thumbnail: Optional[str],
    upload_dir: Path,
    db_conn: sqlite3.Connection,
    now_ms: int,
    source_url: Optional[str] = None,
) -> dict:
    """Write the bytes to UPLOAD_DIR/<uuid>.<ext>, insert a row into
    models, return the new model dict.

    Mirrors the inline Printables persist block at app.py:500-528 so the
    Makerworld route stays a thin wrapper. The Printables route still
    does this work inline; a future cleanup PR can DRY it through here.
    """
    mid = str(uuid.uuid4())
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_ext = (ext or "").lstrip(".") or "3mf"
    filename = f"{mid}.{file_ext}"
    path = upload_dir / filename

    with open(path, "wb") as fh:
        fh.write(file_bytes)
    size = os.path.getsize(path)

    model = {
        "id": mid,
        "name": name,
        "folderId": folder_id if folder_id != "all" else "1",
        "url": f"/api/models/{mid}/download",
        "size": size,
        "dateAdded": now_ms,
        "tags": ["imported"],
        "description": description,
        "thumbnail": thumbnail or "",
        "sourceUrl": source_url,
    }

    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO models(id,name,folderId,url,size,dateAdded,tags,description,thumbnail,sourceUrl) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            model["id"],
            model["name"],
            model["folderId"],
            model["url"],
            model["size"],
            model["dateAdded"],
            json.dumps(model["tags"]),
            model["description"],
            model["thumbnail"],
            model["sourceUrl"],
        ),
    )
    db_conn.commit()
    log.info(
        "persist: imported %s as %s (%d bytes) into folder %s",
        name,
        filename,
        size,
        model["folderId"],
    )
    return model
