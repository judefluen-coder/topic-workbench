from __future__ import annotations

import re


AI_TERMS = (
    "ai",
    "artificial intelligence",
    "agi",
    "agent",
    "agents",
    "llm",
    "model",
    "openai",
    "anthropic",
    "deepmind",
    "nvidia",
    "deepseek",
    "智谱",
    "月之暗面",
    "通义",
    "豆包",
    "大模型",
    "智能体",
    "人工智能",
)

TOPIC_PATTERNS = (
    ("AI Agent/工作流", ("agent", "agentic", "智能体", "workflow", "codex", "cursor", "manus", "工作流")),
    ("模型能力与 AGI", ("agi", "capability", "能力边界", "通用人工智能", "gemini", "claude", "gpt")),
    ("AI 安全与监管", ("safety", "regulation", "danger", "warning", "安全", "监管", "风险", "政府")),
    ("模型公司商业化", ("profit", "盈利", "亏损", "roi", "ipo", "valuation", "估值", "商业模式", "资本")),
    ("算力/芯片/数据中心", ("nvidia", "gpu", "chip", "data center", "算力", "芯片", "数据中心", "英伟达")),
    ("AI for Science", ("science", "alphafold", "drug", "disease", "biology", "科学", "药物", "疾病", "生物")),
    ("机器人/Physical AI", ("robot", "robotics", "physical ai", "机器人", "具身", "自动驾驶")),
    ("组织与产品方法", ("founder", "ceo", "product", "organization", "startup", "创始人", "产品", "组织", "创业")),
    ("就业与产业影响", ("job", "labor", "work", "employment", "工作", "就业", "劳动", "产业")),
)

NOISE_PREFIXES = (
    "subscribe",
    "follow",
    "like this video",
    "watch more",
    "connect with",
    "for business",
    "additional reading",
    "read more",
    "download",
    "links",
    "disclaimer",
    "contact",
    "outline",
    "timestamps",
    "chapter",
    "章节",
    "时间戳",
    "免责声明",
    "商务合作",
)


def build_discovery_summary(
    title: str,
    description: str,
    channel: str,
    matched_people: str,
    topic_name: str = "",
    topic_keywords: list[str] | None = None,
) -> str:
    lead = _lead_sentence(title, description)
    topics = _extract_topics(title, description)
    outline = _extract_outline_items(description)
    people = _validated_people(matched_people, title, description) or _infer_person_hint(title, description)
    source = channel or "未知来源"
    configured_topics = [value.strip() for value in (topic_keywords or []) if value.strip()]
    topic_text = "、".join(topics[:3] or configured_topics[:3]) or topic_name or "当前主题"
    main = f"值得看：{people}｜{source}｜聚焦 {topic_text}。{lead[:150]}"
    if outline:
        detail = f"可剪辑点：{'；'.join(outline[:3])}"
    elif topics:
        detail = f"可剪辑点：围绕 {topic_text} 做观点短切，适合先看原片确认嘉宾原话。"
    else:
        detail = f"可剪辑点：标题和描述命中“{topic_name or '当前主题'}”，建议先确认素材内容和核心观点。"
    return f"{main} {detail}"


def build_transcript_summary(segments: list[dict]) -> str:
    text = _clean_text(" ".join(segment.get("text", "") for segment in segments[:18]))
    if not text:
        return "已生成字幕，可进入剪辑工作台逐段查看。"
    sentence = _first_sentence(text)
    return f"已完成字幕处理。开头重点：{sentence[:180]}"


def looks_ai_related(title: str, description: str, channel: str = "") -> bool:
    haystack = f"{title} {description} {channel}".lower()
    return any(term.lower() in haystack for term in AI_TERMS)


def _clean_text(value: str) -> str:
    lines = []
    for raw_line in (value or "").splitlines():
        line = re.sub(r"https?://\S+|www\.\S+", "", raw_line).strip()
        line = re.sub(r"^[#>*\-\s]+", "", line).strip()
        if not line or _is_noise_line(line):
            continue
        lines.append(line)
    return re.sub(r"\s+", " ", " ".join(lines)).strip()


def _first_sentence(value: str) -> str:
    parts = re.split(r"(?<=[。！？.!?])\s+", value)
    return parts[0].strip() if parts and parts[0].strip() else value.strip()


def _lead_sentence(title: str, description: str) -> str:
    clean_description = _clean_text(description)
    if clean_description:
        first = _first_sentence(clean_description)
        if len(first) >= 18:
            return first
    return f"标题显示这是一条围绕“{title[:72]}”的采访/长谈候选。"


def _extract_topics(title: str, description: str) -> list[str]:
    haystack = f"{title} {description}".lower()
    topics = []
    for label, needles in TOPIC_PATTERNS:
        if any(needle.lower() in haystack for needle in needles):
            topics.append(label)
    return topics[:5]


def _extract_outline_items(description: str) -> list[str]:
    items: list[str] = []
    for raw_line in (description or "").splitlines():
        line = raw_line.strip()
        match = re.match(r"^(?:\d{1,2}:)?\d{1,2}:\d{2}\s+(.+)$", line)
        if not match:
            continue
        item = re.sub(r"\s+", " ", match.group(1)).strip(" -—–·:：")
        if not item or _is_noise_line(item) or item.lower() in {"intro", "introduction", "closing"}:
            continue
        if item not in items:
            items.append(item[:42])
    return items


def _infer_person_hint(title: str, description: str) -> str:
    text = f"{title} {description}"
    patterns = [
        r"(?:CEO|创始人|联合创始人|founder|co-founder)\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,2})",
        r"([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){1,2}),?\s*(?:CEO|founder|co-founder)",
        r"对([^，。:：]{2,12})的.{0,8}访谈",
        r"([^｜|【】]{2,24})\s*对谈\s*([^｜|【】（）()]{2,24})",
        r"和([^，。:：]{2,12})聊",
        r"接受([^，。:：]{2,16})访谈",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            groups = [part.strip(" -—–｜|") for part in match.groups() if part and part.strip()]
            return "、".join(groups[:2])
    return "人物待确认"


def _validated_people(matched_people: str, title: str, description: str) -> str:
    haystack = f"{title} {description}".lower()
    names = []
    for raw_name in re.split(r"[,，]", matched_people or ""):
        name = raw_name.strip()
        if not name:
            continue
        if re.search(r"[\u4e00-\u9fff]", name):
            if name in title or name in description:
                names.append(name)
            continue
        normalized = name.lower()
        tokens = [token for token in re.split(r"\s+", normalized) if len(token) >= 4]
        if normalized in haystack or any(re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", haystack) for token in tokens):
            names.append(name)
    return ", ".join(dict.fromkeys(names))


def _is_noise_line(value: str) -> bool:
    normalized = value.strip().lower()
    if not normalized:
        return True
    if normalized.startswith(NOISE_PREFIXES):
        return True
    if normalized.startswith("#") or normalized.count("#") >= 2:
        return True
    if len(normalized) <= 3:
        return True
    return False
