from __future__ import annotations

import subprocess
from pathlib import Path

from app import bilibili
from app.bilibili import download_bilibili_authorized
from app.db import get_connection, init_db, now_iso


def test_bilibili_download_accepts_completed_file_after_tool_warning(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setenv("DOWNLOAD_DIR", str(tmp_path / "downloads"))
    monkeypatch.setenv("OPENCLI_PREFLIGHT_ENABLED", "false")
    monkeypatch.setenv("OPENCLI_WINDOW_MODE", "foreground")
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
            VALUES (1, 'bilibili', 'BVwarned', 'https://www.bilibili.com/video/BVwarned',
                    'B站下载警告测试', ?, 60, 0, 0, 0.5, 0, 'ready',
                    'metadata_only', ?, ?)
            """,
            (timestamp, timestamp, timestamp),
        )

    monkeypatch.setattr(bilibili, "_require_opencli", lambda: "opencli")

    def fake_run(command: list[str], **_: object) -> None:
        assert command[-2:] == ["--window", "foreground"]
        output_dir = Path(command[command.index("--output") + 1])
        (output_dir / "video.f30112.mp4").write_text("fragment", encoding="utf-8")
        (output_dir / "video.temp.mp4").write_text("temp", encoding="utf-8")
        (output_dir / "video.mp4").write_text("final", encoding="utf-8")
        raise subprocess.CalledProcessError(
            75,
            command,
            output="[1/1] ✓ video 1.3 GB\n\nDownload complete: 1 downloaded in 2m 23s\n",
            stderr="tool warning after download",
        )

    monkeypatch.setattr(bilibili.subprocess, "run", fake_run)

    result = download_bilibili_authorized(1, "BVwarned", "已授权本地测试", "1080p")

    task = result["task"]
    assert task["status"] == "completed"
    assert task["output_path"].endswith("video.mp4")
    assert "工具返回警告" in result["message"]

    with get_connection() as conn:
        video = conn.execute("SELECT status FROM videos WHERE id = 1").fetchone()
        assets = conn.execute("SELECT stored_path FROM media_assets WHERE video_id = 1").fetchall()
    assert video["status"] == "imported"
    assert [asset["stored_path"] for asset in assets] == [task["output_path"]]
