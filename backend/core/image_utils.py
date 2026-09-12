from __future__ import annotations

import re
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tif", ".tiff", ".webp"}


def natural_sort_key(path: Path) -> list[object]:
    parts = re.split(r"(\d+)", path.name)
    key: list[object] = []
    for part in parts:
        if part.isdigit():
            key.append(int(part))
        else:
            key.append(part.lower())
    return key


def list_image_files(folder: str | Path) -> list[Path]:
    root = Path(folder)
    if not root.is_dir():
        return []
    images = [path for path in root.iterdir() if path.suffix.lower() in IMAGE_EXTENSIONS and path.is_file()]
    return sorted(images, key=natural_sort_key)


def _open_rgb_image(path: str | Path) -> Image.Image:
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        return image.convert("RGB")


def create_thumbnail(path: str | Path, size: tuple[int, int] = (240, 135)) -> Image.Image:
    image = _open_rgb_image(path)
    return ImageOps.fit(image, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def storyboard_thumbnail_size(
    video_size: tuple[int, int],
    bounds: tuple[int, int] = (240, 240),
) -> tuple[int, int]:
    """Fit a video-shaped thumbnail inside the UI bounds without changing its aspect ratio."""
    width, height = video_size
    if width <= 0 or height <= 0:
        raise ValueError("Video dimensions must be positive.")
    scale = min(bounds[0] / width, bounds[1] / height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def create_storyboard_thumbnail(
    path: str | Path,
    video_size: tuple[int, int],
    fill_mode: str,
    bounds: tuple[int, int] = (240, 240),
) -> Image.Image:
    """Build the UI preview with the same crop/fit policy as the final scene frame."""
    return build_scene_frame_image(
        path,
        storyboard_thumbnail_size(video_size, bounds),
        fill_mode,
    )


def apply_image_crop(source: Image.Image, size: tuple[int, int], crop: object = None) -> Image.Image:
    if not isinstance(crop, dict) or not crop.get("enabled"):
        return source
    try:
        zoom = max(1.0, min(5.0, float(crop.get("zoom", 1.0))))
        focus_x = max(0.0, min(100.0, float(crop.get("x", 50.0)))) / 100.0
        focus_y = max(0.0, min(100.0, float(crop.get("y", 50.0)))) / 100.0
    except (TypeError, ValueError):
        zoom, focus_x, focus_y = 1.0, .5, .5
    target_aspect = size[0] / size[1]
    source_aspect = source.width / source.height
    if source_aspect >= target_aspect:
        base_height = float(source.height)
        base_width = base_height * target_aspect
    else:
        base_width = float(source.width)
        base_height = base_width / target_aspect
    crop_width = max(1.0, base_width / zoom)
    crop_height = max(1.0, base_height / zoom)
    left = (source.width - crop_width) * focus_x
    top = (source.height - crop_height) * focus_y
    right = min(float(source.width), left + crop_width)
    bottom = min(float(source.height), top + crop_height)
    left = max(0.0, right - crop_width)
    top = max(0.0, bottom - crop_height)
    return source.crop((round(left), round(top), round(right), round(bottom)))


def build_scene_frame_image(path: str | Path, size: tuple[int, int], fill_mode: str, crop: object = None) -> Image.Image:
    source = _open_rgb_image(path)
    source = apply_image_crop(source, size, crop)
    fill_mode_normalized = fill_mode.strip().lower()
    if fill_mode_normalized.startswith("crop"):
        return ImageOps.fit(source, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))

    background = ImageOps.fit(source, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    background = background.filter(ImageFilter.GaussianBlur(radius=24))
    background = ImageEnhanceColor(background)

    frame = Image.new("RGB", size, (8, 12, 24))
    frame.paste(background, (0, 0))

    foreground_max = (int(size[0] * 0.9), int(size[1] * 0.9))
    foreground = ImageOps.contain(source, foreground_max, method=Image.Resampling.LANCZOS)
    x = (size[0] - foreground.width) // 2
    y = (size[1] - foreground.height) // 2
    frame.paste(foreground, (x, y))
    return frame


def ImageEnhanceColor(image: Image.Image) -> Image.Image:
    # Slightly lift contrast and saturation so blurred backgrounds do not look flat.
    from PIL import ImageEnhance

    image = ImageEnhance.Color(image).enhance(1.08)
    image = ImageEnhance.Contrast(image).enhance(1.05)
    return image
