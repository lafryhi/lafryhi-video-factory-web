from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from core.scene_motion_settings import MOTION_INTENSITY_LEVELS, MotionPreset, SceneMotionSettings
from core.audio_timing_settings import AudioTimingMode, AudioTimingSettings
from core.narration_mapping_models import NarrationMappingSettings
from core.project_model import VideoFormat


@dataclass(slots=True)
class SceneConfigurationDocument:
    scenes: list[SceneMotionSettings]
    normalized_legacy_mode: str
    audio_timing: AudioTimingSettings | None
    warnings: list[str]
    migration_required: bool
    preserved_root_fields: dict[str, object]
    narration_mapping: NarrationMappingSettings | None = None
    video_format: VideoFormat = VideoFormat.LANDSCAPE_16_9


class SceneConfigurationService:
    SCHEMA_VERSION = 4
    _preserved_root_fields: dict[Path, dict[str, object]] = {}

    @staticmethod
    def create_defaults(images: list[Path]) -> list[SceneMotionSettings]:
        sequence = (MotionPreset.ZOOM_IN, MotionPreset.PAN_RIGHT, MotionPreset.PAN_LEFT)
        return [
            SceneMotionSettings(
                image_path=image,
                motion=sequence[index % len(sequence)],
                motion_intensity=MOTION_INTENSITY_LEVELS["Low"],
                start_zoom=1.0 if index % 3 == 0 else 1.08,
                end_zoom=1.18 if index % 3 == 0 else 1.12,
            )
            for index, image in enumerate(images)
        ]

    @staticmethod
    def save(
        path: str | Path,
        scenes: list[SceneMotionSettings],
        timing_mode: str = "auto",
        audio_timing: AudioTimingSettings | None = None,
        preserved_root_fields: dict[str, object] | None = None,
        narration_mapping: NarrationMappingSettings | None = None,
        video_format: VideoFormat = VideoFormat.LANDSCAPE_16_9,
    ) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = timing_mode.casefold()
        if mode not in {"auto", "manual"}:
            raise ValueError("Scene timing mode must be 'auto' or 'manual'.")
        canonical_timing = audio_timing or AudioTimingSettings(
            mode=AudioTimingMode.MANUAL if mode == "manual" else AudioTimingMode.EVEN,
            manual_durations_seconds=[scene.duration_seconds for scene in scenes] if mode == "manual" else None,
        )
        payload = dict(
            preserved_root_fields
            if preserved_root_fields is not None
            else SceneConfigurationService._preserved_root_fields.get(target.resolve(), {})
        )
        payload.update({
            "schemaVersion": SceneConfigurationService.SCHEMA_VERSION,
            "videoFormat": VideoFormat.from_value(video_format).key,
            "audioTiming": canonical_timing.to_dict(),
            "scenes": [scene.to_dict(target.parent) for scene in scenes],
        })
        if narration_mapping is not None:
            payload["narrationMapping"] = narration_mapping.to_dict(target.parent)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(target)
        return target

    @staticmethod
    def load(path: str | Path) -> list[SceneMotionSettings]:
        scenes, _mode = SceneConfigurationService.load_with_timing_mode(path)
        return scenes

    @staticmethod
    def load_with_timing_mode(path: str | Path) -> tuple[list[SceneMotionSettings], str]:
        scenes, mode, _audio_timing, _warnings = SceneConfigurationService.load_with_audio_timing(path)
        return scenes, mode

    @staticmethod
    def load_with_audio_timing(
        path: str | Path,
    ) -> tuple[list[SceneMotionSettings], str, AudioTimingSettings | None, list[str]]:
        document = SceneConfigurationService.load_document(path)
        return (
            document.scenes, document.normalized_legacy_mode,
            document.audio_timing, document.warnings,
        )

    @staticmethod
    def load_document(path: str | Path) -> SceneConfigurationDocument:
        source = Path(path)
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise TypeError("configuration root must be an object")
            schema = payload.get("schemaVersion", 1)
            if not isinstance(schema, int) or schema < 1:
                raise ValueError("'schemaVersion' must be a positive integer")
            if schema > SceneConfigurationService.SCHEMA_VERSION:
                raise ValueError(
                    f"Unsupported future scene configuration schema version: {schema}"
                )
            values = payload["scenes"]
            if not isinstance(values, list):
                raise TypeError("'scenes' must be an array")
            if any(not isinstance(item, dict) for item in values):
                raise TypeError("every scene must be an object")
            missing_scene_ids = any(not str(item.get("sceneId", "")).strip() for item in values)
            legacy_present = "timingMode" in payload
            mode = str(payload.get("timingMode", "auto")).casefold()
            if mode not in {"auto", "manual"}:
                raise ValueError("'timingMode' must be 'auto' or 'manual'")
            audio_timing: AudioTimingSettings | None = None
            warnings: list[str] = []
            if "audioTiming" in payload:
                audio_timing, warnings = AudioTimingSettings.from_dict(payload["audioTiming"])
                normalized = "manual" if audio_timing.mode is AudioTimingMode.MANUAL else "auto"
                if legacy_present and normalized != mode:
                    warnings.append(
                        "Legacy timingMode conflicts with audioTiming.mode; audioTiming.mode was used."
                    )
                mode = normalized
            if schema < SceneConfigurationService.SCHEMA_VERSION:
                warnings.append(
                    f"Legacy scene configuration was migrated in memory to schema version {SceneConfigurationService.SCHEMA_VERSION}."
                )
            narration_mapping = (
                NarrationMappingSettings.from_dict(payload["narrationMapping"], source.parent)
                if "narrationMapping" in payload else None
            )
            if "videoFormat" in payload:
                video_format = VideoFormat.from_value(payload["videoFormat"])
            else:
                video_format = VideoFormat.LANDSCAPE_16_9
                warnings.append(
                    "Legacy project has no videoFormat; Landscape 16:9 was applied."
                )
            known = {
                "schemaVersion", "timingMode", "audioTiming", "narrationMapping",
                "videoFormat", "scenes",
            }
            preserved = {
                key: item for key, item in payload.items() if key not in known
            }
            SceneConfigurationService._preserved_root_fields[source.resolve()] = preserved
            migration_required = (
                schema < SceneConfigurationService.SCHEMA_VERSION
                or missing_scene_ids
                or "audioTiming" not in payload
                or "timingMode" in payload
                or "videoFormat" not in payload
            )
            if missing_scene_ids:
                warnings.append("Missing scene IDs were generated; save migration to preserve them.")
            return SceneConfigurationDocument(
                scenes=[SceneMotionSettings.from_dict(item, source.parent) for item in values],
                normalized_legacy_mode=mode,
                audio_timing=audio_timing,
                warnings=warnings,
                migration_required=migration_required,
                preserved_root_fields=preserved,
                narration_mapping=narration_mapping,
                video_format=video_format,
            )
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise ValueError(f"Unable to load scene configuration '{source}': {exc}") from exc

    @staticmethod
    def save_document(path: str | Path, document: SceneConfigurationDocument) -> Path:
        return SceneConfigurationService.save(
            path, document.scenes, document.normalized_legacy_mode,
            document.audio_timing, document.preserved_root_fields,
            document.narration_mapping, document.video_format,
        )

    @staticmethod
    def migrate(
        path: str | Path,
        default_minimum_scene_seconds: float = 4.0,
    ) -> SceneConfigurationDocument:
        """Load and atomically persist schema-v2 IDs/timing, returning the canonical document."""
        document = SceneConfigurationService.load_document(path)
        if document.migration_required:
            if document.audio_timing is None:
                document.audio_timing = AudioTimingSettings(
                    mode=(AudioTimingMode.MANUAL
                          if document.normalized_legacy_mode == "manual"
                          else AudioTimingMode.EVEN),
                    minimum_scene_seconds=default_minimum_scene_seconds,
                )
            SceneConfigurationService.save_document(path, document)
            canonical = SceneConfigurationService.load_document(path)
            canonical.warnings = [*document.warnings, *canonical.warnings]
            return canonical
        return document
