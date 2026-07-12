from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.ai import transcribe_and_translate
from app.automation import run_automation
from app.branding import import_brand_logo
from app.config import settings
from app.daily import get_daily_report, run_daily_discovery
from app.db import get_connection, init_db, now_iso, row_to_dict
from app.downloads import list_download_tasks, run_authorized_download
from app.exports import clip_marks_to_csv, segments_to_srt, segments_to_vtt
from app.jobs import get_job, list_jobs, retry_job
from app.render_jobs import create_render_clips_job
from app.schemas import AutomationRequest, ClipMarkCreate, ClipMarkReorder, ClipMarkUpdate, DailyRunRequest, DownloadRequest, DownloadTranslateRequest, PersonCreate, RenderClipsRequest, TopicCreate, TopicUpdate, VideoUpdate, YoutubeSyncRequest
from app.seed import seed_people_if_empty
from app.system import system_status
from app.media import import_authorized_media
from app.workflow import clip_payload, create_download_translate_job, create_subtitle_reprocess_job, media_asset_with_url
from app.youtube import sync_youtube
from app.topics import create_topic, ensure_default_topic, get_topic, list_topics, update_topic

VALID_STATUSES = {
    "new",
    "shortlisted",
    "imported",
    "translated",
    "clipped",
    "exported",
    "archived",
    "discovered",
    "summarizing",
    "ready",
    "downloading",
    "subtitle_fetching",
    "transcribing",
    "translating",
    "clip_ready",
    "failed",
}

CLIP_MARK_ORDER_SQL = "position IS NULL, position, start_seconds, id"

settings.ensure_dirs()
app = FastAPI(title="Topic Workbench API", version="0.2.0")
app.mount("/media/downloads", StaticFiles(directory=settings.download_dir), name="downloaded_media")
app.mount("/media/uploads", StaticFiles(directory=settings.upload_dir), name="uploaded_media")
app.mount("/media/exports", StaticFiles(directory=settings.export_dir), name="exported_media")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()
    ensure_default_topic()
    seed_people_if_empty()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "time": now_iso(), "compliance": "metadata_only_for_public_youtube"}


@app.get("/api/system/status")
def get_system_status() -> dict:
    return system_status()


@app.get("/api/dashboard")
def dashboard() -> dict:
    with get_connection() as conn:
        status_rows = conn.execute("SELECT status, COUNT(*) AS count FROM videos GROUP BY status").fetchall()
        today = datetime.now(timezone.utc).date().isoformat()
        videos = [
            row_to_dict(row)
            for row in conn.execute(
                """
                SELECT * FROM videos
                ORDER BY priority_score DESC, published_at DESC
                LIMIT 8
                """
            ).fetchall()
        ]
        latest_job = conn.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT 1").fetchone()
        clip_count = conn.execute("SELECT COUNT(*) AS count FROM clip_marks").fetchone()["count"]
        people_count = conn.execute("SELECT COUNT(*) AS count FROM people").fetchone()["count"]
    return {
        "date": today,
        "status_counts": {row["status"]: row["count"] for row in status_rows},
        "top_videos": videos,
        "latest_job": row_to_dict(latest_job) if latest_job else None,
        "clip_count": clip_count,
        "people_count": people_count,
        "compliance_note": "默认只抓 YouTube 元数据和原始链接，不下载公开视频。",
    }


@app.get("/api/topics")
def topics_index() -> list[dict]:
    return list_topics()


@app.post("/api/topics")
def topics_create(payload: TopicCreate) -> dict:
    return create_topic(payload.model_dump())


