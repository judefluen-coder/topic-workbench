from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.config import settings
from app.bilibili import sync_bilibili
from app.db import get_connection, now_iso, row_to_dict
from app.summaries import build_discovery_summary
from app.topics import get_topic
from app.youtube import sync_youtube


BEIJING_TZ = ZoneInfo("Asia/Shanghai")


def default_daily_date() -> str:
    return (datetime.now(BEIJING_TZ).date() - timedelta(days=1)).isoformat()


def beijing_day_window(day: str | None = None) -> tuple[str, str, str]:
    target = date.fromisoformat(day or default_daily_date())
    range_start, range_end, window_start, window_end = beijing_range_window(target.isoformat(), target.isoformat())
    return (range_start, window_start, window_end)


def beijing_range_window(start_date: str | None = None, end_date: str | None = None) -> tuple[str, str, str, str]:
    start = date.fromisoformat(start_date or default_daily_date())
    end = date.fromisoformat(end_date or start.isoformat())
    if end < start:
        raise ValueError("结束日期不能早于开始日期。")
    if (end - start).days > 45:
        raise ValueError("单次抓取区间最长 45 天。")
    return (
        start.isoformat(),
        end.isoformat(),
        _beijing_day_start_utc(start),
        _beijing_day_start_utc(end + timedelta(days=1)),
    )


def _beijing_day_start_utc(target: date) -> str:
    start_local = datetime.combine(target, time.min, tzinfo=BEIJING_TZ)
    return start_local.astimezone(timezone.utc).replace(microsecond=0).isoformat()


