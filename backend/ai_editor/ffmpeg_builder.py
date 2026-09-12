from .media import ffmpeg

COLORS = {"original": "null", "bright": "eq=brightness=0.035:saturation=1.08", "warm": "colorbalance=rs=0.035:bs=-0.025", "cool": "colorbalance=rs=-0.025:bs=0.035", "contrast": "eq=contrast=1.08", "soft": "eq=contrast=0.96:saturation=0.96"}


def video_filter(width, height, fps, preset="original", crop="center"):
    if preset not in COLORS or crop not in {"center", "fit"}: raise ValueError("Unknown video preset")
    if not (16 <= width <= 3840 and 16 <= height <= 3840 and 1 <= fps <= 60): raise ValueError("Invalid output dimensions")
    sizing = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}" if crop == "center" else f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    return f"{sizing},setsar=1,fps={fps},{COLORS[preset]}"


def audio_command(source, output, start, duration, fade_ms=40, normalize=True):
    if not (0 <= start <= 1800 and .05 <= duration <= 1800 and 0 <= fade_ms <= 60): raise ValueError("Invalid audio trim")
    fade = min(fade_ms / 1000, duration / 2)
    filters = f"afade=t=in:d={fade:.4f},afade=t=out:st={duration-fade:.4f}:d={fade:.4f}"
    if normalize: filters += ",loudnorm=I=-16:TP=-1.5:LRA=11"
    return ffmpeg("-ss", start, "-i", source, "-t", duration, "-vn", "-af", filters, "-ar", 48000, "-ac", 2, output)
