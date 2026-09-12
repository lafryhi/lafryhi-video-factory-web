from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
import os
import tempfile

from PIL import Image

from core.audio_utils import get_audio_duration
from core.image_utils import natural_sort_key
from core.project_model import ProjectSettings, VideoFormat
from core.runtime_paths import RESOURCE_ROOT


PROJECT_ROOT = RESOURCE_ROOT
DEMO_ROOT_NAME = "Demo"
DEMO_IMAGES_DIRNAME = "Images"
DEMO_PORTRAIT_IMAGES_DIRNAME = "Images-Portrait-9x16"
DEMO_AUDIO_DIRNAME = "Audio"
DEMO_OUTPUT_DIRNAME = "Output"
DEMO_README_NAME = "README.txt"
DEFAULT_DEMO_OUTPUT_NAME = "LAFRYHI_Video_Factory_Build_Week_Demo.mp4"

SUPPORTED_DEMO_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
SUPPORTED_DEMO_AUDIO_EXTENSIONS = {".mp3", ".wav", ".wave", ".m4a", ".aac", ".flac", ".ogg"}

NARRATION_PREFERRED_FILENAMES = {
    "narration.mp3",
    "narration.wav",
    "voiceover.mp3",
    "voiceover.wav",
    "voice_over.mp3",
    "voice_over.wav",
    "demo_voice.mp3",
    "demo_voice.wav",
}

MUSIC_PREFERRED_FILENAMES = {
    "music.mp3",
    "background_music.mp3",
    "demo_music.mp3",
    "music.wav",
    "background_music.wav",
}


@dataclass(slots=True)
class DemoAssetScan:
    demo_root: Path
    images_folder: Path
    audio_folder: Path
    output_folder: Path
    images: list[Path]
    unsupported_images: list[Path]
    invalid_images: list[Path]
    audio_files: list[Path]
    invalid_audio_files: list[Path]
    audio_durations: dict[Path, float]
    warnings: list[str]


@dataclass(slots=True)
class DemoSelection:
    narration: Path
    music: Path | None


@dataclass(slots=True)
class DemoProjectPlan:
    demo_root: Path
    images: list[Path]
    narration: Path
    music: Path | None
    narration_duration: float
    estimated_duration: float
    output_folder: Path
    output_name: str
    settings: ProjectSettings
    warnings: list[str]
    scene_count: int


def resolve_demo_root(base_dir: Path | None = None) -> Path:
    base = Path(base_dir) if base_dir is not None else PROJECT_ROOT
    project_candidate = base / DEMO_ROOT_NAME
    if _can_use_path(project_candidate):
        return project_candidate

    fallback_base = _fallback_user_demo_root()
    fallback_candidate = fallback_base / DEMO_ROOT_NAME
    fallback_candidate.mkdir(parents=True, exist_ok=True)
    _write_demo_readme(fallback_candidate)
    return fallback_candidate


def ensure_demo_structure(base_dir: Path | None = None) -> Path:
    demo_root = resolve_demo_root(base_dir)
    (demo_root / DEMO_IMAGES_DIRNAME).mkdir(parents=True, exist_ok=True)
    (demo_root / DEMO_AUDIO_DIRNAME).mkdir(parents=True, exist_ok=True)
    (demo_root / DEMO_OUTPUT_DIRNAME).mkdir(parents=True, exist_ok=True)
    _write_demo_readme(demo_root)
    return demo_root


def demo_images_dirname(orientation: str = "landscape") -> str:
    normalized = str(orientation).strip().casefold()
    if normalized == "landscape":
        return DEMO_IMAGES_DIRNAME
    if normalized == "portrait":
        return DEMO_PORTRAIT_IMAGES_DIRNAME
    raise ValueError(f"Unsupported demo orientation: {orientation}")


def collect_demo_assets(base_dir: Path | None = None, orientation: str = "landscape") -> DemoAssetScan:
    demo_root = ensure_demo_structure(base_dir)
    images_folder = demo_root / demo_images_dirname(orientation)
    images_folder.mkdir(parents=True, exist_ok=True)
    audio_folder = demo_root / DEMO_AUDIO_DIRNAME
    output_folder = demo_root / DEMO_OUTPUT_DIRNAME

    images, unsupported_images, invalid_images = _scan_images(images_folder)
    audio_files, invalid_audio_files, audio_durations = _scan_audio(audio_folder)

    warnings: list[str] = []
    if not images_folder.exists():
        warnings.append(f"Images folder was missing and has been created: {images_folder}")
    if not audio_folder.exists():
        warnings.append(f"Audio folder was missing and has been created: {audio_folder}")
    if not output_folder.exists():
        warnings.append(f"Output folder was missing and has been created: {output_folder}")
    if len(images) > 10:
        warnings.append(
            f"Only the first 10 valid images will be used for the demo; {len(images) - 10} extra image(s) were ignored."
        )
        images = images[:10]
    elif len(images) < 10:
        warnings.append(f"Ten images are recommended, but {len(images)} valid image(s) were detected.")
    if unsupported_images:
        warnings.append(
            "Unsupported image files were ignored: "
            + ", ".join(path.name for path in unsupported_images)
        )
    if invalid_images:
        warnings.append(
            "Unreadable image files were ignored: " + ", ".join(path.name for path in invalid_images)
        )
    if invalid_audio_files:
        warnings.append(
            "Unreadable audio files were ignored: " + ", ".join(path.name for path in invalid_audio_files)
        )
    if not images:
        warnings.append(f"No valid images were found in Demo\\{images_folder.name}.")
    if not audio_files:
        warnings.append("No valid narration or music audio files were found in Demo\\Audio.")

    return DemoAssetScan(
        demo_root=demo_root,
        images_folder=images_folder,
        audio_folder=audio_folder,
        output_folder=output_folder,
        images=images,
        unsupported_images=unsupported_images,
        invalid_images=invalid_images,
        audio_files=audio_files,
        invalid_audio_files=invalid_audio_files,
        audio_durations=audio_durations,
        warnings=warnings,
    )


