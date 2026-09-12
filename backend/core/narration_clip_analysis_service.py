from __future__ import annotations

from pathlib import Path
import threading

from core.audio_analysis_service import AudioAnalysisCancelled, AudioAnalysisError, AudioAnalysisService


class NarrationClipAnalysisError(RuntimeError):
    pass


class NarrationClipAnalysisCancelled(NarrationClipAnalysisError):
    pass


class NarrationClipAnalysisService:
    """Offline duration probing for per-scene narration clips."""

    def __init__(self, audio_analysis: AudioAnalysisService) -> None:
        self.audio_analysis = audio_analysis

    def duration(self, path: str | Path, cancellation_event: threading.Event | None = None) -> float:
        source = Path(path)
        if not source.is_file():
            raise NarrationClipAnalysisError(f"Narration clip does not exist: {source}")
        try:
            return self.audio_analysis.duration(source, cancellation_event)
        except AudioAnalysisCancelled as exc:
            raise NarrationClipAnalysisCancelled(str(exc)) from exc
        except AudioAnalysisError as exc:
            raise NarrationClipAnalysisError(f"Narration clip is unreadable: {source.name}") from exc
