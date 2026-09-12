from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import warnings

from core.audio_timing_settings import AudioSyncResult
from core.frame_timing import allocate_scene_frames
from core.project_model import ScenePlan
from core.scene_motion_settings import SceneMotionSettings


class LegacyPlanningError(RuntimeError):
    pass


MOTION_SEQUENCES: dict[str, list[str]] = {
    "Low": ["Zoom In", "Pan Left", "Zoom Out", "Pan Right"],
    "Medium": ["Zoom In", "Pan Left", "Pan Up", "Zoom Out", "Pan Right", "Pan Down"],
    "High": ["Zoom In", "Pan Left", "Pan Up", "Zoom Out", "Pan Right", "Pan Down", "Zoom In", "Pan Right"],
}


def _deprecated() -> None:
    warnings.warn(
        "Legacy timing planning is deprecated; use TimelinePlanningService.resolve().",
        DeprecationWarning,
        stacklevel=2,
    )


def build_scene_plan(image_paths: list[Path], voice_duration: float, minimum_scene_duration: float,
                     motion_intensity: str, fps: int = 30) -> tuple[list[ScenePlan], float, float]:
    _deprecated()
    if not image_paths:
        raise LegacyPlanningError("No image files were found in the selected folder.")
    effective_minimum = max(2.5, float(minimum_scene_duration))
    target_duration = max(voice_duration, effective_minimum * len(image_paths))
    frame_counts = allocate_scene_frames(
        [target_duration / len(image_paths)] * len(image_paths), fps,
        total_duration_seconds=target_duration,
    )
    motions = MOTION_SEQUENCES.get(motion_intensity, MOTION_SEQUENCES["Low"])
    plans: list[ScenePlan] = []
    for index, (image_path, frame_count) in enumerate(zip(image_paths, frame_counts)):
        motion = motions[index % len(motions)]
        if plans and motion == plans[-1].motion:
            motion = motions[(index + 1) % len(motions)]
        plans.append(ScenePlan(index + 1, image_path, frame_count / fps, motion,
                               frame_count=frame_count))
    return plans, sum(frame_counts) / fps, 0.0


def build_configured_scene_plan(
    image_paths: list[Path], voice_duration: float, minimum_scene_duration: float,
    motion_intensity: str, scenes: list[SceneMotionSettings] | None,
    timing_mode: str = "auto", fps: int = 30,
) -> tuple[list[ScenePlan], float, float]:
    _deprecated()
    mode = timing_mode.casefold()
    if mode not in {"auto", "manual"}:
        raise LegacyPlanningError("Scene timing mode must be 'auto' or 'manual'.")
    automatic, automatic_total, automatic_transition = build_scene_plan(
        image_paths, voice_duration, minimum_scene_duration, motion_intensity, fps
    )
    if not scenes:
        return automatic, automatic_total, automatic_transition
    if len(scenes) != len(image_paths):
        raise LegacyPlanningError("Scene configuration does not match the number of project images.")
    if mode == "manual":
        frame_counts = allocate_scene_frames([scene.duration_seconds for scene in scenes], fps)
        plans = [ScenePlan(
            index, scene.image_path, frame_count / fps, scene.motion.display_name,
            replace(scene, duration_seconds=frame_count / fps), frame_count,
        ) for index, (scene, frame_count) in enumerate(zip(scenes, frame_counts), 1)]
        return plans, sum(frame_counts) / fps, 0.0
    plans = [ScenePlan(
        base.index, scene.image_path, base.duration, scene.motion.display_name,
        replace(scene, duration_seconds=base.duration), base.frame_count,
    ) for base, scene in zip(automatic, scenes)]
    return plans, automatic_total, automatic_transition


def build_audio_synced_scene_plan(
    image_paths: list[Path], scenes: list[SceneMotionSettings] | None,
    result: AudioSyncResult, motion_intensity: str,
) -> tuple[list[ScenePlan], float, float]:
    _deprecated()
    if result.fps <= 0 or len(result.scene_frames) != len(image_paths):
        raise LegacyPlanningError("Audio timing result does not match the current project.")
    if any(frame_count < 1 for frame_count in result.scene_frames):
        raise LegacyPlanningError("Audio timing result contains an empty scene.")
    if sum(result.scene_frames) != result.total_frames:
        raise LegacyPlanningError("Audio timing result frame total is inconsistent.")
    fallback, _total, _transition = build_scene_plan(
        image_paths, result.total_frames / result.fps, 0.0, motion_intensity, result.fps
    )
    plans: list[ScenePlan] = []
    for index, (image, frame_count) in enumerate(zip(image_paths, result.scene_frames)):
        scene = scenes[index] if scenes else None
        duration = frame_count / result.fps
        plans.append(ScenePlan(
            index + 1, image, duration,
            scene.motion.display_name if scene else fallback[index].motion,
            replace(scene, duration_seconds=duration) if scene else None, frame_count,
        ))
    return plans, result.total_frames / result.fps, 0.0
