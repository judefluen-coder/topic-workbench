import os
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
import io

import pytest
from fastapi.testclient import TestClient


def make_client() -> TestClient:
    tmp = tempfile.TemporaryDirectory()
    os.environ["TOPIC_WORKBENCH_DB_PATH"] = str(Path(tmp.name) / "app.db")
    os.environ["TOPIC_WORKBENCH_UPLOAD_DIR"] = str(Path(tmp.name) / "uploads")
    os.environ["TOPIC_WORKBENCH_EXPORT_DIR"] = str(Path(tmp.name) / "exports")
    os.environ["TOPIC_WORKBENCH_TMP_DIR"] = str(Path(tmp.name) / "tmp")
    os.environ["DOWNLOAD_DIR"] = str(Path(tmp.name) / "downloads")
    os.environ["YOUTUBE_API_KEY"] = ""
    os.environ["OPENAI_API_KEY"] = ""
    os.environ["CLOUD_AI_ENABLED"] = "false"
    os.environ["ARGOS_TRANSLATE_ENABLED"] = "false"
    os.environ["PLACEHOLDER_TRANSLATION_ENABLED"] = "true"
    os.environ["LOCAL_YTDLP_DISCOVERY"] = "false"
    os.environ["OPENCLI_DISCOVERY_ENABLED"] = "false"
    from app.main import app
    from app.db import init_db
    from app.seed import seed_people_if_empty

    init_db()
    seed_people_if_empty()

    client = TestClient(app)
    client.__dict__["_tmpdir"] = tmp
    return client


def test_demo_sync_does_not_download_public_youtube() -> None:
    client = make_client()
    response = client.post("/api/sync/youtube", json={"days_back": 1, "limit_per_query": 2})
    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "demo"
    videos = client.get("/api/videos").json()
    assert videos
    assert all(item["compliance_note"] == "metadata_only" for item in videos)


def test_daily_range_does_not_return_demo_or_search_urls_without_real_source() -> None:
    client = make_client()
    response = client.post("/api/daily/run", json={"start_date": "2026-06-01", "end_date": "2026-06-13", "limit_per_query": 1})
    assert response.status_code == 200
    payload = response.json()
    assert payload["start_date"] == "2026-06-01"
    assert payload["end_date"] == "2026-06-13"
    assert payload["items"] == []


def test_existing_youtube_subtitles_can_be_reprocessed_without_downloading_video() -> None:
    client = make_client()
    client.post("/api/sync/youtube", json={})
    video_id = client.get("/api/videos").json()[0]["id"]

    from app.config import settings

    subtitle_path = settings.download_dir / f"{video_id}-existing.en.vtt"
    subtitle_path.parent.mkdir(parents=True, exist_ok=True)
    subtitle_path.write_text(
        """WEBVTT

00:00:01.000 --> 00:00:03.000
Hello<00:00:02.000><c> &amp;</c><00:00:02.500><c> welcome</c>

00:00:03.000 --> 00:00:03.010
Hello &amp; welcome

00:00:03.010 --> 00:00:06.000
Hello &amp; welcome
&gt;&gt; Product<00:00:04.000><c> strategy</c>
""",
        encoding="utf-8",
    )
    clip_response = client.post(
        "/api/clip-marks",
        json={
            "video_id": video_id,
            "start_seconds": 1,
            "end_seconds": 5,
            "label": "保留的粗剪片段",
            "note": "字幕重处理不能移除片段或倒退状态",
            "quote": "Product strategy",
            "status": "ready",
        },
    )
    assert clip_response.status_code == 200

    response = client.post(f"/api/items/{video_id}/reprocess-subtitles")
    assert response.status_code == 200
    from app.worker import run_worker_once

    processed = run_worker_once()
    assert processed and processed["id"] == response.json()["job_id"]
    job = client.get(f"/api/jobs/{response.json()['job_id']}").json()
    assert job["status"] == "completed"

    payload = client.get(f"/api/items/{video_id}/clip").json()
    english = [item for item in payload["transcripts"] if item["language"] == "en"]
    chinese = [item for item in payload["transcripts"] if item["language"] == "zh"]
    assert [item["text"] for item in english] == ["Hello & welcome", "Product strategy"]
    assert len(chinese) == 2
    assert all(item["source"] == "reprocessed_local_translation" for item in chinese)
    assert len(payload["clip_marks"]) == 1
    assert payload["video"]["status"] == "clipped"


