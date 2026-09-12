from __future__ import annotations

from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

from backend import app as _web  # Adds the backend package root for the shared core imports.
from core.audio_timing_settings import AudioTimingMode, AudioTimingSettings
from core.project_model import ProjectSettings, ScenePlan
from core.scene_motion_settings import SceneMotionSettings
from core.timeline_planning_service import TimelinePlanningService
from core.video_engine import _build_ffmpeg_command, _build_filter_script


class SilentExportTests(unittest.TestCase):
    def test_missing_narration_falls_back_to_manual_scene_timing(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            image = root / "scene.png"
            image.write_bytes(b"scene fingerprint")
            audio_sync = Mock()
            settings = ProjectSettings(
                images_folder=root,
                voice_file=Path(),
                output_folder=root / "output",
                scenes=[SceneMotionSettings(image, duration_seconds=2.0)],
                audio_timing_settings=AudioTimingSettings(mode=AudioTimingMode.EVEN),
            )

            timeline = TimelinePlanningService(audio_sync).resolve(settings, threading.Event())

            self.assertEqual(timeline.total_frames, 60)
            self.assertEqual(timeline.timing_mode, AudioTimingMode.MANUAL.value)
            self.assertIn("silent audio", " ".join(timeline.warnings).lower())
            audio_sync.analyze.assert_not_called()

    def test_ffmpeg_graph_synthesizes_silence_without_a_voice_input(self) -> None:
        plan = ScenePlan(0, Path("scene.png"), 2.0, "Static", frame_count=60)
        script = _build_filter_script(
            prepared_frames=[Path("prepared.png")], plans=[plan], voice_input_index=None,
            music_input_index=None, total_duration=2.0, width=1920, height=1080, fps=30,
            music_volume=.18, fill_mode="Fit with blurred background", transition_duration=0,
        )
        settings = ProjectSettings(Path("images"), Path(), Path("output"), scenes=[])
        command = _build_ffmpeg_command(
            Path("ffmpeg"), [Path("prepared.png")], [plan], settings,
            Path("filters.txt"), Path("video.mp4"), 60,
        )

        self.assertIn("anullsrc=r=48000:cl=stereo", script)
        self.assertEqual(command.count("-i"), 1)
        self.assertEqual(command[command.index("-t") + 1], "2.000000000")
        self.assertEqual(command[command.index("-filter_complex_threads") + 1], "1")
        self.assertEqual(command[command.index("-threads") + 1], "1")
        self.assertEqual(command[command.index("-preset") + 1], "veryfast")


if __name__ == "__main__":
    unittest.main()
