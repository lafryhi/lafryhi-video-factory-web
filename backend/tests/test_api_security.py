from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from fastapi import HTTPException

from backend import app as web


class ApiWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_root = web.DATA_ROOT
        web.DATA_ROOT = Path(self.temporary.name).resolve()

    def tearDown(self) -> None:
        web.DATA_ROOT = self.previous_root
        self.temporary.cleanup()

    def test_upload_names_cannot_escape_the_workspace(self) -> None:
        self.assertEqual(web.safe_name("../../unsafe.png", "image.png"), "unsafe.png")

    def test_media_outside_the_workspace_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            web.allowed_path("/etc/passwd")
        self.assertEqual(raised.exception.status_code, 403)

    def test_project_output_is_forced_into_its_session(self) -> None:
        session_id, root = web.new_session()
        image = root / "images" / "one.png"
        image.write_bytes(b"test")
        resolved_id, resolved_root, project = web.prepare_project({
            "sessionId": session_id,
            "outputFolder": "/tmp/untrusted",
            "scenes": [{"imagePath": str(image)}],
            "narrationMapping": {"assignments": []},
        })
        self.assertEqual(resolved_id, session_id)
        self.assertEqual(resolved_root, root)
        self.assertEqual(project["outputFolder"], str(root / "outputs"))


if __name__ == "__main__":
    unittest.main()
