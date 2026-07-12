from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from app.config import settings
from app.db import get_connection, now_iso, row_to_dict
from app.exports import segments_to_srt
from app.render_options import logo_overlay_position, normalize_render_options, output_dimensions, subtitle_force_style, subtitle_margin, video_frame_filter

CLIP_MARK_ORDER_SQL = "position IS NULL, position, start_seconds, id"


def render_clip_marks(
    video_id: int,
    destination: str = "downloads",
    destination_dir: str = "",
    filename: str = "",
    target_duration_seconds: float = 0,
    clip_status_filter: str = "all",
    output_profile: str = "source",
    fit_mode: str = "crop",
    focus_x: float = 50,
    subtitle_style: str = "standard",
    subtitle_position: str = "bottom",
    logo_asset_id: int | None = None,
    logo_position: str = "top_right",
    progress_callback: Callable[[int, str], None] | None = None,
) -> dict:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg，无法导出片段视频。")
    filters = _ffmpeg_filters(ffmpeg)
    supports_subtitles_filter = "subtitles" in filters
    supports_overlay_filter = "overlay" in filters
    render_options = normalize_render_options(
        {
            "output_profile": output_profile,
            "fit_mode": fit_mode,
            "focus_x": focus_x,
            "subtitle_style": subtitle_style,
            "subtitle_position": subtitle_position,
            "logo_asset_id": logo_asset_id,
            "logo_position": logo_position,
        }
    )

    with get_connection() as conn:
        video = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise ValueError("视频不存在。")
        marks = [
            row_to_dict(row)
            for row in conn.execute(f"SELECT * FROM clip_marks WHERE video_id = ? ORDER BY {CLIP_MARK_ORDER_SQL}", (video_id,)).fetchall()
        ]
        transcripts = [
            row_to_dict(row)
            for row in conn.execute(
                "SELECT * FROM transcripts WHERE video_id = ? AND language = 'zh' ORDER BY start_seconds",
                (video_id,),
            ).fetchall()
        ]
        media = conn.execute(
            """
            SELECT * FROM media_assets
            WHERE video_id = ? AND kind = 'media' AND stored_path != ''
            ORDER BY id DESC
            LIMIT 1
            """,
            (video_id,),
        ).fetchone()
        logo = None
        if render_options["logo_asset_id"]:
            logo = conn.execute(
                """
                SELECT * FROM media_assets
                WHERE id = ? AND video_id = ? AND kind = 'brand_logo' AND stored_path != ''
                """,
                (render_options["logo_asset_id"], video_id),
            ).fetchone()

    if not marks:
        raise ValueError("还没有保存剪辑点。")
    marks = _filter_export_marks(marks, clip_status_filter)
    if not marks:
        raise ValueError("还没有已确认的剪辑片段。")
    if not media:
        raise FileNotFoundError("还没有本地视频文件。")
    if render_options["logo_asset_id"] and not logo:
        raise ValueError("选择的 Logo 素材不存在。")

    planned_marks = _plan_export_marks(marks, target_duration_seconds)
    if not planned_marks:
        raise ValueError("目标时长太短，无法生成有效片段。")

    source = Path(media["stored_path"])
    if not source.exists():
        raise FileNotFoundError(f"本地视频文件不存在：{source}")
    logo_path = Path(logo["stored_path"]) if logo else None
    if logo_path and not logo_path.exists():
        raise FileNotFoundError(f"Logo 文件不存在：{logo_path}")

    output_dir = settings.export_dir / f"video-{video_id}"
    output_dir.mkdir(parents=True, exist_ok=True)
    source_width, source_height = _probe_video_size(source)
    video_width, video_height = output_dimensions(render_options["output_profile"], source_width, source_height)
    frame_filter = video_frame_filter(render_options["output_profile"], render_options["fit_mode"], render_options["focus_x"])
    rendition_slug = _rendition_slug(render_options)

    exported = []
    burned_subtitle_count = 0
    rendered_duration_seconds = 0.0
    for index, mark in enumerate(planned_marks, start=1):
        start = max(float(mark["start_seconds"]), 0)
        end = max(float(mark["end_seconds"]), start + 0.1)
        duration = max(end - start, 0.1)
        rendered_duration_seconds += duration
        label = _slugify(mark.get("label") or f"clip-{index}")
        output = output_dir / f"{index:02d}-{_time_slug(start)}-{_time_slug(end)}-{label}-{rendition_slug}.mp4"
        subtitle_segments = []
        if render_options["subtitle_style"] != "none":
            subtitle_segments = _compact_subtitle_segments(_clip_subtitle_segments(transcripts, start, end))
        subtitle_path = None
        subtitle_mode = "none"
        if subtitle_segments:
            subtitle_path = output_dir / f"{index:02d}-{_time_slug(start)}-{_time_slug(end)}.zh.srt"
            subtitle_path.write_text(segments_to_srt(subtitle_segments), encoding="utf-8")
            if supports_subtitles_filter:
                subtitle_mode = "subtitles_filter"
            elif supports_overlay_filter:
                subtitle_mode = "image_overlay"
            else:
                raise RuntimeError("当前 ffmpeg 缺少 subtitles/overlay 滤镜，无法烧录中文字幕。")
        command = [
            ffmpeg,
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(source),
        ]
        overlay_inputs, filter_complex = _build_filter_plan(
            frame_filter=frame_filter,
            logo_path=logo_path,
            logo_position=render_options["logo_position"],
            output_dir=output_dir,
            output_height=video_height,
            output_width=video_width,
            subtitle_mode=subtitle_mode,
            subtitle_path=subtitle_path,
            subtitle_position=render_options["subtitle_position"],
            subtitle_segments=subtitle_segments,
            subtitle_style=render_options["subtitle_style"],
            clip_index=index,
        )
        command.extend(overlay_inputs)
        command.extend(
            [
                "-t",
                f"{duration:.3f}",
                "-sn",
                "-dn",
            ]
        )
        if filter_complex:
            command.extend(["-filter_complex", filter_complex, "-map", "[vout]", "-map", "0:a:0?"])
        else:
            command.extend(["-map", "0:v:0", "-map", "0:a:0?"])
        if subtitle_mode != "none":
            burned_subtitle_count += 1
        command.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "22",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )
        completed = subprocess.run(command, capture_output=True, text=True, timeout=600)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip()[-1200:] or "ffmpeg 导出失败。")
        exported.append(
            {
                "id": mark["id"],
                "label": mark.get("label", ""),
                "start_seconds": start,
                "end_seconds": end,
                "path": str(output),
                "url": _export_url(output),
                "subtitle_mode": "burned_in" if subtitle_mode != "none" else "none",
            }
        )
        if progress_callback:
            progress = 10 + round(index / len(planned_marks) * 70)
            progress_callback(progress, f"正在导出片段 {index}/{len(planned_marks)}")

    sequence_path = None
    sequence_url = ""
    saved_path = ""
    if exported:
        if progress_callback:
            progress_callback(90, "片段已生成，正在合成最终序列")
        scope_suffix = "-approved" if _normalized_clip_status_filter(clip_status_filter) == "approved" else ""
        duration_suffix = f"-{int(target_duration_seconds)}s" if target_duration_seconds > 0 else ""
        sequence_path = output_dir / f"sequence-{rendition_slug}{scope_suffix}{duration_suffix}.mp4"
        list_file = output_dir / f"sequence-{rendition_slug}{scope_suffix}{duration_suffix}.txt"
        list_file.write_text("".join(f"file '{Path(item['path']).as_posix()}'\n" for item in exported), encoding="utf-8")
        sequence_command = [
            ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_file),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(sequence_path),
        ]
        completed = subprocess.run(sequence_command, capture_output=True, text=True, timeout=600)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip()[-1200:] or "ffmpeg 合成序列失败。")
        sequence_url = _export_url(sequence_path)
        saved_path = str(_copy_sequence_to_destination(sequence_path, video_id, video["title"], destination, destination_dir, filename))

    with get_connection() as conn:
        conn.execute("UPDATE videos SET status = 'exported', updated_at = ? WHERE id = ?", (now_iso(), video_id))

    duration_note = f"（{int(target_duration_seconds)} 秒版本）" if target_duration_seconds > 0 else ""
    approved_only = _normalized_clip_status_filter(clip_status_filter) == "approved"
    message = f"已导出 {len(exported)} 个{'已确认且' if approved_only else ''}带中文字幕的片段视频，并生成合成序列{duration_note}。"
    if burned_subtitle_count < len(exported):
        message = f"已导出 {len(exported)} 个{'已确认' if approved_only else ''}片段视频，其中 {burned_subtitle_count} 个已烧录中文字幕，并生成合成序列{duration_note}。"

    return {
        "message": message,
        "export_dir": str(output_dir),
        "sequence_path": str(sequence_path) if sequence_path else "",
        "sequence_url": sequence_url,
        "saved_path": saved_path,
        "target_duration_seconds": target_duration_seconds,
        "clip_status_filter": _normalized_clip_status_filter(clip_status_filter),
        "rendered_duration_seconds": round(rendered_duration_seconds, 3),
        "output_profile": render_options["output_profile"],
        "output_width": video_width,
        "output_height": video_height,
        "fit_mode": render_options["fit_mode"],
        "focus_x": render_options["focus_x"],
        "subtitle_style": render_options["subtitle_style"],
        "subtitle_position": render_options["subtitle_position"],
        "logo_asset_id": render_options["logo_asset_id"],
        "logo_position": render_options["logo_position"],
        "clips": exported,
    }


