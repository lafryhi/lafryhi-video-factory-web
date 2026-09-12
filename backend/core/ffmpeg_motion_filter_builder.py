from __future__ import annotations

from pathlib import Path
import re

from core.scene_motion_settings import MotionPreset, SceneMotionSettings, VideoRenderSettings
from core.frame_timing import frames_for_duration


class FFmpegMotionFilterBuilder:
    """Build safe, frame-count based virtual-camera filters for still images."""

    @staticmethod
    def build(
        settings: SceneMotionSettings,
        video: VideoRenderSettings,
        *,
        include_fade: bool = False,
        frame_count: int | None = None,
    ) -> str:
        frames = frame_count if frame_count is not None else frames_for_duration(settings.duration_seconds, video.fps)
        duration = frames / video.fps
        last = max(1, frames - 1)
        linear_progress = f"on/{last}"
        intensity = min(max(settings.motion_intensity, 0.0), 1.0)
        preset = settings.motion

        # Low remains linear. Medium and High use a direct, frame-index based
        # smoothstep. Nothing is accumulated from the previous frame.
        if intensity >= 0.40:
            progress = f"({linear_progress})*({linear_progress})*(3-2*({linear_progress}))"
        else:
            progress = linear_progress

        start, end = FFmpegMotionFilterBuilder._zooms(settings)
        if preset is MotionPreset.STATIC:
            z = f"{start:.6f}"
        else:
            z = f"{start:.6f}+({end - start:.6f})*{progress}"

        # zoompan's x/y are clamped as a second safety net. The cover scale gives
        # zoompan a correctly proportioned source with no borders at zoom=1.
        centered_x = "floor((iw-iw/zoom)/2)"
        centered_y = "floor((ih-ih/zoom)/2)"
        travel = FFmpegMotionFilterBuilder._pan_travel(intensity)
        if preset in {MotionPreset.PAN_RIGHT, MotionPreset.ZOOM_IN_PAN_RIGHT}:
            x = f"floor((iw-iw/zoom)*(0.5-{travel / 2:.6f}+{travel:.6f}*({progress})))"
            y = centered_y
        elif preset in {MotionPreset.PAN_LEFT, MotionPreset.ZOOM_IN_PAN_LEFT}:
            x = f"floor((iw-iw/zoom)*(0.5+{travel / 2:.6f}-{travel:.6f}*({progress})))"
            y = centered_y
        elif preset is MotionPreset.PAN_DOWN:
            x, y = centered_x, f"floor((ih-ih/zoom)*(0.5-{travel / 2:.6f}+{travel:.6f}*({progress})))"
        elif preset is MotionPreset.PAN_UP:
            x, y = centered_x, f"floor((ih-ih/zoom)*(0.5+{travel / 2:.6f}-{travel:.6f}*({progress})))"
        else:
            x, y = centered_x, centered_y

        width, height = video.width, video.height
        # Supersample the virtual camera before returning to the requested
        # resolution. zoompan positions its crop in whole source pixels; using
        # the delivery-sized image here makes gentle pans hold the same frame
        # several times and visibly stutter. The renderer processes only one
        # scene at a time, so this quality buffer stays bounded on containers.
        canvas_width, canvas_height = width * 2, height * 2
        chain = [
            f"scale={canvas_width}:{canvas_height}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={canvas_width}:{canvas_height}",
            # Keep the motion stage full-chroma. yuv420 requires even crop
            # coordinates, which made zoompan alternate between a held frame
            # and a two-pixel jump. Convert to delivery yuv420p only after the
            # virtual camera has produced smoothly sampled output frames.
            "format=yuv444p",
            f"zoompan=z='{z}':x='floor(max(0,min(iw-iw/zoom,{x})))':y='floor(max(0,min(ih-ih/zoom,{y})))':d=1:s={width}x{height}:fps={video.fps}",
            f"trim=end_frame={frames}",
            "setpts=PTS-STARTPTS",
            f"fps={video.fps}",
        ]
        # Plain concat has no overlap, so ordinary Fade is intentionally a
        # no-op. A per-scene fade would create black frames at every boundary.
        if include_fade and settings.transition.casefold() == "dip to black" and settings.transition_duration_seconds > 0:
            fade = min(settings.transition_duration_seconds, duration / 2)
            chain.extend([
                f"fade=t=in:st=0:d={fade:.6f}",
                f"fade=t=out:st={duration - fade:.6f}:d={fade:.6f}",
            ])
        chain.extend(FFmpegMotionFilterBuilder._text_filters(settings, video, duration))
        chain.extend(["setsar=1", "format=yuv420p"])
        return ",".join(chain)

    @staticmethod
    def _text_filters(settings: SceneMotionSettings, video: VideoRenderSettings, duration: float) -> list[str]:
        raw_items = settings.extra_fields.get("texts", [])
        if not isinstance(raw_items, list):
            return []
        fonts = Path(__file__).resolve().parents[1] / "fonts"
        result: list[str] = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", "")).strip()
            if not text:
                continue
            family = "Rubik" if str(item.get("fontFamily", "Outfit")).casefold() == "rubik" else "Outfit"
            font_path = fonts / f"{family}-Variable.ttf"
            if not font_path.is_file():
                continue
            font_size = max(8, min(int(float(item.get("fontSize", 64))), min(300, video.height // 3)))
            color = str(item.get("color", "#ffffff"))
            color = color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "#ffffff"
            x = max(0.0, min(100.0, float(item.get("x", 50)))) / 100
            y = max(0.0, min(100.0, float(item.get("y", 78)))) / 100
            start = max(0.0, min(duration, float(item.get("startSeconds", 0))))
            raw_end = item.get("endSeconds")
            end = duration if raw_end in (None, "") else max(start, min(duration, float(raw_end)))
            escaped_text = (text.replace("\\", "\\\\").replace("'", "\\'")
                            .replace(":", "\\:").replace(",", "\\,")
                            .replace("%", "\\%").replace("\n", "\\n"))
            escaped_font = str(font_path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
            result.append(
                "drawtext="
                f"fontfile='{escaped_font}':text='{escaped_text}':expansion=none:"
                f"fontcolor=0x{color[1:]}:fontsize={font_size}:"
                f"x='w*{x:.6f}-text_w/2':y='h*{y:.6f}-text_h/2':"
                "borderw=2:bordercolor=black@0.38:shadowx=2:shadowy=2:shadowcolor=black@0.48:"
                f"enable='between(t\\,{start:.6f}\\,{end:.6f})'"
            )
        return result

    @staticmethod
    def _zooms(settings: SceneMotionSettings) -> tuple[float, float]:
        start, end = settings.start_zoom, settings.end_zoom
        intensity = min(max(settings.motion_intensity, 0.0), 1.0)
        zoom_span = FFmpegMotionFilterBuilder._calibrated_value(
            intensity, low=0.12, medium=0.25, high=0.40,
        )
        pan = settings.motion in {MotionPreset.PAN_LEFT, MotionPreset.PAN_RIGHT, MotionPreset.PAN_UP, MotionPreset.PAN_DOWN}
        if pan:
            # A fixed zoom creates the crop headroom used by pure pan presets.
            safe = max(start, end, 1.0 + zoom_span)
            return safe, safe
        if settings.motion in {MotionPreset.ZOOM_IN, MotionPreset.ZOOM_IN_PAN_LEFT, MotionPreset.ZOOM_IN_PAN_RIGHT}:
            calibrated_start = min(start, end)
            if settings.motion in {MotionPreset.ZOOM_IN_PAN_LEFT, MotionPreset.ZOOM_IN_PAN_RIGHT}:
                calibrated_start = max(calibrated_start, 1.0)
            return calibrated_start, max(start, end, calibrated_start + zoom_span)
        if settings.motion is MotionPreset.ZOOM_OUT:
            calibrated_end = min(start, end)
            return max(start, end, calibrated_end + zoom_span), calibrated_end
        return start, start

    @staticmethod
    def _pan_travel(intensity: float) -> float:
        # Keep exported camera travel aligned with the browser preview. The
        # former 0.12 low anchor moved a 1080p image only about 25 pixels and
        # repeatedly rounded adjacent frames to the same crop position.
        return FFmpegMotionFilterBuilder._calibrated_value(
            intensity, low=0.40, medium=0.44, high=0.48,
        )

    @staticmethod
    def _calibrated_value(intensity: float, *, low: float, medium: float, high: float) -> float:
        """Interpolate through the canonical Low/Medium/High intensity anchors."""
        value = min(max(intensity, 0.0), 1.0)
        if value <= 0.25:
            return low * (value / 0.25) if value > 0 else 0.0
        if value <= 0.55:
            ratio = (value - 0.25) / 0.30
            return low + (medium - low) * ratio
        ratio = min(1.0, (value - 0.55) / 0.30)
        return medium + (high - medium) * ratio
