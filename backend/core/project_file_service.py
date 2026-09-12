from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path, PureWindowsPath

from core.project_model import ProjectSettings, VideoFormat, normalize_audio_gaps, normalize_audio_trim, normalize_removed_audio_ranges


@dataclass(slots=True)
class ProjectLoadResult:
    settings: ProjectSettings
    warnings: list[str]


class ProjectFileService:
    """Persist the project-level inputs that sit above per-scene configuration."""

    SCHEMA_VERSION = 1
    EXTENSION = ".lvf.json"

    @staticmethod
    def _stored_path(path: Path, base: Path) -> str:
        if path == Path():
            return ""
        resolved = path.resolve()
        try:
            return resolved.relative_to(base.resolve()).as_posix()
        except ValueError:
            return str(resolved)

    @staticmethod
    def _loaded_path(value: object, base: Path) -> Path:
        text = str(value or "").strip()
        if not text:
            return Path()
        candidate = Path(text)
        if candidate.is_absolute() or PureWindowsPath(text).is_absolute():
            return candidate
        return base / Path(text.replace("\\", "/"))

    @classmethod
    def save(cls, path: str | Path, settings: ProjectSettings) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        video_format = VideoFormat.from_value(settings.video_format)
        payload = {
            "schemaVersion": cls.SCHEMA_VERSION,
            "videoFormat": video_format.key,
            "imagesFolder": cls._stored_path(settings.images_folder, target.parent),
            "voiceFile": cls._stored_path(settings.voice_file, target.parent),
            "musicFile": (
                cls._stored_path(settings.music_file, target.parent)
                if settings.music_file is not None else ""
            ),
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
            "outputFolder": cls._stored_path(settings.output_folder, target.parent),
            "outputName": settings.output_name,
            "resolution": settings.effective_resolution,
            "fps": settings.fps,
            "fillMode": settings.fill_mode,
            "minimumSceneDuration": settings.minimum_scene_duration,
            "motionIntensity": settings.motion_intensity,
            "musicVolume": settings.music_volume,
        }
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temporary.replace(target)
        return target

    @classmethod
    def load(cls, path: str | Path) -> ProjectLoadResult:
        source = Path(path)
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise TypeError("project root must be an object")
            schema = payload.get("schemaVersion", 1)
            if not isinstance(schema, int) or schema < 1:
                raise ValueError("'schemaVersion' must be a positive integer")
            if schema > cls.SCHEMA_VERSION:
                raise ValueError(f"Unsupported future project schema version: {schema}")

            warnings: list[str] = []
            if "videoFormat" in payload:
                video_format = VideoFormat.from_value(payload["videoFormat"])
            else:
                video_format = VideoFormat.LANDSCAPE_16_9
                warnings.append(
                    "Legacy project has no videoFormat; Landscape 16:9 was applied."
                )

            base = source.parent
            resolution = str(payload.get("resolution", video_format.resolution))
            voice_trim = normalize_audio_trim(payload.get("voiceTrimStartSeconds", 0.0), payload.get("voiceTrimEndSeconds"))
            music_trim = normalize_audio_trim(payload.get("musicTrimStartSeconds", 0.0), payload.get("musicTrimEndSeconds"))
            removed_payload = payload.get("audioTimelineRemovedRanges", {})
            removed_payload = removed_payload if isinstance(removed_payload, dict) else {}
            raw_narration_removed = removed_payload.get("narration", {})
            gaps_payload = payload.get("audioTimelineGaps", {})
            gaps_payload = gaps_payload if isinstance(gaps_payload, dict) else {}
            raw_narration_gaps = gaps_payload.get("narration", {})
            settings = ProjectSettings(
                images_folder=cls._loaded_path(payload.get("imagesFolder"), base),
                voice_file=cls._loaded_path(payload.get("voiceFile"), base),
                music_file=(
                    cls._loaded_path(payload.get("musicFile"), base)
                    if str(payload.get("musicFile", "")).strip() else None
                ),
                output_folder=cls._loaded_path(payload.get("outputFolder"), base),
                output_name=str(payload.get("outputName", "final_video.mp4")),
                resolution=resolution,
                fps=int(payload.get("fps", 30)),
                fill_mode=str(payload.get("fillMode", "Fit with blurred background")),
                minimum_scene_duration=float(payload.get("minimumSceneDuration", 4.0)),
                motion_intensity=str(payload.get("motionIntensity", "Low")),
                music_volume=float(payload.get("musicVolume", 0.18)),
                video_format=video_format,
                voice_trim_start_seconds=voice_trim[0],
                voice_trim_end_seconds=voice_trim[1],
                music_trim_start_seconds=music_trim[0],
                music_trim_end_seconds=music_trim[1],
                voice_removed_ranges=normalize_removed_audio_ranges(removed_payload.get("voice")),
                music_removed_ranges=normalize_removed_audio_ranges(removed_payload.get("music")),
                narration_removed_ranges={
                    str(scene_id): normalize_removed_audio_ranges(ranges)
                    for scene_id, ranges in raw_narration_removed.items()
                } if isinstance(raw_narration_removed, dict) else {},
                voice_timeline_gaps=normalize_audio_gaps(gaps_payload.get("voice")),
                music_timeline_gaps=normalize_audio_gaps(gaps_payload.get("music")),
                narration_timeline_gaps={str(scene_id): normalize_audio_gaps(gaps) for scene_id, gaps in raw_narration_gaps.items()} if isinstance(raw_narration_gaps, dict) else {},
            )
            # Project format owns orientation; this also normalizes stale/missing
            # resolution values before the UI and exporter see them.
            settings.resolution = settings.effective_resolution
            return ProjectLoadResult(settings=settings, warnings=warnings)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise ValueError(f"Unable to load project '{source}': {exc}") from exc
