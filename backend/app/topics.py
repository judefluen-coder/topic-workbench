from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone

from app.db import get_connection, now_iso, row_to_dict
from app.scoring import people_signals_for_video


DEFAULT_TOPIC = {
    "name": "AI 科技采访（示例）",
    "description": "沿用原工作台能力的示例主题，可以编辑或新建其他主题。",
    "keywords": ["AI interview", "人工智能 访谈", "大模型 访谈"],
    "excluded_keywords": ["shorts", "招聘", "课程广告"],
    "focus_people": ["Sam Altman", "Dario Amodei", "Jensen Huang", "梁文锋"],
    "channel_terms": ["OpenAI", "Anthropic", "NVIDIA", "DeepSeek"],
    "bilibili_channel_uids": [],
    "sources": ["youtube", "bilibili"],
    "ranking_mode": "balanced",
}


def ensure_default_topic() -> dict:
    with get_connection() as conn:
        existing = conn.execute("SELECT * FROM topics ORDER BY id LIMIT 1").fetchone()
        if existing:
            return topic_from_row(row_to_dict(existing))
        timestamp = now_iso()
        cursor = conn.execute(
            """
            INSERT INTO topics (
              name, description, keywords, excluded_keywords, focus_people, channel_terms,
              bilibili_channel_uids, sources, ranking_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                DEFAULT_TOPIC["name"],
                DEFAULT_TOPIC["description"],
                _dump(DEFAULT_TOPIC["keywords"]),
                _dump(DEFAULT_TOPIC["excluded_keywords"]),
                _dump(DEFAULT_TOPIC["focus_people"]),
                _dump(DEFAULT_TOPIC["channel_terms"]),
                _dump(DEFAULT_TOPIC["bilibili_channel_uids"]),
                _dump(DEFAULT_TOPIC["sources"]),
                DEFAULT_TOPIC["ranking_mode"],
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return topic_from_row(row_to_dict(row))


def list_topics() -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT topics.*,
                   COUNT(DISTINCT videos.id) AS video_count,
                   COUNT(DISTINCT clip_marks.id) AS clip_count
            FROM topics
            LEFT JOIN videos ON videos.topic_id = topics.id
            LEFT JOIN clip_marks ON clip_marks.video_id = videos.id
            GROUP BY topics.id
            ORDER BY topics.updated_at DESC, topics.id DESC
            """
        ).fetchall()
    return [topic_from_row(row_to_dict(row)) for row in rows]


def get_topic(topic_id: int) -> dict:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (topic_id,)).fetchone()
    if not row:
        raise ValueError("主题不存在。")
    return topic_from_row(row_to_dict(row))


def create_topic(values: dict) -> dict:
    timestamp = now_iso()
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO topics (
              name, description, keywords, excluded_keywords, focus_people, channel_terms,
              bilibili_channel_uids, sources, ranking_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                values["name"].strip(),
                values.get("description", "").strip(),
                _dump(values["keywords"]),
                _dump(values.get("excluded_keywords", [])),
                _dump(values.get("focus_people", [])),
                _dump(values.get("channel_terms", [])),
                _dump(values.get("bilibili_channel_uids", [])),
                _dump(values.get("sources", ["youtube", "bilibili"])),
                values.get("ranking_mode", "balanced"),
                timestamp,
                timestamp,
            ),
        )
        row = conn.execute("SELECT * FROM topics WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return topic_from_row(row_to_dict(row))


def update_topic(topic_id: int, values: dict) -> dict:
    current = get_topic(topic_id)
    merged = {**current, **{key: value for key, value in values.items() if value is not None}}
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE topics
            SET name = ?, description = ?, keywords = ?, excluded_keywords = ?, focus_people = ?,
                channel_terms = ?, bilibili_channel_uids = ?, sources = ?, ranking_mode = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                merged["name"].strip(),
                merged.get("description", "").strip(),
                _dump(merged["keywords"]),
                _dump(merged.get("excluded_keywords", [])),
                _dump(merged.get("focus_people", [])),
                _dump(merged.get("channel_terms", [])),
                _dump(merged.get("bilibili_channel_uids", [])),
                _dump(merged.get("sources", [])),
                merged.get("ranking_mode", "balanced"),
                now_iso(),
                topic_id,
            ),
        )
    updated = get_topic(topic_id)
    _refresh_topic_videos(updated)
    return updated


def topic_from_row(row: dict) -> dict:
    item = dict(row)
    for field in ("keywords", "excluded_keywords", "focus_people", "channel_terms", "bilibili_channel_uids", "sources"):
        item[field] = _load_list(item.get(field))
    return item


