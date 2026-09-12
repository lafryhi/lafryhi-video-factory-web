from __future__ import annotations

from dataclasses import replace
import math
from pathlib import Path
import threading
from typing import Callable
import weakref

from core.audio_sync_cell import AudioSyncCancelled, AudioSyncCell, AudioSyncError
from core.audio_timing_settings import AudioSyncResult, AudioTimingMode, AudioTimingSettings
from core.image_utils import list_image_files
from core.project_identity import build_timeline_identity, resolved_timeline_hash
from core.project_model import ProjectSettings
from core.scene_configuration_service import SceneConfigurationService
from core.scene_motion_settings import SceneMotionSettings
from core.timeline_models import ResolvedScene, ResolvedTimeline, validate_timeline
from core.frame_timing import allocate_scene_frames
from core.narration_clip_analysis_service import NarrationClipAnalysisService
from core.narration_mapping_service import (
    NarrationMappingCancelled, NarrationMappingError, NarrationMappingService,
)


class TimelinePlanningError(RuntimeError):
    pass


class TimelinePlanningCancelled(TimelinePlanningError):
    pass


class _IssuedTimelineRegistry:
    """Process-local proof that a specific object was issued by this planning layer."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._objects: dict[int, weakref.ReferenceType[ResolvedTimeline]] = {}

    def issue(self, timeline: ResolvedTimeline) -> None:
        object_id = id(timeline)
        with self._lock:
            self._objects[object_id] = weakref.ref(
                timeline, lambda _reference, key=object_id: self._discard(key)
            )

    def contains(self, timeline: ResolvedTimeline) -> bool:
        with self._lock:
            reference = self._objects.get(id(timeline))
            return reference is not None and reference() is timeline

    def _discard(self, object_id: int) -> None:
        with self._lock:
            self._objects.pop(object_id, None)


_ISSUED_TIMELINES = _IssuedTimelineRegistry()


class TimelinePlanningService:
    """Resolve project inputs into the sole immutable frame-based timing authority."""

    def __init__(self, audio_sync_cell: AudioSyncCell) -> None:
        self.audio_sync_cell = audio_sync_cell
        self.narration_mapping_service = NarrationMappingService(
            NarrationClipAnalysisService(audio_sync_cell.analysis_service)
        )
        self._cached: ResolvedTimeline | None = None

    def normalize_timing(self, project: ProjectSettings) -> tuple[AudioTimingSettings, list[str]]:
        warnings: list[str] = []
        if project.audio_timing_settings is not None:
            timing = replace(project.audio_timing_settings)
            legacy = project.scene_timing_mode.casefold()
            expected = "manual" if timing.mode is AudioTimingMode.MANUAL else "auto"
            if legacy in {"auto", "manual"} and legacy != expected:
                warnings.append("Legacy timingMode conflicts with audioTiming.mode; audioTiming.mode was used.")
        else:
            legacy = project.scene_timing_mode.casefold()
            mode = AudioTimingMode.MANUAL if legacy == "manual" else AudioTimingMode.EVEN
            if legacy not in {"auto", "manual"}:
                warnings.append("Invalid legacy timingMode; Even Distribution was used.")
            timing = AudioTimingSettings(mode=mode, minimum_scene_seconds=project.minimum_scene_duration)
        return timing, warnings

    def project_scenes(self, project: ProjectSettings) -> list[SceneMotionSettings]:
        if project.scenes:
            scenes = list(project.scenes)
        else:
            images = list_image_files(project.images_folder)
            scenes = SceneConfigurationService.create_defaults(images)
            project.scenes = scenes
        return scenes

    def resolve(
        self,
        project_settings: ProjectSettings,
        cancellation_event: threading.Event | None = None,
        progress_callback: Callable[[float], None] | None = None,
        force_rebuild: bool = False,
    ) -> ResolvedTimeline:
        self._check_cancel(cancellation_event)
        try:
            scenes = self.project_scenes(project_settings)
            timing, migration_warnings = self.normalize_timing(project_settings)
            if timing.mode is not AudioTimingMode.SCENE_NARRATION and not project_settings.voice_file.is_file():
                if timing.mode is not AudioTimingMode.MANUAL:
                    migration_warnings.append(
                        "No narration track was selected; manual scene timing was used."
                    )
                timing.mode = AudioTimingMode.MANUAL
            self._validate_inputs(project_settings, scenes, timing)
            identity = build_timeline_identity(
                project_settings.voice_file if project_settings.voice_file.is_file() else None,
                scenes, timing, project_settings.fps,
                project_settings.narration_mapping,
                voice_trim_start_seconds=project_settings.voice_trim_start_seconds,
                voice_trim_end_seconds=project_settings.voice_trim_end_seconds,
            )
        except (OSError, ValueError) as exc:
            raise TimelinePlanningError(f"Unable to identify project timing inputs: {exc}") from exc
        supplied = project_settings.resolved_timeline
        if not force_rebuild:
            for candidate in (supplied, self._cached):
                if candidate is None or candidate.identity != identity:
                    continue
                if not _ISSUED_TIMELINES.contains(candidate):
                    continue
                try:
                    validate_timeline(candidate)
                except ValueError:
                    continue
                if timing.mode is AudioTimingMode.SCENE_NARRATION:
                    mapped = project_settings.resolved_narration
                    if (mapped is None or tuple(mapped.scene_frames)
                            != tuple(scene.frame_count for scene in candidate.scenes)):
                        continue
                self._check_cancel(cancellation_event)
                project_settings.resolved_timeline = candidate
                return candidate
        self._check_cancel(cancellation_event)
        if timing.mode is AudioTimingMode.SCENE_NARRATION:
            if project_settings.narration_mapping is None:
                raise TimelinePlanningError("Scene Narration mode requires narration mapping settings.")
            try:
                mapped = self.narration_mapping_service.resolve(
                    scenes, project_settings.narration_mapping, project_settings.fps,
                    cancellation_event, progress_callback,
                )
            except NarrationMappingCancelled as exc:
                raise TimelinePlanningCancelled(str(exc)) from exc
            except NarrationMappingError as exc:
                raise TimelinePlanningError(str(exc)) from exc
            project_settings.resolved_narration = mapped
            result = AudioSyncResult(
                total_frames=mapped.total_frames,
                fps=project_settings.fps,
                scene_frames=list(mapped.scene_frames),
                scene_durations=[value / project_settings.fps for value in mapped.scene_frames],
                audio_duration_seconds=mapped.total_frames / project_settings.fps,
                detected_silence_boundaries=[],
                mode_used=AudioTimingMode.SCENE_NARRATION.value,
                warnings=list(mapped.warnings),
            )
        else:
            project_settings.resolved_narration = None
        if timing.mode is AudioTimingMode.MANUAL:
            timing.manual_durations_seconds = [scene.duration_seconds for scene in scenes]
        timing.weights = [scene.timing_weight for scene in scenes]
        if timing.mode is not AudioTimingMode.SCENE_NARRATION:
            if timing.mode is AudioTimingMode.MANUAL and not project_settings.voice_file.is_file():
                frames = allocate_scene_frames(timing.manual_durations_seconds or [], project_settings.fps)
                result = AudioSyncResult(
                    total_frames=sum(frames), fps=project_settings.fps, scene_frames=frames,
                    scene_durations=[value / project_settings.fps for value in frames],
                    audio_duration_seconds=0.0, detected_silence_boundaries=[],
                    mode_used=AudioTimingMode.MANUAL.value,
                    warnings=["No narration track was selected; silent audio will be exported."],
                )
            else:
                try:
                    result = self.audio_sync_cell.analyze(
                        project_settings.voice_file, len(scenes), project_settings.fps, timing,
                        cancellation_event, progress_callback,
                        trim_start_seconds=project_settings.voice_trim_start_seconds,
                        trim_end_seconds=project_settings.voice_trim_end_seconds,
                    )
                except AudioSyncCancelled as exc:
                    raise TimelinePlanningCancelled(str(exc)) from exc
                except AudioSyncError as exc:
                    raise TimelinePlanningError(str(exc)) from exc
        cursor = 0
        resolved: list[ResolvedScene] = []
        for index, (scene, frame_count) in enumerate(zip(scenes, result.scene_frames)):
            requested = scene.duration_seconds if timing.mode is AudioTimingMode.MANUAL else None
            resolved.append(ResolvedScene(
                scene_id=scene.scene_id,
                source_path=str(scene.image_path.resolve()),
                source_index=index,
                start_frame=cursor,
                end_frame_exclusive=cursor + frame_count,
                frame_count=frame_count,
                timing_weight=scene.timing_weight,
                requested_duration_seconds=requested,
                fps_numerator=project_settings.fps,
            ))
            cursor += frame_count
        timeline = ResolvedTimeline(
            timeline_id="",
            fps_numerator=project_settings.fps,
            fps_denominator=1,
            total_frames=result.total_frames,
            scenes=tuple(resolved),
            identity=identity,
            timing_mode=result.mode_used,
            warnings=tuple([*migration_warnings, *result.warnings]),
            detected_silence_boundaries=tuple(result.detected_silence_boundaries),
            analysis_metadata=(("audio_duration_seconds", f"{result.audio_duration_seconds:.9f}"),),
        )
        try:
            validate_timeline(timeline)
        except ValueError as exc:
            raise TimelinePlanningError(str(exc)) from exc
        timeline = replace(timeline, timeline_id=resolved_timeline_hash(
            identity, result.mode_used, resolved, result.detected_silence_boundaries,
            [*migration_warnings, *result.warnings],
            [("audio_duration_seconds", f"{result.audio_duration_seconds:.9f}")],
        ))
        self._check_cancel(cancellation_event)
        _ISSUED_TIMELINES.issue(timeline)
        self._cached = timeline
        project_settings.resolved_timeline = timeline
        return timeline

    def is_current(self, timeline: ResolvedTimeline, project_settings: ProjectSettings) -> bool:
        try:
            scenes = self.project_scenes(project_settings)
            timing, _warnings = self.normalize_timing(project_settings)
            if timing.mode is not AudioTimingMode.SCENE_NARRATION and not project_settings.voice_file.is_file():
                timing.mode = AudioTimingMode.MANUAL
            self._validate_inputs(project_settings, scenes, timing)
            identity = build_timeline_identity(
                project_settings.voice_file if project_settings.voice_file.is_file() else None,
                scenes, timing, project_settings.fps,
                project_settings.narration_mapping,
                voice_trim_start_seconds=project_settings.voice_trim_start_seconds,
                voice_trim_end_seconds=project_settings.voice_trim_end_seconds,
            )
            validate_timeline(timeline)
            return _ISSUED_TIMELINES.contains(timeline) and timeline.identity == identity
        except (OSError, ValueError, TimelinePlanningError):
            return False

    @staticmethod
    def _validate_inputs(
        project: ProjectSettings, scenes: list[SceneMotionSettings], timing: AudioTimingSettings
    ) -> None:
        if project.fps <= 0 or project.fps > 240:
            raise TimelinePlanningError("FPS must be between 1 and 240.")
        if not scenes:
            raise TimelinePlanningError("At least one scene is required.")
        ids = [scene.scene_id for scene in scenes]
        if any(not value.strip() for value in ids) or len(ids) != len(set(ids)):
            raise TimelinePlanningError("Scene IDs must be non-empty and unique.")
        if timing.mode not in {AudioTimingMode.SCENE_NARRATION, AudioTimingMode.MANUAL} and not project.voice_file.is_file():
            raise TimelinePlanningError("Narration audio file does not exist.")
        for scene in scenes:
            if not scene.image_path.is_file():
                raise TimelinePlanningError(f"Scene source file does not exist: {scene.image_path}")
            if not math.isfinite(scene.timing_weight) or scene.timing_weight <= 0:
                raise TimelinePlanningError("Every timing weight must be a positive finite number.")
            if timing.mode is AudioTimingMode.MANUAL and (
                not math.isfinite(scene.duration_seconds) or scene.duration_seconds <= 0
            ):
                raise TimelinePlanningError("Every manual duration must be a positive finite number.")

    @staticmethod
    def _check_cancel(event: threading.Event | None) -> None:
        if event and event.is_set():
            raise TimelinePlanningCancelled("Timeline planning was cancelled.")
