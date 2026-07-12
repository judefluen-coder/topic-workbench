from app.db import get_connection, init_db, now_iso
from app.jobs import claim_next_job, enqueue_job, fail_job, get_job, list_jobs, recover_interrupted_jobs, retry_job
from app.worker import run_worker_once


def test_interrupted_jobs_are_recovered_and_failed_jobs_can_retry(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    queued = enqueue_job("download_translate", {"video_id": 7}, "等待处理")

    claimed = claim_next_job()
    assert claimed and claimed["id"] == queued["id"]
    assert claimed["status"] == "running"
    assert claimed["attempts"] == 1

    assert recover_interrupted_jobs() == 1
    assert get_job(queued["id"])["status"] == "queued"

    fail_job(queued["id"], "测试失败")
    retried = retry_job(queued["id"])
    assert retried["status"] == "queued"
    assert retried["progress"] == 0
    assert retried["attempts"] == 1


def test_worker_does_not_claim_api_owned_job_types(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    job = enqueue_job("daily_discovery", {}, "API 正在抓取")

    processed = run_worker_once()

    assert processed is None
    assert get_job(job["id"])["status"] == "queued"


def test_video_jobs_are_deduplicated_and_filtered_before_limit(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    first = enqueue_job("render_clips", {"video_id": 7}, "等待导出", dedupe_video_id=7)
    duplicate = enqueue_job("render_clips", {"video_id": 7}, "重复导出", dedupe_video_id=7)
    enqueue_job("render_clips", {"video_id": 8}, "其他视频", dedupe_video_id=8)

    assert duplicate["id"] == first["id"]
    assert [job["id"] for job in list_jobs(video_id=7, limit=1)] == [first["id"]]


def test_video_jobs_include_context_for_restored_task_lists(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    timestamp = now_iso()
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO videos (
              id, platform, external_id, url, title, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (74, "youtube", "restore-74", "https://example.com/watch/74", "恢复后的采访标题", timestamp, timestamp),
        )
    job = enqueue_job("download_translate", {"video_id": 74}, "等待下载")

    restored = get_job(job["id"])

    assert restored["video_id"] == 74
    assert restored["video_title"] == "恢复后的采访标题"
    assert restored["video_url"] == "https://example.com/watch/74"


def test_recovery_only_requeues_worker_owned_jobs(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TOPIC_WORKBENCH_DB_PATH", str(tmp_path / "app.db"))
    init_db()
    worker_job = enqueue_job("download_translate", {"video_id": 7}, "等待下载")
    api_job = enqueue_job("daily_discovery", {}, "API 正在抓取")
    from app.db import get_connection

    with get_connection() as conn:
        conn.execute("UPDATE jobs SET status = 'running'")

    assert recover_interrupted_jobs() == 1
    assert get_job(worker_job["id"])["status"] == "queued"
    assert get_job(api_job["id"])["status"] == "running"