def pick_default_narration(scan: DemoAssetScan) -> Path | None:
    preferred = _preferred_audio_matches(scan.audio_files, NARRATION_PREFERRED_FILENAMES)
    if len(preferred) == 1:
        return preferred[0]
    if len(scan.audio_files) == 1:
        return scan.audio_files[0]
    return None


def pick_default_music(scan: DemoAssetScan, narration: Path | None) -> Path | None:
    remaining = [path for path in scan.audio_files if narration is None or path != narration]
    preferred = _preferred_audio_matches(remaining, MUSIC_PREFERRED_FILENAMES)
    if len(preferred) == 1:
        return preferred[0]
    return None


def build_demo_project_plan(scan: DemoAssetScan, narration: Path, music: Path | None) -> DemoProjectPlan:
    if not scan.images:
        raise ValueError("No valid images were found in Demo\\Images.")
    if narration not in scan.audio_files:
        raise ValueError("The selected narration file is not part of Demo\\Audio.")
    if music is not None and music not in scan.audio_files:
        raise ValueError("The selected music file is not part of Demo\\Audio.")

    narration_duration = scan.audio_durations.get(narration)
    if narration_duration is None:
        narration_duration = get_audio_duration(narration)

    minimum_scene_duration = max(3.5, narration_duration / max(1, len(scan.images)))
    music_file = music if music is not None else None

    # Informational only. Authoritative frame timing is resolved later by
    # TimelinePlanningService when preview or rendering begins.
    estimated_duration = max(
        narration_duration, minimum_scene_duration * len(scan.images)
    )

    settings = ProjectSettings(
        images_folder=scan.images_folder,
        voice_file=narration,
        output_folder=scan.output_folder,
        music_file=music_file,
        resolution=VideoFormat.LANDSCAPE_16_9.resolution,
        video_format=VideoFormat.LANDSCAPE_16_9,
        fps=30,
        fill_mode="Fit with blurred background",
        minimum_scene_duration=minimum_scene_duration,
        motion_intensity="Low",
        music_volume=0.18,
        output_name=DEFAULT_DEMO_OUTPUT_NAME,
    )

    warnings = list(scan.warnings)
    if music_file is None:
        warnings.append("No background music was selected. The demo will render narration only.")

    return DemoProjectPlan(
        demo_root=scan.demo_root,
        images=scan.images,
        narration=narration,
        music=music_file,
        narration_duration=narration_duration,
        estimated_duration=estimated_duration,
        output_folder=scan.output_folder,
        output_name=DEFAULT_DEMO_OUTPUT_NAME,
        settings=settings,
        warnings=warnings,
        scene_count=len(scan.images),
    )


def open_in_explorer(path: Path) -> None:
    target = Path(path)
    if target.is_file():
        target = target.parent
    if not target.exists():
        raise FileNotFoundError(str(target))
    os.startfile(str(target))


def _scan_images(images_folder: Path) -> tuple[list[Path], list[Path], list[Path]]:
    images: list[Path] = []
    unsupported: list[Path] = []
    invalid: list[Path] = []
    if not images_folder.is_dir():
        return images, unsupported, invalid

    for path in sorted((item for item in images_folder.iterdir() if item.is_file()), key=natural_sort_key):
        if path.suffix.lower() not in SUPPORTED_DEMO_IMAGE_EXTENSIONS:
            unsupported.append(path)
            continue
        if _is_readable_image(path):
            images.append(path)
        else:
            invalid.append(path)

    return images, unsupported, invalid


def _scan_audio(audio_folder: Path) -> tuple[list[Path], list[Path], dict[Path, float]]:
    audio_files: list[Path] = []
    invalid: list[Path] = []
    durations: dict[Path, float] = {}
    if not audio_folder.is_dir():
        return audio_files, invalid, durations

    candidates = sorted((item for item in audio_folder.iterdir() if item.is_file()), key=natural_sort_key)
    for path in candidates:
        if path.suffix.lower() not in SUPPORTED_DEMO_AUDIO_EXTENSIONS:
            continue
        try:
            duration = float(get_audio_duration(path))
        except Exception:
            invalid.append(path)
            continue
        audio_files.append(path)
        durations[path] = duration

    return audio_files, invalid, durations


def _is_readable_image(path: Path) -> bool:
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except Exception:
        return False


def _preferred_audio_matches(files: Iterable[Path], preferred_filenames: set[str]) -> list[Path]:
    preferred_lookup = {name.lower() for name in preferred_filenames}
    matches: list[Path] = []
    for path in files:
        name = path.name.lower()
        stem = path.stem.lower()
        if name in preferred_lookup or stem in {Path(item).stem.lower() for item in preferred_lookup}:
            matches.append(path)
    return sorted(matches, key=natural_sort_key)


def _write_demo_readme(demo_root: Path) -> None:
    readme = demo_root / DEMO_README_NAME
    content = (
        "Build Week Demo folder\n\n"
        "Place your image files inside Demo\\Images.\n"
        "Place narration audio inside Demo\\Audio.\n"
        "Place optional background music inside Demo\\Audio.\n"
        "Generated MP4 files are saved in Demo\\Output.\n"
    )
    if not readme.exists():
        readme.write_text(content, encoding="utf-8")


def _can_use_path(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        test_file = path / f".write_test_{os.getpid()}"
        test_file.write_text("ok", encoding="utf-8")
        test_file.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def _fallback_user_demo_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "LAFRYHI Video Factory"
    return Path.home() / "LAFRYHI Video Factory"
