import asyncio
from pathlib import Path
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from backend import app as web
from ai_editor.models import EditPlan, Source, Segment, Operation, SubtitleStyle, validate_sources
from ai_editor.edit_planner import build_plan, filler_segments, retained_ranges
from ai_editor.silence_detection import parse_silences
from ai_editor.subtitles import ass, cues_for_range
from ai_editor.ffmpeg_builder import audio_command, video_filter
from ai_editor.quality_review import review

ID = "a" * 32


def source():
    return Source(id=ID, name="talk.mp4", duration=10, hasAudio=True,
                  segments=[Segment(start=1, end=1.3, text="um"), Segment(start=2, end=2.3, text="like"), Segment(start=3, end=4, text="Bonjour مرحبا")],
                  silences=[Segment(start=5, end=7)])


def test_plan_rejects_shell_fields_nonfinite_and_bad_ranges():
    for extra in [{"command": "rm -rf"}, {"targetDuration": float("nan")}, {"video": {"colorPreset": "movie=/etc/passwd"}}]:
        with pytest.raises(ValidationError): EditPlan.model_validate({"sourceDuration": 10, "targetDuration": 8, **extra})
    with pytest.raises(ValidationError): Segment(start=3, end=2)
    plan = EditPlan(sourceDuration=10, targetDuration=8, operations=[Operation(sourceId=ID, start=9, end=11, type="cut")])
    with pytest.raises(ValueError): validate_sources(plan, [source()])


def test_silence_padding_and_unterminated_tail():
    found = parse_silences("silence_start: 1\nsilence_end: 2\nsilence_start: 9", 10)
    assert [(s.start, s.end) for s in found] == [(1.15, 1.85), (9.15, 10)]
    assert not parse_silences("silence_start: 1\nsilence_end: 1.2", 10)


def test_fillers_do_not_cut_normal_speech_or_long_segments():
    segments = source().segments + [Segment(start=6, end=8, text="um"), Segment(start=8, end=9, text="you know")]
    assert [s.text for s in filler_segments(segments, ["um", "like", "you know"])] == ["um"]


def test_plan_and_ranges_keep_order_and_duration():
    plan = build_plan([source()], "Make a 6 second vertical Reel", ["silence", "fillers", "subtitles"], ["um"], "fr")
    assert plan.aspectRatio == "9:16"
    assert plan.language == "fr"
    ranges = retained_ranges(plan, [source()])
    assert sum(b-a for _, a, b in ranges) == pytest.approx(6)
    assert all(not (a < 7 and b > 5) for _, a, b in ranges)
    plan.operations += [Operation(sourceId=ID, start=0, end=10, type="cut")]
    with pytest.raises(ValueError, match="all footage"): retained_ranges(plan, [source()])


def test_subtitles_unicode_timestamps_and_injection():
    text = ass([(0, 1.25, "Hello Bonjour مرحبا {\\pos(0,0)}")], SubtitleStyle(), 1080, 1920)
    assert "0:00:01.25" in text and "مرحبا" in text
    assert "{\\pos" not in text
    plan = build_plan([source()], "subtitles", ["subtitles"], [], "ar")
    assert cues_for_range(plan, ID, 3.5, 5) == [(0, .5, "Bonjour مرحبا")]


def test_ffmpeg_arguments_are_bounded_and_not_shell_commands():
    with patch("ai_editor.media.resolve_ffmpeg_exe", return_value=Path("ffmpeg")):
        args = audio_command("clip;touch bad.mp4", "out.wav", 2, 4)
    assert args[args.index("-i") + 1] == "clip;touch bad.mp4"
    assert "afade=t=in:d=0.0400" in args[args.index("-af") + 1]
    assert "crop=1080:1920" in video_filter(1080, 1920, 30, "bright")
    with pytest.raises(ValueError): video_filter(1080, 1920, 30, "null;movie=/etc/passwd")


def test_quality_review_detects_missing_audio_and_wrong_dimensions(tmp_path):
    output = tmp_path / "out.mp4"; output.write_bytes(b"media")
    data = {"format": {"duration": 4}, "streams": [{"codec_type": "video", "width": 1920, "height": 1080}]}
    with patch("ai_editor.quality_review.probe", return_value=data):
        assert all(review(output, 4, 1920, 1080, False)["checks"].values())
        with pytest.raises(ValueError): review(output, 4, 1080, 1920, True)


def test_endpoints_and_session_isolation(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "DATA_ROOT", tmp_path)
    with TestClient(web.app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/ai-editor/capabilities").status_code == 200
        assert client.post("/api/ai-editor/analyze", json={"sessionId": "../escape", "sourceIds": [ID]}).status_code == 422
        assert client.post("/api/ai-editor/analyze", json={"sessionId": ID, "sourceIds": ["../escape"]}).status_code == 400
        assert client.post("/api/ai-editor/uploads", data={"session_id": ID}, files={"file": ("attack.html", b"x", "text/html")}).status_code == 415
        assert client.get(f"/api/ai-editor/jobs/{ID}?session_id={ID}").status_code == 404


def test_full_analysis_plan_flow_and_cross_session_denial(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "DATA_ROOT", tmp_path)
    root = web.session_root(ID) / "videos"; root.mkdir()
    (root / f"{ID}.mp4").write_bytes(b"fake fixture")
    data = {"format": {"duration": 10}, "streams": [{"codec_type": "video"}]}
    with patch("ai_editor.routes.probe", return_value=data), TestClient(web.app) as client:
        response = client.post("/api/ai-editor/analyze", json={"sessionId": ID, "sourceIds": [ID]})
        assert response.status_code == 200
        job_id = response.json()["jobId"]
        for _ in range(100):
            result = client.get(f"/api/ai-editor/jobs/{job_id}?session_id={ID}").json()
            if result["status"] == "complete": break
        assert result["status"] == "complete"
        assert client.get(f"/api/ai-editor/jobs/{job_id}?session_id={'b'*32}").status_code == 404
        planned = client.post("/api/ai-editor/plan", json={"sessionId": ID, "analysisId": job_id, "instruction": "45 second Reel"})
        assert planned.status_code == 200
        plan = planned.json()["plan"]
        plan["operations"] = [{"sourceId": ID, "type": "cut", "start": 0, "end": 11}]
        assert client.post("/api/ai-editor/render", json={"sessionId": ID, "analysisId": job_id, "plan": plan}).status_code == 422
