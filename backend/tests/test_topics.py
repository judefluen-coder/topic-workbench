from __future__ import annotations

from app.db import get_connection, init_db, now_iso
from app.topics import create_topic, discovery_queries, get_topic, list_topics, topic_priority_score, topic_relevance, update_topic


def _topic_payload(name: str = "新能源汽车出海") -> dict:
    return {
        "name": name,
        "description": "关注中国汽车品牌的海外市场进展。",
        "keywords": ["新能源汽车 出海", "EV global expansion"],
        "excluded_keywords": ["招聘", "广告"],
        "focus_people": ["李想"],
        "channel_terms": ["比亚迪", "BYD"],
        "bilibili_channel_uids": ["123456"],
        "sources": ["youtube", "bilibili"],
        "ranking_mode": "balanced",
    }


def test_topics_can_be_created_and_updated(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()

    assert list_topics()[0]["id"] == 1
    assert "AI 访谈" in list_topics()[0]["keywords"]
    created = create_topic(_topic_payload())
    assert created["keywords"] == ["新能源汽车 出海", "EV global expansion"]
    assert created["sources"] == ["youtube", "bilibili"]

    updated = update_topic(created["id"], {"ranking_mode": "latest", "excluded_keywords": ["招聘", "直播回放"]})
    assert updated["ranking_mode"] == "latest"
    assert get_topic(created["id"])["excluded_keywords"] == ["招聘", "直播回放"]


def test_topic_rules_build_queries_filter_noise_and_change_ranking(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    topic = create_topic(_topic_payload())

    queries = discovery_queries(topic)
    assert "新能源汽车 出海" in queries
    assert "李想 新能源汽车 出海" in queries
    assert topic_relevance("中国新能源汽车出海进入欧洲", "", "行业观察", topic) > 0
    assert topic_relevance("A Discussion of Open-Source AI with a Founder (Full Interview)", "", "Industry Watch", {**topic, "keywords": ["AI interview"]}) > 0
    assert topic_relevance("新能源汽车招聘专场", "广告", "行业观察", topic) == 0

    latest_score = topic_priority_score([], 0.8, now_iso(), 10, "latest")
    popular_score = topic_priority_score([], 0.8, now_iso(), 1_000_000, "popular")
    assert popular_score > latest_score


def test_same_source_video_is_isolated_between_topics(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    second = create_topic(_topic_payload("城市旅行纪录片"))
    timestamp = now_iso()

    with get_connection() as conn:
        for topic_id, title in ((1, "科技主题素材"), (second["id"], "旅行主题素材")):
            conn.execute(
                """
                INSERT INTO videos (
                  topic_id, platform, external_id, url, title, created_at, updated_at
                ) VALUES (?, 'youtube', 'shared-video', 'https://example.com/shared', ?, ?, ?)
                """,
                (topic_id, title, timestamp, timestamp),
            )
        first_titles = [row["title"] for row in conn.execute("SELECT title FROM videos WHERE topic_id = 1").fetchall()]
        second_titles = [row["title"] for row in conn.execute("SELECT title FROM videos WHERE topic_id = ?", (second["id"],)).fetchall()]

    assert first_titles == ["科技主题素材"]
    assert second_titles == ["旅行主题素材"]
