import asyncio
import math
import subprocess
import time
import threading
import wave
from array import array
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend import app as web
from core.audio_timing_settings import AudioTimingMode, AudioTimingSettings
from core.project_model import ProjectSettings
from core.scene_motion_settings import SceneMotionSettings
from core.video_engine import render_project, resolve_ffmpeg_exe
from ai_editor.integration import prepare_audio

ID = "f" * 32


def generate_audio_wav(path: Path, duration: float = 3.0, freq: int = 440):
    rate = 48000
    samples = array("h")
    total_samples = int(duration * rate)
    for i in range(total_samples):
        val = 0.3 * math.sin(2 * math.pi * freq * i / rate)
        samples.append(int(val * 32767))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(samples.tobytes())


def generate_video_mp4(path: Path, duration: float = 3.0, width: int = 640, height: int = 360, with_audio: bool = True):
    ffmpeg = resolve_ffmpeg_exe()
    args = [
        str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc=duration={duration}:size={width}x{height}:rate=30",
    ]
    if with_audio:
        args.extend(["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"])
        args.extend(["-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", str(path)])
    else:
        args.extend(["-c:v", "libx264", "-an", "-pix_fmt", "yuv420p", str(path)])
    subprocess.run(args, check=True)


def test_prepare_audio_creates_ai_source_audio(tmp_path):
    root = tmp_path / "session_root"
    root.mkdir(parents=True, exist_ok=True)
    (root / "requests").mkdir(exist_ok=True)
    (root / "narration").mkdir(exist_ok=True)

    video_path = root / "video.mp4"
    generate_video_mp4(video_path, duration=2.0, with_audio=True)

    project = {
        "sessionId": ID,
        "fps": 30,
        "audioTiming": {"mode": "manual"},
        "scenes": [
            {
                "imagePath": str(video_path),
                "mediaType": "video",
                "durationSeconds": 2.0,
                "sourceStartSeconds": 0.0,
                "sourceAudio": True,
                "aiAudio": {"crossfadeMs": 40, "normalize": True},
            }
        ]
    }

    prepare_audio(project, root)
    assert "_aiSourceAudio" in project
    target = Path(project["_aiSourceAudio"])
    assert target.is_file()
    assert target.stat().st_size > 0


def test_all_audio_combinations_ffmpeg_render(tmp_path):
    output_folder = tmp_path / "outputs"
    output_folder.mkdir(parents=True, exist_ok=True)
    images_folder = tmp_path / "images"
    images_folder.mkdir(parents=True, exist_ok=True)

    # Synthetic input assets
    video_path = tmp_path / "source.mp4"
    generate_video_mp4(video_path, duration=3.0, with_audio=True)

    voice_path = tmp_path / "voice.wav"
    generate_audio_wav(voice_path, duration=3.0, freq=440)

    music_path = tmp_path / "music.wav"
    generate_audio_wav(music_path, duration=3.0, freq=880)

    ai_audio_path = tmp_path / "ai_source.wav"
    generate_audio_wav(ai_audio_path, duration=3.0, freq=220)

    scene = SceneMotionSettings(
        image_path=video_path,
        duration_seconds=3.0,
        extra_fields={
            "mediaType": "video",
            "sourceStartSeconds": 0.0,
            "crop": "center",
            "aiVideo": {"colorPreset": "original", "cropMode": "center"},
            "aiAudio": {"crossfadeMs": 40, "normalize": True},
        }
    )

    # 1. ai_source_audio alone
    settings = ProjectSettings(
        images_folder=images_folder,
        voice_file=Path(),
        music_file=None,
        output_folder=output_folder,
        output_name="test_ai_only.mp4",
        scenes=[scene],
        ai_source_audio=ai_audio_path,
    )
    out1 = render_project(settings, lambda p, s: None, lambda m: None, threading.Event())
    assert out1.is_file() and out1.stat().st_size > 0

    # 2. voice + ai_source_audio
    settings = ProjectSettings(
        images_folder=images_folder,
        voice_file=voice_path,
        music_file=None,
        output_folder=output_folder,
        output_name="test_voice_ai.mp4",
        scenes=[scene],
        ai_source_audio=ai_audio_path,
    )
    out2 = render_project(settings, lambda p, s: None, lambda m: None, threading.Event())
    assert out2.is_file() and out2.stat().st_size > 0

    # 3. music + ai_source_audio
    settings = ProjectSettings(
        images_folder=images_folder,
        voice_file=Path(),
        music_file=music_path,
        output_folder=output_folder,
        output_name="test_music_ai.mp4",
        scenes=[scene],
        ai_source_audio=ai_audio_path,
    )
    out3 = render_project(settings, lambda p, s: None, lambda m: None, threading.Event())
    assert out3.is_file() and out3.stat().st_size > 0

    # 4. voice + music + ai_source_audio
    settings = ProjectSettings(
        images_folder=images_folder,
        voice_file=voice_path,
        music_file=music_path,
        output_folder=output_folder,
        output_name="test_voice_music_ai.mp4",
        scenes=[scene],
        ai_source_audio=ai_audio_path,
    )
    out4 = render_project(settings, lambda p, s: None, lambda m: None, threading.Event())
    assert out4.is_file() and out4.stat().st_size > 0


def test_full_ai_editor_upload_analyze_plan_render_smoke(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "DATA_ROOT", tmp_path)
    session_id = ID
    root = web.session_root(session_id)
    video_dir = root / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)
    video_file = video_dir / f"{ID}.mp4"
    generate_video_mp4(video_file, duration=4.0, with_audio=True)

    with TestClient(web.app) as client:
        # Analyze
        res_an = client.post("/api/ai-editor/analyze", json={"sessionId": session_id, "sourceIds": [ID], "language": "en"})
        assert res_an.status_code == 200
        job_id = res_an.json()["jobId"]

        # Poll analysis job
        for _ in range(50):
            res_job = client.get(f"/api/ai-editor/jobs/{job_id}?session_id={session_id}").json()
            if res_job["status"] == "complete":
                break
            time.sleep(0.1)
        assert res_job["status"] == "complete"

        # Plan
        res_plan = client.post("/api/ai-editor/plan", json={"sessionId": session_id, "analysisId": job_id, "instruction": "3 second vertical clip", "presets": ["subtitles"]})
        assert res_plan.status_code == 200
        plan = res_plan.json()["plan"]

        # Render
        res_ren = client.post("/api/ai-editor/render", json={"sessionId": session_id, "analysisId": job_id, "plan": plan})
        assert res_ren.status_code == 200
        render_job_id = res_ren.json()["jobId"]

        # Poll render job
        for _ in range(100):
            res_rjob = client.get(f"/api/ai-editor/jobs/{render_job_id}?session_id={session_id}").json()
            if res_rjob["status"] in {"complete", "error"}:
                break
            time.sleep(0.1)
        assert res_rjob["status"] == "complete", f"Render failed: {res_rjob.get('error')}"
        assert res_rjob["outputPath"] and Path(res_rjob["outputPath"]).is_file()
        assert res_rjob["review"]["checks"]["file"] is True
