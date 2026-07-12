from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TopicCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    keywords: list[str] = Field(min_length=1, max_length=20)
    excluded_keywords: list[str] = Field(default_factory=list, max_length=20)
    focus_people: list[str] = Field(default_factory=list, max_length=30)
    channel_terms: list[str] = Field(default_factory=list, max_length=30)
    bilibili_channel_uids: list[str] = Field(default_factory=list, max_length=30)
    sources: list[Literal["youtube", "bilibili"]] = Field(default_factory=lambda: ["youtube", "bilibili"], min_length=1)
    ranking_mode: Literal["balanced", "people", "popular", "latest"] = "balanced"


class TopicUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    keywords: list[str] | None = Field(default=None, min_length=1, max_length=20)
    excluded_keywords: list[str] | None = Field(default=None, max_length=20)
    focus_people: list[str] | None = Field(default=None, max_length=30)
    channel_terms: list[str] | None = Field(default=None, max_length=30)
    bilibili_channel_uids: list[str] | None = Field(default=None, max_length=30)
    sources: list[Literal["youtube", "bilibili"]] | None = Field(default=None, min_length=1)
    ranking_mode: Literal["balanced", "people", "popular", "latest"] | None = None


class PersonCreate(BaseModel):
    name: str
    english_name: str = ""
    aliases: str = ""
    priority: int = Field(default=3, ge=1, le=5)
    notes: str = ""


class VideoUpdate(BaseModel):
    status: str | None = None


class ClipMarkCreate(BaseModel):
    video_id: int
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    label: str
    note: str = ""
    quote: str = ""
    status: str = "draft"


class ClipMarkUpdate(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    label: str
    note: str = ""
    quote: str = ""
    status: str = "ready"


class ClipMarkReorder(BaseModel):
    clip_mark_ids: list[int]


class YoutubeSyncRequest(BaseModel):
    topic_id: int = Field(default=1, gt=0)
    days_back: int = Field(default=1, ge=1, le=30)
    limit_per_query: int = Field(default=8, ge=1, le=25)
    include_demo_when_unconfigured: bool = True


class DailyRunRequest(BaseModel):
    topic_id: int = Field(default=1, gt=0)
    date: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    limit_per_query: int = Field(default=5, ge=1, le=12)


class DownloadRequest(BaseModel):
    authorization_note: str
    quality: str = Field(default="1080p")
    include_subtitles: bool = True
    include_thumbnail: bool = True


class DownloadTranslateRequest(BaseModel):
    authorization_note: str = ""
    quality: str = Field(default="1080p")


class RenderClipsRequest(BaseModel):
    destination: str = Field(default="downloads")
    output_dir: str = ""
    filename: str = ""
    target_duration_seconds: float = Field(default=0, ge=0, le=600)
    clip_status_filter: str = Field(default="all")
    output_profile: Literal["source", "landscape", "portrait"] = "source"
    fit_mode: Literal["crop", "contain"] = "crop"
    focus_x: float = Field(default=50, ge=0, le=100)
    subtitle_style: Literal["standard", "bold", "minimal", "none"] = "standard"
    subtitle_position: Literal["bottom", "lower_third"] = "bottom"
    logo_asset_id: int | None = Field(default=None, gt=0)
    logo_position: Literal["top_left", "top_right", "bottom_left", "bottom_right"] = "top_right"


class AutomationRequest(BaseModel):
    days_back: int = Field(default=1, ge=1, le=30)
    limit_per_query: int = Field(default=4, ge=1, le=10)
    shortlist_threshold: float = Field(default=55, ge=0, le=100)
    auto_download: bool = False
    authorization_note: str = ""
    auto_transcribe: bool = False
