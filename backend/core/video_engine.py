from __future__ import annotations

from datetime import datetime
from dataclasses import replace
import logging
import os
import queue
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
from pathlib import Path
from pathlib import PureWindowsPath
from typing import Callable

import imageio_ffmpeg
from PIL import Image

from core.image_utils import build_scene_frame_image, list_image_files
from core.project_model import ProjectSettings, ScenePlan, format_duration
from core.ffmpeg_motion_filter_builder import FFmpegMotionFilterBuilder
from core.scene_motion_settings import MotionPreset, SceneMotionSettings, VideoRenderSettings
from core.scene_motion_cell import SceneMotionCell
from core.process_utils import shutdown_process
from core.audio_analysis_service import AudioAnalysisService
from core.audio_sync_cell import AudioSyncCell
from core.audio_utils import get_audio_duration
from core.timeline_models import ResolvedTimeline
from core.timeline_planning_service import (
    TimelinePlanningCancelled, TimelinePlanningError, TimelinePlanningService,
)
from core.audio_timing_settings import AudioTimingMode
from core.narration_mapping_models import ResolvedNarrationClip
from core.runtime_paths import app_path, resource_path


TOOLS_FFMPEG_DIR = resource_path("tools", "ffmpeg")
LOGGER = logging.getLogger(__name__)

RenderCallback = Callable[[float, str], None]
LogCallback = Callable[[str], None]
ProcessCallback = Callable[[subprocess.Popen[str] | None], None]


class RenderCancelled(RuntimeError):
    pass


class RenderError(RuntimeError):
    pass


