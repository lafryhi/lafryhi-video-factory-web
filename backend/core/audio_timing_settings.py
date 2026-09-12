from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math


class AudioTimingMode(str, Enum):
    EVEN = "even"
    WEIGHTED = "weighted"
    SILENCE_AWARE = "silence_aware"
    MANUAL = "manual"
    SCENE_NARRATION = "scene_narration"

    @property
    def display_name(self) -> str:
        return {
            self.EVEN: "Even Distribution",
            self.WEIGHTED: "Weighted Distribution",
            self.SILENCE_AWARE: "Silence-Aware",
            self.MANUAL: "Manual",
            self.SCENE_NARRATION: "Scene Narration",
        }[self]

    @classmethod
    def from_value(cls, value: str | AudioTimingMode) -> AudioTimingMode:
        if isinstance(value, cls):
            return value
        normalized = value.strip().casefold().replace("-", "_").replace(" ", "_")
        aliases = {item.display_name.casefold().replace("-", "_").replace(" ", "_"): item for item in cls}
        aliases.update({item.value: item for item in cls})
        try:
            return aliases[normalized]
        except KeyError as exc:
            raise ValueError(f"Unknown audio timing mode: {value}") from exc


@dataclass(slots=True)
class AudioTimingSettings:
    mode: AudioTimingMode = AudioTimingMode.EVEN
    silence_threshold_db: float = -35.0
    minimum_silence_seconds: float = 0.35
    minimum_scene_seconds: float = 1.0
    weights: list[float] | None = None
    manual_durations_seconds: list[float] | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "mode": self.mode.value,
            "silenceThresholdDb": self.silence_threshold_db,
            "minimumSilenceSeconds": self.minimum_silence_seconds,
            "minimumSceneSeconds": self.minimum_scene_seconds,
            "weights": list(self.weights) if self.weights is not None else None,
        }

    @classmethod
    def from_dict(cls, value: object) -> tuple[AudioTimingSettings, list[str]]:
        defaults = cls()
        warnings: list[str] = []
        if not isinstance(value, dict):
            return defaults, ["Invalid audioTiming configuration; Even Distribution defaults were used."]
        try:
            mode = AudioTimingMode.from_value(str(value.get("mode", defaults.mode.value)))
        except ValueError:
            mode = defaults.mode
            warnings.append("Invalid audio timing mode; Even Distribution was used.")
        try:
            settings = cls(
                mode=mode,
                silence_threshold_db=float(value.get("silenceThresholdDb", defaults.silence_threshold_db)),
                minimum_silence_seconds=float(value.get("minimumSilenceSeconds", defaults.minimum_silence_seconds)),
                minimum_scene_seconds=float(value.get("minimumSceneSeconds", defaults.minimum_scene_seconds)),
                weights=[float(item) for item in value["weights"]] if isinstance(value.get("weights"), list) else None,
            )
        except (TypeError, ValueError):
            return defaults, warnings + ["Invalid audioTiming values; Even Distribution defaults were used."]
        numeric = (settings.silence_threshold_db, settings.minimum_silence_seconds, settings.minimum_scene_seconds)
        invalid_weights = settings.weights is not None and any(
            not math.isfinite(weight) or weight <= 0 for weight in settings.weights
        )
        if (any(not math.isfinite(item) for item in numeric)
                or settings.minimum_silence_seconds <= 0
                or settings.minimum_scene_seconds <= 0
                or invalid_weights
                or (settings.mode is AudioTimingMode.WEIGHTED and settings.weights is None)):
            return defaults, warnings + ["Invalid audioTiming values; Even Distribution defaults were used."]
        return settings, warnings


@dataclass(frozen=True, slots=True)
class AudioSyncResult:
    total_frames: int
    fps: int
    scene_frames: list[int]
    scene_durations: list[float]
    audio_duration_seconds: float
    detected_silence_boundaries: list[float]
    mode_used: str
    warnings: list[str] = field(default_factory=list)
