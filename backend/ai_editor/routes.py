import asyncio
import json
import re
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from . import transcription
from .edit_planner import build_plan, retained_ranges
from .media import probe
from .models import AnalyzeRequest, PlanRequest, RenderRequest, Source
from .silence_detection import detect
from .subtitles import cues_for_range
from .quality_review import review


def create_router(web):
    router = APIRouter(prefix="/api/ai-editor")
    jobs = {}
    tasks = set()
    gate = asyncio.Semaphore(1)

    def source_path(session, source_id):
        if not re.fullmatch(r"[a-f0-9]{32}", source_id): raise HTTPException(400, "Invalid source ID")
        folder = web.session_root(session) / "videos"
        matches = list(folder.glob(source_id + ".*"))
        media = [p for p in matches if p.suffix in {".mp4", ".mov", ".webm", ".mkv"}]
        if len(media) != 1 or not media[0].resolve().is_relative_to(folder.resolve()): raise HTTPException(404, "Source not found")
        return media[0]

    def owned_job(job_id, session):
        item = jobs.get(job_id)
        if not item or item["sessionId"] != session: raise HTTPException(404, "AI job not found; reanalyze after a server restart")
        return item

    def new_job(session, action):
        for key, item in list(jobs.items()):
            if item["status"] in {"complete", "error"} and time.time() - item["created"] > 3600: jobs.pop(key)
        if sum(j["status"] in {"queued", "running"} for j in jobs.values()) >= 4 or len(jobs) >= 100:
            raise HTTPException(429, "AI editor is busy; try again later")
        job_id = uuid.uuid4().hex
        job = jobs[job_id] = dict(id=job_id, sessionId=session, status="queued", stage="Queued", progress=0, created=time.time(), warnings=[])
        async def work():
            async with gate:
                try:
                    job.update(status="running")
                    await action(job)
                    job.update(status="complete", stage="Ready", progress=1)
                except Exception as exc:
                    web.LOGGER.exception("AI editor job failed")
                    job.update(status="error", stage="Failed", error=str(exc))
        task = asyncio.create_task(work())
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return {"jobId": job_id}

    @router.get("/capabilities")
    async def capabilities():
        return {"version": 1, "planner": "conservative-rules-v1", "maxFileBytes": 200 * 1024 * 1024, "maxClips": 10, "languages": ["en", "fr", "ar"], "transcription": bool(web.os.environ.get("AI_EDITOR_WHISPER_MODEL_DIR"))}

    @router.post("/uploads")
    async def upload(session_id: str = Form(...), file: UploadFile = File(...)):
        root = web.session_root(session_id) / "videos"
        root.mkdir(exist_ok=True)
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in {".mp4", ".mov", ".webm", ".mkv"}:
            await file.close()
            raise HTTPException(415, "Use MP4, MOV, WebM or MKV video")
        if len(list(root.glob("*"))) >= 50:
            await file.close()
            raise HTTPException(413, "Session video limit reached; start a new project")
        source_id = uuid.uuid4().hex
        path = root / (source_id + suffix)
        await web.store_upload(file, path, 200 * 1024 * 1024)
        try:
            data = await asyncio.to_thread(probe, path)
        except Exception as exc:
            path.unlink(missing_ok=True)
            raise HTTPException(415, str(exc)) from exc
        return {"id": source_id, "name": Path(file.filename or "video").name[:250], "duration": float(data["format"]["duration"]), "hasAudio": any(s["codec_type"] == "audio" for s in data["streams"]), "path": str(path)}

    @router.post("/analyze")
    async def analyze(body: AnalyzeRequest):
        if len(set(body.sourceIds)) != len(body.sourceIds): raise HTTPException(422, "Duplicate source IDs")
        paths = [source_path(body.sessionId, value) for value in body.sourceIds]
        async def action(job):
            sources = []
            for index, (source_id, path) in enumerate(zip(body.sourceIds, paths)):
                data = await asyncio.to_thread(probe, path)
                source = Source(id=source_id, name=path.name, duration=float(data["format"]["duration"]), hasAudio=any(s["codec_type"] == "audio" for s in data["streams"]))
                if sum(s.duration for s in sources) + source.duration > 1800: raise ValueError("Total source duration exceeds 30 minutes")
                job.update(stage="Transcribing", progress=.1 + index / len(paths) * .7)
                if source.hasAudio:
                    try:
                        source.segments = await asyncio.to_thread(lambda: transcription.provider().transcribe(path, body.language))
                        if any(s.end > source.duration + .1 for s in source.segments): raise ValueError("Transcript timestamps exceed source")
                    except Exception as exc:
                        source.segments = []
                        job["warnings"].append(str(exc))
                    job.update(stage="Analyzing")
                    source.silences = await asyncio.to_thread(detect, path, source.duration)
                sources.append(source)
            job.update(sources=[s.model_dump() for s in sources], language=body.language)
        return new_job(body.sessionId, action)

    def analysis(body):
        item = owned_job(body.analysisId, body.sessionId)
        if item["status"] != "complete" or "sources" not in item: raise HTTPException(409, "Analysis is not ready")
        return item, [Source.model_validate(s) for s in item["sources"]]

    @router.post("/plan")
    async def plan(body: PlanRequest):
        item, sources = analysis(body)
        try:
            result = build_plan(sources, body.instruction, body.presets, body.fillerWords, item["language"])
            retained_ranges(result, sources)
        except ValueError as exc: raise HTTPException(422, str(exc)) from exc
        return {"plan": result.model_dump()}

    @router.post("/render")
    async def render(body: RenderRequest):
        _, sources = analysis(body)
        try: ranges = retained_ranges(body.plan, sources)
        except ValueError as exc: raise HTTPException(422, str(exc)) from exc
        async def action(job):
            job.update(stage="Building Edit Plan", progress=.1)
            result = await web.run_cli("capabilities")
            project = result["defaults"]
            root = web.session_root(body.sessionId)
            vertical = body.plan.aspectRatio == "9:16"
            width, height = (1080, 1920) if vertical else (1920, 1080)
            scenes = []
            for source, start, end in ranges:
                texts = [{"id": uuid.uuid4().hex, "text": text, "fontFamily": "Rubik", "fontSize": body.plan.subtitleStyle.fontSize, "color": "#ffffff", "x": 50, "y": {"top": 12, "center": 50, "bottom": 85}[body.plan.subtitleStyle.position], "startSeconds": a, "endSeconds": b} for a, b, text in cues_for_range(body.plan, source.id, start, end)]
                scenes.append(dict(sceneId=uuid.uuid4().hex, imagePath=str(source_path(body.sessionId, source.id)), durationSeconds=end-start,
                    motion="Static", motionIntensity=0, startZoom=1, endZoom=1, transition="none", transitionDurationSeconds=0, timingWeight=1,
                    mediaType="video", sourceStartSeconds=start, sourceEndSeconds=end, sourceDurationSeconds=source.duration,
                    sourceAudio=source.hasAudio, aiVideo=body.plan.video.model_dump(), aiAudio=body.plan.audio.model_dump(), subtitleStyle=body.plan.subtitleStyle.model_dump(), texts=texts))
            project.update(sessionId=body.sessionId, baseDir=str(root), outputFolder=str(root / "outputs"), outputName=f"ai-{job['id']}.mp4", videoFormat="vertical_9_16" if vertical else "landscape_16_9", resolution=f"{width}x{height}", scenes=scenes, voiceFile="", musicFile="", aiEdits=[{"analysisId": body.analysisId, "plan": body.plan.model_dump()}])
            project["audioTiming"]["mode"] = "manual"
            job.update(stage="Rendering", progress=.2)
            render_id = uuid.uuid4().hex
            web.JOBS[render_id] = dict(id=render_id, sessionId=body.sessionId, status="queued", progress=0, stage="Rendering", events=[], error=None, outputPath=None)
            await web.start_render(render_id, json.loads(json.dumps(project)), root)
            output = web.JOBS.pop(render_id)
            if output["status"] != "complete": raise ValueError(output.get("error") or "Render failed")
            job.update(stage="Reviewing", progress=.9)
            duration = sum(round(s["durationSeconds"] * project["fps"]) / project["fps"] for s in scenes)
            quality = await asyncio.to_thread(review, Path(output["outputPath"]), duration, width, height, any(s.hasAudio for s, _, _ in ranges))
            job.update(project=project, outputPath=output["outputPath"], review=quality)
        return new_job(body.sessionId, action)

    @router.get("/jobs/{job_id}")
    async def job(job_id: str, session_id: str):
        return owned_job(job_id, session_id)

    return router
