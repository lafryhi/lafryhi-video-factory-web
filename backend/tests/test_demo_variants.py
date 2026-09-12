from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from PIL import Image

from backend.core.demo_workflow import collect_demo_assets, demo_images_dirname


class DemoVariantTests(unittest.TestCase):
    def test_orientation_maps_to_fixed_demo_folders(self) -> None:
        self.assertEqual(demo_images_dirname("landscape"), "Images")
        self.assertEqual(demo_images_dirname(" PORTRAIT "), "Images-Portrait-9x16")
        with self.assertRaisesRegex(ValueError, "Unsupported demo orientation"):
            demo_images_dirname("../../outside")

    def test_portrait_scan_does_not_mix_landscape_images(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            landscape = root / "Demo" / "Images"
            portrait = root / "Demo" / "Images-Portrait-9x16"
            landscape.mkdir(parents=True)
            portrait.mkdir(parents=True)
            Image.new("RGB", (160, 90), "blue").save(landscape / "landscape.png")
            Image.new("RGB", (90, 160), "orange").save(portrait / "portrait.png")

            scan = collect_demo_assets(root, "portrait")

            self.assertEqual(scan.images_folder, portrait)
            self.assertEqual([path.name for path in scan.images], ["portrait.png"])


if __name__ == "__main__":
    unittest.main()
