from __future__ import annotations

from pathlib import Path
import unittest

from backend.core.ffmpeg_motion_filter_builder import FFmpegMotionFilterBuilder
from backend.core.scene_motion_settings import MotionPreset, SceneMotionSettings, VideoRenderSettings


class TextOverlayFilterTests(unittest.TestCase):
    def test_outfit_and_arabic_rubik_overlays_are_exported(self) -> None:
        scene = SceneMotionSettings(Path("image.png"), duration_seconds=3, extra_fields={"texts": [
            {"text": "Hello", "fontFamily": "Outfit", "fontSize": 64, "color": "#ffffff", "x": 50, "y": 20},
            {"text": "مرحبا", "fontFamily": "Rubik", "fontSize": 72, "color": "#4da3ff", "x": 50, "y": 80},
        ]})
        value = FFmpegMotionFilterBuilder.build(scene, VideoRenderSettings(1920, 1080, 30))
        self.assertEqual(value.count("drawtext="), 2)
        self.assertIn("Outfit-Variable.ttf", value)
        self.assertIn("Rubik-Variable.ttf", value)
        self.assertIn("fontcolor=0x4da3ff", value)

    def test_motion_uses_bounded_supersampling_and_smooth_low_pan_travel(self) -> None:
        scene = SceneMotionSettings(
            Path("image.png"), duration_seconds=6,
            motion=MotionPreset.PAN_RIGHT, motion_intensity=.25,
        )
        value = FFmpegMotionFilterBuilder.build(
            scene, VideoRenderSettings(1920, 1080, 30), frame_count=180,
        )
        self.assertIn("scale=3840:2160", value)
        self.assertIn("crop=3840:2160", value)
        self.assertIn("format=yuv444p,zoompan", value)
        self.assertIn("0.400000", value)


if __name__ == "__main__":
    unittest.main()