def default_save_dir(destination: str = "downloads") -> Path:
    home = Path.home()
    if destination == "desktop":
        return home / "Desktop" / "Topic Workbench Clips"
    return home / "Downloads" / "Topic Workbench Clips"


def _copy_sequence_to_destination(sequence_path: Path, video_id: int, title: str, destination: str, output_dir: Path | str, filename: str) -> Path:
    save_dir = Path(output_dir).expanduser() if destination == "custom" and str(output_dir).strip() else default_save_dir(destination)
    save_dir.mkdir(parents=True, exist_ok=True)
    safe_filename = _safe_filename(filename) if filename.strip() else _default_sequence_filename(video_id, title)
    if not safe_filename.lower().endswith(".mp4"):
        safe_filename = f"{safe_filename}.mp4"
    target = _dedupe_path(save_dir / safe_filename)
    shutil.copy2(sequence_path, target)
    return target


def _default_sequence_filename(video_id: int, title: str) -> str:
    date_slug = datetime.now().strftime("%Y%m%d-%H%M")
    title_slug = _safe_filename(title)[:48] or f"video-{video_id}"
    return f"{title_slug}-剪辑序列-{date_slug}.mp4"


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "-", value.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:96] or "clip-sequence"


def _dedupe_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    for index in range(2, 1000):
        candidate = path.with_name(f"{stem}-{index}{suffix}")
        if not candidate.exists():
            return candidate
    return path.with_name(f"{stem}-{datetime.now().strftime('%H%M%S')}{suffix}")


