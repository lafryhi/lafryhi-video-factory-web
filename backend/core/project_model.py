from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.narration_mapping_models import NarrationMappingSettings, NarrationMappingResult
    from core.scene_motion_settings import SceneMotionSettings
    from core.audio_timing_settings import AudioSyncResult, AudioTimingSettings
    from core.timeline_models import ResolvedTimeline


class VideoFormat(Enum):
    """Canonical export formats exposed by the project UI."""

    LANDSCAPE_16_9 = ("landscape_16_9", "Landscape 16:9", 1920, 1080)
    VERTICAL_9_16 = ("vertical_9_16", "Vertical 9:16", 1080, 1920)

    def __init__(self, key: str, title: str, width: int, height: int) -> None:
        self.key = key
        self.title = title
        self.width = width
        self.height = height

    @property
    def dimensions(self) -> tuple[int, int]:
        return self.width, self.height

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}"

    @property
    def display_name(self) -> str:
        return f"{self.title} \u2014 {self.width}\u00d7{self.height}"

    @classmethod
    def from_value(cls, value: object) -> VideoFormat:
        if isinstance(value, cls):
            return value
        normalized = str(value).strip().casefold().replace("\u00d7", "x")
        for item in cls:
            candidates = {
                item.key.casefold(), item.name.casefold(), item.title.casefold(),
                item.resolution.casefold(), item.display_name.casefold().replace("\u00d7", "x"),
            }
            if normalized in candidates:
                return item
        raise ValueError(f"Unsupported video format: {value}")

    @classmethod
    def from_resolution(cls, value: str) -> VideoFormat | None:
        try:
            dimensions = parse_resolution(value)
        except (TypeError, ValueError):
            return None
        return next((item for item in cls if item.dimensions == dimensions), None)


def resolve_video_dimensions(video_format: VideoFormat | object, resolution: str) -> tuple[int, int]:
    """Resolve the real frame size while keeping project orientation authoritative."""
    selected = VideoFormat.from_value(video_format)
    if selected is VideoFormat.VERTICAL_9_16:
        return selected.dimensions
    try:
        width, height = parse_resolution(resolution)
    except (TypeError, ValueError):
        return selected.dimensions
    return (width, height) if width > height else selected.dimensions


def normalize_audio_trim(start: object = 0.0, end: object = None) -> tuple[float, float | None]:
    start_value = float(start or 0.0)
    end_value = None if end in (None, "") else float(end)
    if not math.isfinite(start_value) or start_value < 0:
        raise ValueError("Audio trim start must be a non-negative finite number.")
    if end_value is not None and (not math.isfinite(end_value) or end_value <= start_value):
        raise ValueError("Audio trim end must be a finite number greater than trim start.")
    return start_value, end_value


def normalize_removed_audio_ranges(value: object) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        return []
    ranges: list[tuple[float, float]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("startSeconds", 0.0))
            end = float(item.get("endSeconds", 0.0))
        except (TypeError, ValueError):
            continue
        if math.isfinite(start) and math.isfinite(end) and start >= 0 and end - start >= .05:
            ranges.append((start, end))
    ranges.sort()
    merged: list[tuple[float, float]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1] + .001:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def normalize_audio_gaps(value: object) -> list[tuple[float, float]]:
    if not isinstance(value, list):
        return []
    merged: dict[float, float] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        try:
            at = round(float(item.get("atSeconds", 0.0)), 3)
            duration = round(float(item.get("durationSeconds", 0.0)), 3)
        except (TypeError, ValueError):
            continue
        if math.isfinite(at) and math.isfinite(duration) and at >= 0 and duration >= .05:
            merged[at] = round(merged.get(at, 0.0) + duration, 3)
    return sorted(merged.items())


@dataclass(slots=True)
class ProjectSettings:
    """Project inputs; legacy timing fields are accepted only for migration adapters."""
    images_folder: Path
    voice_file: Path
    output_folder: Path
    music_file: Path | None = None
    output_name: str = "final_video.mp4"
    resolution: str = "1920x1080"
    fps: int = 30
    fill_mode: str = "Fit with blurred background"
    minimum_scene_duration: float = 4.0
    motion_intensity: str = "Low"
    music_volume: float = 0.18
    scenes: list[SceneMotionSettings] | None = None
    # Migration-only compatibility fields. TimelinePlanningService normalizes them;
    # renderers and future engines must never use them as timing authorities.
    scene_timing_mode: str = "auto"
    audio_timing_settings: AudioTimingSettings | None = None
    audio_sync_result: AudioSyncResult | None = None
    resolved_timeline: ResolvedTimeline | None = None
    narration_mapping: NarrationMappingSettings | None = None
    resolved_narration: NarrationMappingResult | None = None
    # Appended to preserve the positional order of the pre-existing settings API.
    # Landscape is the compatibility default for projects saved before this field existed.
    video_format: VideoFormat = VideoFormat.LANDSCAPE_16_9
    voice_trim_start_seconds: float = 0.0
    voice_trim_end_seconds: float | None = None
    music_trim_start_seconds: float = 0.0
    music_trim_end_seconds: float | None = None
    voice_removed_ranges: list[tuple[float, float]] | None = None
    music_removed_ranges: list[tuple[float, float]] | None = None
    narration_removed_ranges: dict[str, list[tuple[float, float]]] | None = None
    voice_timeline_gaps: list[tuple[float, float]] | None = None
    music_timeline_gaps: list[tuple[float, float]] | None = None
    narration_timeline_gaps: dict[str, list[tuple[float, float]]] | None = None
    ai_source_audio: Path | None = None

    @property
    def video_dimensions(self) -> tuple[int, int]:
        return resolve_video_dimensions(self.video_format, self.resolution)

    @property
    def effective_resolution(self) -> str:
        width, height = self.video_dimensions
        return f"{width}x{height}"


@dataclass(slots=True)
class ScenePlan:
    index: int
    source_path: Path
    duration: float
    motion: str
    settings: SceneMotionSettings | None = None
    frame_count: int = 0


def parse_resolution(value: str) -> tuple[int, int]:
    cleaned = value.lower().replace("×", "x").strip()
    width_text, height_text = cleaned.split("x", maxsplit=1)
    return int(width_text.strip()), int(height_text.strip())


def format_duration(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"
