import re
from .media import ffmpeg, run
from .models import Segment


def parse_silences(log: str, duration: float, minimum=.7, padding=.15):
    result = []
    start = None
    for kind, raw in re.findall(r"silence_(start|end):\s*([0-9.]+)", log):
        value = min(duration, float(raw))
        if kind == "start":
            start = value
        elif start is not None:
            if value - start >= minimum and value - start > 2 * padding:
                result.append(Segment(start=start + padding, end=value - padding))
            start = None
    if start is not None and duration - start >= minimum:
        result.append(Segment(start=start + padding, end=duration))
    return result


def detect(path, duration):
    result = run(ffmpeg("-i", path, "-vn", "-af", "silencedetect=noise=-38dB:d=0.7", "-f", "null", "-"), 240)
    return parse_silences(result.stderr, duration)
