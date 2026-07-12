from __future__ import annotations

import argparse
import os
import signal
import time

from app.db import init_db
from app.jobs import claim_next_job, fail_job, get_job, job_payload, recover_interrupted_jobs
from app.render_jobs import run_render_clips_job
from app.workflow import run_download_translate_job, run_subtitle_reprocess_job

_running = True


def run_worker_once() -> dict | None:
    job = claim_next_job()
    if not job:
        return None
    try:
        _dispatch_job(job)
    except Exception as exc:
        fail_job(job["id"], str(exc))
    completed = get_job(job["id"])
    if completed["status"] == "running":
        completed = fail_job(job["id"], "后台处理器结束了任务，但任务没有写入完成状态。")
    return completed


def _dispatch_job(job: dict) -> None:
    payload = job_payload(job)
    job_type = job["type"]
    if job_type == "download_translate":
        run_download_translate_job(
            job["id"],
            int(payload.get("video_id") or 0),
            str(payload.get("authorization_note") or ""),
            str(payload.get("quality") or "1080p"),
        )
        return
    if job_type == "subtitle_reprocess":
        run_subtitle_reprocess_job(job["id"], int(payload.get("video_id") or 0))
        return
    if job_type == "render_clips":
        run_render_clips_job(job["id"], payload)
        return
    raise RuntimeError(f"不支持的任务类型：{job_type}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Topic Workbench persistent background worker")
    parser.add_argument("--once", action="store_true", help="Process at most one queued job and exit")
    args = parser.parse_args()

    init_db()
    recovered = recover_interrupted_jobs()
    if recovered:
        print(f"[worker] recovered {recovered} interrupted job(s)", flush=True)
    if args.once:
        run_worker_once()
        return

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    poll_seconds = max(float(os.getenv("TOPIC_WORKBENCH_WORKER_POLL_SECONDS", os.getenv("TECH_PR_WORKER_POLL_SECONDS", "0.8"))), 0.1)
    print("[worker] ready", flush=True)
    while _running:
        processed = run_worker_once()
        if not processed:
            time.sleep(poll_seconds)


def _stop(_signum: int, _frame: object) -> None:
    global _running
    _running = False


if __name__ == "__main__":
    main()