def _refresh_topic_videos(topic: dict) -> None:
    from app.summaries import build_discovery_summary

    with get_connection() as conn:
        videos = [row_to_dict(row) for row in conn.execute("SELECT * FROM videos WHERE topic_id = ?", (topic["id"],)).fetchall()]
        for video in videos:
            matches, names, candidates, reason, confidence = topic_signals(
                video.get("title", ""), video.get("description", ""), video.get("channel_title", ""), topic
            )
            score = topic_priority_score(
                matches,
                confidence,
                video.get("published_at", ""),
                int(video.get("view_count") or 0),
                topic["ranking_mode"],
            )
            summary = build_discovery_summary(
                video.get("title", ""),
                video.get("description", ""),
                video.get("channel_title", ""),
                names or candidates,
                topic["name"],
                topic["keywords"],
            )
            conn.execute(
                """
                UPDATE videos
                SET matched_people = ?, candidate_people = ?, people_match_reason = ?,
                    interview_confidence = ?, priority_score = ?, summary = ?, updated_at = ?
                WHERE id = ?
                """,
                (names, candidates, reason, confidence, score, summary, now_iso(), video["id"]),
            )


def topic_people(topic: dict) -> list[dict]:
    return [
        {"name": name, "english_name": "", "aliases": "", "priority": 5}
        for name in topic.get("focus_people", [])
        if str(name).strip()
    ]


def discovery_queries(topic: dict, limit: int = 12) -> list[str]:
    keywords = _clean_terms(topic.get("keywords", []))
    people = _clean_terms(topic.get("focus_people", []))
    channels = _clean_terms(topic.get("channel_terms", []))
    queries = list(keywords)
    if keywords:
        queries.extend(f"{person} {keyword}" for person in people[:4] for keyword in keywords[:2])
    queries.extend(channels)
    return list(dict.fromkeys(queries))[:limit]


def topic_signals(title: str, description: str, channel: str, topic: dict) -> tuple[list[dict], str, str, str, float]:
    people = topic_people(topic)
    matches, names, candidates, reason = people_signals_for_video(title, description, channel, people)
    confidence = topic_relevance(title, description, channel, topic)
    if names:
        reason = "命中本主题的重点人物"
    elif confidence > 0:
        reason = "命中主题关键词或频道线索"
    return matches, names, candidates, reason, confidence


def topic_relevance(title: str, description: str, channel: str, topic: dict) -> float:
    haystack = f"{title}\n{description[:2000]}\n{channel}".lower()
    normalized_haystack = _normalize_match_text(haystack)
    excluded = _clean_terms(topic.get("excluded_keywords", []))
    if any(_term_matches(term, haystack, normalized_haystack) for term in excluded):
        return 0.0
    keywords = _clean_terms(topic.get("keywords", []))
    channels = _clean_terms(topic.get("channel_terms", []))
    keyword_hits = sum(1 for term in keywords if _term_matches(term, haystack, normalized_haystack))
    channel_haystack = channel.lower()
    normalized_channel = _normalize_match_text(channel_haystack)
    channel_hits = sum(1 for term in channels if _term_matches(term, channel_haystack, normalized_channel))
    if not keyword_hits and not channel_hits:
        return 0.0
    keyword_score = min(keyword_hits / max(min(len(keywords), 3), 1), 1.0)
    return min(0.25 + keyword_score * 0.55 + min(channel_hits, 1) * 0.2, 1.0)


def topic_priority_score(matches: list[dict], confidence: float, published_at: str, view_count: int, ranking_mode: str) -> float:
    people_score = 1.0 if matches else 0.0
    recency = _recency_score(published_at)
    popularity = min(math.log10(max(view_count, 1)) / 6, 1.0)
    weights = {
        "balanced": (0.28, 0.42, 0.18, 0.12),
        "people": (0.58, 0.24, 0.10, 0.08),
        "popular": (0.12, 0.28, 0.12, 0.48),
        "latest": (0.12, 0.25, 0.53, 0.10),
    }
    people_weight, relevance_weight, recency_weight, popularity_weight = weights.get(ranking_mode, weights["balanced"])
    return round(
        (people_score * people_weight + confidence * relevance_weight + recency * recency_weight + popularity * popularity_weight) * 100,
        2,
    )


def _recency_score(published_at: str) -> float:
    try:
        parsed = datetime.fromisoformat((published_at or "").replace("Z", "+00:00"))
    except ValueError:
        return 0.15
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    days = max((datetime.now(timezone.utc) - parsed).days, 0)
    if days <= 1:
        return 1.0
    if days <= 7:
        return 0.7
    if days <= 30:
        return 0.4
    return 0.15


def _clean_terms(values: list[object]) -> list[str]:
    return [str(value).strip() for value in values if str(value).strip()]


def _term_matches(term: str, haystack: str, normalized_haystack: str) -> bool:
    lowered = term.lower().strip()
    normalized = _normalize_match_text(lowered)
    return bool(lowered) and (lowered in haystack or bool(normalized) and normalized in normalized_haystack)


def _normalize_match_text(value: str) -> str:
    return re.sub(r"[\s\-_·/]+", "", value.lower())


def _load_list(value: object) -> list[str]:
    if isinstance(value, list):
        return _clean_terms(value)
    try:
        loaded = json.loads(str(value or "[]"))
    except json.JSONDecodeError:
        return []
    return _clean_terms(loaded) if isinstance(loaded, list) else []


def _dump(values: list[object]) -> str:
    return json.dumps(_clean_terms(values), ensure_ascii=False)
