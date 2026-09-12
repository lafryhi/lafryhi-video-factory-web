from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import uuid
from typing import Any

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from core.image_utils import IMAGE_EXTENSIONS, natural_sort_key
from core.narration_mapping_models import SUPPORTED_NARRATION_EXTENSIONS
from core.scene_configuration_service import SceneConfigurationService

DATA_ROOT = Path(os.environ.get("LAFRYHI_WEB_DATA", ROOT / "data")).resolve()
FRONTEND_DIST = ROOT.parent / "frontend" / "dist"
SESSION_RE = re.compile(r"^[a-f0-9]{32}$")
MAX_IMAGE_BYTES = int(os.environ.get("LAFRYHI_MAX_IMAGE_BYTES", 30 * 1024 * 1024))
MAX_AUDIO_BYTES = int(os.environ.get("LAFRYHI_MAX_AUDIO_BYTES", 300 * 1024 * 1024))
ERRORS: deque[dict[str, Any]] = deque(maxlen=200)
JOBS: dict[str, dict[str, Any]] = {}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
LOGGER = logging.getLogger("lafryhi.web")


def session_root(session_id: str) -> Path:
    if not SESSION_RE.fullmatch(session_id):
        raise HTTPException(400, "Invalid session identifier.")
    root = (DATA_ROOT / "sessions" / session_id).resolve()
    root.mkdir(parents=True, exist_ok=True)
    for name in ("images", "audio", "narration", "outputs", "previews", "requests"):
        (root / name).mkdir(exist_ok=True)
    return root


def new_session() -> tuple[str, Path]:
    session_id = uuid.uuid4().hex
    return session_id, session_root(session_id)


def allowed_path(value: str | Path) -> Path:
    candidate = Path(value).resolve()
    allowed_roots = (DATA_ROOT, ROOT / "Demo")
    if not any(candidate == root.resolve() or candidate.is_relative_to(root.resolve()) for root in allowed_roots):
        raise HTTPException(403, "The requested file is outside the managed media workspace.")
    return candidate


def safe_name(filename: str | None, fallback: str) -> str:
    name = Path(filename or fallback).name.replace("\x00", "").strip()
    return name or fallback


async def store_upload(upload: UploadFile, destination: Path, maximum: int) -> Path:
    size = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("wb") as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(413, f"{upload.filename or 'Upload'} exceeds the configured size limit.")
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()
    return destination


