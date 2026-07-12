from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.db import get_connection, now_iso
from app.summaries import build_discovery_summary
from app.topics import ensure_default_topic, get_topic, topic_priority_score, topic_signals

DEFAULT_PEOPLE = [
    ("Sam Altman", "Sam Altman", "OpenAI, Altman", 5, "AI 公司与平台生态重点人物"),
    ("Greg Brockman", "Greg Brockman", "OpenAI, Brockman", 4, "OpenAI 与 AI 工程化重点人物"),
    ("Dario Amodei", "Dario Amodei", "Anthropic, Claude", 5, "AI 安全与模型公司重点人物"),
    ("Daniela Amodei", "Daniela Amodei", "Anthropic, Claude", 4, "AI 公司运营与产品重点人物"),
    ("Demis Hassabis", "Demis Hassabis", "Google DeepMind, DeepMind", 5, "基础模型与 AI 科学重点人物"),
    ("Sundar Pichai", "Sundar Pichai", "Google, Alphabet", 4, "AI 平台与搜索生态重点人物"),
    ("Jensen Huang", "Jensen Huang", "NVIDIA, 黄仁勋", 5, "芯片与 AI 基础设施重点人物"),
    ("Yann LeCun", "Yann LeCun", "Meta AI, LeCun", 4, "AI 研究与开源生态重点人物"),
    ("Mark Zuckerberg", "Mark Zuckerberg", "Meta, Zuckerberg", 4, "开源模型与 AI 产品生态重点人物"),
    ("Mustafa Suleyman", "Mustafa Suleyman", "Microsoft AI, Inflection", 4, "AI 产品与消费者 AI 重点人物"),
    ("Kevin Scott", "Kevin Scott", "Microsoft CTO, Microsoft AI", 4, "微软 AI 工程与平台重点人物"),
    ("Elon Musk", "Elon Musk", "xAI, Tesla AI, Grok", 4, "xAI 与机器人/自动驾驶重点人物"),
    ("Andrej Karpathy", "Andrej Karpathy", "Karpathy, OpenAI, Tesla AI", 5, "AI 教育、模型与工程重点人物"),
    ("Fei-Fei Li", "Fei-Fei Li", "Stanford HAI, 李飞飞", 4, "AI 学术与产业趋势重点人物"),
    ("Andrew Ng", "Andrew Ng", "DeepLearning.AI, 吴恩达", 4, "AI 教育与应用落地重点人物"),
    ("Ilya Sutskever", "Ilya Sutskever", "SSI, Safe Superintelligence", 5, "基础模型与 AI 安全重点人物"),
    ("Mira Murati", "Mira Murati", "Thinking Machines Lab, OpenAI", 4, "AI 产品与模型公司重点人物"),
    ("Arthur Mensch", "Arthur Mensch", "Mistral AI, Mistral", 4, "欧洲基础模型公司重点人物"),
    ("Alexandr Wang", "Alexandr Wang", "Scale AI", 4, "AI 数据与应用基础设施重点人物"),
    ("Aidan Gomez", "Aidan Gomez", "Cohere", 4, "企业 AI 与基础模型重点人物"),
    ("Clement Delangue", "Clement Delangue", "Hugging Face, HuggingFace", 4, "开源模型社区重点人物"),
    ("Satya Nadella", "Satya Nadella", "Microsoft, Nadella", 4, "云与 AI 平台重点人物"),
    ("Lisa Su", "Lisa Su", "AMD, 苏姿丰", 4, "芯片产业重点人物"),
    ("梁文锋", "Liang Wenfeng", "DeepSeek, 幻方, 深度求索", 5, "中国基础模型公司观察池"),
    ("张鹏", "Zhang Peng", "智谱, Zhipu AI, ChatGLM", 4, "中国大模型公司观察池"),
    ("杨植麟", "Yang Zhilin", "月之暗面, Moonshot AI, Kimi", 4, "中国 AI 应用与模型公司观察池"),
    ("闫俊杰", "Yan Junjie", "MiniMax, 海螺 AI", 4, "中国多模态与应用公司观察池"),
    ("李开复", "Kai-Fu Lee", "零一万物, 01.AI", 4, "中国 AI 创业与模型公司观察池"),
    ("王小川", "Wang Xiaochuan", "百川智能, Baichuan", 4, "中国大模型公司观察池"),
    ("姜大昕", "Jiang Daxin", "阶跃星辰, StepFun", 4, "中国大模型公司观察池"),
    ("周靖人", "Zhou Jingren", "阿里通义, Tongyi, Qwen", 4, "中国大模型与云生态观察池"),
]