def _plan_export_marks(marks: list[dict], target_duration_seconds: float = 0) -> list[dict]:
    if target_duration_seconds <= 0:
        return [dict(mark) for mark in marks]
    remaining = float(target_duration_seconds)
    planned: list[dict] = []
    for mark in marks:
        start = max(float(mark["start_seconds"]), 0)
        end = max(float(mark["end_seconds"]), start)
        duration = end - start
        if duration <= 0:
            continue
        if remaining <= 0.1:
            break
        planned_mark = dict(mark)
        planned_duration = min(duration, remaining)
        planned_mark["start_seconds"] = start
        planned_mark["end_seconds"] = start + planned_duration
        planned.append(planned_mark)
        remaining -= planned_duration
    return planned


def _filter_export_marks(marks: list[dict], clip_status_filter: str = "all") -> list[dict]:
    normalized = _normalized_clip_status_filter(clip_status_filter)
    if normalized == "all":
        return [dict(mark) for mark in marks]
    return [dict(mark) for mark in marks if mark.get("status") == "approved"]


def _normalized_clip_status_filter(value: str) -> str:
    normalized = (value or "all").strip().lower()
    if normalized in {"", "all"}:
        return "all"
    if normalized == "approved":
        return "approved"
    raise ValueError("无效导出范围。")


