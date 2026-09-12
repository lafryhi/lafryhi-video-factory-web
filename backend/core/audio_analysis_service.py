from __future__ import annotations

import math
from pathlib import Path
import re
import subprocess
import threading
import queue
from typing import Callable

from core.audio_utils import get_audio_duration
from core.process_utils import shutdown_process


class AudioAnalysisError(RuntimeError):
    pass


class AudioAnalysisCancelled(AudioAnalysisError):
    pass


class AudioAnalysisService:
    _SILENCE_START = re.compile(r"silence_start:\s*([-+0-9.eE]+)")
    _SILENCE_END = re.compile(r"silence_end:\s*([-+0-9.eE]+)")

    def __init__(self, ffmpeg_path: str | Path) -> None:
        self.ffmpeg_path = Path(ffmpeg_path)

    def duration(self, audio_path: str | Path, cancellation_event: threading.Event | None = None) -> float:
        if cancellation_event and cancellation_event.is_set():
            raise AudioAnalysisCancelled("Audio analysis was cancelled.")
        try:
            duration = get_audio_duration(audio_path)
        except Exception as exc:
            raise AudioAnalysisError("Narration audio is unreadable or unsupported.") from exc
        if cancellation_event and cancellation_event.is_set():
            raise AudioAnalysisCancelled("Audio analysis was cancelled.")
        if not math.isfinite(duration) or duration <= 0:
            raise AudioAnalysisError("Narration duration is invalid.")
        return duration

    def detect_silence_boundaries(
        self,
        audio_path: str | Path,
        threshold_db: float,
        minimum_silence_seconds: float,
        cancellation_event: threading.Event | None = None,
        progress_callback: Callable[[float], None] | None = None,
    ) -> list[float]:
        command = [
            str(self.ffmpeg_path), "-hide_banner", "-nostdin", "-i", str(audio_path),
            "-af", f"silencedetect=noise={threshold_db:.3f}dB:d={minimum_silence_seconds:.6f}",
            "-f", "null", "-",
        ]
        try:
            process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace",
                creationflags=subprocess.CREATE_NO_WINDOW if __import__("os").name == "nt" else 0,
            )
        except OSError as exc:
            raise AudioAnalysisError("FFmpeg could not start for silence analysis.") from exc
        assert process.stderr is not None
        lines: list[str] = []
        line_queue: queue.Queue[str | None] = queue.Queue()

        def read_stderr() -> None:
            assert process.stderr is not None
            for line in process.stderr:
                line_queue.put(line)
            line_queue.put(None)

        reader = threading.Thread(target=read_stderr, daemon=True)
        reader.start()
        try:
            reader_done = False
            while not reader_done:
                if cancellation_event and cancellation_event.is_set():
                    shutdown_process(process)
                    raise AudioAnalysisCancelled("Audio analysis was cancelled.")
                try:
                    line = line_queue.get(timeout=.1)
                except queue.Empty:
                    if process.poll() is not None and not reader.is_alive():
                        break
                    continue
                if line is None:
                    reader_done = True
                else:
                    lines.append(line)
            return_code = process.wait()
            reader.join(timeout=1)
            if cancellation_event and cancellation_event.is_set():
                raise AudioAnalysisCancelled("Audio analysis was cancelled.")
            if return_code != 0:
                raise AudioAnalysisError("FFmpeg silence analysis failed.")
            if progress_callback:
                progress_callback(70.0)
            return self.parse_silence_events(lines)
        finally:
            if process.poll() is None:
                shutdown_process(process)
            process.stderr.close()

    @classmethod
    def parse_silence_events(cls, lines: list[str]) -> list[float]:
        starts: list[float] = []
        boundaries: list[float] = []
        for line in lines:
            start_match = cls._SILENCE_START.search(line)
            if start_match:
                try:
                    starts.append(float(start_match.group(1)))
                except ValueError:
                    continue
            end_match = cls._SILENCE_END.search(line)
            if end_match and starts:
                try:
                    end = float(end_match.group(1))
                except ValueError:
                    continue
                start = starts.pop(0)
                if math.isfinite(start) and math.isfinite(end) and end > start:
                    boundaries.append((start + end) / 2.0)
        return sorted(set(boundaries))