@app.get("/api/topics/{topic_id}")
def topics_detail(topic_id: int) -> dict:
    try:
        return get_topic(topic_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.patch("/api/topics/{topic_id}")
def topics_update(topic_id: int, payload: TopicUpdate) -> dict:
    try:
        return update_topic(topic_id, payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/daily")
def daily(date: str | None = None, start_date: str | None = None, end_date: str | None = None, topic_id: int = Query(default=1, gt=0)) -> dict:
    try:
        return get_daily_report(start_date or date, end_date, topic_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/daily/run")
async def daily_run(payload: DailyRunRequest) -> dict:
    try:
        return await run_daily_discovery(payload.date, payload.limit_per_query, payload.start_date, payload.end_date, payload.topic_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/jobs")
def jobs_index(video_id: int | None = None, topic_id: int | None = Query(default=None, gt=0), limit: int = Query(default=100, ge=1, le=500)) -> list[dict]:
    return list_jobs(video_id=video_id, limit=limit, topic_id=topic_id)


@app.get("/api/jobs/{job_id}")
def job_detail(job_id: int) -> dict:
    try:
        return get_job(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/jobs/{job_id}/retry")
def retry_job_endpoint(job_id: int) -> dict:
    try:
        return retry_job(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/people")
def list_people() -> list[dict]:
    with get_connection() as conn:
        return [row_to_dict(row) for row in conn.execute("SELECT * FROM people ORDER BY priority DESC, id DESC").fetchall()]


@app.post("/api/people")
def create_person(payload: PersonCreate) -> dict:
    timestamp = now_iso()
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO people (name, english_name, aliases, priority, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (payload.name, payload.english_name, payload.aliases, payload.priority, payload.notes, timestamp, timestamp),
        )
        return row_to_dict(conn.execute("SELECT * FROM people WHERE id = ?", (cursor.lastrowid,)).fetchone())


@app.post("/api/people/import-csv")
async def import_people_csv(file: UploadFile = File(...)) -> dict:
    text = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    inserted = 0
    timestamp = now_iso()
    with get_connection() as conn:
        for row in reader:
            name = (row.get("name") or row.get("姓名") or "").strip()
            if not name:
                continue
            conn.execute(
                """
                INSERT INTO people (name, english_name, aliases, priority, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    (row.get("english_name") or row.get("英文名") or "").strip(),
                    (row.get("aliases") or row.get("别名") or "").strip(),
                    int(row.get("priority") or row.get("优先级") or 3),
                    (row.get("notes") or row.get("备注") or "").strip(),
                    timestamp,
                    timestamp,
                ),
            )
            inserted += 1
    return {"inserted": inserted}


@app.get("/api/videos")
def list_videos(
    status: str | None = None,
    search: str = "",
    topic_id: int = Query(default=1, gt=0),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[dict]:
    clauses = ["topic_id = ?"]
    params: list[object] = [topic_id]
    if status:
        clauses.append("status = ?")
        params.append(status)
    if search:
        clauses.append("(title LIKE ? OR channel_title LIKE ? OR matched_people LIKE ? OR candidate_people LIKE ?)")
        term = f"%{search}%"
        params.extend([term, term, term, term])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with get_connection() as conn:
        return [
            row_to_dict(row)
            for row in conn.execute(
                f"""
                SELECT * FROM videos
                {where}
                ORDER BY priority_score DESC, published_at DESC, id DESC
                LIMIT ?
                """,
                (*params, limit),
            ).fetchall()
        ]


@app.get("/api/videos/{video_id}")
def get_video(video_id: int) -> dict:
    with get_connection() as conn:
        video = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise HTTPException(status_code=404, detail="视频不存在。")
        transcripts = [
            row_to_dict(row)
            for row in conn.execute(
                "SELECT * FROM transcripts WHERE video_id = ? ORDER BY language, start_seconds",
                (video_id,),
            ).fetchall()
        ]
        clips = [
            row_to_dict(row)
            for row in conn.execute(f"SELECT * FROM clip_marks WHERE video_id = ? ORDER BY {CLIP_MARK_ORDER_SQL}", (video_id,)).fetchall()
        ]
        assets = [
            media_asset_with_url(row_to_dict(row))
            for row in conn.execute("SELECT * FROM media_assets WHERE video_id = ? ORDER BY id DESC", (video_id,)).fetchall()
        ]
    return {"video": row_to_dict(video), "transcripts": transcripts, "clip_marks": clips, "media_assets": assets}


@app.patch("/api/videos/{video_id}")
def update_video(video_id: int, payload: VideoUpdate) -> dict:
    if payload.status and payload.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="无效状态。")
    timestamp = now_iso()
    with get_connection() as conn:
        existing = conn.execute("SELECT id FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="视频不存在。")
        if payload.status:
            conn.execute("UPDATE videos SET status = ?, updated_at = ? WHERE id = ?", (payload.status, timestamp, video_id))
        return row_to_dict(conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone())


@app.post("/api/sync/youtube")
async def sync_youtube_endpoint(payload: YoutubeSyncRequest) -> dict:
    timestamp = now_iso()
    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO jobs (type, status, message, payload, created_at, updated_at) VALUES ('sync_youtube', 'running', '', ?, ?, ?)",
            (json.dumps(payload.model_dump(), ensure_ascii=False), timestamp, timestamp),
        )
        job_id = cursor.lastrowid
    try:
        result = await sync_youtube(payload.days_back, payload.limit_per_query, payload.include_demo_when_unconfigured, topic_id=payload.topic_id)
        status = "completed"
        message = result.get("message", "")
    except Exception as exc:
        result = {"message": str(exc)}
        status = "failed"
        message = str(exc)
    with get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, message = ?, payload = ?, updated_at = ? WHERE id = ?",
            (status, message, json.dumps(result, ensure_ascii=False), now_iso(), job_id),
        )
    if status == "failed":
        raise HTTPException(status_code=502, detail=message)
    return {"job_id": job_id, **result}


@app.post("/api/automation/run")
async def automation_endpoint(payload: AutomationRequest) -> dict:
    return await run_automation(payload)


@app.post("/api/media/import")
async def import_media_endpoint(
    video_id: int = Form(...),
    authorization_note: str = Form(...),
    transcript_text: str = Form(""),
    delete_after_processing: bool | None = Form(None),
    file: UploadFile | None = File(None),
) -> dict:
    return await import_authorized_media(video_id, authorization_note, file, transcript_text, delete_after_processing)


@app.post("/api/videos/{video_id}/transcribe")
def transcribe_endpoint(video_id: int) -> dict:
    result = transcribe_and_translate(video_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("message", "处理失败"))
    return result


@app.post("/api/videos/{video_id}/download")
def download_video_endpoint(video_id: int, payload: DownloadRequest) -> dict:
    return run_authorized_download(
        video_id=video_id,
        authorization_note=payload.authorization_note,
        quality=payload.quality,
        include_subtitles=payload.include_subtitles,
        include_thumbnail=payload.include_thumbnail,
    )


@app.post("/api/items/{video_id}/download-translate")
def download_translate_endpoint(video_id: int, payload: DownloadTranslateRequest) -> dict:
    try:
        job = create_download_translate_job(video_id, payload.authorization_note, payload.quality)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return job


@app.post("/api/items/{video_id}/reprocess-subtitles")
def reprocess_subtitles_endpoint(video_id: int) -> dict:
    try:
        job = create_subtitle_reprocess_job(video_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return job


@app.get("/api/items/{video_id}/clip")
def item_clip(video_id: int) -> dict:
    try:
        return clip_payload(video_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/items/{video_id}/brand-logo")
async def upload_brand_logo(video_id: int, file: UploadFile = File(...)) -> dict:
    return await import_brand_logo(video_id, file)


@app.post("/api/items/{video_id}/render-clips")
def render_clips(video_id: int, payload: RenderClipsRequest | None = None) -> dict:
    payload = payload or RenderClipsRequest()
    try:
        return create_render_clips_job(video_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/download-tasks")
def download_tasks(video_id: int | None = None) -> list[dict]:
    return list_download_tasks(video_id)


@app.post("/api/clip-marks")
def create_clip_mark(payload: ClipMarkCreate) -> dict:
    if payload.end_seconds <= payload.start_seconds:
        raise HTTPException(status_code=400, detail="结束时间必须大于开始时间。")
    timestamp = now_iso()
    with get_connection() as conn:
        video = conn.execute("SELECT id FROM videos WHERE id = ?", (payload.video_id,)).fetchone()
        if not video:
            raise HTTPException(status_code=404, detail="视频不存在。")
        next_position = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM clip_marks WHERE video_id = ?",
            (payload.video_id,),
        ).fetchone()["next_position"]
        cursor = conn.execute(
            """
            INSERT INTO clip_marks (video_id, start_seconds, end_seconds, label, note, quote, position, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.video_id,
                payload.start_seconds,
                payload.end_seconds,
                payload.label,
                payload.note,
                payload.quote,
                next_position,
                payload.status,
                timestamp,
                timestamp,
            ),
        )
        conn.execute("UPDATE videos SET status = 'clipped', updated_at = ? WHERE id = ?", (timestamp, payload.video_id))
        return row_to_dict(conn.execute("SELECT * FROM clip_marks WHERE id = ?", (cursor.lastrowid,)).fetchone())


@app.delete("/api/clip-marks/{clip_mark_id}")
def delete_clip_mark(clip_mark_id: int) -> dict:
    with get_connection() as conn:
        mark = conn.execute("SELECT * FROM clip_marks WHERE id = ?", (clip_mark_id,)).fetchone()
        if not mark:
            raise HTTPException(status_code=404, detail="剪辑片段不存在。")
        conn.execute("DELETE FROM clip_marks WHERE id = ?", (clip_mark_id,))
        remaining = conn.execute("SELECT COUNT(*) AS count FROM clip_marks WHERE video_id = ?", (mark["video_id"],)).fetchone()["count"]
        if not remaining:
            conn.execute("UPDATE videos SET status = 'clip_ready', updated_at = ? WHERE id = ?", (now_iso(), mark["video_id"]))
    return {"message": "已从剪辑序列移除。"}


@app.patch("/api/clip-marks/{clip_mark_id}")
def update_clip_mark(clip_mark_id: int, payload: ClipMarkUpdate) -> dict:
    if payload.end_seconds <= payload.start_seconds:
        raise HTTPException(status_code=400, detail="结束时间必须大于开始时间。")
    timestamp = now_iso()
    with get_connection() as conn:
        mark = conn.execute("SELECT * FROM clip_marks WHERE id = ?", (clip_mark_id,)).fetchone()
        if not mark:
            raise HTTPException(status_code=404, detail="剪辑片段不存在。")
        conn.execute(
            """
            UPDATE clip_marks
            SET start_seconds = ?, end_seconds = ?, label = ?, note = ?, quote = ?, status = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.start_seconds,
                payload.end_seconds,
                payload.label,
                payload.note,
                payload.quote,
                payload.status,
                timestamp,
                clip_mark_id,
            ),
        )
        conn.execute("UPDATE videos SET status = 'clipped', updated_at = ? WHERE id = ?", (timestamp, mark["video_id"]))
        return row_to_dict(conn.execute("SELECT * FROM clip_marks WHERE id = ?", (clip_mark_id,)).fetchone())


@app.post("/api/items/{video_id}/clip-order")
def reorder_clip_marks(video_id: int, payload: ClipMarkReorder) -> dict:
    submitted_ids = payload.clip_mark_ids
    if len(submitted_ids) != len(set(submitted_ids)):
        raise HTTPException(status_code=400, detail="剪辑序列包含重复片段。")
    timestamp = now_iso()
    with get_connection() as conn:
        video = conn.execute("SELECT id FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise HTTPException(status_code=404, detail="视频不存在。")
        existing_ids = [
            row["id"]
            for row in conn.execute(f"SELECT id FROM clip_marks WHERE video_id = ? ORDER BY {CLIP_MARK_ORDER_SQL}", (video_id,)).fetchall()
        ]
        if set(submitted_ids) != set(existing_ids):
            raise HTTPException(status_code=400, detail="排序列表必须包含当前视频的全部片段。")
        for position, clip_mark_id in enumerate(submitted_ids):
            conn.execute("UPDATE clip_marks SET position = ?, updated_at = ? WHERE id = ?", (position, timestamp, clip_mark_id))
        conn.execute("UPDATE videos SET status = 'clipped', updated_at = ? WHERE id = ?", (timestamp, video_id))
        clips = [
            row_to_dict(row)
            for row in conn.execute(f"SELECT * FROM clip_marks WHERE video_id = ? ORDER BY {CLIP_MARK_ORDER_SQL}", (video_id,)).fetchall()
        ]
    return {"message": "剪辑序列顺序已更新。", "clip_marks": clips}


@app.get("/api/videos/{video_id}/export")
def export_video(
    video_id: int,
    format: str = Query(pattern="^(srt|vtt|csv)$"),
    language: str = Query(default="zh"),
    disposition: str = Query(default="attachment", pattern="^(attachment|inline)$"),
) -> PlainTextResponse:
    with get_connection() as conn:
        video = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise HTTPException(status_code=404, detail="视频不存在。")
        if format in {"srt", "vtt"}:
            segments = [
                row_to_dict(row)
                for row in conn.execute(
                    "SELECT * FROM transcripts WHERE video_id = ? AND language = ? ORDER BY start_seconds",
                    (video_id, language),
                ).fetchall()
            ]
            if not segments:
                raise HTTPException(status_code=404, detail="没有可导出的字幕。")
            content = segments_to_srt(segments) if format == "srt" else segments_to_vtt(segments)
            media_type = "application/x-subrip; charset=utf-8" if format == "srt" else "text/vtt; charset=utf-8"
        else:
            clips = [
                row_to_dict(row)
                for row in conn.execute(f"SELECT * FROM clip_marks WHERE video_id = ? ORDER BY {CLIP_MARK_ORDER_SQL}", (video_id,)).fetchall()
            ]
            content = clip_marks_to_csv(clips)
            media_type = "text/csv; charset=utf-8"
        if disposition == "attachment":
            conn.execute("UPDATE videos SET status = 'exported', updated_at = ? WHERE id = ?", (now_iso(), video_id))
    filename = f"video-{video_id}-{language if format in {'srt', 'vtt'} else 'clips'}.{format}"
    return PlainTextResponse(
        content,
        media_type=media_type,
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )
