from __future__ import annotations

from pathlib import Path
import sys


IS_FROZEN = bool(getattr(sys, "frozen", False))
SOURCE_ROOT = Path(__file__).resolve().parents[1]

# PyInstaller extracts/collects read-only application resources below _MEIPASS.
# User-created output and logs belong beside the portable executable instead.
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", SOURCE_ROOT)).resolve()
APP_ROOT = (
    Path(sys.executable).resolve().parent
    if IS_FROZEN
    else SOURCE_ROOT
)


def resource_path(*parts: str) -> Path:
    """Return a bundled resource path in both source and PyInstaller modes."""
    return RESOURCE_ROOT.joinpath(*parts)


def app_path(*parts: str) -> Path:
    """Return a writable portable-app path in both source and frozen modes."""
    return APP_ROOT.joinpath(*parts)