BEIJING_TZ = ZoneInfo("Asia/Shanghai")


def _demo_videos() -> list[dict]:
    return [
        {
            "external_id": f"demo-altman-{_demo_day_key()}",
            "url": "https://www.youtube.com/results?search_query=Sam+Altman+AI+interview",
            "title": "Sam Altman interview: building useful AI products in 2026",
            "description": "A long-form conversation about AI agents, safety, compute, and product strategy.",
            "channel_title": "Decoder Style Tech",
            "published_at": _published_yesterday(9),
            "duration_seconds": 3020,
            "view_count": 128400,
            "thumbnail_url": "https://picsum.photos/seed/altman-interview/480/270",
        },
        {
            "external_id": f"demo-jensen-{_demo_day_key()}",
            "url": "https://www.youtube.com/results?search_query=Jensen+Huang+AI+interview",
            "title": "Jensen Huang full conversation on AI factories and robotics",
            "description": "NVIDIA CEO Jensen Huang talks with a technology editor about chips, supply chains, and robotics.",
            "channel_title": "Tech Summit",
            "published_at": _published_yesterday(14),
            "duration_seconds": 2440,
            "view_count": 221000,
            "thumbnail_url": "https://picsum.photos/seed/jensen-conversation/480/270",
        },
        {
            "external_id": f"demo-deepseek-{_demo_day_key()}",
            "url": "https://www.youtube.com/results?search_query=DeepSeek+AI+interview",
            "title": "DeepSeek founder discussion on open models and inference cost",
            "description": "A technical interview about open-weight models, reasoning systems, and China AI startup competition.",
            "channel_title": "AI Founder Forum",
            "published_at": _published_yesterday(19),
            "duration_seconds": 1880,
            "view_count": 76420,
            "thumbnail_url": "https://picsum.photos/seed/deepseek-founder/480/270",
        },
    ]


def seed_people_if_empty(topic_id: int = 1) -> None:
    topic = ensure_default_topic() if topic_id == 1 else get_topic(topic_id)
    with get_connection() as conn:
        timestamp = now_iso()
        existing = {row["name"] for row in conn.execute("SELECT name FROM people WHERE topic_id = ?", (topic_id,)).fetchall()}
        rows = [
            (topic_id, name, english, aliases, priority, notes, timestamp, timestamp)
            for name, english, aliases, priority, notes in DEFAULT_PEOPLE
            if name in topic["focus_people"] and name not in existing
        ]
        if rows:
            conn.executemany(
                """
                INSERT INTO people (topic_id, name, english_name, aliases, priority, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )


def seed_demo_videos(topic_id: int = 1) -> int:
    seed_people_if_empty(topic_id)
    topic = get_topic(topic_id)
    with get_connection() as conn:
        inserted = 0
        for item in _demo_videos():
            matches, names, candidate_people, reason, confidence = topic_signals(
                item["title"], item["description"], item["channel_title"], topic
            )
            score = topic_priority_score(matches, confidence, item["published_at"], item["view_count"], topic["ranking_mode"])
            summary = build_discovery_summary(
                item["title"], item["description"], item["channel_title"], names or candidate_people, topic["name"], topic["keywords"]
            )
            timestamp = now_iso()
            cursor = conn.execute(
                """
                INSERT INTO videos (
                  topic_id, platform, external_id, url, title, description, channel_title, published_at,
                  duration_seconds, view_count, thumbnail_url, matched_people, candidate_people, people_match_reason, interview_confidence,
                  priority_score, status, compliance_note, summary, source_tier, created_at, updated_at
                )
                VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'metadata_only', ?, 'stable', ?, ?)
                ON CONFLICT(topic_id, platform, external_id) DO UPDATE SET
                  title = excluded.title,
                  description = excluded.description,
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
                    item["external_id"],
                    item["url"],
                    item["title"],
                    item["description"],
                    item["channel_title"],
                    item["published_at"],
                    item["duration_seconds"],
                    item["view_count"],
                    item["thumbnail_url"],
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
            inserted += cursor.rowcount
        return inserted


def _demo_day_key() -> str:
    return (datetime.now(BEIJING_TZ).date() - timedelta(days=1)).strftime("%Y%m%d")


def _published_yesterday(hour: int) -> str:
    target = datetime.now(BEIJING_TZ).date() - timedelta(days=1)
    local_time = datetime.combine(target, time(hour=hour), tzinfo=BEIJING_TZ)
    return local_time.astimezone(timezone.utc).replace(microsecond=0).isoformat()