def _clip_subtitle_segments(transcripts: list[dict], start: float, end: float) -> list[dict]:
    segments = []
    for transcript in transcripts:
        segment_start = max(float(transcript["start_seconds"]), start)
        segment_end = min(float(transcript["end_seconds"]), end)
        text = (transcript.get("text") or "").strip()
        if not text or segment_end <= segment_start:
            continue
        segments.append(
            {
                "start_seconds": segment_start - start,
                "end_seconds": segment_end - start,
                "text": text,
            }
        )
    return segments


def _compact_subtitle_segments(segments: list[dict]) -> list[dict]:
    compacted: list[dict] = []
    for segment in segments:
        start = float(segment["start_seconds"])
        end = float(segment["end_seconds"])
        text = re.sub(r"\s+", " ", (segment.get("text") or "").strip())
        if not text or end - start < 0.35:
            continue
        if compacted and compacted[-1]["text"] == text and start <= float(compacted[-1]["end_seconds"]) + 0.4:
            compacted[-1]["end_seconds"] = max(float(compacted[-1]["end_seconds"]), end)
            continue
        compacted.append({"start_seconds": start, "end_seconds": end, "text": text})
    return compacted


def _build_filter_plan(
    *,
    frame_filter: str,
    logo_path: Path | None,
    logo_position: str,
    output_dir: Path,
    output_height: int,
    output_width: int,
    subtitle_mode: str,
    subtitle_path: Path | None,
    subtitle_position: str,
    subtitle_segments: list[dict],
    subtitle_style: str,
    clip_index: int,
) -> tuple[list[str], str]:
    inputs: list[str] = []
    filters: list[str] = []
    current_label = "[0:v]"
    stage = 0

    def next_stage() -> str:
        nonlocal stage
        stage += 1
        return f"[vstage{stage}]"

    base_filters = [frame_filter] if frame_filter else []
    if subtitle_path and subtitle_mode == "subtitles_filter":
        base_filters.append(_subtitle_filter(subtitle_path, output_width, output_height, subtitle_style, subtitle_position))
    if base_filters:
        output_label = next_stage()
        filters.append(f"{current_label}{','.join(base_filters)}{output_label}")
        current_label = output_label

    input_index = 1
    if logo_path:
        inputs.extend(["-loop", "1", "-i", str(logo_path)])
        logo_label = f"[logo{clip_index}]"
        logo_width = max(72, round(output_width * 0.14))
        filters.append(f"[{input_index}:v]format=rgba,scale={logo_width}:-1{logo_label}")
        input_index += 1
        output_label = next_stage()
        margin = max(24, round(min(output_width, output_height) * 0.035))
        overlay_x, overlay_y = logo_overlay_position(logo_position, margin)
        filters.append(f"{current_label}{logo_label}overlay={overlay_x}:{overlay_y}:format=auto{output_label}")
        current_label = output_label

    if subtitle_mode == "image_overlay" and subtitle_segments:
        images, strip_height = _render_subtitle_images(subtitle_segments, output_dir, clip_index, output_width, output_height, subtitle_style)
        overlay_y = max(0, output_height - strip_height - subtitle_margin(output_height, subtitle_position))
        for image_path, start, end in images:
            inputs.extend(["-loop", "1", "-i", str(image_path)])
            output_label = next_stage()
            filters.append(f"{current_label}[{input_index}:v]overlay=0:{overlay_y}:enable='between(t,{start:.3f},{end:.3f})'{output_label}")
            current_label = output_label
            input_index += 1

    if current_label == "[0:v]":
        return inputs, ""
    filters.append(f"{current_label}null[vout]")
    return inputs, ";".join(filters)


def _subtitle_filter(path: Path, width: int = 1280, height: int = 720, subtitle_style: str = "standard", subtitle_position: str = "bottom") -> str:
    style = subtitle_force_style(width, height, subtitle_style, subtitle_position)
    return f"subtitles=filename='{_escape_filter_path(path)}':charenc=UTF-8:force_style='{style}'"


