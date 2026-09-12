from __future__ import annotations

import math
from pathlib import Path
import threading
from typing import Callable

from core.audio_analysis_service import AudioAnalysisCancelled, AudioAnalysisError, AudioAnalysisService
from core.audio_timing_settings import AudioSyncResult, AudioTimingMode, AudioTimingSettings
from core.frame_timing import allocate_scene_frames, frames_for_duration


class AudioSyncError(RuntimeError):
    pass


class AudioSyncCancelled(AudioSyncError):
    pass


class AudioSyncCell:
    def __init__(self, analysis_service: AudioAnalysisService) -> None:
        self.analysis_service = analysis_service

    def analyze(
        self,
        audio_path: str | Path,
        scene_count: int,
        fps: int,
        settings: AudioTimingSettings,
        cancellation_event: threading.Event | None = None,
        progress_callback: Callable[[float], None] | None = None,
        trim_start_seconds: float = 0.0,
        trim_end_seconds: float | None = None,
    ) -> AudioSyncResult:
        self._validate(scene_count, fps, settings)
        self._check_cancel(cancellation_event)
        if progress_callback:
            progress_callback(5.0)
        try:
            audio_duration = self.analysis_service.duration(audio_path, cancellation_event)
        except AudioAnalysisCancelled as exc:
            raise AudioSyncCancelled(str(exc)) from exc
        except AudioAnalysisError as exc:
            raise AudioSyncError(str(exc)) from exc
        if progress_callback:
            progress_callback(25.0)

        if not math.isfinite(trim_start_seconds) or trim_start_seconds < 0:
            raise AudioSyncError("Narration trim start must be a non-negative finite number.")
        effective_end = audio_duration if trim_end_seconds is None else trim_end_seconds
        if not math.isfinite(effective_end) or effective_end <= trim_start_seconds or effective_end > audio_duration + .01:
            raise AudioSyncError("Narration trim range is outside the audio file or has no duration.")
        audio_duration = min(audio_duration, effective_end) - trim_start_seconds
        warnings: list[str] = []
        minimum_total = max(scene_count / fps, settings.minimum_scene_seconds * scene_count)
        project_duration = max(audio_duration, minimum_total)
        if audio_duration < scene_count / fps:
            warnings.append("Narration is shorter than one frame per scene; video timing was extended.")
        elif audio_duration < minimum_total:
            warnings.append("Narration is shorter than the configured minimum scene duration; video timing was extended.")

        mode = settings.mode
        boundaries: list[float] = []
        if mode is AudioTimingMode.MANUAL:
            durations = settings.manual_durations_seconds
            if durations is None or len(durations) != scene_count:
                raise AudioSyncError("Manual timing requires one duration for every scene.")
            frames = allocate_scene_frames(durations, fps)
        elif mode is AudioTimingMode.WEIGHTED:
            assert settings.weights is not None
            frames = allocate_scene_frames(settings.weights, fps, total_duration_seconds=project_duration)
        elif mode is AudioTimingMode.SILENCE_AWARE:
            try:
                boundaries = self.analysis_service.detect_silence_boundaries(
                    audio_path, settings.silence_threshold_db, settings.minimum_silence_seconds,
                    cancellation_event, progress_callback,
                )
                boundaries = [value - trim_start_seconds for value in boundaries if trim_start_seconds < value < effective_end]
                durations = self._silence_durations(
                    audio_duration, scene_count, boundaries, settings.minimum_scene_seconds
                )
                if durations is None:
                    raise AudioAnalysisError("Silence boundaries were not usable.")
                frames = allocate_scene_frames(durations, fps, total_duration_seconds=project_duration)
            except AudioAnalysisCancelled as exc:
                raise AudioSyncCancelled(str(exc)) from exc
            except AudioAnalysisError:
                mode = AudioTimingMode.EVEN
                warnings.append("Silence analysis was unavailable or unusable; Even Distribution was used.")
                frames = allocate_scene_frames([1.0] * scene_count, fps, total_duration_seconds=project_duration)
        else:
            frames = allocate_scene_frames([1.0] * scene_count, fps, total_duration_seconds=project_duration)

        self._check_cancel(cancellation_event)
        if progress_callback:
            progress_callback(100.0)
        return AudioSyncResult(
            total_frames=sum(frames), fps=fps, scene_frames=frames,
            scene_durations=[frame_count / fps for frame_count in frames],
            audio_duration_seconds=audio_duration,
            detected_silence_boundaries=boundaries,
            mode_used=mode.value, warnings=warnings,
        )

    @staticmethod
    def _silence_durations(
        audio_duration: float,
        scene_count: int,
        boundaries: list[float],
        minimum_scene_seconds: float,
    ) -> list[float] | None:
        if scene_count == 1:
            return [audio_duration]
        if audio_duration < minimum_scene_seconds * scene_count:
            return None
        usable = sorted(value for value in boundaries if minimum_scene_seconds <= value <= audio_duration - minimum_scene_seconds)
        selected: list[float] = []
        for index in range(1, scene_count):
            ideal = audio_duration * index / scene_count
            candidates = [value for value in usable if all(abs(value - other) >= minimum_scene_seconds for other in selected)]
            choice = min(candidates, key=lambda value: abs(value - ideal)) if candidates else ideal
            selected.append(choice)
        selected.sort()
        points = [0.0, *selected, audio_duration]
        durations = [points[index + 1] - points[index] for index in range(scene_count)]
        if any(value < minimum_scene_seconds - 1e-9 for value in durations):
            return [audio_duration / scene_count] * scene_count
        return durations

    @staticmethod
    def _validate(scene_count: int, fps: int, settings: AudioTimingSettings) -> None:
        if scene_count < 1:
            raise AudioSyncError("Scene count must be at least one.")
        if fps <= 0 or fps > 240:
            raise AudioSyncError("FPS must be between 1 and 240.")
        numeric = (settings.silence_threshold_db, settings.minimum_silence_seconds, settings.minimum_scene_seconds)
        if any(not math.isfinite(value) for value in numeric):
            raise AudioSyncError("Audio timing values must be finite numbers.")
        if settings.minimum_silence_seconds <= 0 or settings.minimum_scene_seconds <= 0:
            raise AudioSyncError("Minimum silence and scene durations must be greater than zero.")
        if settings.mode is AudioTimingMode.WEIGHTED:
            if settings.weights is None or len(settings.weights) != scene_count:
                raise AudioSyncError("Weighted timing requires one weight for every scene.")
            if any(not math.isfinite(value) or value <= 0 for value in settings.weights):
                raise AudioSyncError("Every timing weight must be a positive finite number.")

    @staticmethod
    def _check_cancel(event: threading.Event | None) -> None:
        if event and event.is_set():
            raise AudioSyncCancelled("Audio timing analysis was cancelled.")
