from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import shutil
import subprocess
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException

from app.config import settings
from app.ytdlp_runtime import require_ytdlp_command
from app.db import get_connection, now_iso
from app.opencli_runtime import opencli_window_args, prepare_opencli_browser
from app.scoring import parse_youtube_duration
from app.seed import seed_demo_videos
from app.summaries import build_discovery_summary
from app.topics import discovery_queries, get_topic, topic_priority_score, topic_signals

YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
BEIJING_TZ = ZoneInfo("Asia/Shanghai")


async def sync_youtube(
    days_back: int = 1,
    limit_per_query: int = 8,
    include_demo_when_unconfigured: bool = True,
    published_after: str | None = None,
    published_before: str | None = None,
    topic_id: int = 1,
) -> dict:
    topic = get_topic(topic_id)
    if "youtube" not in topic["sources"]:
        return {"mode": "disabled", "inserted": 0, "message": "当前主题未启用 YouTube。"}
    if not settings.youtube_api_key:
        if settings.opencli_discovery_enabled:
            try:
                result = _sync_with_opencli_search(limit_per_query, published_after, published_before, topic_id, topic)
                if result["candidates"] or result["inserted"]:
                    return result
            except Exception as exc:
                if not settings.local_ytdlp_discovery and not include_demo_when_unconfigured:
                    raise HTTPException(status_code=502, detail=f"opencli 搜索失败：{exc}") from exc
        if settings.local_ytdlp_discovery:
            try:
                result = _sync_with_ytdlp_search(limit_per_query, published_after, published_before, topic_id, topic)
                if result["inserted"] or not include_demo_when_unconfigured:
                    return result
            except Exception as exc:
                if not include_demo_when_unconfigured:
                    raise HTTPException(status_code=502, detail=f"本机 yt-dlp 搜索失败：{exc}") from exc
        if not include_demo_when_unconfigured:
            return {
                "mode": "unconfigured",
                "inserted": 0,
                "message": "未配置 YOUTUBE_API_KEY；本机补充搜索没有返回区间内可验证日期的视频。未生成 demo 数据。",
            }
        inserted = seed_demo_videos(topic_id)
        return {
            "mode": "demo",
            "inserted": inserted,
            "message": "未配置 YOUTUBE_API_KEY，且本机搜索未返回结果，已使用 demo 元数据；没有下载任何公开视频。",
        }

    published_after_value = published_after or (datetime.now(timezone.utc) - timedelta(days=days_back)).replace(microsecond=0).isoformat()
    video_ids: set[str] = set()
    query_count = 0
    async with httpx.AsyncClient(timeout=20) as client:
        for query in discovery_queries(topic):
            query_count += 1
            ids = await _search_video_ids(client, query, published_after_value, limit_per_query, published_before)
            video_ids.update(ids)
            _record_source_query(topic_id, query)

        details = await _fetch_video_details(client, sorted(video_ids))

    inserted = _upsert_video_details(details, topic_id, topic)
    return {
        "mode": "live",
        "queried": query_count,
        "candidates": len(video_ids),
        "inserted": inserted,
        "message": "已同步 YouTube 元数据；合规模式未下载公开视频。",
    }


async def _search_video_ids(client: httpx.AsyncClient, query: str, published_after: str, limit: int, published_before: str | None = None) -> list[str]:
    params = {
        "part": "snippet",
        "type": "video",
        "q": query,
        "order": "date",
        "publishedAfter": published_after,
        "maxResults": limit,
        "key": settings.youtube_api_key,
    }
    if published_before:
        params["publishedBefore"] = published_before
    response = await client.get(
        YOUTUBE_SEARCH_URL,
        params=params,
    )
    response.raise_for_status()
    payload = response.json()
    ids = []
    for item in payload.get("items", []):
        video_id = item.get("id", {}).get("videoId")
        if video_id:
            ids.append(video_id)
    return ids


async def _fetch_video_details(client: httpx.AsyncClient, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    details: list[dict] = []
    for start in range(0, len(ids), 50):
        chunk = ids[start : start + 50]
        response = await client.get(
            YOUTUBE_VIDEOS_URL,
            params={
                "part": "snippet,contentDetails,statistics",
                "id": ",".join(chunk),
                "key": settings.youtube_api_key,
            },
        )
        response.raise_for_status()
        details.extend(response.json().get("items", []))
    return details


def _record_source_query(topic_id: int, query: str, person_id: int | None = None) -> None:
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM source_queries WHERE topic_id = ? AND query = ?",
            (topic_id, query),
        ).fetchone()
        timestamp = now_iso()
        if existing:
            conn.execute("UPDATE source_queries SET last_run_at = ? WHERE id = ?", (timestamp, existing["id"]))
        else:
            conn.execute(
                """
                INSERT INTO source_queries (topic_id, person_id, platform, query, last_run_at, created_at)
                VALUES (?, ?, 'youtube', ?, ?, ?)
                """,
                (topic_id, person_id, query, timestamp, timestamp),
            )


