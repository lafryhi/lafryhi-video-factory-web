from __future__ import annotations

import os
import logging
import math
from pathlib import Path
import subprocess
import threading
from dataclasses import replace
from typing import Callable

from PIL import Image

from core.ffmpeg_motion_filter_builder import FFmpegMotionFilterBuilder
from core.scene_motion_settings import SceneMotionSettings, SceneRenderResult, VideoRenderSettings
from core.frame_timing import frames_for_duration
from core.process_utils import shutdown_process


LOGGER = logging.getLogger(__name__)


class SceneMotionError(RuntimeError):
    pass


class SceneMotionCancelled(SceneMotionError):
    pass


class SceneMotionCell:
    def __init__(self, ffmpeg_path: str | Path) -> None:
        self.ffmpeg_path = Path(ffmpeg_path)

    def render(
        self,
        settings: SceneMotionSettings,
        video_settings: VideoRenderSettings,
        output_path: str | Path,
        progress: Callable[[float], None] | None = None,
        cancel_event: threading.Event | None = None,
        log: Callable[[str], None] | None = None,
        process_callback: Callable[[subprocess.Popen[str] | None], None] | None = None,
    ) -> SceneRenderResult:
        self.validate(settings, video_settings, output_path)
        frames = frames_for_duration(settings.duration_seconds, video_settings.fps)
        return self.render_frames(
            settings, frames, video_settings.fps, video_settings, output_path,
            progress, cancel_event, log, process_callback,
        )

    def render_frames(
        self,
        settings: SceneMotionSettings,
        frame_count: int,
        fps: int,
        video_settings: VideoRenderSettings,
        output_path: str | Path,
        progress: Callable[[float], None] | None = None,
        cancel_event: threading.Event | None = None,
        log: Callable[[str], None] | None = None,
        process_callback: Callable[[subprocess.Popen[str] | None], None] | None = None,
    ) -> SceneRenderResult:
        if frame_count < 1:
            raise SceneMotionError("Scene frame count must be at least one.")
        if fps != video_settings.fps:
            raise SceneMotionError("Scene frame allocation FPS does not match video settings.")
        duration = frame_count / fps
        transition_duration = settings.transition_duration_seconds
        if settings.transition.casefold() == "fade" and transition_duration >= duration:
            transition_duration = duration / 2
        effective = replace(
            settings, duration_seconds=duration,
            transition_duration_seconds=transition_duration,
        )
        self.validate(effective, video_settings, output_path)
        if cancel_event and cancel_event.is_set():
            raise SceneMotionCancelled("Scene motion rendering was cancelled.")
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        frames = frame_count
        duration = frames / fps
        # Ordinary Fade is a transition intent, not a per-scene fade-to-black.
        # The current renderer concatenates scenes without overlap.
        filters = FFmpegMotionFilterBuilder.build(
            effective, video_settings, include_fade=False, frame_count=frames,
        )
        cmd = [str(self.ffmpeg_path), "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
               "-loop", "1", "-framerate", str(video_settings.fps), "-i", str(settings.image_path),
               "-filter_threads", "1", "-vf", filters, "-frames:v", str(frames), "-an", "-c:v", "libx264", "-fps_mode", "cfr", "-preset", "veryfast", "-threads", "1",
               "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target)]
        if settings.extra_fields.get("mediaType") == "video":
            from ai_editor.ffmpeg_builder import video_filter
            from ai_editor.models import Video, SubtitleStyle
            from ai_editor.subtitles import ass
            options = Video.model_validate(settings.extra_fields.get("aiVideo", {}))
            filters = video_filter(video_settings.width, video_settings.height, fps, options.colorPreset, options.cropMode)
            filters += f",tpad=stop_mode=clone:stop_duration={1/fps:.6f},trim=end_frame={frames},setpts=PTS-STARTPTS"
            texts = settings.extra_fields.get("texts", [])
            if texts:
                subtitle_path = target.with_suffix(".ass")
                cues = [(max(0, float(t.get("startSeconds", 0))), min(duration, float(t.get("endSeconds") or duration)), str(t.get("text", ""))) for t in texts]
                subtitle_path.write_text(ass(cues, SubtitleStyle.model_validate(settings.extra_fields.get("subtitleStyle", {})), video_settings.width, video_settings.height), encoding="utf-8")
                escaped = str(subtitle_path.resolve()).replace("\\", "/").replace(":", "\\:").replace("'", "'\\''")
                filters += f",subtitles=filename='{escaped}'"
            cmd = [str(self.ffmpeg_path), "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-ss", str(settings.extra_fields.get("sourceStartSeconds", 0)), "-i", str(settings.image_path), "-filter_threads", "1", "-vf", filters, "-frames:v", str(frames), "-an", "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(fps), str(target)]
        if log:
            log(f"Scene Motion FFmpeg: {subprocess.list2cmdline(cmd)}")
        process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if process_callback:
            process_callback(process)
        stderr_lines: list[str] = []
        assert process.stdout is not None and process.stderr is not None
        stderr_thread = threading.Thread(target=lambda: stderr_lines.extend(line.rstrip() for line in process.stderr), daemon=True)
        stderr_thread.start()
        render_succeeded = False
        try:
            for line in process.stdout:
                if cancel_event and cancel_event.is_set():
                    shutdown_process(process, log=log)
                    raise SceneMotionCancelled("Scene motion rendering was cancelled.")
                if line.startswith("frame=") and progress:
                    progress(min(100.0, int(line.split("=", 1)[1]) / frames * 100.0))
            code = process.wait()
            stderr_thread.join(timeout=2)
            if cancel_event and cancel_event.is_set():
                raise SceneMotionCancelled("Scene motion rendering was cancelled.")
            if code != 0:
                detail = "\n".join(stderr_lines)[-4000:] or "FFmpeg did not provide error details."
                if log:
                    log(detail)
                raise SceneMotionError(f"FFmpeg could not render the scene:\n{detail}")
            if not target.is_file() or target.stat().st_size == 0:
                raise SceneMotionError("FFmpeg finished without creating a scene video.")
            if progress:
                progress(100.0)
            render_succeeded = True
            return SceneRenderResult(target, duration, frames)
        finally:
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
            if process_callback:
                process_callback(None)
            if process.poll() is None:
                shutdown_process(process, log=log)
            if target.exists() and not render_succeeded:
                try:
                    target.unlink()
                except OSError as exc:
                    if log:
                        log(f"Cleanup failed for preview output '{target}': {exc}")
                    LOGGER.warning("Unable to remove partial scene output %s", target, exc_info=True)

    @staticmethod
    def validate(settings: SceneMotionSettings, video: VideoRenderSettings, output_path: str | Path) -> None:
        if not settings.image_path.is_file():
            raise SceneMotionError(f"Image file does not exist: {settings.image_path}")
        if settings.extra_fields.get("mediaType") != "video":
            try:
                with Image.open(settings.image_path) as image:
                    image.verify()
            except Exception as exc:
                raise SceneMotionError(f"Image is invalid or unsupported: {settings.image_path}") from exc
        if not math.isfinite(settings.duration_seconds) or settings.duration_seconds <= 0:
            raise SceneMotionError("Scene duration must be a finite number greater than zero.")
        if video.fps <= 0 or video.fps > 240:
            raise SceneMotionError("FPS must be between 1 and 240.")
        if video.width <= 0 or video.height <= 0 or video.width % 2 or video.height % 2:
            raise SceneMotionError("Resolution must contain positive, even dimensions.")
        if not (1.0 <= settings.start_zoom <= 4.0 and 1.0 <= settings.end_zoom <= 4.0):
            raise SceneMotionError("Start and end zoom must be between 1.0 and 4.0.")
        if not (0.0 <= settings.motion_intensity <= 1.0):
            raise SceneMotionError("Motion intensity must be between 0.0 and 1.0.")
        if settings.transition_duration_seconds < 0 or settings.transition_duration_seconds >= settings.duration_seconds:
            raise SceneMotionError("Transition duration must be non-negative and shorter than the scene duration.")
        parent = Path(output_path).parent
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SceneMotionError(f"Output directory cannot be created: {parent}") from exc
