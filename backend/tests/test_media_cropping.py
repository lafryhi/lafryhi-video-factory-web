from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from PIL import Image

from backend import app as _web  # Adds the backend package root for shared core imports.
from core.image_utils import build_scene_frame_image
from core.audio_sync_cell import AudioSyncCell
from core.audio_timing_settings import AudioTimingMode, AudioTimingSettings
from core.project_model import ProjectSettings, normalize_audio_gaps, normalize_audio_trim, normalize_removed_audio_ranges
from core.video_engine import _build_audio_only_filter


class MediaCroppingTests(unittest.TestCase):
    def test_image_crop_keeps_the_requested_edge_and_target_aspect(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "quadrants.png"
            image = Image.new("RGB", (400, 200), "red")
            image.paste(Image.new("RGB", (200, 200), "blue"), (200, 0))
            image.save(source)
            left = build_scene_frame_image(source, (100, 100), "Crop to fill", {"enabled": True, "x": 0, "y": 50, "zoom": 1})
            right = build_scene_frame_image(source, (100, 100), "Crop to fill", {"enabled": True, "x": 100, "y": 50, "zoom": 1})
            self.assertEqual(left.size, (100, 100))
            self.assertGreater(left.getpixel((50, 50))[0], left.getpixel((50, 50))[2])
            self.assertGreater(right.getpixel((50, 50))[2], right.getpixel((50, 50))[0])

    def test_disabled_crop_preserves_the_existing_fill_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "wide.png"
            Image.new("RGB", (200, 100), "green").save(source)
            original = build_scene_frame_image(source, (100, 100), "Crop to fill")
            disabled = build_scene_frame_image(source, (100, 100), "Crop to fill", {"enabled": False, "x": 0, "y": 0, "zoom": 5})
            self.assertEqual(original.tobytes(), disabled.tobytes())

    def test_audio_trim_validation_rejects_empty_and_non_finite_ranges(self) -> None:
        self.assertEqual(normalize_audio_trim(1, 3), (1.0, 3.0))
        for start, end in ((-1, None), (3, 3), (4, 2), (float("nan"), None)):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                normalize_audio_trim(start, end)

    def test_removed_audio_ranges_are_validated_sorted_and_merged(self) -> None:
        self.assertEqual(normalize_removed_audio_ranges([
            {"startSeconds": 2, "endSeconds": 4},
            {"startSeconds": 1, "endSeconds": 2.5},
            {"startSeconds": -1, "endSeconds": 1},
            {"startSeconds": "bad", "endSeconds": 9},
        ]), [(1.0, 4.0)])

    def test_audio_gaps_are_validated_and_combined_at_the_same_edit_point(self) -> None:
        self.assertEqual(normalize_audio_gaps([
            {"atSeconds": 2, "durationSeconds": .5},
            {"atSeconds": 2, "durationSeconds": .25},
            {"atSeconds": -1, "durationSeconds": 2},
        ]), [(2.0, .75)])

    def test_voice_trim_controls_timeline_duration_and_rebases_silence(self) -> None:
        analysis = Mock()
        analysis.duration.return_value = 10.0
        analysis.detect_silence_boundaries.return_value = [1.0, 3.0, 7.0, 9.0]
        cell = AudioSyncCell(analysis)
        result = cell.analyze(
            "voice.mp3", 2, 30,
            AudioTimingSettings(mode=AudioTimingMode.SILENCE_AWARE, minimum_scene_seconds=1),
            trim_start_seconds=2, trim_end_seconds=8,
        )
        self.assertEqual(result.total_frames, 180)
        self.assertEqual(result.detected_silence_boundaries, [1.0, 5.0])
        self.assertEqual(result.audio_duration_seconds, 6.0)

    def test_voice_trim_cannot_extend_beyond_source_duration(self) -> None:
        analysis = Mock()
        analysis.duration.return_value = 4.0
        cell = AudioSyncCell(analysis)
        with self.assertRaisesRegex(Exception, "outside the audio file"):
            cell.analyze(
                "voice.mp3", 1, 30, AudioTimingSettings(mode=AudioTimingMode.EVEN),
                trim_start_seconds=1, trim_end_seconds=8,
            )

    def test_export_filter_trims_voice_and_loops_only_the_music_selection(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            voice = Path(folder) / "voice.mp3"
            music = Path(folder) / "music.mp3"
            voice.touch(); music.touch()
            settings = ProjectSettings(
                Path("images"), voice, Path("output"), music,
                voice_trim_start_seconds=1.25, voice_trim_end_seconds=4.5,
                music_trim_start_seconds=2.0, music_trim_end_seconds=5.0,
                voice_removed_ranges=[(2.0, 2.5)], music_removed_ranges=[(6.0, 7.0)],
                voice_timeline_gaps=[(2.5, .5)], music_timeline_gaps=[(7.0, .25)],
            )
            script = _build_audio_only_filter(settings, 12)
            self.assertIn("atrim=start=1.250000000:end=4.500000000", script)
            self.assertIn("atrim=start=2.000000000:end=5.000000000", script)
            self.assertIn("aloop=loop=-1:size=144000", script)
            self.assertIn("atrim=start=2.500000000:end=12.000000000", script)
            self.assertIn("adelay=2500:all=1", script)
            self.assertIn("atrim=start=7.000000000:end=12.000000000", script)
            self.assertIn("adelay=6250:all=1", script)
            self.assertNotIn("volume=0:enable", script)
            self.assertIn("atrim=0:12.000000000", script)


if __name__ == "__main__":
    unittest.main()
