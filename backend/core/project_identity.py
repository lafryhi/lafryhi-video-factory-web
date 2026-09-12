from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from core.audio_timing_settings import AudioTimingSettings
from core.scene_motion_settings import SceneMotionSettings
from core.timeline_models import ResolvedScene, TimelineIdentity
from core.narration_mapping_models import NarrationMappingSettings


FINGERPRINT_BLOCK_SIZE = 64 * 1024
FINGERPRINT_SAMPLE_COUNT = 5


def _hash(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _file_identity(path: Path) -> dict[str, object]:
    resolved = path.resolve()
    stat = resolved.stat()
    sample_hash = hashlib.sha256()
    sample_hash.update(str(stat.st_size).encode("ascii"))
    if stat.st_size:
        last_start = max(0, stat.st_size - FINGERPRINT_BLOCK_SIZE)
        positions = {0, last_start}
        for index in range(1, FINGERPRINT_SAMPLE_COUNT - 1):
            position = int(last_start * index / (FINGERPRINT_SAMPLE_COUNT - 1))
            positions.add(position)
        with resolved.open("rb") as handle:
            for position in sorted(positions):
                handle.seek(position)
                block = handle.read(FINGERPRINT_BLOCK_SIZE)
                sample_hash.update(position.to_bytes(8, "big", signed=False))
                sample_hash.update(len(block).to_bytes(8, "big", signed=False))
                sample_hash.update(block)
    return {
        "path": str(resolved).casefold(),
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "sample_sha256": sample_hash.hexdigest(),
    }


def build_timeline_identity(
    narration_path: Path | None,
    scenes: list[SceneMotionSettings],
    timing: AudioTimingSettings,
    fps: int,
    narration_mapping: NarrationMappingSettings | None = None,
    project_version: int = 2,
    voice_trim_start_seconds: float = 0.0,
    voice_trim_end_seconds: float | None = None,
) -> TimelineIdentity:
    """Use path, size and nanosecond mtime; in-place edits preserving both can evade detection."""
    narration = (
        None if timing.mode.value == "scene_narration"
        else _hash(_file_identity(narration_path)) if narration_path else None
    )
    collection = _hash([
        {
            "scene_id": scene.scene_id,
            "source": _file_identity(scene.image_path),
            "order": index,
        }
        for index, scene in enumerate(scenes)
    ])
    timing_payload = {
        "mode": timing.mode.value,
        "fps_numerator": fps,
        "fps_denominator": 1,
        "silence_threshold_db": timing.silence_threshold_db,
        "minimum_silence_seconds": timing.minimum_silence_seconds,
        "minimum_scene_seconds": timing.minimum_scene_seconds,
        "weights": [scene.timing_weight for scene in scenes],
        "manual_durations": [scene.duration_seconds for scene in scenes]
        if timing.mode.value == "manual" else None,
        "voice_trim_start_seconds": voice_trim_start_seconds,
        "voice_trim_end_seconds": voice_trim_end_seconds,
    }
    if timing.mode.value == "scene_narration":
        mapping = narration_mapping or NarrationMappingSettings()
        by_id = mapping.by_scene_id()
        timing_payload["narration_mapping"] = {
            "mismatch_strategy": mapping.mismatch_strategy.value,
            "default_outro_seconds": mapping.default_outro_seconds,
            "extend_last_weights": list(mapping.extend_last_weights),
            "assignments": [
                {
                    "scene_id": scene.scene_id,
                    "audio": _file_identity(assignment.audio_path)
                    if (assignment := by_id.get(scene.scene_id)) and assignment.enabled and assignment.audio_path
                    else None,
                    "trim_start": assignment.trim_start_seconds if assignment else None,
                    "trim_end": assignment.trim_end_seconds if assignment else None,
                    "leading_padding": assignment.leading_padding_seconds if assignment else None,
                    "trailing_padding": assignment.trailing_padding_seconds if assignment else None,
                    "enabled": assignment.enabled if assignment else None,
                }
                for scene in scenes
            ],
        }
    return TimelineIdentity(narration, collection, _hash(timing_payload), project_version)


def timeline_identity_hash(identity: TimelineIdentity) -> str:
    return _hash({
        "narration": identity.narration_identity,
        "scenes": identity.scene_collection_identity,
        "timing": identity.timing_settings_identity,
        "version": identity.project_version,
    })


def resolved_timeline_hash(
    identity: TimelineIdentity,
    effective_mode: str,
    scenes: list[ResolvedScene],
    silence_boundaries: list[float],
    warnings: list[str],
    analysis_metadata: list[tuple[str, str]],
) -> str:
    """Identify a resolved output, separately from the identity of its inputs."""
    return _hash({
        "input_identity": {
            "narration": identity.narration_identity,
            "scenes": identity.scene_collection_identity,
            "timing": identity.timing_settings_identity,
            "version": identity.project_version,
        },
        "effective_mode": effective_mode,
        "scenes": [
            {
                "scene_id": scene.scene_id,
                "start": scene.start_frame,
                "end": scene.end_frame_exclusive,
                "frames": scene.frame_count,
            }
            for scene in scenes
        ],
        "silence_boundaries": silence_boundaries,
        "warnings": warnings,
        "analysis_metadata": analysis_metadata,
    })
