from __future__ import annotations

"""JSON command-line interface for the LAFRYHI video engine.

The Electron application treats this module as the only boundary to the Python
core. Commands emit newline-delimited JSON so progress and logs can be streamed
without importing UI code.
"""

import argparse
from dataclasses import asdict
import json
import logging
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import threading
from typing import Any

from core.audio_analysis_service import AudioAnalysisService
from core.audio_sync_cell import AudioSyncCell
from core.audio_timing_settings import AudioTimingMode, AudioTimingSettings
from core.demo_workflow import (
    DEFAULT_DEMO_OUTPUT_NAME,
    collect_demo_assets,
    pick_default_music,
    pick_default_narration,
)
from core.image_utils import IMAGE_EXTENSIONS, list_image_files
from core.narration_clip_analysis_service import NarrationClipAnalysisService
from core.narration_mapping_models import (
    NarrationMappingSettings,
    NarrationMismatchStrategy,
    SUPPORTED_NARRATION_EXTENSIONS,
)
from core.narration_mapping_service import NarrationMappingService
from core.project_model import ProjectSettings, VideoFormat, normalize_audio_gaps, normalize_audio_trim, normalize_removed_audio_ranges
from core.scene_configuration_service import SceneConfigurationService
from core.scene_motion_cell import SceneMotionCell
from core.scene_motion_settings import MotionPreset, SceneMotionSettings, VideoRenderSettings
from core.scene_preview_service import ScenePreviewService
from core.timeline_planning_service import TimelinePlanningService
from core.video_engine import RenderCancelled, render_project, resolve_ffmpeg_exe


logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
SCHEMA_VERSION = 2


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _path(value: object, base_dir: Path) -> Path:
    text = str(value or "").strip()
    if not text:
        return Path()
    candidate = Path(text)
    return candidate if candidate.is_absolute() else base_dir / candidate