async def run_cli(command: str, *, payload: dict[str, Any] | None = None, extra: list[str] | None = None) -> dict[str, Any]:
    request_path: Path | None = None
    arguments = (
        [sys.executable, "__cli__", command]
        if getattr(sys, "frozen", False)
        else [sys.executable, str(ROOT / "cli.py"), command]
    )
    if payload is not None:
        request_dir = DATA_ROOT / "requests"
        request_dir.mkdir(parents=True, exist_ok=True)
        request_path = request_dir / f"{uuid.uuid4().hex}.json"
        request_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        arguments += ["--request", str(request_path)]
    arguments += extra or []
    process = await asyncio.create_subprocess_exec(
        *arguments, cwd=str(ROOT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await process.communicate()
    request_path and request_path.unlink(missing_ok=True)
    events = []
    for line in stdout.decode("utf-8", "replace").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    result = next((event for event in reversed(events) if event.get("type") in {"result", "error", "cancelled"}), None)
    if process.returncode != 0 or not result or result.get("type") == "error":
        message = (result or {}).get("message") or stderr.decode("utf-8", "replace").strip() or f"Python command exited with {process.returncode}."
        raise HTTPException(400, message)
    return result


def prepare_project(payload: dict[str, Any]) -> tuple[str, Path, dict[str, Any]]:
    project = dict(payload.get("project") or payload)
    project.pop("_aiSourceAudio", None)  # server-generated only
    session_id = str(project.get("sessionId") or "")
    root = session_root(session_id)
    project["sessionId"] = session_id
    project["baseDir"] = str(root)
    project["outputFolder"] = str(root / "outputs")
    for key in ("voiceFile", "musicFile"):
        if project.get(key):
            project[key] = str(allowed_path(project[key]))
    scenes = []
    for scene in project.get("scenes") or []:
        item = dict(scene)
        item["imagePath"] = str(allowed_path(item["imagePath"]))
        scenes.append(item)
    project["scenes"] = scenes
    assignments = project.get("narrationMapping", {}).get("assignments", [])
    for assignment in assignments:
        if assignment.get("audioPath"):
            assignment["audioPath"] = str(allowed_path(assignment["audioPath"]))
    return session_id, root, project


async def start_render(job_id: str, project: dict[str, Any], root: Path) -> None:
    job = JOBS[job_id]
    if any(s.get("mediaType") == "video" for s in project.get("scenes", [])):
        try:
            from ai_editor.integration import prepare_audio
            await asyncio.to_thread(prepare_audio, project, root)
        except Exception as exc:
            job.update(status="error", error=str(exc))
            return
    if job["status"] == "cancelling":
        job.update(status="cancelled")
        return
    request_path = root / "requests" / f"render-{job_id}.json"
    request_path.write_text(json.dumps({"project": project}, ensure_ascii=False), encoding="utf-8")
    arguments = (
        [sys.executable, "__cli__", "render", "--request", str(request_path)]
        if getattr(sys, "frozen", False)
        else [sys.executable, str(ROOT / "cli.py"), "render", "--request", str(request_path)]
    )
    process = await asyncio.create_subprocess_exec(
        *arguments, cwd=str(ROOT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    if job["status"] == "cancelling":
        job["process"] = process
        process.send_signal(signal.SIGINT)
    else:
        job.update(status="running", process=process)
    try:
        assert process.stdout
        async for raw in process.stdout:
            try:
                event = json.loads(raw.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue
            job["events"].append(event)
            if event.get("type") == "progress":
                job.update(progress=event.get("value", 0), stage=event.get("stage", "Rendering"))
            elif event.get("type") == "result":
                job.update(status="complete", progress=1, outputPath=str(allowed_path(event["outputPath"])))
            elif event.get("type") == "error":
                job.update(status="error", error=str(event.get("message") or "The renderer reported an error."))
            elif event.get("type") == "cancelled":
                job.update(status="cancelled")
        stderr = (await process.stderr.read()).decode("utf-8", "replace") if process.stderr else ""
        return_code = await process.wait()
        if job["status"] == "cancelling":
            job.update(status="cancelled", error=None)
        elif return_code not in (0, 130) and job["status"] not in {"cancelled", "complete", "error"}:
            job.update(status="error", error=stderr.strip() or f"Renderer exited with {return_code}.")
        elif job["status"] == "running":
            job.update(status="cancelled" if return_code == 130 else "error", error=None if return_code == 130 else "Renderer finished without a result.")
    except Exception as exc:
        LOGGER.exception("Render job %s failed", job_id)
        job.update(status="error", error=str(exc))
    finally:
        request_path.unlink(missing_ok=True)
        job.pop("process", None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    yield
    for job in JOBS.values():
        process = job.get("process")
        if process and process.returncode is None:
            process.terminate()


app = FastAPI(title="LAFRYHI Video Factory API", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.environ.get("LAFRYHI_CORS", "http://127.0.0.1:5173,http://localhost:5173").split(",")],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Request-ID"],
)


@app.middleware("http")
async def request_diagnostics(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    try:
        response = await call_next(request)
    except Exception as exc:
        ERRORS.append({"requestId": request_id, "path": request.url.path, "error": type(exc).__name__, "message": str(exc)})
        LOGGER.exception("request_id=%s path=%s", request_id, request.url.path)
        raise
    response.headers["X-Request-ID"] = request_id
    response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    return response


@app.get("/api/health")
async def health():
    return {"ok": True, "version": app.version, "jobs": len(JOBS)}


@app.get("/api/debug/errors")
async def debug_errors():
    return list(ERRORS)


@app.get("/api/capabilities")
async def capabilities():
    result = await run_cli("capabilities")
    session_id, root = new_session()
    result["defaults"].update(sessionId=session_id, baseDir=str(root), outputFolder=str(root / "outputs"))
    return result


@app.post("/api/uploads/images")
async def upload_images(session_id: str = Form(...), files: list[UploadFile] = File(...)):
    root = session_root(session_id)
    stored = []
    for index, upload in enumerate(files):
        suffix = Path(upload.filename or "").suffix.casefold()
        if suffix not in IMAGE_EXTENSIONS:
            raise HTTPException(415, f"Unsupported image type: {upload.filename}")
        destination = root / "images" / f"{index:04d}-{safe_name(upload.filename, f'image-{index}{suffix}')}"
        await store_upload(upload, destination, MAX_IMAGE_BYTES)
        try:
            with Image.open(destination) as image:
                image.verify()
        except Exception as exc:
            destination.unlink(missing_ok=True)
            raise HTTPException(415, f"Invalid image: {upload.filename}") from exc
        stored.append(destination)
    stored.sort(key=natural_sort_key)
    scenes = SceneConfigurationService.create_defaults(stored)
    return {"folder": str(root / "images"), "count": len(stored), "scenes": [scene.to_dict() for scene in scenes]}


@app.post("/api/uploads/audio")
async def upload_audio(session_id: str = Form(...), kind: str = Form(...), file: UploadFile = File(...)):
    if kind not in {"voice", "music", "narration"}:
        raise HTTPException(400, "Audio kind must be voice, music, or narration.")
    suffix = Path(file.filename or "").suffix.casefold()
    if suffix not in SUPPORTED_NARRATION_EXTENSIONS:
        raise HTTPException(415, f"Unsupported audio type: {file.filename}")
    root = session_root(session_id)
    destination = root / ("narration" if kind == "narration" else "audio") / safe_name(file.filename, f"{kind}{suffix}")
    await store_upload(file, destination, MAX_AUDIO_BYTES)
    return {"path": str(destination), "name": destination.name, "kind": kind}


@app.post("/api/uploads/narration")
async def upload_narration(session_id: str = Form(...), files: list[UploadFile] = File(...)):
    root = session_root(session_id)
    stored = []
    for upload in files:
        suffix = Path(upload.filename or "").suffix.casefold()
        if suffix not in SUPPORTED_NARRATION_EXTENSIONS:
            raise HTTPException(415, f"Unsupported audio type: {upload.filename}")
        stored.append(await store_upload(upload, root / "narration" / safe_name(upload.filename, f"clip-{len(stored)}{suffix}"), MAX_AUDIO_BYTES))
    return {"folder": str(root / "narration"), "count": len(stored)}


@app.post("/api/demo")
async def demo(request: Request):
    body = await request.json()
    session_id = str(body.get("sessionId") or "")
    orientation = str(body.get("orientation") or "landscape").strip().casefold()
    if orientation not in {"landscape", "portrait"}:
        raise HTTPException(400, "Demo orientation must be landscape or portrait.")
    root = session_root(session_id)
    result = await run_cli("demo-scan", extra=["--root", str(ROOT), "--output-folder", str(root / "outputs"), "--orientation", orientation])
    scenes = SceneConfigurationService.create_defaults([Path(item) for item in result.get("images", [])])
    result["scenes"] = [scene.to_dict() for scene in scenes]
    return result


@app.post("/api/analyze")
async def analyze(request: Request):
    body = await request.json()
    _session_id, _root, project = prepare_project(body)
    return await run_cli("analyze", payload={"project": project})


@app.post("/api/map-narration")
async def map_narration(request: Request):
    body = await request.json()
    _session_id, root, project = prepare_project(body)
    return await run_cli("map-narration", payload={"project": project, "narrationFolder": str(root / "narration")})


@app.post("/api/preview")
async def preview(request: Request):
    body = await request.json()
    _session_id, root, project = prepare_project(body)
    scene_id = str(body.get("sceneId") or "")
    result = await run_cli("preview", payload={"project": project, "sceneId": scene_id}, extra=["--scene-id", scene_id])
    source = Path(result["previewPath"])
    destination = root / "previews" / f"{uuid.uuid4().hex}.mp4"
    shutil.copy2(source, destination)
    result["previewPath"] = str(destination)
    return result


@app.post("/api/render")
async def render(request: Request):
    body = await request.json()
    session_id, root, project = prepare_project(body)
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"id": job_id, "sessionId": session_id, "status": "queued", "progress": 0, "stage": "Preparing export", "events": [], "error": None, "outputPath": None}
    asyncio.create_task(start_render(job_id, project, root))
    return {"jobId": job_id}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Render job not found.")
    return {key: value for key, value in job.items() if key != "process"}


@app.delete("/api/jobs/{job_id}")
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Render job not found.")
    process = job.get("process")
    if process and process.returncode is None:
        process.send_signal(signal.SIGINT)
    job["status"] = "cancelling"
    return {"cancelled": True}


@app.get("/api/media")
async def media(path: str, download: bool = False):
    target = allowed_path(path)
    if not target.is_file():
        raise HTTPException(404, "Media file not found.")
    return FileResponse(target, filename=target.name if download else None)


from ai_editor.routes import create_router
app.include_router(create_router(sys.modules[__name__]))

if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
