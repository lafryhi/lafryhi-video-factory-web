from __future__ import annotations

from array import array
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import wave

from PIL import Image, ImageDraw

from core.audio_timing_settings import AudioTimingSettings
from core.project_file_service import ProjectFileService
from core.project_model import ProjectSettings, VideoFormat
from core.runtime_paths import IS_FROZEN
from core.scene_motion_cell import SceneMotionCell
from core.scene_motion_settings import MotionPreset, SceneMotionSettings
from core.scene_motion_settings import VideoRenderSettings
from core.scene_preview_service import ScenePreviewService
from core.video_engine import render_project, resolve_ffmpeg_exe


def _write_test_image(path: Path) -> None:
    image = Image.new("RGB", (960, 540), "#101a36")
    draw = ImageDraw.Draw(image)
    draw.rectangle((80, 70, 880, 470), outline="#2979ff", width=18)
    draw.text((240, 245), "LAFRYHI VIDEO FACTORY", fill="white")
    image.save(path, quality=92)


def _write_test_audio(path: Path, duration: float = 1.0) -> None:
    sample_rate = 44_100
    samples = array(
        "h",
        (
            int(4_000 * math.sin(2.0 * math.pi * 440.0 * index / sample_rate))
            for index in range(round(sample_rate * duration))
        ),
    )
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())


def _inspect_video_with_ffmpeg(ffmpeg: Path, video_path: Path) -> dict[str, object]:
    """Inspect one decoded frame without requiring a separate FFprobe binary."""
    result = subprocess.run(
        [
            str(ffmpeg), "-hide_banner", "-i", str(video_path), "-map", "0:v:0",
            "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-",
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    codec_name = ""
    for line in result.stderr.splitlines():
        match = re.search(r"Stream #.*Video:\s*([^,\s]+)", line)
        if match:
            codec_name = match.group(1)
            break
    frame = re.search(r"fmt:(\S+).*?s:(\d+)x(\d+)", result.stderr)
    if frame is None:
        raise RuntimeError("FFmpeg did not report decoded frame dimensions.")
    return {
        "width": int(frame.group(2)),
        "height": int(frame.group(3)),
        "codec_name": codec_name,
        "pix_fmt": frame.group(1),
    }


def run_bundle_smoke(report_path: str | Path) -> int:
    """Exercise the frozen resource paths and a real vertical H.264 export."""
    report = Path(report_path).resolve()
    work = report.parent / "artifacts"
    images = work / "images"
    output = work / "output"
    images.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    image_path = images / "01.jpg"
    voice_path = work / "voice.wav"
    _write_test_image(image_path)
    _write_test_audio(voice_path)

    ffmpeg = resolve_ffmpeg_exe()
    logs: list[str] = []
    scene = SceneMotionSettings(
        image_path=image_path,
        duration_seconds=1.0,
        motion=MotionPreset.ZOOM_IN,
        transition="none",
        transition_duration_seconds=0.0,
    )
    settings = ProjectSettings(
        images_folder=images,
        voice_file=voice_path,
        output_folder=output,
        output_name=f"exe_vertical_smoke_{os.getpid()}.mp4",
        resolution=VideoFormat.VERTICAL_9_16.resolution,
        fps=25,
        fill_mode="Fit with blurred background",
        minimum_scene_duration=0.1,
        scenes=[scene],
        audio_timing_settings=AudioTimingSettings(minimum_scene_seconds=0.1),
        video_format=VideoFormat.VERTICAL_9_16,
    )

    try:
        project_path = ProjectFileService.save(work / "vertical_smoke.lvf.json", settings)
        preview_service = ScenePreviewService(SceneMotionCell(ffmpeg))
        try:
            preview_result = preview_service.render(
                scene,
                VideoRenderSettings(width=1080, height=1920, fps=25),
                cancel_event=threading.Event(),
                log=logs.append,
                fill_mode=settings.fill_mode,
                frame_count=25,
            )
            preview_path = work / "vertical_motion_preview.mp4"
            shutil.copy2(preview_result.output_path, preview_path)
        finally:
            preview_service.cleanup(logs.append)
        video_path = render_project(
            settings,
            lambda percent, stage: logs.append(f"{percent:.1f}% {stage}"),
            logs.append,
            threading.Event(),
        )
        stream = _inspect_video_with_ffmpeg(ffmpeg, video_path)
        success = (
            stream.get("width") == 1080
            and stream.get("height") == 1920
            and stream.get("codec_name") == "h264"
        )
        payload = {
            "success": success,
            "frozen": IS_FROZEN,
            "ffmpeg": str(ffmpeg),
            "project": str(project_path),
            "preview": str(preview_path),
            "previewBytes": preview_path.stat().st_size,
            "video": str(video_path),
            "videoBytes": video_path.stat().st_size,
            "stream": stream,
            "logs": logs,
        }
        exit_code = 0 if success and IS_FROZEN else 2
    except Exception as exc:
        payload = {
            "success": False,
            "frozen": IS_FROZEN,
            "ffmpeg": str(ffmpeg),
            "error": f"{type(exc).__name__}: {exc}",
            "logs": logs,
        }
        exit_code = 1

    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return exit_code
