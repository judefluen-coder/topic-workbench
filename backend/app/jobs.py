from __future__ import annotations

import json

from app.db import get_connection, now_iso, row_to_dict

ACTIVE_JOB_STATUSES = {"queued", "running"}
WORKER_JOB_TYPES = ("download_translate", "subtitle_reprocess", "render_clips")


def enqueue_job(job_type: str, payload: dict, message: str, dedupe_video_id: int | None = None) -> dict:
    timestamp = now_iso()
    with get_connection() as conn:
        if dedupe_video_id is not None:
            conn.execute("BEGIN IMMEDIATE")
            active_rows = conn.execute(
                "SELECT * FROM jobs WHERE type = ? AND status IN ('queued', 'running') ORDER BY id DESC",
                (job_type,),
            ).fetchall()
            existing = next(
                (row for row in active_rows if job_payload(row_to_dict(row)).get("video_id") == dedupe_video_id),
                None,
            )
            if existing:
                return row_to_dict(existing)
        cursor = conn.execute(
            """
            INSERT INTO jobs (type, status, message, payload, result, progress, attempts, created_at, updated_at)
            VALUES (?, 'queued', ?, ?, '{}', 0, 0, ?, ?)
            """,
            (job_type, message, json.dumps(payload, ensure_ascii=False), timestamp, timestamp),
        )
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return row_to_dict(row)


def get_job(job_id: int) -> dict:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise ValueError("任务不存在。")
    return _with_video_context([row_to_dict(row)])[0]


def list_jobs(video_id: int | None = None, limit: int = 100, topic_id: int | None = None) -> list[dict]:
    with get_connection() as conn:
        query = "SELECT * FROM jobs ORDER BY id DESC" if video_id is not None else "SELECT * FROM jobs ORDER BY id DESC LIMIT ?"
        params = () if video_id is not None else (max(limit, 1),)
        rows = [
            row_to_dict(row)
            for row in conn.execute(query, params).fetchall()
        ]
    if video_id is None:
        enriched = _with_video_context(rows)
        if topic_id is not None:
            enriched = [row for row in enriched if int(row.get("topic_id") or 1) == topic_id]
        return enriched[: max(limit, 1)]
    filtered = [row for row in rows if job_payload(row).get("video_id") == video_id][: max(limit, 1)]
    return _with_video_context(filtered)


def retry_job(job_id: int) -> dict:
    timestamp = now_iso()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise ValueError("任务不存在。")
        if row["status"] != "failed":
            raise ValueError("只有失败任务可以重试。")
        conn.execute(
            """
            UPDATE jobs
            SET status = 'queued', message = '已重新加入任务队列', result = '{}', progress = 0, updated_at = ?
            WHERE id = ?
            """,
            (timestamp, job_id),
        )
        updated = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return row_to_dict(updated)


def recover_interrupted_jobs(job_types: tuple[str, ...] = WORKER_JOB_TYPES) -> int:
    if not job_types:
        return 0
    timestamp = now_iso()
    placeholders = ", ".join("?" for _ in job_types)
    with get_connection() as conn:
        cursor = conn.execute(
            f"""
            UPDATE jobs
            SET status = 'queued', message = '上次运行中断，已自动恢复到任务队列', updated_at = ?
            WHERE status = 'running' AND type IN ({placeholders})
            """,
            (timestamp, *job_types),
        )
    return cursor.rowcount


def claim_next_job(job_types: tuple[str, ...] = WORKER_JOB_TYPES) -> dict | None:
    if not job_types:
        return None
    timestamp = now_iso()
    placeholders = ", ".join("?" for _ in job_types)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            f"SELECT * FROM jobs WHERE status = 'queued' AND type IN ({placeholders}) ORDER BY id LIMIT 1",
            job_types,
        ).fetchone()
        if not row:
            return None
        conn.execute(
            """
            UPDATE jobs
            SET status = 'running', message = '任务已由后台处理器接收', attempts = attempts + 1, updated_at = ?
            WHERE id = ? AND status = 'queued'
            """,
            (timestamp, row["id"]),
        )
        claimed = conn.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone()
    return row_to_dict(claimed)


def update_job(job_id: int, status: str, message: str, progress: int | None = None, result: dict | None = None) -> dict:
    fields = ["status = ?", "message = ?", "updated_at = ?"]
    params: list[object] = [status, message, now_iso()]
    if progress is not None:
        fields.append("progress = ?")
        params.append(max(0, min(int(progress), 100)))
    if result is not None:
        fields.append("result = ?")
        params.append(json.dumps(result, ensure_ascii=False))
    params.append(job_id)
    with get_connection() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(fields)} WHERE id = ?", params)
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if not row:
        raise ValueError("任务不存在。")
    return row_to_dict(row)


def fail_job(job_id: int, message: str) -> dict:
    return update_job(job_id, "failed", message, progress=0)


def job_payload(job: dict) -> dict:
    try:
        payload = json.loads(job.get("payload") or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _with_video_context(jobs: list[dict]) -> list[dict]:
    video_ids = sorted(
        {
            int(video_id)
            for job in jobs
            if (video_id := job_payload(job).get("video_id")) and str(video_id).isdigit() and int(video_id) > 0
        }
    )
    videos: dict[int, dict] = {}
    if video_ids:
        placeholders = ", ".join("?" for _ in video_ids)
        with get_connection() as conn:
            videos = {
                row["id"]: row_to_dict(row)
                for row in conn.execute(
                    f"SELECT id, topic_id, title, url FROM videos WHERE id IN ({placeholders})",
                    video_ids,
                ).fetchall()
            }
    enriched: list[dict] = []
    for job in jobs:
        item = dict(job)
        video_id = job_payload(item).get("video_id")
        try:
            normalized_video_id = int(video_id) if video_id else None
        except (TypeError, ValueError):
            normalized_video_id = None
        item["video_id"] = normalized_video_id
        video = videos.get(normalized_video_id) if normalized_video_id else None
        item["video_title"] = video.get("title", "") if video else ""
        item["video_url"] = video.get("url", "") if video else ""
        item["topic_id"] = video.get("topic_id") if video else job_payload(item).get("topic_id", 1)
        enriched.append(item)
    return enriched
