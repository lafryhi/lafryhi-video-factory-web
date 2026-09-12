from __future__ import annotations

from pathlib import Path
import wave

from mutagen import File as MutagenFile


def get_audio_duration(audio_path: str | Path) -> float:
    path = Path(audio_path)
    if not path.is_file():
        raise FileNotFoundError(str(path))

    duration = _duration_with_mutagen(path)
    if duration is not None and duration > 0:
        return float(duration)

    if path.suffix.lower() in {".wav", ".wave"}:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate() or 1
            return float(frames / rate)

    raise RuntimeError(f"Unable to read audio duration: {path}")


def _duration_with_mutagen(path: Path) -> float | None:
    audio = MutagenFile(str(path))
    if audio is None:
        return None
    info = getattr(audio, "info", None)
    length = getattr(info, "length", None)
    if length is None:
        return None
    return float(length)
