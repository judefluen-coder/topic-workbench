from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from app.config import settings
from app.db import get_connection, now_iso, row_to_dict
from app.opencli_runtime import opencli_path, opencli_window_args, prepare_opencli_browser
from app.summaries import build_discovery_summary
from app.topics import discovery_queries, get_topic, topic_priority_score, topic_signals


BILIBILI_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://www.bilibili.com",
}
MEDIA_SUFFIXES = {".mp4", ".m4a", ".mp3", ".mov", ".webm", ".mkv", ".flv"}
BEIJING_TZ = ZoneInfo("Asia/Shanghai")


def sync_bilibili(
    limit_per_query: int = 5,
    published_after: str | None = None,
    published_before: str | None = None,
    topic_id: int = 1,
) -> dict:
    topic = get_topic(topic_id)
    if "bilibili" not in topic["sources"]:
        return {"mode": "disabled", "queried": 0, "candidates": 0, "inserted": 0, "message": "当前主题未启用 B站。"}
    if not settings.bilibili_discovery_enabled or not settings.opencli_discovery_enabled:
        return {"mode": "disabled", "queried": 0, "candidates": 0, "inserted": 0, "message": "B站抓取已关闭。"}

    opencli = _opencli_path()
    if not opencli:
        return {"mode": "opencli_bilibili", "queried": 0, "candidates": 0, "inserted": 0, "message": "未找到 opencli，暂不能抓取 B站。"}

    raw_items: list[dict] = []
    errors: list[str] = []
    queried = 0
    channel_uids = topic.get("bilibili_channel_uids", [])
    for uid in channel_uids[:12]:
        queried += 1
        try:
            raw_items.extend(_run_opencli_user_videos(opencli, uid, max(limit_per_query, 5)))
        except Exception as exc:
            errors.append(f"账号 {uid} 抓取失败：{exc}")

    for query in discovery_queries(topic, limit=max(3, min(12, limit_per_query * 2))):
        queried += 1
        try:
            raw_items.extend(_run_opencli_search(opencli, query, max(limit_per_query, 5)))
        except Exception as exc:
            errors.append(f"关键词 {query} 抓取失败：{exc}")

    seen: set[str] = set()
    enriched: list[dict] = []
    for item in raw_items:
        bvid = _extract_bvid(str(item.get("url") or item.get("bvid") or ""))
        if not bvid or bvid in seen:
            continue
        seen.add(bvid)
        metadata = _fetch_bilibili_view(bvid) or _metadata_from_opencli_item(bvid, item)
        if metadata:
            enriched.append(metadata)

    inserted = _upsert_bilibili_items(enriched, published_after, published_before, topic_id, topic)
    message = "已同步 B站候选，并按真实发布时间过滤。"
    if errors:
        message += f" 部分来源失败 {len(errors)} 个。"
    return {
        "mode": "opencli_bilibili",
        "queried": queried,
        "candidates": len(enriched),
        "inserted": inserted,
        "errors": errors[:6],
        "message": message,
    }


def fetch_bilibili_subtitle_segments(bvid: str) -> list[dict]:
    opencli = _require_opencli()
    prepare_opencli_browser(opencli, f"https://www.bilibili.com/video/{bvid}")
    completed = subprocess.run(
        [opencli, "bilibili", "subtitle", bvid, "--format", "json", *_opencli_window_args()],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    payload = _json_from_opencli(completed.stdout)
    if not isinstance(payload, list):
        return []
    segments = []
    for row in payload:
        text = str(row.get("content") or "").strip()
        if not text:
            continue
        segments.append(
            {
                "start_seconds": _seconds_from_bilibili_time(row.get("from")),
                "end_seconds": _seconds_from_bilibili_time(row.get("to")),
                "text": text,
            }
        )
    return [segment for segment in segments if segment["end_seconds"] > segment["start_seconds"]]


def download_bilibili_authorized(video_id: int, bvid: str, authorization_note: str, quality: str = "1080p") -> dict:
    if not authorization_note.strip():
        raise RuntimeError("下载前必须填写授权说明。")
    opencli = _require_opencli()
    timestamp = now_iso()
    with get_connection() as conn:
        video = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise RuntimeError("视频不存在。")
        cursor = conn.execute(
            """
            INSERT INTO download_tasks (video_id, engine, status, authorization_note, created_at, updated_at)
            VALUES (?, 'opencli-bilibili', 'running', ?, ?, ?)
            """,
            (video_id, authorization_note, timestamp, timestamp),
        )
        task_id = cursor.lastrowid

    output_dir = settings.download_dir / f"bilibili-{video_id}"
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        opencli,
        "bilibili",
        "download",
        bvid,
        "--output",
        str(output_dir),
        "--quality",
        _bilibili_quality(quality),
        "--format",
        "json",
        *_opencli_window_args(),
    ]
    try:
        prepare_opencli_browser(opencli, f"https://www.bilibili.com/video/{bvid}")
        completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60 * 60)
        log = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
        output_path = _find_downloaded_media(output_dir)
        if not output_path:
            raise RuntimeError("下载结束但未找到媒体文件。")
        status = "completed"
        message = "B站视频已下载为本地素材。"
    except Exception as exc:
        log = _exception_log(exc)
        output_path = _find_downloaded_media(output_dir)
        if output_path and "Download complete" in log:
            status = "completed"
            message = "B站视频已下载为本地素材；下载工具返回警告，已保留日志。"
        else:
            output_path = ""
            status = "failed"
            message = str(exc)

    with get_connection() as conn:
        conn.execute(
            "UPDATE download_tasks SET status = ?, output_path = ?, log = ?, updated_at = ? WHERE id = ?",
            (status, str(output_path), log[-8000:], now_iso(), task_id),
        )
        if status == "completed":
            conn.execute(
                """
                INSERT INTO media_assets (
                  video_id, kind, original_filename, stored_path, transcript_text,
                  authorization_note, delete_after_processing, processing_status, created_at
                )
                VALUES (?, 'media', ?, ?, '', ?, 0, 'imported', ?)
                """,
                (video_id, Path(output_path).name, str(output_path), authorization_note, now_iso()),
            )
            conn.execute("UPDATE videos SET status = 'imported', updated_at = ? WHERE id = ?", (now_iso(), video_id))
        task = row_to_dict(conn.execute("SELECT * FROM download_tasks WHERE id = ?", (task_id,)).fetchone())
    if status == "failed":
        raise RuntimeError(f"B站下载失败：{message}")
    return {"task": task, "message": message, "media_path": str(output_path)}


