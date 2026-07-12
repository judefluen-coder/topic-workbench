from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


class Settings:
    @property
    def youtube_api_key(self) -> str:
        return os.getenv("YOUTUBE_API_KEY", "")

    @property
    def openai_api_key(self) -> str:
        return os.getenv("OPENAI_API_KEY", "")

    @property
    def cloud_ai_enabled(self) -> bool:
        return _as_bool(os.getenv("CLOUD_AI_ENABLED"), False)

    @property
    def ollama_base_url(self) -> str:
        return os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")

    @property
    def ollama_model(self) -> str:
        return os.getenv("OLLAMA_MODEL", "qwen2.5:7b")

    @property
    def argos_translate_enabled(self) -> bool:
        return _as_bool(os.getenv("ARGOS_TRANSLATE_ENABLED"), True)

    @property
    def argos_auto_install(self) -> bool:
        return _as_bool(os.getenv("ARGOS_AUTO_INSTALL"), True)

    @property
    def placeholder_translation_enabled(self) -> bool:
        return _as_bool(os.getenv("PLACEHOLDER_TRANSLATION_ENABLED"), False)

    @property
    def local_asr_enabled(self) -> bool:
        return _as_bool(os.getenv("LOCAL_ASR_ENABLED"), False)

    @property
    def download_engine(self) -> str:
        return os.getenv("DOWNLOAD_ENGINE", "yt-dlp")

    @property
    def ytdlp_path(self) -> str:
        return os.getenv("YTDLP_PATH", "yt-dlp")

    @property
    def local_ytdlp_discovery(self) -> bool:
        return _as_bool(os.getenv("LOCAL_YTDLP_DISCOVERY"), True)

    @property
    def opencli_discovery_enabled(self) -> bool:
        return _as_bool(os.getenv("OPENCLI_DISCOVERY_ENABLED"), True)

    @property
    def opencli_path(self) -> str:
        return os.getenv("OPENCLI_PATH", "opencli")

    @property
    def opencli_window_mode(self) -> str:
        raw = os.getenv("OPENCLI_WINDOW_MODE", "background").strip().lower()
        if raw in {"", "0", "false", "none", "off"}:
            return ""
        if raw in {"foreground", "background"}:
            return raw
        return "foreground"

    @property
    def opencli_preflight_enabled(self) -> bool:
        return _as_bool(os.getenv("OPENCLI_PREFLIGHT_ENABLED"), False)

    @property
    def bilibili_discovery_enabled(self) -> bool:
        return _as_bool(os.getenv("BILIBILI_DISCOVERY_ENABLED"), True)

    @property
    def bilibili_channel_uids(self) -> list[str]:
        raw = os.getenv(
            "BILIBILI_CHANNEL_UIDS",
            "",
        )
        return [part.strip() for part in raw.split(",") if part.strip()]

    @property
    def bilibili_channel_scan_limit(self) -> int:
        try:
            return max(0, int(os.getenv("BILIBILI_CHANNEL_SCAN_LIMIT", "2")))
        except ValueError:
            return 2

    @property
    def download_dir(self) -> Path:
        return self._path_from_env("DOWNLOAD_DIR", "storage/downloads")

    @property
    def database_path(self) -> Path:
        return self._path_from_env("TOPIC_WORKBENCH_DB_PATH", "storage/app.db", "TECH_PR_DB_PATH")

    @property
    def upload_dir(self) -> Path:
        return self._path_from_env("TOPIC_WORKBENCH_UPLOAD_DIR", "storage/uploads", "TECH_PR_UPLOAD_DIR")

    @property
    def export_dir(self) -> Path:
        return self._path_from_env("TOPIC_WORKBENCH_EXPORT_DIR", "storage/exports", "TECH_PR_EXPORT_DIR")

    @property
    def tmp_dir(self) -> Path:
        return self._path_from_env("TOPIC_WORKBENCH_TMP_DIR", "storage/tmp", "TECH_PR_TMP_DIR")

    @property
    def delete_after_processing_default(self) -> bool:
        return _as_bool(os.getenv("TOPIC_WORKBENCH_DEFAULT_MEDIA_DELETE_AFTER_PROCESSING", os.getenv("TECH_PR_DEFAULT_MEDIA_DELETE_AFTER_PROCESSING")), True)

    def ensure_dirs(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self.download_dir.mkdir(parents=True, exist_ok=True)

    def _path_from_env(self, key: str, default: str, legacy_key: str | None = None) -> Path:
        raw = os.getenv(key, os.getenv(legacy_key, default) if legacy_key else default)
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = ROOT_DIR / path
        return path


settings = Settings()
