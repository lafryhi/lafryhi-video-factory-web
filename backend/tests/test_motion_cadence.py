from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest

from backend.core.scene_motion_cell import SceneMotionCell
from backend.core.scene_motion_settings import MotionPreset, SceneMotionSettings, VideoRenderSettings
from backend.core.video_engine import resolve_ffmpeg_exe


class MotionCadenceTests(unittest.TestCase):
    def test_low_pan_renders_every_requested_frame_without_holds(self) -> None:
        image = Path(__file__).resolve().parents[1] / "Demo" / "Images" / "02.jpg.png"
        settings = SceneMotionSettings(
            image_path=image,
            duration_seconds=3.0,
            motion=MotionPreset.PAN_RIGHT,
            motion_intensity=.25,
            start_zoom=1.08,
            end_zoom=1.12,
        )
        ffmpeg = resolve_ffmpeg_exe()

        with tempfile.TemporaryDirectory(prefix="lvf-motion-test-") as temporary:
            output = Path(temporary) / "pan.mp4"
            result = SceneMotionCell(ffmpeg).render(
                settings, VideoRenderSettings(1280, 720, 30), output,
            )
            probe = subprocess.run(
                [str(ffmpeg), "-v", "error", "-i", str(output), "-map", "0:v:0", "-f", "framemd5", "-"],
                check=True, capture_output=True, text=True,
            )
            cadence = subprocess.run(
                [
                    str(ffmpeg), "-v", "error", "-i", str(output),
                    "-vf", "tblend=all_mode=difference,signalstats,metadata=print:file=-",
                    "-an", "-f", "null", "-",
                ],
                check=True, capture_output=True, text=True,
            )

        hashes = [
            line.rsplit(",", 1)[-1].strip()
            for line in probe.stdout.splitlines()
            if line and not line.startswith("#")
        ]
        deltas = [
            float(line.split("=", 1)[1])
            for line in cadence.stdout.splitlines()
            if "lavfi.signalstats.YAVG=" in line
        ]
        self.assertEqual(result.frame_count, 90)
        self.assertEqual(len(hashes), 90)
        self.assertGreaterEqual(len(deltas), 88)
        self.assertLessEqual(sum(delta < .05 for delta in deltas), 2)


if __name__ == "__main__":
    unittest.main()