def _request(path: str) -> tuple[dict[str, Any], Path]:
    request_path = Path(path).resolve()
    payload = json.loads(request_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("The request root must be a JSON object.")
    return payload, request_path.parent


def project_from_payload(payload: dict[str, Any], base_dir: Path) -> ProjectSettings:
    project = payload.get("project", payload)
    if not isinstance(project, dict):
        raise ValueError("The project must be a JSON object.")
    project_base = _path(project.get("baseDir"), base_dir)
    if project_base == Path():
        project_base = base_dir
    images_folder = _path(project.get("imagesFolder"), project_base)
    video_format = VideoFormat.from_value(
        project.get("videoFormat", VideoFormat.LANDSCAPE_16_9.key)
    )
    raw_scenes = project.get("scenes")
    if isinstance(raw_scenes, list):
        scenes = [
            SceneMotionSettings.from_dict(item, project_base)
            for item in raw_scenes
            if isinstance(item, dict)
        ]
    else:
        scenes = SceneConfigurationService.create_defaults(list_image_files(images_folder))
    timing_payload = project.get("audioTiming", {})
    if isinstance(timing_payload, dict):
        timing_payload = dict(timing_payload)
        if str(timing_payload.get("mode", "")).strip().casefold() == "weighted" and not timing_payload.get("weights"):
            timing_payload["weights"] = [scene.timing_weight for scene in scenes]
    timing, timing_warnings = AudioTimingSettings.from_dict(timing_payload)
    if timing_warnings:
        for warning in timing_warnings:
            emit({"type": "warning", "message": warning})
    narration = (
        NarrationMappingSettings.from_dict(project["narrationMapping"], project_base)
        if isinstance(project.get("narrationMapping"), dict)
        else NarrationMappingSettings()
    )
    music = _path(project.get("musicFile"), project_base)
    voice_trim = normalize_audio_trim(project.get("voiceTrimStartSeconds", 0.0), project.get("voiceTrimEndSeconds"))
    music_trim = normalize_audio_trim(project.get("musicTrimStartSeconds", 0.0), project.get("musicTrimEndSeconds"))
    removed_payload = project.get("audioTimelineRemovedRanges", {})
    removed_payload = removed_payload if isinstance(removed_payload, dict) else {}
    raw_narration_removed = removed_payload.get("narration", {})
    narration_removed = {
        str(scene_id): normalize_removed_audio_ranges(ranges)
        for scene_id, ranges in raw_narration_removed.items()
    } if isinstance(raw_narration_removed, dict) else {}
    gaps_payload = project.get("audioTimelineGaps", {})
    gaps_payload = gaps_payload if isinstance(gaps_payload, dict) else {}
    raw_narration_gaps = gaps_payload.get("narration", {})
    return ProjectSettings(
        ai_source_audio=_path(project["_aiSourceAudio"], project_base) if project.get("_aiSourceAudio") else None,
        images_folder=images_folder,
        voice_file=_path(project.get("voiceFile"), project_base),
        music_file=music if music != Path() else None,
        output_folder=_path(project.get("outputFolder"), project_base),
        output_name=str(project.get("outputName", "final_video.mp4")),
        resolution=str(project.get("resolution", video_format.resolution)),
        fps=int(project.get("fps", 30)),
        fill_mode=str(project.get("fillMode", "Fit with blurred background")),
        minimum_scene_duration=float(project.get("minimumSceneDuration", 4.0)),
        motion_intensity=str(project.get("motionIntensity", "Low")),
        music_volume=float(project.get("musicVolume", 0.18)),
        scenes=scenes,
        scene_timing_mode=(
            "manual" if timing.mode is AudioTimingMode.MANUAL else "auto"
        ),
        audio_timing_settings=timing,
        narration_mapping=narration,
        video_format=video_format,
        voice_trim_start_seconds=voice_trim[0],
        voice_trim_end_seconds=voice_trim[1],
        music_trim_start_seconds=music_trim[0],
        music_trim_end_seconds=music_trim[1],
        voice_removed_ranges=normalize_removed_audio_ranges(removed_payload.get("voice")),
        music_removed_ranges=normalize_removed_audio_ranges(removed_payload.get("music")),
        narration_removed_ranges=narration_removed,
        voice_timeline_gaps=normalize_audio_gaps(gaps_payload.get("voice")),
        music_timeline_gaps=normalize_audio_gaps(gaps_payload.get("music")),
        narration_timeline_gaps={str(scene_id): normalize_audio_gaps(gaps) for scene_id, gaps in raw_narration_gaps.items()} if isinstance(raw_narration_gaps, dict) else {},
    )


def project_to_payload(settings: ProjectSettings, base_dir: Path) -> dict[str, Any]:
    timing = settings.audio_timing_settings or AudioTimingSettings()
    narration = settings.narration_mapping or NarrationMappingSettings()

    def stored(path: Path | None) -> str:
        if path is None or path == Path():
            return ""
        try:
            return path.resolve().relative_to(base_dir.resolve()).as_posix()
        except ValueError:
            return str(path.resolve())

    return {
        "schemaVersion": SCHEMA_VERSION,
        "baseDir": str(base_dir.resolve()),
        "imagesFolder": stored(settings.images_folder),
        "voiceFile": stored(settings.voice_file),
        "musicFile": stored(settings.music_file),
        "voiceTrimStartSeconds": settings.voice_trim_start_seconds,
        "voiceTrimEndSeconds": settings.voice_trim_end_seconds,
        "musicTrimStartSeconds": settings.music_trim_start_seconds,
        "musicTrimEndSeconds": settings.music_trim_end_seconds,
        "audioTimelineRemovedRanges": {
            "voice": [{"startSeconds": start, "endSeconds": end} for start, end in settings.voice_removed_ranges or []],
            "music": [{"startSeconds": start, "endSeconds": end} for start, end in settings.music_removed_ranges or []],
            "narration": {
                scene_id: [{"startSeconds": start, "endSeconds": end} for start, end in ranges]
                for scene_id, ranges in (settings.narration_removed_ranges or {}).items()
            },
        },
        "audioTimelineGaps": {
            "voice": [{"atSeconds": at, "durationSeconds": duration} for at, duration in settings.voice_timeline_gaps or []],
            "music": [{"atSeconds": at, "durationSeconds": duration} for at, duration in settings.music_timeline_gaps or []],
            "narration": {scene_id: [{"atSeconds": at, "durationSeconds": duration} for at, duration in gaps] for scene_id, gaps in (settings.narration_timeline_gaps or {}).items()},
        },
        "outputFolder": stored(settings.output_folder),
        "outputName": settings.output_name,
        "videoFormat": VideoFormat.from_value(settings.video_format).key,
        "resolution": settings.effective_resolution,
        "fps": settings.fps,
        "fillMode": settings.fill_mode,
        "minimumSceneDuration": settings.minimum_scene_duration,
        "motionIntensity": settings.motion_intensity,
        "musicVolume": settings.music_volume,
        "audioTiming": timing.to_dict(),
        "narrationMapping": narration.to_dict(base_dir),
        "scenes": [scene.to_dict(base_dir) for scene in settings.scenes or []],
    }


def timeline_payload(timeline: Any, project: ProjectSettings) -> dict[str, Any]:
    fps = timeline.fps_numerator / timeline.fps_denominator
    narration = project.resolved_narration
    clips = []
    if narration is not None:
        clips = [
            {
                **asdict(clip),
                "audio_path": str(clip.audio_path) if clip.audio_path else None,
                "duration_seconds": clip.frame_count / fps,
            }
            for clip in narration.clips
        ]
    return {
        "timelineId": timeline.timeline_id,
        "fps": fps,
        "totalFrames": timeline.total_frames,
        "durationSeconds": timeline.duration_seconds,
        "timingMode": timeline.timing_mode,
        "warnings": list(timeline.warnings),
        "silenceBoundaries": list(timeline.detected_silence_boundaries),
        "scenes": [
            {
                "sceneId": scene.scene_id,
                "sourcePath": scene.source_path,
                "sourceIndex": scene.source_index,
                "startFrame": scene.start_frame,
                "endFrame": scene.end_frame_exclusive,
                "frameCount": scene.frame_count,
                "durationSeconds": scene.duration_seconds,
                "timingWeight": scene.timing_weight,
            }
            for scene in timeline.scenes
        ],
        "narrationClips": clips,
    }


def _planner() -> TimelinePlanningService:
    ffmpeg = resolve_ffmpeg_exe()
    return TimelinePlanningService(AudioSyncCell(AudioAnalysisService(ffmpeg)))


def command_capabilities(_args: argparse.Namespace) -> int:
    emit({
        "type": "result",
        "schemaVersion": SCHEMA_VERSION,
        "formats": [
            {"key": item.key, "name": item.title, "width": item.width, "height": item.height}
            for item in VideoFormat
        ],
        "motions": [
            {"value": item.value, "name": item.display_name} for item in MotionPreset
        ],
        "timingModes": [
            {"value": item.value, "name": item.display_name} for item in AudioTimingMode
        ],
        "mismatchStrategies": [
            {"value": item.value, "name": item.display_name}
            for item in NarrationMismatchStrategy
        ],
        "imageExtensions": sorted(IMAGE_EXTENSIONS),
        "audioExtensions": sorted(SUPPORTED_NARRATION_EXTENSIONS),
        "defaults": project_to_payload(ProjectSettings(
            images_folder=Path(), voice_file=Path(), output_folder=Path("output")
        ), Path.cwd()),
    })
    return 0


def command_scan(args: argparse.Namespace) -> int:
    folder = Path(args.folder).resolve()
    images = list_image_files(folder)
    scenes = SceneConfigurationService.create_defaults(images)
    emit({
        "type": "result",
        "folder": str(folder),
        "count": len(images),
        "images": [str(path) for path in images],
        # Electron may save the project anywhere, so scanned scenes cross the
        # process boundary as absolute paths instead of folder-relative paths.
        "scenes": [scene.to_dict() for scene in scenes],
    })
    return 0


def command_analyze(args: argparse.Namespace) -> int:
    payload, base_dir = _request(args.request)
    project = project_from_payload(payload, base_dir)
    timeline = _planner().resolve(
        project,
        progress_callback=lambda value: emit({"type": "progress", "value": value, "stage": "analyze"}),
    )
    emit({"type": "result", "timeline": timeline_payload(timeline, project)})
    return 0


def command_render(args: argparse.Namespace) -> int:
    payload, base_dir = _request(args.request)
    project = project_from_payload(payload, base_dir)
    cancelled = threading.Event()

    def cancel(*_unused: object) -> None:
        cancelled.set()

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    try:
        output = render_project(
            project,
            lambda value, stage: emit({"type": "progress", "value": value, "stage": stage}),
            lambda message: emit({"type": "log", "message": message}),
            cancelled,
        )
    except RenderCancelled:
        emit({"type": "cancelled"})
        return 130
    emit({"type": "result", "outputPath": str(output)})
    return 0


def command_preview(args: argparse.Namespace) -> int:
    payload, base_dir = _request(args.request)
    project = project_from_payload(payload, base_dir)
    planner = _planner()
    timeline = planner.resolve(project)
    scene_id = args.scene_id or str(payload.get("sceneId", ""))
    selected = next((scene for scene in project.scenes or [] if scene.scene_id == scene_id), None)
    if selected is None:
        raise ValueError("The requested preview scene does not exist.")
    resolved = next(item for item in timeline.scenes if item.scene_id == selected.scene_id)
    width, height = project.video_dimensions
    service = ScenePreviewService(SceneMotionCell(resolve_ffmpeg_exe()))
    result = service.render(
        selected,
        VideoRenderSettings(width, height, project.fps),
        fill_mode=project.fill_mode,
        frame_count=resolved.frame_count,
        narration_clip=(
            next((clip for clip in project.resolved_narration.clips if clip.scene_id == selected.scene_id), None)
            if project.resolved_narration else None
        ),
    )
    preview_root = Path(tempfile.gettempdir()) / "lafryhi-web-previews"
    preview_root.mkdir(parents=True, exist_ok=True)
    destination = preview_root / f"{selected.scene_id}.mp4"
    shutil.copy2(result.output_path, destination)
    service.cleanup()
    emit({
        "type": "result",
        "previewPath": str(destination),
        "timeline": timeline_payload(timeline, project),
    })
    return 0


def command_demo_scan(args: argparse.Namespace) -> int:
    orientation = str(args.orientation or "landscape")
    scan = collect_demo_assets(Path(args.root).resolve() if args.root else None, orientation)
    narration = pick_default_narration(scan)
    music = pick_default_music(scan, narration)
    output_folder = Path(args.output_folder).resolve() if args.output_folder else scan.output_folder
    output_folder.mkdir(parents=True, exist_ok=True)
    emit({
        "type": "result",
        "orientation": orientation,
        "videoFormat": VideoFormat.VERTICAL_9_16.key if orientation == "portrait" else VideoFormat.LANDSCAPE_16_9.key,
        "resolution": VideoFormat.VERTICAL_9_16.resolution if orientation == "portrait" else VideoFormat.LANDSCAPE_16_9.resolution,
        "demoRoot": str(scan.demo_root),
        "imagesFolder": str(scan.images_folder),
        "audioFolder": str(scan.audio_folder),
        "outputFolder": str(output_folder),
        "images": [str(path) for path in scan.images],
        "audioFiles": [str(path) for path in scan.audio_files],
        "audioDurations": {str(path): duration for path, duration in scan.audio_durations.items()},
        "defaultNarration": str(narration) if narration else "",
        "defaultMusic": str(music) if music else "",
        "outputName": DEFAULT_DEMO_OUTPUT_NAME,
        "warnings": scan.warnings,
    })
    return 0


def command_map_narration(args: argparse.Namespace) -> int:
    payload, base_dir = _request(args.request)
    project = project_from_payload(payload, base_dir)
    folder = _path(payload.get("narrationFolder"), base_dir)
    service = NarrationMappingService(
        NarrationClipAnalysisService(AudioAnalysisService(resolve_ffmpeg_exe()))
    )
    mapped = service.map_folder(
        project.scenes or [], folder, project.narration_mapping or NarrationMappingSettings()
    )
    emit({"type": "result", "narrationMapping": mapped.to_dict(base_dir)})
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="lafryhi-video-cli")
    commands = root.add_subparsers(dest="command", required=True)
    capabilities = commands.add_parser("capabilities")
    capabilities.set_defaults(handler=command_capabilities)
    scan = commands.add_parser("scan-images")
    scan.add_argument("--folder", required=True)
    scan.set_defaults(handler=command_scan)
    for name, handler in (("analyze", command_analyze), ("render", command_render),
                          ("preview", command_preview), ("map-narration", command_map_narration)):
        command = commands.add_parser(name)
        command.add_argument("--request", required=True)
        if name == "preview":
            command.add_argument("--scene-id")
        command.set_defaults(handler=handler)
    demo = commands.add_parser("demo-scan")
    demo.add_argument("--root")
    demo.add_argument("--output-folder")
    demo.add_argument("--orientation", choices=("landscape", "portrait"), default="landscape")
    demo.set_defaults(handler=command_demo_scan)
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        return int(args.handler(args))
    except Exception as exc:
        emit({"type": "error", "error": type(exc).__name__, "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
