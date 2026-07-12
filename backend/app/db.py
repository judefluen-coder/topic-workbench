from __future__ import annotations

import sqlite3
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from app.config import settings


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    settings.ensure_dirs()
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS topics (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              description TEXT DEFAULT '',
              keywords TEXT NOT NULL DEFAULT '[]',
              excluded_keywords TEXT NOT NULL DEFAULT '[]',
              focus_people TEXT NOT NULL DEFAULT '[]',
              channel_terms TEXT NOT NULL DEFAULT '[]',
              bilibili_channel_uids TEXT NOT NULL DEFAULT '[]',
              sources TEXT NOT NULL DEFAULT '["youtube", "bilibili"]',
              ranking_mode TEXT NOT NULL DEFAULT 'balanced',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS people (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              topic_id INTEGER NOT NULL DEFAULT 1,
              name TEXT NOT NULL,
              english_name TEXT DEFAULT '',
              aliases TEXT DEFAULT '',
              priority INTEGER NOT NULL DEFAULT 3,
              notes TEXT DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(topic_id) REFERENCES topics(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS source_queries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              topic_id INTEGER NOT NULL DEFAULT 1,
              person_id INTEGER,
              platform TEXT NOT NULL DEFAULT 'youtube',
              query TEXT NOT NULL,
              last_run_at TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE,
              FOREIGN KEY(topic_id) REFERENCES topics(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS videos (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              topic_id INTEGER NOT NULL DEFAULT 1,
              platform TEXT NOT NULL DEFAULT 'youtube',
              external_id TEXT NOT NULL,
              url TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT DEFAULT '',
              channel_title TEXT DEFAULT '',
              published_at TEXT DEFAULT '',
              duration_seconds INTEGER NOT NULL DEFAULT 0,
              view_count INTEGER NOT NULL DEFAULT 0,
              like_count INTEGER NOT NULL DEFAULT 0,
              thumbnail_url TEXT DEFAULT '',
              matched_people TEXT DEFAULT '',
              candidate_people TEXT DEFAULT '',
              people_match_reason TEXT DEFAULT '',
              interview_confidence REAL NOT NULL DEFAULT 0,
              priority_score REAL NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'new',
              compliance_note TEXT NOT NULL DEFAULT 'metadata_only',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(topic_id, platform, external_id),
              FOREIGN KEY(topic_id) REFERENCES topics(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS media_assets (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              video_id INTEGER NOT NULL,
              kind TEXT NOT NULL,
              original_filename TEXT DEFAULT '',
              stored_path TEXT DEFAULT '',
              transcript_text TEXT DEFAULT '',
              authorization_note TEXT NOT NULL,
              delete_after_processing INTEGER NOT NULL DEFAULT 1,
              processing_status TEXT NOT NULL DEFAULT 'imported',
              created_at TEXT NOT NULL,
              FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS transcripts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              video_id INTEGER NOT NULL,
              language TEXT NOT NULL,
              start_seconds REAL NOT NULL,
              end_seconds REAL NOT NULL,
              text TEXT NOT NULL,
              source TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS clip_marks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              video_id INTEGER NOT NULL,
              start_seconds REAL NOT NULL,
              end_seconds REAL NOT NULL,
              label TEXT NOT NULL,
              note TEXT DEFAULT '',
              quote TEXT DEFAULT '',
              position INTEGER,
              status TEXT NOT NULL DEFAULT 'draft',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL,
              status TEXT NOT NULL,
              message TEXT DEFAULT '',
              payload TEXT DEFAULT '{}',
              result TEXT DEFAULT '{}',
              progress INTEGER NOT NULL DEFAULT 0,
              attempts INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS download_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              video_id INTEGER NOT NULL,
              engine TEXT NOT NULL,
              status TEXT NOT NULL,
              authorization_note TEXT NOT NULL,
              output_path TEXT DEFAULT '',
              log TEXT DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
            );
            """
        )
        _ensure_column(conn, "videos", "summary", "TEXT DEFAULT ''")
        _ensure_column(conn, "people", "topic_id", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "source_queries", "topic_id", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "videos", "topic_id", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "videos", "source_tier", "TEXT NOT NULL DEFAULT 'stable'")
        _ensure_column(conn, "videos", "last_error", "TEXT DEFAULT ''")
        _ensure_column(conn, "videos", "candidate_people", "TEXT DEFAULT ''")
        _ensure_column(conn, "videos", "people_match_reason", "TEXT DEFAULT ''")
        _ensure_column(conn, "clip_marks", "position", "INTEGER")
        _ensure_column(conn, "jobs", "result", "TEXT DEFAULT '{}'")
        _ensure_column(conn, "jobs", "progress", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "jobs", "attempts", "INTEGER NOT NULL DEFAULT 0")
        _ensure_default_topic_row(conn)
        _backfill_clip_positions(conn)
        _refresh_people_signals(conn)


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _ensure_default_topic_row(conn: sqlite3.Connection) -> None:
    from app.topics import DEFAULT_TOPIC

    timestamp = now_iso()
    conn.execute(
        """
        INSERT OR IGNORE INTO topics (
          id, name, description, keywords, excluded_keywords, focus_people, channel_terms,
          bilibili_channel_uids, sources, ranking_mode, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            DEFAULT_TOPIC["name"],
            DEFAULT_TOPIC["description"],
            json.dumps(DEFAULT_TOPIC["keywords"], ensure_ascii=False),
            json.dumps(DEFAULT_TOPIC["excluded_keywords"], ensure_ascii=False),
            json.dumps(DEFAULT_TOPIC["focus_people"], ensure_ascii=False),
            json.dumps(DEFAULT_TOPIC["channel_terms"], ensure_ascii=False),
            json.dumps(DEFAULT_TOPIC["bilibili_channel_uids"], ensure_ascii=False),
            json.dumps(DEFAULT_TOPIC["sources"], ensure_ascii=False),
            DEFAULT_TOPIC["ranking_mode"],
            timestamp,
            timestamp,
        ),
    )


def _backfill_clip_positions(conn: sqlite3.Connection) -> None:
    video_ids = [
        row["video_id"]
        for row in conn.execute(
            "SELECT DISTINCT video_id FROM clip_marks WHERE position IS NULL ORDER BY video_id",
        ).fetchall()
    ]
    for video_id in video_ids:
        rows = conn.execute(
            "SELECT id FROM clip_marks WHERE video_id = ? ORDER BY start_seconds, id",
            (video_id,),
        ).fetchall()
        for position, row in enumerate(rows):
            conn.execute("UPDATE clip_marks SET position = ? WHERE id = ?", (position, row["id"]))


def _refresh_people_signals(conn: sqlite3.Connection) -> None:
    from app.summaries import build_discovery_summary
    from app.topics import topic_from_row, topic_priority_score, topic_signals

    topics = {
        row["id"]: topic_from_row(row_to_dict(row))
        for row in conn.execute("SELECT * FROM topics").fetchall()
    }
    videos = conn.execute("SELECT * FROM videos").fetchall()
    for row in videos:
        video = row_to_dict(row)
        topic = topics.get(video.get("topic_id"))
        if not topic:
            continue
        matches, matched_names, candidate_people, reason, confidence = topic_signals(
            video.get("title", ""),
            video.get("description", ""),
            video.get("channel_title", ""),
            topic,
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
            matched_names or candidate_people,
            topic["name"],
            topic["keywords"],
        )
        conn.execute(
            """
            UPDATE videos
            SET matched_people = ?, candidate_people = ?, people_match_reason = ?,
                priority_score = ?, summary = ?, updated_at = ?
            WHERE id = ?
            """,
            (matched_names, candidate_people, reason, score, summary, now_iso(), video["id"]),
        )
