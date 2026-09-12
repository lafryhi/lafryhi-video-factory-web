from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path, PureWindowsPath
from typing import Any
from uuid import uuid4


MOTION_INTENSITY_LEVELS: dict[str, float] = {
    "Low": 0.25,
    "Medium": 0.55,
    "High": 0.85,
}


class MotionPreset(str, Enum):
    STATIC = "Static"
    ZOOM_IN = "ZoomIn"
    ZOOM_OUT = "ZoomOut"
    PAN_LEFT = "PanLeft"
    PAN_RIGHT = "PanRight"
    PAN_UP = "PanUp"
    PAN_DOWN = "PanDown"
    ZOOM_IN_PAN_RIGHT = "ZoomInPanRight"
    ZOOM_IN_PAN_LEFT = "ZoomInPanLeft"

    @property
    def display_name(self) -> str:
        names = {
            "ZoomIn": "Zoom In", "ZoomOut": "Zoom Out",
            "PanLeft": "Pan Left", "PanRight": "Pan Right",
            "PanUp": "Pan Up", "PanDown": "Pan Down",
            "ZoomInPanRight": "Zoom In + Pan Right",
            "ZoomInPanLeft": "Zoom In + Pan Left",
        }
        return names.get(self.value, self.value)

    @classmethod
    def from_value(cls, value: str | MotionPreset) -> MotionPreset:
        if isinstance(value, cls):
            return value
        compact = value.replace(" ", "").replace("+", "").strip()
        for preset in cls:
            if compact.casefold() in {preset.value.casefold(), preset.name.replace("_", "").casefold()}:
                return preset
        raise ValueError(f"Unknown motion preset: {value}")


@dataclass(slots=True)
class SceneMotionSettings:
    image_path: Path
    duration_seconds: float = 6.0
    motion: MotionPreset = MotionPreset.ZOOM_IN
    motion_intensity: float = MOTION_INTENSITY_LEVELS["Low"]
    start_zoom: float = 1.0
    end_zoom: float = 1.15
    transition: str = "fade"
    transition_duration_seconds: float = 0.6
    timing_weight: float = 1.0
    scene_id: str = field(default_factory=lambda: str(uuid4()))
    extra_fields: dict[str, Any] = field(default_factory=dict, repr=False)

    def to_dict(self, base_path: Path | None = None) -> dict[str, Any]:
        image = self.image_path
        if base_path:
            try:
                image = image.resolve().relative_to(base_path.resolve())
            except ValueError:
                pass
        payload = dict(self.extra_fields)
        payload.update({
            "sceneId": self.scene_id,
            "imagePath": image.as_posix(),
            "durationSeconds": self.duration_seconds,
            "motion": self.motion.value,
            "motionIntensity": self.motion_intensity,
            "startZoom": self.start_zoom,
            "endZoom": self.end_zoom,
            "transition": self.transition,
            "transitionDurationSeconds": self.transition_duration_seconds,
            "timingWeight": self.timing_weight,
        })
        return payload

    @classmethod
    def from_dict(cls, value: dict[str, Any], base_path: Path | None = None) -> SceneMotionSettings:
        image_text = str(value.get("imagePath", ""))
        image = Path(image_text)
        if base_path and not image.is_absolute() and not PureWindowsPath(image_text).is_absolute():
            image = base_path / Path(image_text.replace("\\", "/"))
        known = {
            "sceneId", "imagePath", "durationSeconds", "motion", "motionIntensity",
            "startZoom", "endZoom", "transition", "transitionDurationSeconds", "timingWeight",
        }
        return cls(
            image_path=image,
            scene_id=str(value.get("sceneId") or uuid4()),
            duration_seconds=float(value.get("durationSeconds", 6.0)),
            motion=MotionPreset.from_value(str(value.get("motion", "ZoomIn"))),
            motion_intensity=float(value.get("motionIntensity", MOTION_INTENSITY_LEVELS["Low"])),
            start_zoom=float(value.get("startZoom", 1.0)),
            end_zoom=float(value.get("endZoom", 1.15)),
            transition=str(value.get("transition", "fade")),
            transition_duration_seconds=float(value.get("transitionDurationSeconds", 0.6)),
            timing_weight=float(value.get("timingWeight", 1.0)),
            extra_fields={key: item for key, item in value.items() if key not in known},
        )


@dataclass(frozen=True, slots=True)
class VideoRenderSettings:
    width: int
    height: int
    fps: int


@dataclass(frozen=True, slots=True)
class SceneRenderResult:
    output_path: Path
    duration_seconds: float
    frame_count: int