async def run_daily_discovery(
    day: str | None = None,
    limit_per_query: int = 5,
    start_date: str | None = None,
    end_date: str | None = None,
    topic_id: int = 1,
) -> dict:
    range_start, range_end, window_start, window_end = beijing_range_window(start_date or day, end_date or day)
    topic = get_topic(topic_id)
    timestamp = now_iso()
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO jobs (type, status, message, payload, created_at, updated_at)
            VALUES ('daily_discovery', 'running', '正在抓取当前主题素材', ?, ?, ?)
            """,
            (
                json.dumps({"topic_id": topic_id, "start_date": range_start, "end_date": range_end, "window_start": window_start, "window_end": window_end}, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
        job_id = cursor.lastrowid

    source_results: dict[str, dict] = {}
    failures: dict[str, str] = {}

    if "youtube" in topic["sources"]:
        try:
            source_results["youtube"] = await sync_youtube(
                days_back=1,
                limit_per_query=limit_per_query,
                include_demo_when_unconfigured=False,
                published_after=window_start,
                published_before=window_end,
                topic_id=topic_id,
            )
        except Exception as exc:
            failures["youtube"] = str(exc)

    if "bilibili" in topic["sources"]:
        try:
            source_results["bilibili"] = sync_bilibili(
                limit_per_query=limit_per_query,
                published_after=window_start,
                published_before=window_end,
                topic_id=topic_id,
            )
        except Exception as exc:
            failures["bilibili"] = str(exc)

    result = {"sources": source_results, "failures": failures}
    status = "failed" if failures and not source_results else "completed"
    inserted = sum(int(source.get("inserted") or 0) for source in source_results.values())
    if status == "failed":
        message = "、".join(f"{name}: {error}" for name, error in failures.items())
    elif failures:
        message = f"日报抓取完成，新增/更新 {inserted} 条；部分来源失败。"
    else:
        message = f"日报抓取完成，新增/更新 {inserted} 条。"

    with get_connection() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, message = ?, payload = ?, updated_at = ? WHERE id = ?",
            (
                status,
                message,
                json.dumps({"topic_id": topic_id, "start_date": range_start, "end_date": range_end, "result": result}, ensure_ascii=False),
                now_iso(),
                job_id,
            ),
        )

    daily = get_daily_report(range_start, range_end, topic_id)
    daily["job_id"] = job_id
    daily["run_result"] = result
    return daily


def get_daily_report(day: str | None = None, end_date: str | None = None, topic_id: int = 1) -> dict:
    range_start, range_end, window_start, window_end = beijing_range_window(day, end_date or day)
    topic = get_topic(topic_id)
    with get_connection() as conn:
        rows = [
            row_to_dict(row)
            for row in conn.execute(
                """
                SELECT * FROM videos
                WHERE topic_id = ?
                ORDER BY priority_score DESC, published_at DESC, created_at DESC, id DESC
                """,
                (topic_id,),
            ).fetchall()
        ]
        latest_jobs = conn.execute("SELECT * FROM jobs WHERE type IN ('daily_discovery', 'download_translate') ORDER BY id DESC LIMIT 100").fetchall()
        latest_job = next((row for row in latest_jobs if _job_matches_topic(row, topic_id)), None)
    items = [
        _with_decision_summary(row, topic)
        for row in rows
        if _row_matches_beijing_range(row, range_start, range_end) and _is_real_video_row(row) and _is_visible_for_topic(row)
    ]
    return {
        "date": range_start,
        "start_date": range_start,
        "end_date": range_end,
        "topic": topic,
        "timezone": "Asia/Shanghai",
        "window_start": window_start,
        "window_end": window_end,
        "items": items,
        "source_runs": _source_runs(topic),
        "latest_job": row_to_dict(latest_job) if latest_job else None,
    }


def _row_matches_beijing_range(row: dict, start: str, end: str) -> bool:
    value = row.get("published_at") or row.get("created_at") or ""
    parsed = _parse_datetime(value)
    if not parsed:
        return False
    local_date = parsed.astimezone(BEIJING_TZ).date().isoformat()
    return start <= local_date <= end


def _is_real_video_row(row: dict) -> bool:
    external_id = str(row.get("external_id") or "")
    url = str(row.get("url") or "")
    if external_id.startswith("demo-"):
        return False
    if "youtube.com/results" in url:
        return False
    return bool(url)


def _is_visible_for_topic(row: dict) -> bool:
    if float(row.get("interview_confidence") or 0) > 0:
        return True
    return row.get("status") in {"imported", "translated", "clipped", "exported", "clip_ready", "downloading", "transcribing", "translating"}


def _with_decision_summary(row: dict, topic: dict) -> dict:
    item = dict(row)
    item["summary"] = build_discovery_summary(
        item.get("title", ""),
        item.get("description", ""),
        item.get("channel_title", ""),
        item.get("matched_people", "") or item.get("candidate_people", ""),
        topic["name"],
        topic["keywords"],
    )
    return item


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _source_runs(topic: dict) -> list[dict]:
    if settings.youtube_api_key:
        youtube_status = "ready"
        youtube_message = "使用 YouTube Data API 按发布日期区间抓取，返回具体视频链接。"
    elif settings.opencli_discovery_enabled:
        youtube_status = "opencli"
        youtube_message = "未配置 YouTube API：使用 opencli 搜索具体视频链接，再按元数据日期过滤；覆盖不保证完整。"
    else:
        youtube_status = "local_ytdlp"
        youtube_message = "未配置 YouTube API：本机 yt-dlp 只能补充发现，按真实上传日期过滤，可能不全面。"
    youtube = {"name": "YouTube", "tier": "stable", "status": youtube_status, "message": youtube_message}
    if "youtube" not in topic["sources"]:
        youtube = {"name": "YouTube", "tier": "stable", "status": "disabled", "message": "当前主题未启用 YouTube。"}
    bilibili = _bilibili_source_run()
    if "bilibili" not in topic["sources"]:
        bilibili = {"name": "B站", "tier": "stable", "status": "disabled", "message": "当前主题未启用 B站。"}
    return [
        youtube,
        {"name": "Podcast RSS", "tier": "stable", "status": "planned", "message": "待接入节目 RSS；当前不参与自动抓取，避免误报。"},
        bilibili,
        {"name": "X / LinkedIn", "tier": "experimental", "status": "manual", "message": "官方 API 有收费或权限限制，首版不做自动全网抓取。"},
    ]


def _bilibili_source_run() -> dict:
    if settings.bilibili_discovery_enabled and settings.opencli_discovery_enabled:
        return {
            "name": "B站",
            "tier": "stable",
            "status": "ready",
            "message": "使用 opencli 抓关键词和重点 UP 投稿，再用 B站元数据按发布时间过滤。",
        }
    return {"name": "B站", "tier": "stable", "status": "disabled", "message": "B站抓取未启用或未找到 opencli。"}


def _job_matches_topic(row: object, topic_id: int) -> bool:
    try:
        payload = json.loads(row["payload"] or "{}")
    except (TypeError, json.JSONDecodeError):
        return False
    return int(payload.get("topic_id") or 1) == topic_id
