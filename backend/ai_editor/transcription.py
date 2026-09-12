"""Optional local model only: never downloads weights during a request."""
import os
from functools import lru_cache
from pathlib import Path
from typing import Protocol
from .models import Segment


class Transcriber(Protocol):
    def transcribe(self, path: Path, language: str) -> list[Segment]: ...


class UnavailableTranscriber:
    def transcribe(self, path, language):
        raise RuntimeError("Transcription is not configured. Silence editing remains available; subtitles and filler removal require Whisper.")


class WhisperTranscriber:
    def __init__(self, model_path):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(model_path, device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)

    def transcribe(self, path, language):
        segments, _ = self.model.transcribe(str(path), language=language, word_timestamps=True, vad_filter=True, beam_size=3)
        return [Segment(start=w.start, end=w.end, text=w.word.strip()) for s in segments for w in (s.words or []) if w.end > w.start and w.word.strip()]


@lru_cache(maxsize=1)
def provider() -> Transcriber:
    model = os.environ.get("AI_EDITOR_WHISPER_MODEL_DIR", "")
    return WhisperTranscriber(model) if model and Path(model).is_dir() else UnavailableTranscriber()