def log_exception(message: str, exc: BaseException) -> None:
    error_dir = app_path("logs")
    error_dir.mkdir(parents=True, exist_ok=True)
    error_path = error_dir / "error.log"
    with error_path.open("a", encoding="utf-8") as handle:
        handle.write(f"{message}\n")
        handle.write("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        handle.write("\n")


def _format_command_for_log(cmd: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(cmd)
    return shlex.join(cmd)


def _terminate_process(process: subprocess.Popen[str]) -> None:
    shutdown_process(process)


def _parse_ffmpeg_time(value: str) -> float:
    hours_text, minutes_text, seconds_text = value.split(":")
    return (int(hours_text) * 3600) + (int(minutes_text) * 60) + float(seconds_text)


def _scene_label_for_elapsed(
    elapsed_seconds: float,
    plans: list[ScenePlan] | None,
    transition_duration: float,
) -> str | None:
    if not plans:
        return None

    if len(plans) == 1:
        index = 0
    else:
        scene_span = max(0.01, plans[0].duration)
        index = min(int(max(0.0, elapsed_seconds) / scene_span), len(plans) - 1)

    return f"Scene {index + 1}/{len(plans)}: {plans[index].source_path.name}"


def _run_ffmpeg_command(
    cmd: list[str],
    *,
    total_duration: float | None,
    progress_cb: RenderCallback,
    log_cb: LogCallback,
    cancel_event: threading.Event,
    stage_label: str,
    progress_start: float,
    progress_end: float,
    scene_plans: list[ScenePlan] | None = None,
    transition_duration: float = 0.0,
    process_cb: ProcessCallback | None = None,
) -> tuple[int, str]:
    command_text = _format_command_for_log(cmd)
    start_time = datetime.now()
    LOGGER.info("%s command: %s", stage_label, command_text)
    LOGGER.info("%s output started at: %s", stage_label, start_time.isoformat(timespec="seconds"))
    log_cb(f"{stage_label} command: {command_text}")
    log_cb(f"{stage_label} output started at: {start_time.isoformat(timespec='seconds')}")

    process = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if process_cb is not None:
        process_cb(process)

    LOGGER.info("%s PID: %s", stage_label, process.pid)
    log_cb(f"{stage_label} PID: {process.pid}")

    line_queue: queue.Queue[tuple[str, str | None]] = queue.Queue()
    stderr_lines: list[str] = []

    def _read_stdout() -> None:
        assert process.stdout is not None
        for raw_line in iter(process.stdout.readline, ""):
            line_queue.put(("stdout", raw_line))
        line_queue.put(("stdout_eof", None))

    def _read_stderr() -> None:
        assert process.stderr is not None
        for raw_line in iter(process.stderr.readline, ""):
            line = raw_line.rstrip()
            if not line:
                continue
            stderr_lines.append(line)
            LOGGER.error("[ffmpeg] %s", line)
            log_cb(f"[ffmpeg] {line}")
        line_queue.put(("stderr_eof", None))

    stdout_thread = threading.Thread(target=_read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    stdout_done = False
    stderr_done = False
    last_progress = progress_start - 1.0
    last_scene_label: str | None = None

    try:
        while True:
            if cancel_event.is_set():
                log_cb("Cancellation requested, terminating FFmpeg")
                LOGGER.info("%s cancellation requested", stage_label)
                _terminate_process(process)
                raise RenderCancelled("Rendering was cancelled.")

            try:
                kind, payload = line_queue.get(timeout=0.2)
            except queue.Empty:
                if process.poll() is not None and stdout_done and stderr_done:
                    break
                continue

            if kind == "stdout":
                line = (payload or "").strip()
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key in {"out_time_ms", "out_time"} and total_duration:
                    try:
                        elapsed_seconds = (
                            int(value) / 1_000_000.0
                            if key == "out_time_ms"
                            else _parse_ffmpeg_time(value)
                        )
                    except ValueError:
                        continue

                    ratio = min(max(elapsed_seconds / max(total_duration, 0.01), 0.0), 1.0)
                    percent = progress_start + ratio * (progress_end - progress_start)
                    scene_label = _scene_label_for_elapsed(elapsed_seconds, scene_plans, transition_duration)
                    if scene_label and scene_label != last_scene_label:
                        last_scene_label = scene_label
                        log_cb(f"{stage_label} scene: {scene_label}")
                    if percent >= last_progress + 0.2 or percent >= progress_end:
                        last_progress = percent
                        progress_cb(min(percent, progress_end), "Rendering video")
                elif key == "progress" and value == "end":
                    progress_cb(progress_end, "Finalizing MP4")
            elif kind == "stdout_eof":
                stdout_done = True
            elif kind == "stderr_eof":
                stderr_done = True

            if process.poll() is not None and stdout_done and stderr_done:
                break

        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)

        return_code = process.wait()
        if cancel_event.is_set():
            raise RenderCancelled("Rendering was cancelled.")
        end_time = datetime.now()
        LOGGER.info("%s output finished at: %s", stage_label, end_time.isoformat(timespec="seconds"))
        LOGGER.info("%s return code: %s", stage_label, return_code)
        log_cb(f"{stage_label} output finished at: {end_time.isoformat(timespec='seconds')}")
        log_cb(f"{stage_label} return code: {return_code}")
        return return_code, "\n".join(stderr_lines)
    finally:
        if process_cb is not None:
            process_cb(None)


def _media_tool_name(tool: str, platform: str | None = None) -> str:
    active_platform = sys.platform if platform is None else platform
    return f"{tool}.exe" if active_platform.startswith("win") else tool


def _is_compatible_media_tool(path: Path, platform: str | None = None) -> bool:
    active_platform = sys.platform if platform is None else platform
    if not path.is_file():
        return False
    if active_platform.startswith("win"):
        return path.suffix.casefold() == ".exe"
    return path.suffix.casefold() != ".exe" and os.access(path, os.X_OK)


def _portable_media_tool_candidates(tool: str) -> list[Path]:
    executable_name = _media_tool_name(tool)
    candidates = [
        TOOLS_FFMPEG_DIR / executable_name,
        app_path("tools", "ffmpeg", executable_name),
    ]
    # PyInstaller hooks and portable distributions can preserve a versioned
    # binary name (for example, ffmpeg-macos-x86_64-v7.1). Accept that name
    # only after the canonical platform-specific locations above.
    for directory in (TOOLS_FFMPEG_DIR, app_path("tools", "ffmpeg")):
        if directory.is_dir():
            candidates.extend(sorted(directory.glob(f"{tool}*")))

    unique: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(candidate)
    return unique


def _resolve_portable_media_tool(tool: str) -> Path | None:
    for candidate in _portable_media_tool_candidates(tool):
        if _is_compatible_media_tool(candidate):
            return candidate
    return None


def resolve_ffmpeg_exe() -> Path:
    portable = _resolve_portable_media_tool("ffmpeg")
    if portable is not None:
        return portable

    # Prefer a full system build when available. Distribution FFmpeg packages
    # include filters such as drawtext that the compact imageio binary omits.
    system_ffmpeg = shutil.which(_media_tool_name("ffmpeg"))
    if system_ffmpeg and _is_compatible_media_tool(Path(system_ffmpeg)):
        return Path(system_ffmpeg)

    # imageio-ffmpeg ships the matching Windows, macOS, or Linux executable.
    # Its PyInstaller hook also makes this work in frozen application bundles.
    try:
        cached = Path(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        LOGGER.warning("Unable to resolve imageio-ffmpeg", exc_info=True)
    else:
        if _is_compatible_media_tool(cached):
            return cached

    raise RenderError(
        "FFmpeg was not found for this operating system. Reinstall the app dependencies "
        "or place a compatible FFmpeg executable in tools/ffmpeg."
    )


def resolve_ffprobe_exe() -> Path:
    """Resolve a platform-compatible FFprobe executable when smoke testing."""
    portable = _resolve_portable_media_tool("ffprobe")
    if portable is not None:
        return portable

    system_ffprobe = shutil.which(_media_tool_name("ffprobe"))
    if system_ffprobe and _is_compatible_media_tool(Path(system_ffprobe)):
        return Path(system_ffprobe)

    raise RenderError(
        "FFprobe was not found for this operating system. Place a compatible FFprobe "
        "executable in tools/ffmpeg or install it on PATH."
    )


def validate_output_name(output_name: str) -> str:
    requested_name = output_name.strip()
    if not requested_name:
        raise RenderError("Output filename cannot be empty.")
    if Path(requested_name).is_absolute() or PureWindowsPath(requested_name).is_absolute():
        raise RenderError("Output filename must be a filename, not an absolute path.")
    if "/" in requested_name or "\\" in requested_name or requested_name in {".", ".."}:
        raise RenderError("Output filename cannot contain folders or path traversal.")
    if any(character in requested_name for character in '<>:"/\\|?*') or any(ord(character) < 32 for character in requested_name):
        raise RenderError("Output filename contains characters that are not allowed on Windows.")
    if requested_name.endswith((" ", ".")):
        raise RenderError("Output filename cannot end with a space or period.")
    candidate = Path(requested_name)
    if candidate.suffix:
        if candidate.suffix.casefold() != ".mp4":
            raise RenderError("Output filename must use the .mp4 extension.")
    else:
        requested_name += ".mp4"
        candidate = Path(requested_name)
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
    reserved_base = candidate.name.split(".", 1)[0].rstrip(" .").casefold()
    if reserved_base in reserved:
        raise RenderError("Output filename uses a reserved Windows device name.")
    return requested_name


def _resolve_output_path(output_folder: Path, output_name: str) -> Path:
    requested_name = validate_output_name(output_name)
    output_folder.mkdir(parents=True, exist_ok=True)
    resolved_folder = output_folder.resolve()
    requested_path = (resolved_folder / requested_name).resolve()
    if requested_path.parent != resolved_folder:
        raise RenderError("Output filename must remain inside the selected output folder.")
    if not requested_path.exists():
        return requested_path

    stem = requested_path.stem
    suffix = requested_path.suffix or ".mp4"
    for index in range(1, 1000):
        candidate = resolved_folder / f"{stem}_{index:02d}{suffix}"
        if not candidate.exists():
            return candidate

    raise RenderError("Unable to find a safe output filename without overwriting an existing file.")


def build_timeline_scene_plan(
    timeline: ResolvedTimeline,
    scenes: list[SceneMotionSettings],
) -> tuple[list[ScenePlan], float, float]:
    by_id = {scene.scene_id: scene for scene in scenes}
    plans: list[ScenePlan] = []
    for resolved in timeline.scenes:
        try:
            scene = by_id[resolved.scene_id]
        except KeyError as exc:
            raise RenderError(f"Timeline references unknown scene ID: {resolved.scene_id}") from exc
        effective = replace(scene, duration_seconds=resolved.duration_seconds)
        plans.append(ScenePlan(
            index=resolved.source_index + 1,
            source_path=Path(resolved.source_path),
            duration=resolved.duration_seconds,
            motion=scene.motion.display_name,
            settings=effective,
            frame_count=resolved.frame_count,
        ))
    return plans, timeline.duration_seconds, 0.0


def render_project(
    settings: ProjectSettings,
    progress_cb: RenderCallback,
    log_cb: LogCallback,
    cancel_event: threading.Event,
    process_cb: ProcessCallback | None = None,
) -> Path:
    ffmpeg_exe = resolve_ffmpeg_exe()
    images = list_image_files(settings.images_folder)
    has_video_scenes = bool(settings.scenes and any(s.extra_fields.get("mediaType") == "video" for s in settings.scenes))
    if not images and not has_video_scenes:
        raise RenderError("No images found. Select a folder that contains numbered image files.")

    scene_narration_mode = (
        settings.audio_timing_settings is not None
        and settings.audio_timing_settings.mode is AudioTimingMode.SCENE_NARRATION
    )
    has_voice = settings.voice_file.is_file()

    for label, path, start, end in (
        ("voice", settings.voice_file if has_voice else None, settings.voice_trim_start_seconds, settings.voice_trim_end_seconds),
        ("music", settings.music_file, settings.music_trim_start_seconds, settings.music_trim_end_seconds),
    ):
        if path is None:
            continue
        if not path.is_file():
            raise RenderError(f"The selected {label} audio file does not exist: {path}")
        try:
            source_duration = get_audio_duration(path)
        except Exception as exc:
            raise RenderError(f"The selected {label} audio file is unreadable or unsupported.") from exc
        effective_end = source_duration if end is None else end
        if start < 0 or start >= source_duration or effective_end <= start or effective_end > source_duration + .01:
            raise RenderError(f"The {label} trim range must stay inside its {source_duration:.2f}-second source file.")

    output_path = _resolve_output_path(settings.output_folder, settings.output_name)

    log_cb(f"Using FFmpeg at: {ffmpeg_exe}")
    log_cb(f"Output file: {output_path}")
    log_cb(f"Render started at: {datetime.now().isoformat(timespec='seconds')}")

    log_cb("Loading images")
    progress_cb(2.0, "Loading images")

    render_succeeded = False
    planning = TimelinePlanningService(AudioSyncCell(AudioAnalysisService(ffmpeg_exe)))
    try:
        timeline = planning.resolve(
            settings, cancel_event,
            lambda value: progress_cb(2.0 + value * .08, "Resolving timeline"),
        )
    except TimelinePlanningCancelled as exc:
        raise RenderCancelled(str(exc)) from exc
    except TimelinePlanningError as exc:
        raise RenderError(str(exc)) from exc
    log_cb(f"Timeline: {timeline.timeline_id}")
    log_cb(f"Timeline duration: {timeline.total_frames} frames ({timeline.duration_seconds:.3f}s)")
    for warning in timeline.warnings:
        log_cb(f"Timeline warning: {warning}")
    width, height = settings.video_dimensions
    if settings.scenes:
        video_settings = VideoRenderSettings(width=width, height=height, fps=settings.fps)
        for scene in settings.scenes:
            SceneMotionCell.validate(scene, video_settings, output_path)
    assert settings.scenes is not None
    plans, total_duration, transition_duration = build_timeline_scene_plan(timeline, settings.scenes)

    if len(plans) > 250:
        raise RenderError(
            f"Too many images selected ({len(plans)}). "
            "The first release is designed for practical batches, not very large collections."
        )

    log_cb(f"Video frame: {width}x{height} (square pixels, rotation metadata disabled)")
    temp_root: tempfile.TemporaryDirectory[str] | None = tempfile.TemporaryDirectory(prefix="lvc_")

    try:
        temp_dir = Path(temp_root.name)
        scene_dir = temp_dir / "scenes"
        scene_dir.mkdir(parents=True, exist_ok=True)

        prepared_frames: list[Path] = []
        progress_cb(12.0, "Preparing scenes")
        for index, plan in enumerate(plans, start=1):
            if cancel_event.is_set():
                raise RenderCancelled("Rendering was cancelled.")
            if plan.settings and plan.settings.extra_fields.get("mediaType") == "video":
                prepared_frames.append(plan.source_path)
                continue
            frame = build_scene_frame_image(
                plan.source_path, (width, height), settings.fill_mode,
                plan.settings.extra_fields.get("crop") if plan.settings else None,
            )
            frame_path = scene_dir / f"scene_{plan.index:03d}.png"
            frame.save(frame_path)
            prepared_frames.append(frame_path)
            percent = 12.0 + (index / len(plans)) * 21.0
            progress_cb(percent, f"Preparing scenes ({index}/{len(plans)})")

        progress_cb(33.0, "Preparing final render")

        # Render one scene at a time. A single FFmpeg graph containing every
        # full-resolution motion branch scales memory with scene count and is
        # routinely OOM-killed on hosted containers.
        segment_dir = temp_dir / "segments"
        segment_dir.mkdir()
        segments: list[Path] = []
        cell = SceneMotionCell(ffmpeg_exe)
        video_settings = VideoRenderSettings(width=width, height=height, fps=settings.fps)
        for index, (plan, prepared_frame) in enumerate(zip(plans, prepared_frames), start=1):
            if cancel_event.is_set():
                raise RenderCancelled("Rendering was cancelled.")
            segment = segment_dir / f"scene_{index:03d}.mp4"
            scene_settings = replace(plan.settings, image_path=prepared_frame)
            try:
                cell.render_frames(
                    scene_settings, plan.frame_count, settings.fps, video_settings, segment,
                    progress=lambda value, i=index: progress_cb(
                        33.0 + (((i - 1) + value / 100.0) / len(plans)) * 52.0,
                        f"Rendering scene {i}/{len(plans)}",
                    ),
                    cancel_event=cancel_event, log=log_cb, process_callback=process_cb,
                )
            except Exception as exc:
                if cancel_event.is_set():
                    raise RenderCancelled("Rendering was cancelled.") from exc
                raise RenderError(str(exc)) from exc
            segments.append(segment)

        concat_path = temp_dir / "segments.txt"
        concat_path.write_text("".join(f"file '{path.as_posix()}'\n" for path in segments), encoding="utf-8")
        audio_script_path = temp_dir / "audio_filter.txt"
        audio_script_path.write_text(_build_audio_only_filter(settings, total_duration), encoding="utf-8")
        final_cmd = _build_segment_mux_command(
            ffmpeg_exe, concat_path, settings, audio_script_path, output_path,
            timeline.total_frames,
        )

        progress_cb(35.0, "Rendering video")
        return_code, stderr_output = _run_ffmpeg_command(
            final_cmd,
            total_duration=total_duration,
            progress_cb=progress_cb,
            log_cb=log_cb,
            cancel_event=cancel_event,
            stage_label="Rendering video",
            progress_start=85.0,
            progress_end=98.5,
            scene_plans=plans,
            transition_duration=transition_duration,
            process_cb=process_cb,
        )

        if return_code != 0:
            raise RenderError(
                "FFmpeg failed while creating the MP4 file.\n"
                f"{stderr_output[-4000:] if stderr_output else 'No additional details were reported.'}"
            )

        if not output_path.is_file() or output_path.stat().st_size <= 0:
            raise RenderError("FFmpeg completed but the output video was not created.")

        progress_cb(100.0, "Completed")
        log_cb(f"Completed at: {datetime.now().isoformat(timespec='seconds')}")
        render_succeeded = True
        return output_path
    except RenderCancelled:
        raise
    except Exception as exc:
        log_exception("Render failed", exc)
        raise
    finally:
        if not render_succeeded and output_path.exists():
            try:
                output_path.unlink()
            except OSError as exc:
                log_cb(f"Cleanup failed for partial output '{output_path}': {exc}")
                LOGGER.warning("Unable to remove partial output %s", output_path, exc_info=True)
        if temp_root is not None:
            try:
                temp_root.cleanup()
            except OSError as exc:
                log_cb(f"Cleanup failed for temporary render files: {exc}")
                LOGGER.warning("Unable to clean temporary render files", exc_info=True)


def _build_ffmpeg_command(
    ffmpeg_exe: Path,
    prepared_frames: list[Path],
    plans: list[ScenePlan],
    settings: ProjectSettings,
    script_path: Path,
    output_path: Path,
    total_frames: int,
) -> list[str]:
    cmd: list[str] = [
        str(ffmpeg_exe),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    for clip_path, plan in zip(prepared_frames, plans):
        cmd.extend(
            [
                "-loop",
                "1",
                "-framerate",
                str(settings.fps),
                "-i",
                str(clip_path),
            ]
        )
    scene_narration_mode = (
        settings.audio_timing_settings is not None
        and settings.audio_timing_settings.mode is AudioTimingMode.SCENE_NARRATION
    )
    if scene_narration_mode:
        if settings.resolved_narration is None:
            raise RenderError("Resolved scene narration is unavailable.")
        for clip in settings.resolved_narration.clips:
            if clip.has_audio:
                cmd.extend(["-i", str(clip.audio_path)])
    elif settings.voice_file.is_file():
        cmd.extend(["-i", str(settings.voice_file)])
    if settings.music_file:
        if settings.music_trim_end_seconds is None:
            cmd.extend(["-stream_loop", "-1"])
        cmd.extend(["-i", str(settings.music_file)])
    cmd.extend(
        [
            # Keep exports within the memory limits of small hosted API
            # containers. FFmpeg otherwise creates a worker pool for every
            # branch of a multi-scene filter graph and can be OOM-killed.
            "-filter_complex_threads",
            "1",
            "-filter_complex_script",
            str(script_path),
            "-map",
            "[vout]",
            "-map",
            "[aout]",
            "-c:v",
            "libx264",
            "-fps_mode",
            "passthrough",
            "-preset",
            "veryfast",
            "-threads",
            "1",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-metadata:s:v:0",
            "rotate=0",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-frames:v",
            str(total_frames),
            "-t",
            f"{total_frames / settings.fps:.9f}",
            "-shortest",
            str(output_path),
        ]
    )
    return cmd


def _build_audio_only_filter(settings: ProjectSettings, total_duration: float) -> str:
    scene_narration_mode = (
        settings.audio_timing_settings is not None
        and settings.audio_timing_settings.mode is AudioTimingMode.SCENE_NARRATION
    )
    lines: list[str] = []

    def layout_ranges(duration: float, removed: list[tuple[float, float]] | None, gaps: list[tuple[float, float]] | None) -> list[tuple[float, float, float]]:
        deleted: list[tuple[float, float]] = []
        for start, end in removed or []:
            safe_start = max(0.0, min(duration, start))
            safe_end = max(safe_start, min(duration, end))
            if safe_end - safe_start >= .001:
                deleted.append((safe_start, safe_end))
        kept: list[tuple[float, float]] = []
        cursor = 0.0
        for start, end in deleted:
            if start > cursor + .001:
                kept.append((cursor, start))
            cursor = max(cursor, end)
        if cursor < duration - .001:
            kept.append((cursor, duration))
        result: list[tuple[float, float, float]] = []
        for source_start, source_end in kept:
            deleted_before = sum(max(0.0, min(source_start, end) - min(source_start, start)) for start, end in deleted)
            inserted_before = sum(gap_duration for at, gap_duration in gaps or [] if at <= source_start + .001)
            result.append((source_start, source_end, source_start - deleted_before + inserted_before))
        return result

    def edited_track(input_label: str, base_filter: str, duration: float, removed: list[tuple[float, float]] | None, gaps: list[tuple[float, float]] | None, output_label: str, volume: float = 1.0) -> None:
        pieces = layout_ranges(duration, removed, gaps)
        if not pieces:
            lines.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{duration:.9f}[{output_label}]")
            return
        bases = [f"{output_label}base{index}" for index in range(len(pieces))]
        if len(pieces) == 1:
            lines.append(f"{input_label}{base_filter}[{bases[0]}]")
        else:
            outputs = "".join(f"[{label}]" for label in bases)
            lines.append(f"{input_label}{base_filter},asplit={len(pieces)}{outputs}")
        piece_labels: list[str] = []
        for index, (source_start, source_end, timeline_start) in enumerate(pieces):
            label = f"{output_label}piece{index}"
            piece_labels.append(f"[{label}]")
            delay_ms = max(0, int(round(timeline_start * 1000)))
            lines.append(
                f"[{bases[index]}]atrim=start={source_start:.9f}:end={source_end:.9f},"
                f"asetpts=PTS-STARTPTS,adelay={delay_ms}:all=1[{label}]"
            )
        mixed = "".join(piece_labels)
        if len(piece_labels) == 1:
            lines.append(f"{mixed}anull,volume={volume:.3f},apad,atrim=0:{duration:.9f}[{output_label}]")
        else:
            lines.append(f"{mixed}amix=inputs={len(piece_labels)}:duration=longest:normalize=0:dropout_transition=0,volume={volume:.3f},apad,atrim=0:{duration:.9f}[{output_label}]")

    input_index = 1  # Input zero is the concatenated scene video.
    if scene_narration_mode and settings.resolved_narration is not None:
        labels: list[str] = []
        for index, clip in enumerate(settings.resolved_narration.clips):
            duration = clip.frame_count / settings.fps
            label = f"narr{index}"
            labels.append(f"[{label}]")
            if clip.has_audio:
                end = f":end={clip.trim_end_seconds:.9f}" if clip.trim_end_seconds is not None else ""
                delay_ms = int(round(clip.leading_padding_seconds * 1000))
                base = f"atrim=start={clip.trim_start_seconds:.9f}{end},asetpts=PTS-STARTPTS,adelay={delay_ms}:all=1,aresample=48000,apad,atrim=0:{duration:.9f}"
                edited_track(
                    f"[{input_index}:a]", base, duration,
                    (settings.narration_removed_ranges or {}).get(clip.scene_id),
                    (settings.narration_timeline_gaps or {}).get(clip.scene_id), label,
                )
                input_index += 1
            else:
                lines.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{duration:.9f}[{label}]")
        lines.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1,atrim=0:{total_duration:.9f}[voicea]")
    elif settings.voice_file.is_file():
        end = f":end={settings.voice_trim_end_seconds:.9f}" if settings.voice_trim_end_seconds is not None else ""
        edited_track(
            f"[{input_index}:a]",
            f"atrim=start={settings.voice_trim_start_seconds:.9f}{end},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=0:{total_duration:.9f}",
            total_duration, settings.voice_removed_ranges, settings.voice_timeline_gaps, "voicea",
        )
        input_index += 1
    else:
        lines.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{total_duration:.9f}[voicea]")

    if settings.music_file:
        end = f":end={settings.music_trim_end_seconds:.9f}" if settings.music_trim_end_seconds is not None else ""
        loop = ""
        if settings.music_trim_end_seconds is not None:
            samples = max(1, round((settings.music_trim_end_seconds - settings.music_trim_start_seconds) * 48000))
            loop = f",aloop=loop=-1:size={samples}"
        edited_track(
            f"[{input_index}:a]",
            f"atrim=start={settings.music_trim_start_seconds:.9f}{end},asetpts=PTS-STARTPTS,aresample=48000{loop},apad,atrim=0:{total_duration:.9f}",
            total_duration, settings.music_removed_ranges, settings.music_timeline_gaps, "musica", settings.music_volume,
        )
        lines.append("[voicea][musica]amix=inputs=2:duration=first:dropout_transition=0[aout]")
        input_index += 1
    else:
        lines.append("[voicea]anull[aout]")
    if settings.ai_source_audio:
        lines[-1] = lines[-1].replace("[aout]", "[existingmix]")
        lines.append(f"[{input_index}:a]aresample=48000,apad,atrim=0:{total_duration:.9f}[sourceaudio]")
        lines.append("[existingmix][sourceaudio]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]")
    return ";\n".join(lines)


def _build_segment_mux_command(
    ffmpeg_exe: Path,
    concat_path: Path,
    settings: ProjectSettings,
    script_path: Path,
    output_path: Path,
    total_frames: int,
) -> list[str]:
    cmd = [
        str(ffmpeg_exe), "-y", "-hide_banner", "-loglevel", "error",
        "-progress", "pipe:1", "-nostats", "-f", "concat", "-safe", "0",
        "-i", str(concat_path),
    ]
    scene_narration_mode = (
        settings.audio_timing_settings is not None
        and settings.audio_timing_settings.mode is AudioTimingMode.SCENE_NARRATION
    )
    if scene_narration_mode:
        if settings.resolved_narration is None:
            raise RenderError("Resolved scene narration is unavailable.")
        for clip in settings.resolved_narration.clips:
            if clip.has_audio:
                cmd.extend(["-i", str(clip.audio_path)])
    elif settings.voice_file.is_file():
        cmd.extend(["-i", str(settings.voice_file)])
    if settings.music_file:
        if settings.music_trim_end_seconds is None:
            cmd.extend(["-stream_loop", "-1"])
        cmd.extend(["-i", str(settings.music_file)])
    if settings.ai_source_audio:
        cmd.extend(["-i", str(settings.ai_source_audio)])
    cmd.extend([
        "-filter_complex_threads", "1", "-filter_complex_script", str(script_path),
        "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
        "-b:a", "192k", "-movflags", "+faststart", "-t",
        f"{total_frames / settings.fps:.9f}", "-shortest", str(output_path),
    ])
    return cmd


def _build_filter_script(
    prepared_frames: list[Path],
    plans: list[ScenePlan],
    voice_input_index: int | None,
    music_input_index: int | None,
    total_duration: float,
    width: int,
    height: int,
    fps: int,
    music_volume: float,
    fill_mode: str,
    transition_duration: float,
    narration_clips: list[ResolvedNarrationClip] | None = None,
    voice_trim_start: float = 0.0,
    voice_trim_end: float | None = None,
    music_trim_start: float = 0.0,
    music_trim_end: float | None = None,
) -> str:
    parts: list[str] = []
    mux_audio_duration = total_duration
    for input_index, plan in enumerate(plans):
        frames = plan.frame_count
        denom = max(1, frames - 1)
        parts.append(
            _scene_filter_chain(
                input_index=input_index,
                motion=plan.motion,
                width=width,
                height=height,
                fps=fps,
                denom=denom,
                scene_settings=plan.settings,
                frame_count=frames,
            )
        )

    if len(plans) == 1:
        parts.append("[v1]null[vout]")
    else:
        concat_inputs = "".join(f"[v{index + 1}]" for index in range(len(plans)))
        parts.append(f"{concat_inputs}concat=n={len(plans)}:v=1:a=0[vout]")

    if narration_clips is not None:
        audio_lines: list[str] = []
        input_index = len(plans)
        labels: list[str] = []
        for index, clip in enumerate(narration_clips):
            duration = clip.frame_count / fps
            label = f"narr{index}"
            labels.append(f"[{label}]")
            if clip.has_audio:
                end = (f":end={clip.trim_end_seconds:.9f}"
                       if clip.trim_end_seconds is not None else "")
                delay_ms = int(round(clip.leading_padding_seconds * 1000))
                audio_lines.append(
                    f"[{input_index}:a]atrim=start={clip.trim_start_seconds:.9f}{end},"
                    f"asetpts=PTS-STARTPTS,adelay={delay_ms}:all=1,aresample=48000,"
                    f"apad,atrim=0:{duration:.9f}[{label}]"
                )
                input_index += 1
            else:
                audio_lines.append(
                    f"anullsrc=r=48000:cl=stereo,atrim=0:{duration:.9f}[{label}]"
                )
        audio_lines.append(
            f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1,atrim=0:{mux_audio_duration:.9f}[voicea]"
        )
    elif voice_input_index is not None:
        end = f":end={voice_trim_end:.9f}" if voice_trim_end is not None else ""
        audio_lines = [
            f"[{voice_input_index}:a]atrim=start={voice_trim_start:.9f}{end},asetpts=PTS-STARTPTS,"
            f"aresample=48000,apad=pad_dur={mux_audio_duration:.9f},atrim=0:{mux_audio_duration:.9f}[voicea]"
        ]
    else:
        audio_lines = [
            f"anullsrc=r=48000:cl=stereo,atrim=0:{mux_audio_duration:.9f}[voicea]"
        ]
    if music_input_index is not None:
        end = f":end={music_trim_end:.9f}" if music_trim_end is not None else ""
        loop = ""
        if music_trim_end is not None:
            loop = f",aloop=loop=-1:size={max(1, round((music_trim_end - music_trim_start) * 48000))}"
        audio_lines.append(
            f"[{music_input_index}:a]atrim=start={music_trim_start:.9f}{end},asetpts=PTS-STARTPTS,"
            f"aresample=48000{loop},volume={music_volume:.3f},apad=pad_dur={mux_audio_duration:.9f},"
            f"atrim=0:{mux_audio_duration:.9f}[musica]"
        )
        audio_lines.append("[voicea][musica]amix=inputs=2:duration=first:dropout_transition=0[aout]")
    else:
        audio_lines.append("[voicea]anull[aout]")

    parts.extend(audio_lines)
    return ";\n".join(parts)


def _scene_filter_chain(
    input_index: int,
    motion: str,
    width: int,
    height: int,
    fps: int,
    denom: int,
    scene_settings: SceneMotionSettings | None = None,
    frame_count: int | None = None,
) -> str:
    effective = scene_settings
    if effective is None:
        try:
            preset = MotionPreset.from_value(motion)
        except ValueError:
            preset = MotionPreset.ZOOM_IN
        effective = SceneMotionSettings(
            image_path=Path("."), motion=preset, motion_intensity=.20,
            start_zoom=1.08 if preset in {
                MotionPreset.PAN_LEFT, MotionPreset.PAN_RIGHT,
                MotionPreset.PAN_UP, MotionPreset.PAN_DOWN,
            } else 1.0,
            end_zoom=1.08 if preset in {
                MotionPreset.PAN_LEFT, MotionPreset.PAN_RIGHT,
                MotionPreset.PAN_UP, MotionPreset.PAN_DOWN,
            } else 1.08,
            transition="none",
        )
    video = VideoRenderSettings(width=width, height=height, fps=fps)
    return (
        f"[{input_index}:v]"
        f"{FFmpegMotionFilterBuilder.build(effective, video, include_fade=False, frame_count=frame_count)}"
        f"[v{input_index + 1}]"
    )
