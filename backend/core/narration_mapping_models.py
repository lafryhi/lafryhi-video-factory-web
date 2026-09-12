from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
from pathlib import Path, PureWindowsPath


SUPPORTED_NARRATION_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}


class NarrationMismatchStrategy(str, Enum):
    OUTRO = "outro"
    EXTEND_LAST = "extend_last"
    DUPLICATE_FINAL_FRAME = "duplicate_final_frame"
    ERROR = "error"

    @property
    def display_name(self) -> str:
        return {
            self.OUTRO: "Outro Scene",
            self.EXTEND_LAST: "Extend Last Narration",
            self.DUPLICATE_FINAL_FRAME: "Duplicate Final Frame",
            self.ERROR: "Error",
        }[self]

    @classmethod
    def from_value(cls, value: str | NarrationMismatchStrategy) -> NarrationMismatchStrategy:
        if isinstance(value, cls):
            return value
        normalized = value.strip().casefold().replace("-", "_").replace(" ", "_")
        for item in cls:
            if normalized in {item.value, item.display_name.casefold().replace(" ", "_")}:
                return item
        raise ValueError(f"Unknown narration mismatch strategy: {value}")


@dataclass(frozen=True, slots=True)
class SceneNarrationAssignment:
    scene_id: str
    audio_path: Path | None
    trim_start_seconds: float = 0.0
    trim_end_seconds: float | None = None
    leading_padding_seconds: float = 0.0
    trailing_padding_seconds: float = 0.0
    enabled: bool = True

    def validate(self) -> None:
        if not self.scene_id.strip():
            raise ValueError("Narration assignment scene ID cannot be empty.")
        values = [self.trim_start_seconds, self.leading_padding_seconds, self.trailing_padding_seconds]
        if self.trim_end_seconds is not None:
            values.append(self.trim_end_seconds)
        if any(not math.isfinite(value) or value < 0 for value in values):
            raise ValueError("Narration trim and padding values must be finite and non-negative.")
        if self.trim_end_seconds is not None and self.trim_end_seconds <= self.trim_start_seconds:
            raise ValueError("Narration trim end must be greater than trim start.")
        if self.enabled and self.audio_path is not None:
            if self.audio_path.suffix.casefold() not in SUPPORTED_NARRATION_EXTENSIONS:
                raise ValueError(f"Unsupported narration format: {self.audio_path.suffix or '(none)'}")


@dataclass(slots=True)
class NarrationMappingSettings:
    mismatch_strategy: NarrationMismatchStrategy = NarrationMismatchStrategy.OUTRO
    default_outro_seconds: float = 4.0
    extend_last_weights: tuple[float, float] = (1.0, 1.0)
    assignments: list[SceneNarrationAssignment] = field(default_factory=list)

    def validate(self) -> None:
        if not math.isfinite(self.default_outro_seconds) or self.default_outro_seconds < 0:
            raise ValueError("Outro duration must be finite and non-negative.")
        if (len(self.extend_last_weights) != 2 or any(
            not math.isfinite(value) or value <= 0 for value in self.extend_last_weights
        )):
            raise ValueError("Extend Last weights must be two positive finite values.")
        ids = [assignment.scene_id for assignment in self.assignments]
        if len(ids) != len(set(ids)):
            raise ValueError("Only one narration assignment is allowed per scene ID.")
        for assignment in self.assignments:
            assignment.validate()

    def by_scene_id(self) -> dict[str, SceneNarrationAssignment]:
        return {assignment.scene_id: assignment for assignment in self.assignments}

    def to_dict(self, base_dir: Path) -> dict[str, object]:
        def stored_path(path: Path | None) -> str | None:
            if path is None:
                return None
            try:
                return path.resolve().relative_to(base_dir.resolve()).as_posix()
            except ValueError:
                return str(path.resolve())

        return {
            "mismatchStrategy": self.mismatch_strategy.value,
            "defaultOutroSeconds": self.default_outro_seconds,
            "extendLastWeights": list(self.extend_last_weights),
            "assignments": [{
                "sceneId": item.scene_id,
                "audioPath": stored_path(item.audio_path),
                "trimStartSeconds": item.trim_start_seconds,
                "trimEndSeconds": item.trim_end_seconds,
                "leadingPaddingSeconds": item.leading_padding_seconds,
                "trailingPaddingSeconds": item.trailing_padding_seconds,
                "enabled": item.enabled,
            } for item in self.assignments],
        }

    @classmethod
    def from_dict(cls, value: object, base_dir: Path) -> NarrationMappingSettings:
        if not isinstance(value, dict):
            raise ValueError("'narrationMapping' must be an object")
        raw_assignments = value.get("assignments", [])
        if not isinstance(raw_assignments, list) or any(not isinstance(item, dict) for item in raw_assignments):
            raise ValueError("Narration assignments must be an array of objects.")
        assignments: list[SceneNarrationAssignment] = []
        for item in raw_assignments:
            raw_path = item.get("audioPath")
            raw_path_text = str(raw_path) if raw_path not in {None, ""} else ""
            path = Path(raw_path_text) if raw_path_text else None
            if (
                path is not None
                and not path.is_absolute()
                and not PureWindowsPath(raw_path_text).is_absolute()
            ):
                # Project files use POSIX separators, but schema versions written
                # on Windows may contain backslashes. Accept both on every OS.
                path = base_dir / Path(raw_path_text.replace("\\", "/"))
            assignments.append(SceneNarrationAssignment(
                scene_id=str(item.get("sceneId", "")), audio_path=path,
                trim_start_seconds=float(item.get("trimStartSeconds", 0.0)),
                trim_end_seconds=(float(item["trimEndSeconds"]) if item.get("trimEndSeconds") is not None else None),
                leading_padding_seconds=float(item.get("leadingPaddingSeconds", 0.0)),
                trailing_padding_seconds=float(item.get("trailingPaddingSeconds", 0.0)),
                enabled=bool(item.get("enabled", True)),
            ))
        weights = value.get("extendLastWeights", [1.0, 1.0])
        if not isinstance(weights, list) or len(weights) != 2:
            raise ValueError("extendLastWeights must contain two values.")
        result = cls(
            mismatch_strategy=NarrationMismatchStrategy.from_value(str(value.get("mismatchStrategy", "outro"))),
            default_outro_seconds=float(value.get("defaultOutroSeconds", 4.0)),
            extend_last_weights=(float(weights[0]), float(weights[1])),
            assignments=assignments,
        )
        result.validate()
        return result


@dataclass(frozen=True, slots=True)
class ResolvedNarrationClip:
    scene_id: str
    audio_path: Path | None
    source_duration_seconds: float | None
    trim_start_seconds: float
    trim_end_seconds: float | None
    leading_padding_seconds: float
    trailing_padding_seconds: float
    frame_count: int
    warning: str | None = None

    @property
    def has_audio(self) -> bool:
        return self.audio_path is not None and self.warning is None


@dataclass(frozen=True, slots=True)
class NarrationMappingResult:
    scene_frames: tuple[int, ...]
    clips: tuple[ResolvedNarrationClip, ...]
    warnings: tuple[str, ...] = ()

    @property
    def total_frames(self) -> int:
        return sum(self.scene_frames)
