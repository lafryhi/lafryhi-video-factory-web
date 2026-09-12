from __future__ import annotations

from dataclasses import replace
import re
from pathlib import Path
import threading
from typing import Callable

from core.frame_timing import allocate_scene_frames, frames_for_duration
from core.narration_clip_analysis_service import (
    NarrationClipAnalysisCancelled, NarrationClipAnalysisError, NarrationClipAnalysisService,
)
from core.narration_mapping_models import (
    NarrationMappingResult, NarrationMappingSettings, NarrationMismatchStrategy,
    ResolvedNarrationClip, SceneNarrationAssignment, SUPPORTED_NARRATION_EXTENSIONS,
)
from core.scene_motion_settings import SceneMotionSettings


class NarrationMappingError(RuntimeError):
    pass


class NarrationMappingCancelled(NarrationMappingError):
    pass


def natural_audio_sort_key(path: Path) -> tuple[object, ...]:
    return tuple(int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", path.name))


class NarrationMappingService:
    def __init__(self, analysis: NarrationClipAnalysisService) -> None:
        self.analysis = analysis

    @staticmethod
    def audio_files(folder: str | Path) -> list[Path]:
        source = Path(folder)
        if not source.is_dir():
            raise NarrationMappingError("Narration folder does not exist.")
        files = sorted(
            (path for path in source.iterdir() if path.is_file() and path.suffix.casefold() in SUPPORTED_NARRATION_EXTENSIONS),
            key=natural_audio_sort_key,
        )
        if not files:
            raise NarrationMappingError("Narration folder contains no supported audio files.")
        return files

    def map_folder(
        self,
        scenes: list[SceneMotionSettings],
        folder: str | Path,
        settings: NarrationMappingSettings,
        cancellation_event: threading.Event | None = None,
    ) -> NarrationMappingSettings:
        files = self.audio_files(folder)
        self._check_cancel(cancellation_event)
        if settings.mismatch_strategy is NarrationMismatchStrategy.ERROR and len(files) != len(scenes):
            raise NarrationMappingError(
                f"Error strategy requires exactly {len(scenes)} clips; found {len(files)}."
            )
        if len(files) > len(scenes):
            raise NarrationMappingError(f"Found {len(files)} clips for only {len(scenes)} scenes.")
        assignments = [
            SceneNarrationAssignment(scene.scene_id, files[index] if index < len(files) else None)
            for index, scene in enumerate(scenes)
        ]
        if (settings.mismatch_strategy is NarrationMismatchStrategy.EXTEND_LAST
                and len(files) == len(scenes) - 1 and files):
            duration = self.analysis.duration(files[-1], cancellation_event)
            left, right = settings.extend_last_weights
            split = duration * left / (left + right)
            assignments[-2] = replace(assignments[-2], trim_end_seconds=split)
            assignments[-1] = SceneNarrationAssignment(
                scenes[-1].scene_id, files[-1], trim_start_seconds=split, trim_end_seconds=duration
            )
        return replace(settings, assignments=assignments)

    def resolve(
        self,
        scenes: list[SceneMotionSettings],
        settings: NarrationMappingSettings,
        fps: int,
        cancellation_event: threading.Event | None = None,
        progress_callback: Callable[[float], None] | None = None,
    ) -> NarrationMappingResult:
        try:
            settings.validate()
        except ValueError as exc:
            raise NarrationMappingError(str(exc)) from exc
        if fps <= 0 or fps > 240:
            raise NarrationMappingError("FPS must be between 1 and 240.")
        scene_ids = [scene.scene_id for scene in scenes]
        if len(scene_ids) != len(set(scene_ids)):
            raise NarrationMappingError("Scene IDs must be unique.")
        by_id = settings.by_scene_id()
        unknown = set(by_id) - set(scene_ids)
        if unknown:
            raise NarrationMappingError(f"Narration assignment references unknown scene ID: {sorted(unknown)[0]}")
        if settings.mismatch_strategy is NarrationMismatchStrategy.ERROR and set(by_id) != set(scene_ids):
            raise NarrationMappingError("Error strategy requires one narration assignment for every scene.")

        clips: list[ResolvedNarrationClip] = []
        warnings: list[str] = []
        for index, scene in enumerate(scenes):
            self._check_cancel(cancellation_event)
            assignment = by_id.get(scene.scene_id)
            if assignment is None:
                raise NarrationMappingError(f"Scene {scene.scene_id} has no explicit narration assignment.")
            path = assignment.audio_path if assignment.enabled else None
            if path is None:
                if settings.mismatch_strategy is NarrationMismatchStrategy.ERROR:
                    raise NarrationMappingError(f"Scene {scene.scene_id} requires a narration clip.")
                seconds = settings.default_outro_seconds
                warning = "No narration; silence will be generated."
                warnings.append(f"{scene.scene_id}: {warning}")
                frames = frames_for_duration(max(seconds, 1 / fps), fps)
                clips.append(ResolvedNarrationClip(
                    scene.scene_id, None, None, 0.0, None, 0.0, 0.0, frames, warning
                ))
            else:
                try:
                    duration = self.analysis.duration(path, cancellation_event)
                except NarrationClipAnalysisCancelled as exc:
                    raise NarrationMappingCancelled(str(exc)) from exc
                except NarrationClipAnalysisError as exc:
                    raise NarrationMappingError(str(exc)) from exc
                end = assignment.trim_end_seconds if assignment.trim_end_seconds is not None else duration
                if assignment.trim_start_seconds >= duration or end > duration + 1e-9:
                    raise NarrationMappingError(f"Trim range exceeds narration duration for {path.name}.")
                effective = (
                    end - assignment.trim_start_seconds
                    + assignment.leading_padding_seconds + assignment.trailing_padding_seconds
                )
                frames = frames_for_duration(effective, fps)
                clips.append(ResolvedNarrationClip(
                    scene.scene_id, path.resolve(), duration, assignment.trim_start_seconds,
                    assignment.trim_end_seconds, assignment.leading_padding_seconds,
                    assignment.trailing_padding_seconds, frames,
                ))
            if progress_callback:
                progress_callback((index + 1) / len(scenes) * 100.0)
        if (settings.mismatch_strategy is NarrationMismatchStrategy.EXTEND_LAST
                and len(clips) >= 2 and clips[-2].audio_path is not None
                and clips[-2].audio_path == clips[-1].audio_path):
            left_clip, right_clip = clips[-2], clips[-1]
            left_seconds = left_clip.frame_count / fps
            right_seconds = right_clip.frame_count / fps
            total_source = (
                (right_clip.trim_end_seconds or right_clip.source_duration_seconds or 0.0)
                - left_clip.trim_start_seconds
                + left_clip.leading_padding_seconds + left_clip.trailing_padding_seconds
                + right_clip.leading_padding_seconds + right_clip.trailing_padding_seconds
            )
            exact = allocate_scene_frames(
                [left_seconds, right_seconds], fps, total_duration_seconds=total_source
            )
            clips[-2] = replace(left_clip, frame_count=exact[0])
            clips[-1] = replace(right_clip, frame_count=exact[1])
        return NarrationMappingResult(tuple(item.frame_count for item in clips), tuple(clips), tuple(warnings))

    @staticmethod
    def _check_cancel(event: threading.Event | None) -> None:
        if event and event.is_set():
            raise NarrationMappingCancelled("Narration mapping was cancelled.")
