from __future__ import annotations

import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.config import settings
from app.db import get_connection, now_iso


ALLOWED_MEDIA_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".srt", ".vtt", ".txt"}


async def import_authorized_media(
    video_id: int,
    authorization_note: str,
    upload: UploadFile | None = None,
    transcript_text: str = "",
    delete_after_processing: bool | None = None,
) -> dict:
    if not authorization_note.strip():
        raise HTTPException(status_code=400, detail="导入授权素材必须填写授权说明。")

    delete_after = settings.delete_after_processing_default if delete_after_processing is None else delete_after_processing
    stored_path = ""
    original_filename = ""
    kind = "transcript"

    if upload and upload.filename:
        original_filename = upload.filename
        suffix = Path(upload.filename).suffix.lower()
        if suffix not in ALLOWED_MEDIA_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"不支持的素材格式：{suffix}")
        kind = "transcript" if suffix in {".srt", ".vtt", ".txt"} else "media"
        settings.upload_dir.mkdir(parents=True, exist_ok=True)
        upload_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        safe_name = f"video-{video_id}-{upload_stamp}-{uuid4().hex[:8]}{suffix}"
        destination = settings.upload_dir / safe_name
        with destination.open("wb") as handle:
            shutil.copyfileobj(upload.file, handle)
        stored_path = str(destination)
        if kind == "transcript" and not transcript_text:
            transcript_text = destination.read_text(encoding="utf-8", errors="ignore")

    if not upload and not transcript_text.strip():
        raise HTTPException(status_code=400, detail="请上传授权素材或粘贴授权文本稿。")

    timestamp = now_iso()
    with get_connection() as conn:
        video = conn.execute("SELECT id FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise HTTPException(status_code=404, detail="视频不存在。")
        cursor = conn.execute(
            """
            INSERT INTO media_assets (
              video_id, kind, original_filename, stored_path, transcript_text,
              authorization_note, delete_after_processing, processing_status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?)
            """,
            (
                video_id,
                kind,
                original_filename,
                stored_path,
                transcript_text,
                authorization_note,
                1 if delete_after else 0,
                timestamp,
            ),
        )
        conn.execute("UPDATE videos SET status = 'imported', updated_at = ? WHERE id = ?", (timestamp, video_id))
        return {
            "id": cursor.lastrowid,
            "video_id": video_id,
            "kind": kind,
            "original_filename": original_filename,
            "delete_after_processing": delete_after,
            "message": "已导入授权素材；公开视频未被下载。",
        }


def extract_audio(media_path: str, video_id: int) -> Path:
    source = Path(media_path)
    if not source.exists():
        raise FileNotFoundError(media_path)
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    output = settings.tmp_dir / f"video-{video_id}-audio.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(output),
        ],
        check=True,
        capture_output=True,
    )
    return output


def cleanup_processed_media(video_id: int) -> list[str]:
    removed: list[str] = []
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, stored_path FROM media_assets
            WHERE video_id = ? AND delete_after_processing = 1 AND stored_path != ''
            """,
            (video_id,),
        ).fetchall()
        for row in rows:
            path = Path(row["stored_path"])
            if path.exists():
                path.unlink()
                removed.append(str(path))
            conn.execute(
                "UPDATE media_assets SET stored_path = '', processing_status = 'processed_deleted' WHERE id = ?",
                (row["id"],),
            )
    return removed
