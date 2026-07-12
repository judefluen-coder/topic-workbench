from __future__ import annotations

import subprocess
from pathlib import Path

from app import downloads
from app.db import get_connection, init_db, now_iso
from app.downloads import run_authorized_download


class Completed:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _seed_video(monkeypatch, tmp_path: Path, title: str = "YouTube warning test") -> Path:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setenv("DOWNLOAD_DIR", str(tmp_path / "downloads"))
    monkeypatch.setenv("DOWNLOAD_ENGINE", "yt-dlp")
    init_db()
    timestamp = now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO videos (
              id, platform, external_id, url, title, published_at,
              duration_seconds, view_count, like_count, interview_confidence,
              priority_score, status, compliance_note, created_at, updated_at
            )
            VALUES (1, 'youtube', 'abc123', 'https://www.youtube.com/watch?v=abc123',
                    ?, ?, 60, 0, 0, 0.5, 0, 'ready',
                    'metadata_only', ?, ?)
            """,
            (title, timestamp, timestamp, timestamp),
        )
    return tmp_path / "downloads"


def _output_path(command: list[str]) -> Path:
    template = command[command.index("-o") + 1]
    return Path(template.replace("%(ext)s", "mp4"))


def test_youtube_download_accepts_completed_file_after_tool_warning(monkeypatch, tmp_path: Path) -> None:
    _seed_video(monkeypatch, tmp_path)

    def fake_run(command: list[str], **_: object) -> Completed:
        output = _output_path(command)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("video", encoding="utf-8")
        raise subprocess.CalledProcessError(
            1,
            command,
            output=f"{output}\n",
            stderr="WARNING: postprocess warning after media moved",
        )

    monkeypatch.setattr(downloads.subprocess, "run", fake_run)

    result = run_authorized_download(1, "已授权本地测试", "1080p", include_subtitles=False, include_thumbnail=False)

    task = result["task"]
    assert task["status"] == "completed"
    assert task["output_path"].endswith(".mp4")
    assert "下载工具返回警告" in result["message"]


def test_thumbnail_failure_does_not_fail_media_download(monkeypatch, tmp_path: Path) -> None:
    _seed_video(monkeypatch, tmp_path)
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> Completed:
        commands.append(command)
        if "--write-thumbnail" in command:
            raise subprocess.TimeoutExpired(command, timeout=600)
        output = _output_path(command)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("video", encoding="utf-8")
        return Completed(stdout=f"{output}\n")

    monkeypatch.setattr(downloads.subprocess, "run", fake_run)

    result = run_authorized_download(1, "已授权本地测试", "1080p", include_subtitles=False, include_thumbnail=True)

    assert result["task"]["status"] == "completed"
    assert "--write-thumbnail" not in commands[0]
    assert any("--write-thumbnail" in command for command in commands[1:])
    assert "封面" in result["message"]


def test_download_uses_single_file_format_when_ffmpeg_is_missing(monkeypatch, tmp_path: Path) -> None:
    _seed_video(monkeypatch, tmp_path)
    commands: list[list[str]] = []

    def fake_which(name: str) -> str | None:
        if name == "ffmpeg":
            return None
        if name == "node":
            return "/usr/bin/node"
        return None

    def fake_run(command: list[str], **_: object) -> Completed:
        commands.append(command)
        output = _output_path(command)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("video", encoding="utf-8")
        return Completed(stdout=f"{output}\n")

    monkeypatch.setattr(downloads.shutil, "which", fake_which)
    monkeypatch.setattr(downloads.subprocess, "run", fake_run)

    run_authorized_download(1, "已授权本地测试", "1080p", include_subtitles=False, include_thumbnail=False)

    command = commands[0]
    assert "--merge-output-format" not in command
    assert "+" not in command[command.index("-f") + 1]