def _render_subtitle_images(
    segments: list[dict],
    output_dir: Path,
    clip_index: int,
    video_width: int,
    video_height: int,
    subtitle_style: str,
) -> tuple[list[tuple[Path, float, float]], int]:
    layer_dir = output_dir / "subtitle_layers"
    layer_dir.mkdir(parents=True, exist_ok=True)
    strip_height = max(132, min(320, int(video_height * 0.18)))
    images: list[tuple[Path, float, float]] = []
    for index, segment in enumerate(segments, start=1):
        image_path = layer_dir / f"{clip_index:02d}-{index:03d}.png"
        _render_subtitle_image(segment["text"], image_path, video_width, strip_height, subtitle_style)
        start = max(float(segment["start_seconds"]), 0)
        end = max(float(segment["end_seconds"]), start + 0.1)
        images.append((image_path, start, end))
    return images, strip_height


def _render_subtitle_image(text: str, path: Path, width: int, height: int, subtitle_style: str = "standard") -> None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as exc:
        raise RuntimeError("缺少 Pillow，无法生成字幕图层。请先安装后端依赖。") from exc

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font_size = max(28, min(58, width // 42))
    if subtitle_style == "bold":
        font_size = round(font_size * 1.14)
    font = _load_subtitle_font(ImageFont, font_size)
    lines = _wrap_text(draw, text, font, width - 160, max_lines=2)
    text_box = [draw.textbbox((0, 0), line, font=font, stroke_width=2) for line in lines]
    line_height = max((box[3] - box[1] for box in text_box), default=34) + 8
    block_height = line_height * len(lines)
    block_width = min(width - 72, max((box[2] - box[0] for box in text_box), default=0) + 56)
    x = (width - block_width) // 2
    y = max(10, height - block_height - 30)
    if subtitle_style != "minimal":
        alpha = 178 if subtitle_style == "bold" else 150
        draw.rounded_rectangle((x, y - 12, x + block_width, y + block_height + 10), radius=16, fill=(0, 0, 0, alpha))
    for line_index, line in enumerate(lines):
        box = draw.textbbox((0, 0), line, font=font, stroke_width=2)
        line_x = (width - (box[2] - box[0])) // 2
        draw.text((line_x, y + line_index * line_height), line, font=font, fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 210))
    image.save(path)


def _load_subtitle_font(image_font: object, size: int):
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            try:
                return image_font.truetype(candidate, size=size)
            except OSError:
                continue
    return image_font.load_default()


def _wrap_text(draw: object, text: str, font: object, max_width: int, max_lines: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for char in text:
        candidate = f"{current}{char}"
        box = draw.textbbox((0, 0), candidate, font=font, stroke_width=2)
        if current and box[2] - box[0] > max_width:
            lines.append(current)
            current = char
            if len(lines) == max_lines:
                break
        else:
            current = candidate
    if len(lines) < max_lines and current:
        lines.append(current)
    if len(lines) == max_lines and len("".join(lines)) < len(text):
        lines[-1] = f"{lines[-1].rstrip('。,.， ')}..."
    return lines or [text[:24]]


def _ffmpeg_filters(ffmpeg: str) -> set[str]:
    completed = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=20)
    if completed.returncode != 0:
        return set()
    filters: set[str] = set()
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            filters.add(parts[1])
    return filters


def _probe_video_size(source: Path) -> tuple[int, int]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 1280, 720
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            str(source),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        return 1280, 720
    try:
        width, height = completed.stdout.strip().split("x", 1)
        return max(int(width), 320), max(int(height), 180)
    except ValueError:
        return 1280, 720


def _escape_filter_path(path: Path) -> str:
    return path.as_posix().replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _slugify(value: str) -> str:
    normalized = re.sub(r"\s+", "-", value.strip().lower())
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff._-]+", "", normalized)
    return normalized[:36] or "clip"


def _time_slug(seconds: float) -> str:
    total = int(seconds)
    minutes = total // 60
    secs = total % 60
    return f"{minutes:02d}m{secs:02d}s"


def _rendition_slug(options: dict) -> str:
    focus = round(float(options["focus_x"]))
    logo = f"-logo{options['logo_asset_id']}-{options['logo_position']}" if options.get("logo_asset_id") else ""
    return (
        f"{options['output_profile']}-{options['fit_mode']}-f{focus}-"
        f"{options['subtitle_style']}-{options['subtitle_position']}{logo}"
    )


def _export_url(path: Path) -> str:
    relative = path.relative_to(settings.export_dir)
    return f"/media/exports/{relative.as_posix()}"
