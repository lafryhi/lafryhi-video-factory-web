from __future__ import annotations

from pathlib import Path
import logging
from dataclasses import replace
import shutil
import tempfile
import threading
import subprocess
import time
from typing import Callable

from core.scene_motion_cell import SceneMotionCell
from core.scene_motion_settings import SceneMotionSettings, SceneRenderResult, VideoRenderSettings
from core.image_utils import build_scene_frame_image
from core.scene_motion_cell import SceneMotionError
from core.narration_mapping_models import ResolvedNarrationClip
from core.process_utils import shutdown_process


LOGGER = logging.getLogger(__name__)


class ScenePreviewService:
    """Owns temporary preview output and removes earlier previews safely."""

    MAX_PENDING_DIRECTORIES = 32

    def __init__(self, cell: SceneMotionCell) -> None:
        self.cell = cell
        self._directory: Path | None = None
        self._pending_cleanup: set[Path] = set()

    @staticmethod
    def prepare_input(
        settings: SceneMotionSettings,
        video_settings: VideoRenderSettings,
        fill_mode: str,
        output_path: Path,
    ) -> SceneMotionSettings:
        frame = build_scene_frame_image(
            settings.image_path, (video_settings.width, video_settings.height), fill_mode,
            settings.extra_fields.get("crop"),
        )
        frame.save(output_path)
        return replace(settings, image_path=output_path)

    def render(
        self,
        settings: SceneMotionSettings,
        video_settings: VideoRenderSettings,
        progress: Callable[[float], None] | None = None,
        cancel_event: threading.Event | None = None,
        log: Callable[[str], None] | None = None,
        process_callback=None,
        fill_mode: str = "Crop",
        frame_count: int | None = None,
        narration_clip: ResolvedNarrationClip | None = None,
    ) -> SceneRenderResult:
        self._retire_current()
        self.retry_pending_cleanup(log)
        if len(self._pending_cleanup) >= self.MAX_PENDING_DIRECTORIES:
            raise SceneMotionError(
                "Too many locked preview directories are awaiting cleanup. Close the preview player and try again."
            )
        self._directory = Path(tempfile.mkdtemp(prefix="lafryhi_scene_preview_"))
        preview = self._directory / "motion_preview.mp4"
        visual_preview = self._directory / "motion_silent.mp4" if narration_clip and narration_clip.has_audio else preview
        prepared = self.prepare_input(settings, video_settings, fill_mode, self._directory / "prepared_frame.png")
        try:
            if frame_count is None:
                result = self.cell.render(
                    prepared, video_settings, visual_preview, progress, cancel_event, log, process_callback
                )
            else:
                result = self.cell.render_frames(
                    prepared, frame_count, video_settings.fps, video_settings, visual_preview,
                    progress, cancel_event, log, process_callback,
                )
            if narration_clip and narration_clip.has_audio:
                result = self._mux_narration(
                    result, preview, narration_clip, video_settings.fps,
                    cancel_event, log, process_callback,
                )
            self.retry_pending_cleanup(log)
            return result
        except Exception:
            self._retire_current()
            self.retry_pending_cleanup(log)
            raise

    def _mux_narration(
        self, visual_result: SceneRenderResult, output: Path, clip: ResolvedNarrationClip,
        fps: int, cancel_event: threading.Event | None, log: Callable[[str], None] | None,
        process_callback,
    ) -> SceneRenderResult:
        duration = clip.frame_count / fps
        end = f":end={clip.trim_end_seconds:.9f}" if clip.trim_end_seconds is not None else ""
        delay_ms = int(round(clip.leading_padding_seconds * 1000))
        audio_filter = (
            f"atrim=start={clip.trim_start_seconds:.9f}{end},asetpts=PTS-STARTPTS,"
            f"adelay={delay_ms}:all=1,aresample=48000,apad,atrim=0:{duration:.9f}"
        )
        command = [
            str(self.cell.ffmpeg_path), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(visual_result.output_path), "-i", str(clip.audio_path),
            "-map", "0:v:0", "-map", "1:a:0", "-af", audio_filter,
            "-c:v", "copy", "-c:a", "aac", "-t", f"{duration:.9f}", str(output),
        ]
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if __import__("os").name == "nt" else 0,
        )
        if process_callback:
            process_callback(process)
        try:
            while process.poll() is None:
                if cancel_event and cancel_event.is_set():
                    shutdown_process(process, log=log)
                    raise SceneMotionError("Scene preview narration was cancelled.")
                time.sleep(.05)
            stderr = process.stderr.read() if process.stderr else ""
            if process.returncode != 0:
                raise SceneMotionError(f"Unable to add scene narration to preview:\n{stderr[-2000:]}")
            return SceneRenderResult(output, duration, clip.frame_count)
        finally:
            if process_callback:
                process_callback(None)
            if process.stderr:
                process.stderr.close()

    def cleanup(self, log: Callable[[str], None] | None = None) -> None:
        self._retire_current()
        self.retry_pending_cleanup(log)

    def _retire_current(self) -> None:
        if self._directory is not None:
            self._pending_cleanup.add(self._directory)
            self._directory = None

    def retry_pending_cleanup(self, log: Callable[[str], None] | None = None) -> None:
        for directory in tuple(self._pending_cleanup):
            if not directory.exists():
                self._pending_cleanup.discard(directory)
                continue
            try:
                shutil.rmtree(directory)
            except OSError as exc:
                if log:
                    log(f"Cleanup failed for preview directory '{directory}'; it will be retried: {exc}")
                LOGGER.warning("Unable to remove preview directory %s", directory, exc_info=True)
            else:
                self._pending_cleanup.discard(directory)