def _upsert_video_details(details: list[dict], topic_id: int, topic: dict) -> int:
    if not details:
        return 0
    with get_connection() as conn:
        inserted_or_updated = 0
        for item in details:
            snippet = item.get("snippet", {})
            stats = item.get("statistics", {})
            content = item.get("contentDetails", {})
            external_id = item["id"]
            title = snippet.get("title", "")
            description = snippet.get("description", "")
            published_at = snippet.get("publishedAt", "")
            duration = parse_youtube_duration(content.get("duration", ""))
            channel = snippet.get("channelTitle", "")
            matches, names, candidate_people, reason, confidence = topic_signals(title, description, channel, topic)
            if confidence <= 0:
                continue
            score = topic_priority_score(matches, confidence, published_at, int(stats.get("viewCount", 0) or 0), topic["ranking_mode"])
            summary = build_discovery_summary(title, description, channel, names or candidate_people, topic["name"], topic["keywords"])
            thumbnails = snippet.get("thumbnails", {})
            thumbnail_url = (
                thumbnails.get("high", {}).get("url")
                or thumbnails.get("medium", {}).get("url")
                or thumbnails.get("default", {}).get("url", "")
            )
            timestamp = now_iso()
            cursor = conn.execute(
                """
                INSERT INTO videos (
                  topic_id, platform, external_id, url, title, description, channel_title, published_at,
                  duration_seconds, view_count, like_count, thumbnail_url, matched_people,
                  candidate_people, people_match_reason, interview_confidence, priority_score, status, compliance_note, summary, source_tier, created_at, updated_at
                )
                VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'metadata_only', ?, 'stable', ?, ?)
                ON CONFLICT(topic_id, platform, external_id) DO UPDATE SET
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
                    external_id,
                    f"https://www.youtube.com/watch?v={external_id}",
                    title,
                    description,
                    channel,
                    published_at,
                    duration,
                    int(stats.get("viewCount", 0) or 0),
                    int(stats.get("likeCount", 0) or 0),
                    thumbnail_url,
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


def _sync_with_ytdlp_search(
    limit_per_query: int,
    published_after: str | None,
    published_before: str | None,
    topic_id: int,
    topic: dict,
) -> dict:
    items: list[dict] = []
    query_count = 0
    for query in discovery_queries(topic, limit=8):
        query_count += 1
        items.extend(_run_ytdlp_search(query, min(limit_per_query, 3)))
        _record_source_query(topic_id, f"yt-dlp:{query}")

    inserted = _upsert_ytdlp_items(items, published_after, published_before, topic_id, topic)
    return {
        "mode": "local_yt_dlp_search",
        "queried": query_count,
        "candidates": len(items),
        "inserted": inserted,
        "message": "已用本机 yt-dlp 补充搜索并按真实上传日期过滤；无 YouTube API 时结果可能不全面。",
    }


def _sync_with_opencli_search(
    limit_per_query: int,
    published_after: str | None,
    published_before: str | None,
    topic_id: int,
    topic: dict,
) -> dict:
    opencli = shutil.which(settings.opencli_path) or shutil.which("opencli")
    if not opencli:
        return {"mode": "opencli_youtube_search", "queried": 0, "candidates": 0, "inserted": 0, "message": "未找到 opencli 命令。"}

    queries = _opencli_queries(topic, published_after, published_before)
    raw_items: list[dict] = []
    for query in queries:
        raw_items.extend(_run_opencli_youtube_search(opencli, query, max(limit_per_query, 5)))

    seen: set[str] = set()
    enriched: list[dict] = []
    for item in raw_items:
        url = item.get("url", "")
        if not url or url in seen:
            continue
        seen.add(url)
        metadata = _metadata_from_ytdlp_url(url)
        if metadata:
            metadata.setdefault("webpage_url", url)
            metadata.setdefault("title", item.get("title", ""))
            metadata.setdefault("channel", item.get("channel", ""))
            enriched.append(metadata)

    inserted = _upsert_ytdlp_items(enriched, published_after, published_before, topic_id, topic)
    return {
        "mode": "opencli_youtube_search",
        "queried": len(queries),
        "candidates": len(enriched),
        "inserted": inserted,
        "message": "已用 opencli 搜索 YouTube 候选，并用元数据校验日期后入库；无 YouTube API 时覆盖仍不保证完整。",
    }


def _opencli_queries(topic: dict, published_after: str | None, published_before: str | None) -> list[str]:
    start, before = _query_date_bounds(published_after, published_before)
    date_clause = f" after:{start} before:{before}" if start and before else ""
    return [f"{query}{date_clause}" for query in discovery_queries(topic, limit=8)]


def _query_date_bounds(published_after: str | None, published_before: str | None) -> tuple[str, str]:
    if not published_after or not published_before:
        return "", ""
    try:
        start = datetime.fromisoformat(published_after.replace("Z", "+00:00")).astimezone(BEIJING_TZ).date().isoformat()
        before = datetime.fromisoformat(published_before.replace("Z", "+00:00")).astimezone(BEIJING_TZ).date().isoformat()
    except ValueError:
        return "", ""
    return start, before


def _run_opencli_youtube_search(opencli: str, query: str, limit: int) -> list[dict]:
    prepare_opencli_browser(opencli, "https://www.youtube.com")
    completed = subprocess.run(
        [
            opencli,
            "youtube",
            "search",
            query,
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
    try:
        payload = json.loads(_strip_opencli_update_notice(completed.stdout))
    except json.JSONDecodeError:
        return []
    return payload if isinstance(payload, list) else []


def _strip_opencli_update_notice(output: str) -> str:
    text = output.strip()
    if "\n\n  Update available:" in text:
        text = text.split("\n\n  Update available:", 1)[0].strip()
    return text


def _opencli_window_args() -> list[str]:
    return opencli_window_args()


def _metadata_from_ytdlp_url(url: str) -> dict | None:
    try:
        completed = subprocess.run(
            [
                *_ytdlp_command(),
                "--ignore-config",
                "--dump-single-json",
                "--skip-download",
                "--no-playlist",
                "--no-warnings",
                "--extractor-args",
                "youtube:player_client=web",
                url,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        info = json.loads(completed.stdout)
    except (json.JSONDecodeError, subprocess.SubprocessError, OSError):
        return None
    if not info or not info.get("id"):
        return None
    return {
        "id": info.get("id"),
        "title": info.get("title", ""),
        "description": info.get("description", "") or "",
        "webpage_url": info.get("webpage_url") or url,
        "duration": int(info.get("duration") or 0),
        "channel": info.get("channel") or info.get("uploader") or "",
        "uploader": info.get("uploader") or "",
        "thumbnail": info.get("thumbnail") or "",
        "timestamp": info.get("timestamp") or info.get("release_timestamp"),
        "upload_date": info.get("upload_date") or "",
        "view_count": int(info.get("view_count") or 0),
    }


def _run_ytdlp_search(query: str, limit: int) -> list[dict]:
    completed = subprocess.run(
        [
            *_ytdlp_command(),
            "--ignore-config",
            "--dump-json",
            "--no-warnings",
            "--playlist-end",
            str(limit),
            f"ytsearch{limit}:{query}",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=90,
    )
    entries = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def _ytdlp_command() -> list[str]:
    return require_ytdlp_command()


def _upsert_ytdlp_items(
    items: list[dict],
    published_after: str | None = None,
    published_before: str | None = None,
    topic_id: int = 1,
    topic: dict | None = None,
) -> int:
    if not items:
        return 0
    with get_connection() as conn:
        topic = topic or get_topic(topic_id)
        inserted_or_updated = 0
        for item in items:
            external_id = item.get("id") or item.get("url")
            if not external_id:
                continue
            title = item.get("title", "")
            description = item.get("description", "") or ""
            url = item.get("webpage_url") or item.get("url") or f"https://www.youtube.com/watch?v={external_id}"
            if external_id and "youtube.com" not in url and "youtu.be" not in url:
                url = f"https://www.youtube.com/watch?v={external_id}"
            duration = int(item.get("duration") or 0)
            channel = item.get("channel") or item.get("uploader") or ""
            published_at = _published_at_from_ytdlp(item)
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
                VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'ready', 'metadata_only', ?, 'stable', ?, ?)
                ON CONFLICT(topic_id, platform, external_id) DO UPDATE SET
                  title = excluded.title,
                  url = excluded.url,
                  channel_title = excluded.channel_title,
                  published_at = excluded.published_at,
                  duration_seconds = excluded.duration_seconds,
                  view_count = excluded.view_count,
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
                    str(external_id),
                    url,
                    title,
                    description,
                    channel,
                    published_at,
                    duration,
                    view_count,
                    item.get("thumbnail") or "",
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


def _published_at_from_ytdlp(item: dict) -> str:
    timestamp = item.get("timestamp") or item.get("release_timestamp")
    if timestamp:
        try:
            return datetime.fromtimestamp(int(timestamp), tz=timezone.utc).replace(microsecond=0).isoformat()
        except (TypeError, ValueError, OSError):
            pass
    upload_date = str(item.get("upload_date") or "")
    if len(upload_date) == 8 and upload_date.isdigit():
        try:
            parsed = datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc)
            return parsed.isoformat()
        except ValueError:
            pass
    return ""


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
