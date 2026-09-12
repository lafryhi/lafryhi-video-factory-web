import json
import math
import shutil
import subprocess
from pathlib import Path
from core.video_engine import resolve_ffmpeg_exe


def run(args: list[str], timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode:
        raise ValueError("Media processing failed: " + result.stderr[-1500:])
    return result


def ffmpeg(*args):
    return [str(resolve_ffmpeg_exe()), "-nostdin", "-hide_banner", "-y", *map(str, args)]


def probe(path: Path):
    binary = shutil.which("ffprobe")
    if not binary:
        try:
            from core.video_engine import resolve_ffprobe_exe
            binary = str(resolve_ffprobe_exe())
        except Exception:
            binary = None
    if binary:
        result = json.loads(run([binary, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], 30).stdout)
        duration = float(result.get("format", {}).get("duration", 0))
        if not math.isfinite(duration) or not 0 < duration <= 1800:
            raise ValueError("Video duration must be between 0 and 1800 seconds")
        if not any(s["codec_type"] == "video" for s in result["streams"]):
            raise ValueError("Uploaded file must contain a video stream")
        return result

    import re
    res = subprocess.run([str(resolve_ffmpeg_exe()), "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    output = res.stderr
    dur_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", output)
    if not dur_match:
        raise ValueError("Could not determine video duration with FFmpeg")
    hours, mins, secs = dur_match.groups()
    duration = float(hours) * 3600 + float(mins) * 60 + float(secs)
    if not math.isfinite(duration) or not 0 < duration <= 1800:
        raise ValueError("Video duration must be between 0 and 1800 seconds")
    streams = []
    if re.search(r"Stream.*Video:", output):
        streams.append({"codec_type": "video", "width": 1920, "height": 1080})
        res_match = re.search(r"Video:.*?\b(\d{2,4})x(\d{2,4})\b", output)
        if res_match:
            streams[-1]["width"] = int(res_match.group(1))
            streams[-1]["height"] = int(res_match.group(2))
    if re.search(r"Stream.*Audio:", output):
        streams.append({"codec_type": "audio"})
    if not any(s["codec_type"] == "video" for s in streams):
        raise ValueError("Uploaded file must contain a video stream")
    return {"format": {"duration": duration}, "streams": streams}
