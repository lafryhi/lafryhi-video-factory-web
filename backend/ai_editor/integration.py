"""Adapter to the existing narration mixer and scene renderer."""
import math
import uuid
from .ffmpeg_builder import audio_command
from .media import run, probe, ffmpeg
from .models import Audio, Video, SubtitleStyle


def validate_scene(scene, root):
    from pathlib import Path
    path = Path(scene["imagePath"]).resolve()
    if not path.is_relative_to(root.resolve()): raise ValueError("Video source must belong to this session")
    data = probe(path)
    duration = float(data["format"]["duration"])
    start = float(scene.get("sourceStartSeconds", 0))
    length = float(scene["durationSeconds"])
    if not all(math.isfinite(v) for v in [start, length]) or start < 0 or length < .05 or start + length > duration + .05:
        raise ValueError("Video scene trim exceeds source duration")
    Audio.model_validate(scene.get("aiAudio", {}))
    Video.model_validate(scene.get("aiVideo", {}))
    SubtitleStyle.model_validate(scene.get("subtitleStyle", {}))
    return any(s["codec_type"] == "audio" for s in data["streams"])


def prepare_audio(project, root):
    if project.get("audioTiming", {}).get("mode") != "manual":
        raise ValueError("Video scenes require Manual timeline timing; select Manual before exporting")
    assignments = project.setdefault("narrationMapping", {}).setdefault("assignments", [])
    import tempfile
    from pathlib import Path
    pieces = []
    folder = Path(tempfile.mkdtemp(prefix="ai-audio-", dir=root / "requests"))
    for scene in project.get("scenes", []):
        has_audio = validate_scene(scene, root) if scene.get("mediaType") == "video" else False
        duration = round(scene["durationSeconds"] * project["fps"]) / project["fps"]
        target = folder / f"{len(pieces):04}.wav"
        pieces.append(target)
        if not has_audio or not scene.get("sourceAudio", True):
            run(ffmpeg("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", duration, target))
            continue
        audio = Audio.model_validate(scene.get("aiAudio", {}))
        run(audio_command(scene["imagePath"], target, scene.get("sourceStartSeconds", 0), duration, audio.crossfadeMs, audio.normalize), 240)
    listing = folder / "concat.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in pieces), encoding="utf-8")
    target = root / "narration" / f"ai-source-{uuid.uuid4().hex}.wav"
    run(ffmpeg("-f", "concat", "-safe", 1, "-i", listing, "-c:a", "pcm_s16le", target))
    project["_aiSourceAudio"] = str(target)
    for piece in pieces: piece.unlink(missing_ok=True)
    listing.unlink(missing_ok=True)
    folder.rmdir()
