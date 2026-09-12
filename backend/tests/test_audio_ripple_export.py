from __future__ import annotations

from array import array
import math
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

from backend import app as _web  # Adds the backend package root for shared core imports.
from core.project_model import ProjectSettings
from core.video_engine import _build_audio_only_filter, resolve_ffmpeg_exe


class AudioRippleExportTests(unittest.TestCase):
    RATE = 48_000

    def _source(self, path: Path) -> None:
        samples = array("h")
        levels = (.1, .2, .4, .8)
        for second, level in enumerate(levels):
            for index in range(self.RATE):
                sample = level * math.sin(2 * math.pi * 440 * (second * self.RATE + index) / self.RATE)
                samples.append(round(sample * 32767))
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(self.RATE)
            output.writeframes(samples.tobytes())

    def _rms(self, path: Path, second: int) -> float:
        with wave.open(str(path), "rb") as source:
            source.setpos(round((second + .25) * source.getframerate()))
            frames = source.readframes(round(.5 * source.getframerate()))
        samples = array("h"); samples.frombytes(frames)
        return math.sqrt(sum(value * value for value in samples) / max(1, len(samples))) / 32767

    def _render(self, folder: Path, gaps: list[tuple[float, float]]) -> list[float]:
        source = folder / f"source-{len(gaps)}.wav"
        output = folder / f"output-{len(gaps)}.wav"
        script = folder / f"filter-{len(gaps)}.txt"
        self._source(source)
        settings = ProjectSettings(
            images_folder=folder,
            voice_file=source,
            output_folder=folder,
            voice_removed_ranges=[(1.0, 2.0)],
            voice_timeline_gaps=gaps,
        )
        script.write_text(_build_audio_only_filter(settings, 4.0), encoding="utf-8")
        subprocess.run([
            str(resolve_ffmpeg_exe()), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1:d=4", "-i", str(source),
            "-filter_complex_threads", "1", "-filter_complex_script", str(script),
            "-map", "[aout]", "-c:a", "pcm_s16le", "-t", "4", str(output),
        ], check=True, capture_output=True)
        return [self._rms(output, second) for second in range(4)]

    def test_delete_ripples_and_only_an_explicit_gap_exports_silence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            rippled = self._render(folder, [])
            self.assertAlmostEqual(rippled[0], .1 / math.sqrt(2), delta=.015)
            self.assertAlmostEqual(rippled[1], .4 / math.sqrt(2), delta=.02)
            self.assertAlmostEqual(rippled[2], .8 / math.sqrt(2), delta=.03)
            self.assertLess(rippled[3], .005)

            with_gap = self._render(folder, [(2.0, 1.0)])
            self.assertAlmostEqual(with_gap[0], .1 / math.sqrt(2), delta=.015)
            self.assertLess(with_gap[1], .005)
            self.assertAlmostEqual(with_gap[2], .4 / math.sqrt(2), delta=.02)
            self.assertAlmostEqual(with_gap[3], .8 / math.sqrt(2), delta=.03)


if __name__ == "__main__":
    unittest.main()