def test_import_transcribe_clip_and_export() -> None:
    client = make_client()
    client.post("/api/sync/youtube", json={})
    video_id = client.get("/api/videos").json()[0]["id"]

    import_response = client.post(
        "/api/media/import",
        data={
            "video_id": video_id,
            "authorization_note": "自有采访素材文本稿",
            "transcript_text": "This is a useful answer.\nWe should mark the product strategy quote.",
            "delete_after_processing": "true",
        },
    )
    assert import_response.status_code == 200
    assert import_response.json()["kind"] == "transcript"

    transcribe_response = client.post(f"/api/videos/{video_id}/transcribe")
    assert transcribe_response.status_code == 200
    assert transcribe_response.json()["segments"] == 2

    clip_response = client.post(
        "/api/clip-marks",
        json={
            "video_id": video_id,
            "start_seconds": 0,
            "end_seconds": 7,
            "label": "产品战略",
            "note": "适合 15 秒短切",
            "quote": "This is a useful answer.",
            "status": "ready",
        },
    )
    assert clip_response.status_code == 200
    clip_id = clip_response.json()["id"]

    update_response = client.patch(
        f"/api/clip-marks/{clip_id}",
        json={
            "start_seconds": 1,
            "end_seconds": 8,
            "label": "产品战略精修版",
            "note": "开头去掉停顿",
            "quote": "We should mark the product strategy quote.",
            "status": "approved",
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["label"] == "产品战略精修版"
    assert update_response.json()["status"] == "approved"

    invalid_update = client.patch(
        f"/api/clip-marks/{clip_id}",
        json={
            "start_seconds": 9,
            "end_seconds": 8,
            "label": "无效片段",
            "note": "",
            "quote": "",
            "status": "ready",
        },
    )
    assert invalid_update.status_code == 400

    second_clip_response = client.post(
        "/api/clip-marks",
        json={
            "video_id": video_id,
            "start_seconds": 20,
            "end_seconds": 27,
            "label": "结尾观点",
            "note": "放到开头测试序列编排",
            "quote": "We should mark the product strategy quote.",
            "status": "ready",
        },
    )
    assert second_clip_response.status_code == 200
    second_clip_id = second_clip_response.json()["id"]

    reorder_response = client.post(
        f"/api/items/{video_id}/clip-order",
        json={"clip_mark_ids": [second_clip_id, clip_id]},
    )
    assert reorder_response.status_code == 200
    assert [item["id"] for item in reorder_response.json()["clip_marks"]] == [second_clip_id, clip_id]

    invalid_reorder = client.post(
        f"/api/items/{video_id}/clip-order",
        json={"clip_mark_ids": [second_clip_id]},
    )
    assert invalid_reorder.status_code == 400

    srt = client.get(f"/api/videos/{video_id}/export?format=srt&language=zh")
    csv = client.get(f"/api/videos/{video_id}/export?format=csv")
    assert srt.status_code == 200
    assert "【中译】" in srt.text
    assert csv.status_code == 200
    assert "产品战略精修版" in csv.text
    assert csv.text.index("结尾观点") < csv.text.index("产品战略精修版")


def test_authorized_media_file_upload_is_stored_with_a_safe_unique_name() -> None:
    client = make_client()
    client.post("/api/sync/youtube", json={})
    video_id = client.get("/api/videos").json()[0]["id"]

    first = client.post(
        "/api/media/import",
        data={"video_id": video_id, "authorization_note": "自动生成的授权测试素材", "delete_after_processing": "false"},
        files={"file": ("sample.mp4", b"first-test-media", "video/mp4")},
    )
    second = client.post(
        "/api/media/import",
        data={"video_id": video_id, "authorization_note": "自动生成的授权测试素材", "delete_after_processing": "false"},
        files={"file": ("sample.mp4", b"second-test-media", "video/mp4")},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    from app.db import get_connection

    with get_connection() as conn:
        paths = [row["stored_path"] for row in conn.execute("SELECT stored_path FROM media_assets WHERE video_id = ? AND kind = 'media' ORDER BY id", (video_id,)).fetchall()]
    assert len(paths) == 2
    assert paths[0] != paths[1]
    assert all(Path(path).exists() for path in paths)


def test_render_clips_registers_exported_sequence_asset() -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg is required for clip rendering")

    client = make_client()
    client.post("/api/sync/youtube", json={})
    video_id = client.get("/api/videos").json()[0]["id"]

    from app.config import settings
    from app.db import get_connection, now_iso

    source = settings.upload_dir / "source.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=160x90:d=2",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    timestamp = now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO media_assets (
              video_id, kind, original_filename, stored_path, transcript_text,
              authorization_note, delete_after_processing, processing_status, created_at
            )
            VALUES (?, 'media', 'source.mp4', ?, '', '测试授权素材', 0, 'imported', ?)
            """,
            (video_id, str(source), timestamp),
        )
        conn.execute(
            """
            INSERT INTO transcripts (video_id, language, start_seconds, end_seconds, text, source, created_at)
            VALUES (?, 'zh', 0.1, 0.9, '发布规格字幕测试', 'test', ?)
            """,
            (video_id, timestamp),
        )

    clip_response = client.post(
        "/api/clip-marks",
        json={
            "video_id": video_id,
            "start_seconds": 0,
            "end_seconds": 1,
            "label": "确认导出",
            "note": "用于验证导出资产登记",
            "quote": "",
            "status": "approved",
        },
    )
    assert clip_response.status_code == 200
    draft_clip_response = client.post(
        "/api/clip-marks",
        json={
            "video_id": video_id,
            "start_seconds": 1,
            "end_seconds": 2,
            "label": "待审跳过",
            "note": "仅导出已确认时不应包含",
            "quote": "",
            "status": "ready",
        },
    )
    assert draft_clip_response.status_code == 200

    from PIL import Image

    logo_bytes = io.BytesIO()
    Image.new("RGBA", (80, 40), (240, 30, 30, 255)).save(logo_bytes, format="PNG")
    logo_response = client.post(
        f"/api/items/{video_id}/brand-logo",
        files={"file": ("brand.png", logo_bytes.getvalue(), "image/png")},
    )
    assert logo_response.status_code == 200
    assert logo_response.json()["kind"] == "brand_logo"
    assert logo_response.json()["url"].startswith("/media/uploads/brand/")

    invalid_profile = client.post(
        f"/api/items/{video_id}/render-clips",
        json={"output_profile": "square"},
    )
    assert invalid_profile.status_code == 422

    save_dir = settings.tmp_dir / "saved"
    render_response = client.post(
        f"/api/items/{video_id}/render-clips",
        json={
            "destination": "custom",
            "output_dir": str(save_dir),
            "filename": "asset-test.mp4",
            "target_duration_seconds": 0,
            "clip_status_filter": "approved",
            "output_profile": "portrait",
            "fit_mode": "crop",
            "focus_x": 65,
            "subtitle_style": "bold",
            "subtitle_position": "lower_third",
            "logo_asset_id": logo_response.json()["id"],
            "logo_position": "top_right",
        },
    )
    assert render_response.status_code == 200
    from app.worker import run_worker_once

    processed = run_worker_once()
    assert processed and processed["id"] == render_response.json()["id"]
    assert processed["status"] == "completed"
    render_payload = json.loads(processed["result"])
    assert render_payload["sequence_path"]
    assert render_payload["clip_status_filter"] == "approved"
    assert render_payload["output_profile"] == "portrait"
    assert (render_payload["output_width"], render_payload["output_height"]) == (1080, 1920)
    assert render_payload["logo_asset_id"] == logo_response.json()["id"]
    assert [clip["label"] for clip in render_payload["clips"]] == ["确认导出"]
    assert render_payload["clips"][0]["subtitle_mode"] == "burned_in"
    assert render_payload["sequence_url"].startswith("/media/exports/")

    clip_payload = client.get(f"/api/items/{video_id}/clip").json()
    exported_assets = [asset for asset in clip_payload["media_assets"] if asset["kind"] == "exported_sequence"]
    assert len(exported_assets) == 1
    assert exported_assets[0]["original_filename"] == Path(render_payload["sequence_path"]).name
    assert exported_assets[0]["stored_path"] == render_payload["sequence_path"]
    assert exported_assets[0]["url"] == render_payload["sequence_url"]
    assert exported_assets[0]["processing_status"] == "exported"

    video_detail = client.get(f"/api/videos/{video_id}").json()
    detail_asset = next(asset for asset in video_detail["media_assets"] if asset["kind"] == "exported_sequence")
    assert detail_asset["url"] == render_payload["sequence_url"]

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            render_payload["sequence_path"],
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert probe.stdout.strip() == "1080x1920"

    frame_path = settings.tmp_dir / "portrait-logo-frame.png"
    subprocess.run(
        [ffmpeg, "-y", "-ss", "0.2", "-i", render_payload["sequence_path"], "-frames:v", "1", str(frame_path)],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    with Image.open(frame_path) as frame:
        red, green, blue = frame.convert("RGB").getpixel((930, 60))
    assert red > 150 and red > green * 2 and red > blue * 2


def test_download_requires_authorization_note() -> None:
    client = make_client()
    client.post("/api/sync/youtube", json={})
    video_id = client.get("/api/videos").json()[0]["id"]
    response = client.post(
        f"/api/videos/{video_id}/download",
        json={"authorization_note": "", "quality": "720p", "include_subtitles": True, "include_thumbnail": True},
    )
    assert response.status_code == 400
