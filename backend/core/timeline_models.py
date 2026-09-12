from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from core.scene_motion_settings import SceneMotionSettings


@dataclass(frozen=True, slots=True)
class MediaSource:
    path: Path
    kind: str = "image"


@dataclass(frozen=True, slots=True)
class SceneTimingRequest:
    weight: float = 1.0
    requested_duration_seconds: float | None = None


@dataclass(slots=True)
class ProjectScene:
    """Minimal scene aggregate; timing and motion remain separate responsibilities."""

    scene_id: str
    source: MediaSource
    timing: SceneTimingRequest
    motion: SceneMotionSettings
    transition: dict[str, Any] = field(default_factory=dict)
    effects: list[Any] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class TimelineIdentity:
    narration_identity: str | None
    scene_collection_identity: str
    timing_settings_identity: str
    project_version: int = 2


@dataclass(frozen=True, slots=True)
class ResolvedScene:
    scene_id: str
    source_path: str
    source_index: int
    start_frame: int
    end_frame_exclusive: int
    frame_count: int
    timing_weight: float
    fps_numerator: int
    fps_denominator: int = 1
    requested_duration_seconds: float | None = None

    @property
    def duration_seconds(self) -> float:
        return self.frame_count * self.fps_denominator / self.fps_numerator


@dataclass(frozen=True, slots=True, weakref_slot=True)
class ResolvedTimeline:
    timeline_id: str
    fps_numerator: int
    fps_denominator: int
    total_frames: int
    scenes: tuple[ResolvedScene, ...]
    identity: TimelineIdentity
    timing_mode: str
    warnings: tuple[str, ...] = ()
    detected_silence_boundaries: tuple[float, ...] = ()
    analysis_metadata: tuple[tuple[str, str], ...] = ()

    @property
    def duration_seconds(self) -> float:
        return self.total_frames * self.fps_denominator / self.fps_numerator


def validate_timeline(timeline: ResolvedTimeline) -> None:
    if timeline.fps_numerator <= 0 or timeline.fps_denominator <= 0:
        raise ValueError("Timeline FPS/timebase must be positive.")
    if not timeline.scenes:
        raise ValueError("Timeline must contain at least one scene.")
    if timeline.total_frames < len(timeline.scenes):
        raise ValueError("Timeline does not contain at least one frame per scene.")
    ids = [scene.scene_id for scene in timeline.scenes]
    if any(not value.strip() for value in ids) or len(ids) != len(set(ids)):
        raise ValueError("Timeline scene IDs must be non-empty and unique.")
    cursor = 0
    for scene in timeline.scenes:
        if scene.start_frame != cursor:
            raise ValueError("Timeline scene ranges must be contiguous.")
        if scene.frame_count < 1 or scene.end_frame_exclusive - scene.start_frame != scene.frame_count:
            raise ValueError("Timeline scene frame range is invalid.")
        if (scene.fps_numerator, scene.fps_denominator) != (
            timeline.fps_numerator, timeline.fps_denominator
        ):
            raise ValueError("Timeline scene timebase is inconsistent.")
        cursor = scene.end_frame_exclusive
    if cursor != timeline.total_frames:
        raise ValueError("Final scene does not end at the timeline frame total.")