def _run_opencli_search(opencli: str, query: str, limit: int) -> list[dict]:
    prepare_opencli_browser(opencli, "https://www.bilibili.com")
    completed = subprocess.run(
        [
            opencli,
            "bilibili",
            "search",
            query,
            "--type",
            "video",
            "--limit",
            str(min(limit, 12)),
            "--format",
            "json",
            *_opencli_window_args(),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=90,
    )
    payload = _json_from_opencli(completed.stdout)
    return payload if isinstance(payload, list) else []


def _run_opencli_user_videos(opencli: str, uid: str, limit: int) -> list[dict]:
    prepare_opencli_browser(opencli, f"https://space.bilibili.com/{uid}/video")
    completed = subprocess.run(
        [
            opencli,
            "bilibili",
            "user-videos",
            uid,
            "--limit",
            str(min(limit, 12)),
            "--order",
            "pubdate",
            "--format",
            "json",
            *_opencli_window_args(),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=90,
    )
    payload = _json_from_opencli(completed.stdout)
    return payload if isinstance(payload, list) else []


def _fetch_bilibili_view(bvid: str) -> dict | None:
    try:
        response = httpx.get(
            "https://api.bilibili.com/x/web-interface/view",
            params={"bvid": bvid},
            headers=BILIBILI_HEADERS,
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception:
        return None
    if payload.get("code") != 0:
        return None
    data = payload.get("data") or {}
    owner = data.get("owner") or {}
    stat = data.get("stat") or {}
    pubdate = int(data.get("pubdate") or 0)
    published_at = datetime.fromtimestamp(pubdate, tz=timezone.utc).replace(microsecond=0).isoformat() if pubdate else ""
    return {
        "external_id": data.get("bvid") or bvid,
        "url": f"https://www.bilibili.com/video/{data.get('bvid') or bvid}",
        "title": data.get("title") or "",
        "description": data.get("desc") or "",
        "channel_title": owner.get("name") or "",
        "published_at": published_at,
        "duration_seconds": int(data.get("duration") or 0),
        "view_count": int(stat.get("view") or 0),
        "like_count": int(stat.get("like") or 0),
        "thumbnail_url": data.get("pic") or "",
    }


def _metadata_from_opencli_item(bvid: str, item: dict) -> dict | None:
    published_at = _published_from_local_date(str(item.get("date") or ""))
    if not published_at:
        return None
    return {
        "external_id": bvid,
        "url": f"https://www.bilibili.com/video/{bvid}",
        "title": item.get("title") or "",
        "description": "",
        "channel_title": item.get("author") or "",
        "published_at": published_at,
        "duration_seconds": 0,
        "view_count": int(item.get("plays") or 0),
        "like_count": int(item.get("likes") or 0),
        "thumbnail_url": "",
    }


def _upsert_bilibili_items(
    items: list[dict],
    published_after: str | None,
    published_before: str | None,
    topic_id: int = 1,
    topic: dict | None = None,
) -> int:
    if not items:
        return 0
    with get_connection() as conn:
        topic = topic or get_topic(topic_id)
        inserted_or_updated = 0
        for item in items:
            title = item.get("title", "")
            description = item.get("description", "") or ""
            channel = item.get("channel_title") or ""
            published_at = item.get("published_at", "")
            if not published_at or not _within_utc_window(published_at, published_after, published_before):
                continue
            matches, names, candidate_people, reason, confidence = topic_signals(title, description, channel, topic)
            if confidence <= 0:
                continue
            view_count = int(item.get("view_count") or 0)
            score = topic_priority_score(matches, confidence, published_at, view_count, topic["ranking_mode"])
            summary = build_discovery_summary(title, description, channel, names or candidate_people, topic["name"], topic["keywords"])
            timestamp = now_iso()
            cursor = conn.execute(
                """
                INSERT INTO videos (
                  topic_id, platform, external_id, url, title, description, channel_title, published_at,
                  duration_seconds, view_count, like_count, thumbnail_url, matched_people,
                  candidate_people, people_match_reason, interview_confidence, priority_score, status, compliance_note, summary, source_tier, created_at, updated_at
                )
                VALUES (?, 'bilibili', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'metadata_only', ?, 'stable', ?, ?)
                ON CONFLICT(topic_id, platform, external_id) DO UPDATE SET
                  url = excluded.url,
                  title = excluded.title,
                  description = excluded.description,
                  channel_title = excluded.channel_title,
                  published_at = excluded.published_at,
                  duration_seconds = excluded.duration_seconds,
                  view_count = excluded.view_count,
                  like_count = excluded.like_count,
                  thumbnail_url = excluded.thumbnail_url,
                  matched_people = excluded.matched_people,
                  candidate_people = excluded.candidate_people,
                  people_match_reason = excluded.people_match_reason,
                  interview_confidence = excluded.interview_confidence,
                  priority_score = excluded.priority_score,
                  summary = excluded.summary,
                  source_tier = excluded.source_tier,
                  updated_at = excluded.updated_at
                """,
                (
                    topic_id,
                    str(item["external_id"]),
                    item["url"],
                    title,
                    description,
                    channel,
                    published_at,
                    int(item.get("duration_seconds") or 0),
                    view_count,
                    int(item.get("like_count") or 0),
                    item.get("thumbnail_url") or "",
                    names,
                    candidate_people,
                    reason,
                    confidence,
                    score,
                    summary,
                    timestamp,
                    timestamp,
                ),
            )
            inserted_or_updated += max(cursor.rowcount, 0)
        return inserted_or_updated


def _json_from_opencli(output: str) -> object:
    text = _strip_opencli_update_notice(output)
    return json.loads(text) if text else []


def _strip_opencli_update_notice(output: str) -> str:
    text = output.strip()
    if "\n\n  Update available:" in text:
        text = text.split("\n\n  Update available:", 1)[0].strip()
    return text


def _extract_bvid(value: str) -> str:
    match = re.search(r"(BV[0-9A-Za-z]+)", value)
    return match.group(1) if match else ""


def _published_from_local_date(value: str) -> str:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return ""
    local = datetime.combine(parsed, time.min, tzinfo=BEIJING_TZ)
    return local.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _within_utc_window(published_at: str, published_after: str | None, published_before: str | None) -> bool:
    try:
        published = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    if published_after:
        start = datetime.fromisoformat(published_after.replace("Z", "+00:00"))
        if published < start:
            return False
    if published_before:
        end = datetime.fromisoformat(published_before.replace("Z", "+00:00"))
        if published >= end:
            return False
    return True


def _seconds_from_bilibili_time(value: object) -> float:
    text = str(value or "").strip().removesuffix("s")
    try:
        return float(text)
    except ValueError:
        return 0.0


def _opencli_path() -> str:
    return opencli_path()


def _opencli_window_args() -> list[str]:
    return opencli_window_args()


def _require_opencli() -> str:
    opencli = _opencli_path()
    if not opencli:
        raise RuntimeError("未找到 opencli，无法处理 B站视频。")
    return opencli


def _bilibili_quality(quality: str) -> str:
    if quality in {"best", "1080p", "720p", "480p"}:
        return quality
    return "1080p"


def _find_downloaded_media(output_dir: Path) -> str:
    files = sorted(
        [path for path in output_dir.rglob("*") if _is_final_media_file(path)],
        key=lambda path: path.stat().st_mtime,
    )
    return str(files[-1]) if files else ""


def _is_final_media_file(path: Path) -> bool:
    if not path.is_file() or path.suffix.lower() not in MEDIA_SUFFIXES:
        return False
    name = path.name
    if name.endswith(".part") or ".temp." in name:
        return False
    if re.search(r"\.f\d+\.", name):
        return False
    return True


def _exception_log(exc: Exception) -> str:
    stdout = str(getattr(exc, "stdout", "") or "")
    stderr = str(getattr(exc, "stderr", "") or "")
    message = str(exc)
    return "\n".join(part for part in [stdout, stderr, message] if part)
