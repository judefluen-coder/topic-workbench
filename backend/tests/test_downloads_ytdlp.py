from __future__ import annotations

from pathlib import Path

from app import downloads
from app.db import get_connection, init_db, now_iso
from app.downloads import run_authorized_download


class Completed:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def test_authorized_download_uses_configured_ytdlp_for_video_and_subtitles(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setenv("DOWNLOAD_DIR", str(tmp_path / "downloads"))
    monkeypatch.setenv("YTDLP_PATH", "yt-dlp-custom")
    monkeypatch.setattr(downloads.shutil, "which", lambda name: "/usr/local/bin/yt-dlp-custom" if name == "yt-dlp-custom" else None)
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
                    'Configured yt-dlp test', ?, 60, 0, 0, 0.5, 0, 'ready',
                    'metadata_only', ?, ?)
            """,
            (timestamp, timestamp, timestamp),
        )

    commands: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> Completed:
        commands.append(command)
        if "--skip-download" in command:
            return Completed(stdout="subtitle check\n")
        output_template = command[command.index("-o") + 1]
        media_path = Path(output_template.replace("%(ext)s", "mp4"))
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_text("fake media", encoding="utf-8")
        return Completed(stdout=f"{media_path}\n")

    monkeypatch.setattr(downloads.subprocess, "run", fake_run)

    result = run_authorized_download(1, "已授权测试下载", include_subtitles=True, include_thumbnail=False)

    assert result["task"]["status"] == "completed"
    assert result["task"]["output_path"].endswith(".mp4")
    assert commands[0][0] == "/usr/local/bin/yt-dlp-custom"
    assert commands[1][0] == "/usr/local/bin/yt-dlp-custom"
