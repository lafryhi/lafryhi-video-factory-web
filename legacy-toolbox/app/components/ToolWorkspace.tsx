"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import NextImage from "next/image";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import type { LogEvent, ProgressEvent } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { TOOL_STATUS_MESSAGES } from "../lib/tools";
import type { ToolDefinition } from "../lib/tools";

const FFMPEG_CORE_URL = "/ffmpeg/ffmpeg-core.js";
const FFMPEG_WASM_URL = "/ffmpeg/ffmpeg-core.wasm";

let ffmpeg: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
let ffmpegOperationLocked = false;

function tryAcquireFFmpegOperation() {
  if (ffmpegOperationLocked) return false;
  ffmpegOperationLocked = true;
  return true;
}

function releaseFFmpegOperation() {
  ffmpegOperationLocked = false;
}

async function loadFFmpegClient(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    try {
      const instance = new FFmpeg();
      await instance.load({
        coreURL: FFMPEG_CORE_URL,
        wasmURL: FFMPEG_WASM_URL,
      });
      ffmpeg = instance;
      return instance;
    } catch (error) {
      ffmpegLoadPromise = null;
      console.error("FFmpeg runtime failed to load from same-origin assets.", {
        coreURL: FFMPEG_CORE_URL,
        wasmURL: FFMPEG_WASM_URL,
        error,
      });
      throw new Error("FFmpeg runtime load failed.", { cause: error });
    }
  })();

  return ffmpegLoadPromise;
}

async function writeFFmpegInputFile(path: string, file: File) {
  const instance = await loadFFmpegClient();
  await instance.writeFile(path, await fetchFile(file));
}

async function execFFmpeg(args: string[], onProgress: (progress: number) => void) {
  const instance = await loadFFmpegClient();
  const progressCallback = ({ progress }: ProgressEvent) => {
    if (typeof progress === "number" && Number.isFinite(progress)) {
      onProgress(Math.max(0, Math.min(1, progress)));
    }
  };

  instance.on("progress", progressCallback);
  try {
    const exitCode = await instance.exec(args);
    if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}.`);
  } finally {
    instance.off("progress", progressCallback);
  }
}

async function readFFmpegOutputFile(path: string) {
  const instance = await loadFFmpegClient();
  const data = await instance.readFile(path);
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function createMp4ObjectUrl(output: Uint8Array) {
  const outputBuffer = new ArrayBuffer(output.byteLength);
  new Uint8Array(outputBuffer).set(output);
  return URL.createObjectURL(new Blob([outputBuffer], { type: "video/mp4" }));
}

async function deleteFFmpegFiles(paths: string[]) {
  if (!ffmpeg) return;
  await Promise.allSettled(paths.map((path) => ffmpeg?.deleteFile(path)));
}

async function ffmpegInputHasAudio(path: string) {
  const instance = await loadFFmpegClient();
  let log = "";
  const logCallback = ({ message }: LogEvent) => {
    if (message) log += `${message}\n`;
  };
  instance.on("log", logCallback);
  try {
    await instance.exec(["-i", path, "-map", "0:a:0?", "-t", "0.01", "-f", "null", "-"]);
  } finally {
    instance.off("log", logCallback);
  }
  return /Stream #\d+:\d+(?:\([^)]*\))?: Audio:/i.test(log);
}

type SelectedVideo = {
  id: string;
  file: File;
};

type WorkspacePhase = "idle" | "metadata" | "loading" | "processing" | "complete" | "error";

const MIN_MERGE_FILES = 2;
const OUTPUT_FILE = "merged-output.mp4";
const TRIM_OUTPUT_FILE = "trimmed-output.mp4";

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function safeInputName(index: number, file: File) {
  const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp4";
  return `input-${index}.${extension}`;
}

function createConcatFile(files: string[]) {
  return files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n");
}

function getErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "The selected videos are too large for the browser memory available. Try smaller files or fewer clips.";
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("memory") || message.includes("allocation")) {
      return "The merge could not complete because the browser ran out of memory. Try smaller files or fewer clips.";
    }
    if (message.includes("load") || message.includes("asset") || message.includes("runtime")) {
      return "FFmpeg could not load in this browser. Check your connection and try again.";
    }
    return error.message;
  }

  return "The merge failed. Try different files or a smaller selection.";
}

function MergeVideosWorkspace({ tool }: { tool: ToolDefinition }) {
  const [videos, setVideos] = useState<SelectedVideo[]>([]);
  const [phase, setPhase] = useState<WorkspacePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const totalSize = useMemo(
    () => videos.reduce((sum, video) => sum + video.file.size, 0),
    [videos]
  );

  const canMerge = videos.length >= MIN_MERGE_FILES && phase !== "loading" && phase !== "processing";
  const isWorking = phase === "loading" || phase === "processing";

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  function setSelectedFiles(files: File[]) {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setVideos(files.map((file, index) => ({ id: `${index}-${file.name}-${file.size}-${file.lastModified}`, file })));
    setDownloadUrl(null);
    setProgress(0);
    setPhase("idle");
    setError(null);
  }

  function moveVideo(index: number, direction: -1 | 1) {
    setVideos((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeVideo(id: string) {
    setVideos((current) => current.filter((video) => video.id !== id));
    setProgress(0);
    setPhase("idle");
    setError(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
  }

  function resetWorkspace() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setVideos([]);
    setDownloadUrl(null);
    setProgress(0);
    setPhase("idle");
    setError(null);
  }

  async function mergeVideos() {
    if (videos.length < MIN_MERGE_FILES) {
      setError("Select at least two video files to merge.");
      return;
    }

    const inputFiles = videos.map(({ file }, index) => safeInputName(index, file));
    const concatList = "merge-inputs.txt";
    const tempFiles = [...inputFiles, concatList, OUTPUT_FILE];

    if (!tryAcquireFFmpegOperation()) {
      setPhase("error");
      setError("FFmpeg is already busy processing another video. Wait for it to finish and try again.");
      return;
    }

    try {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
      setError(null);
      setProgress(0);
      setPhase("loading");

      await loadFFmpegClient();
      setPhase("processing");

      await Promise.all(videos.map(({ file }, index) => writeFFmpegInputFile(inputFiles[index], file)));
      const ffmpeg = await loadFFmpegClient();
      await ffmpeg.writeFile(concatList, createConcatFile(inputFiles));

      // Stream-copy concat is fast but only reliable when every input has matching codecs,
      // dimensions, time bases and stream layouts. User uploads are arbitrary, so this first
      // working workflow uses FFmpeg's concat demuxer plus H.264/AAC re-encoding to produce a
      // broadly compatible MP4 result. Re-encoding can change quality and takes more memory/CPU.
      await execFFmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatList,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        OUTPUT_FILE,
      ], setProgress);

      const output = await readFFmpegOutputFile(OUTPUT_FILE);
      setDownloadUrl(createMp4ObjectUrl(output));
      setProgress(1);
      setPhase("complete");
    } catch (mergeError) {
      setPhase("error");
      setError(getErrorMessage(mergeError));
    } finally {
      try {
        await deleteFFmpegFiles(tempFiles);
      } finally {
        releaseFFmpegOperation();
      }
    }
  }

  return (
    <section className="workspace">
      <label className="dropzone">
        <input
          type="file"
          accept={tool.input.accept}
          multiple={tool.input.multiple}
          disabled={isWorking}
          aria-label="Select video files to merge"
          onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
        />
        <span className="drop-icon">↑</span>
        <strong>Select files</strong>
        <small>Choose at least two videos. Files stay on your device and are processed in your browser.</small>
      </label>

      {videos.length ? (
        <div className="selection stack">
          <div className="selection-heading">
            <div>
              <strong>{`${videos.length} ${videos.length === 1 ? "file" : "files"} selected`}</strong>
              <small>{formatMegabytes(totalSize)}</small>
            </div>
            <button type="button" className="secondary" onClick={resetWorkspace} disabled={isWorking}>Reset</button>
          </div>

          <ol className="file-list" aria-label="Selected videos in merge order">
            {videos.map((video, index) => (
              <li key={video.id}>
                <div>
                  <strong>{video.file.name}</strong>
                  <small>{formatMegabytes(video.file.size)}</small>
                </div>
                <div className="file-actions">
                  <button type="button" className="secondary" onClick={() => moveVideo(index, -1)} disabled={isWorking || index === 0} aria-label={`Move ${video.file.name} earlier`}>↑</button>
                  <button type="button" className="secondary" onClick={() => moveVideo(index, 1)} disabled={isWorking || index === videos.length - 1} aria-label={`Move ${video.file.name} later`}>↓</button>
                  <button type="button" className="secondary" onClick={() => removeVideo(video.id)} disabled={isWorking} aria-label={`Remove ${video.file.name}`}>Remove</button>
                </div>
              </li>
            ))}
          </ol>

          {videos.length < MIN_MERGE_FILES ? <p className="error">Select at least two video files to merge.</p> : null}

          {isWorking ? (
            <div>
              <small>{phase === "loading" ? "Loading FFmpeg in your browser…" : "Merging videos…"}</small>
              <div className="progress" aria-label="Merge progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} role="progressbar">
                <span style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
              </div>
            </div>
          ) : null}

          {error ? <p className="error">{error}</p> : null}

          <div className="workspace-actions">
            <button type="button" onClick={mergeVideos} disabled={!canMerge}>{phase === "error" ? "Retry Merge Videos" : "Start Merge Videos"}</button>
            {downloadUrl ? <a className="download" href={downloadUrl} download="lafryhi-merged-video.mp4">Download MP4</a> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

type TrimRange = {
  startTime: number;
  endTime: number;
};

function validateTrimRange(startValue: string, endValue: string): TrimRange | string {
  if (!startValue.trim() || !endValue.trim()) {
    return "Enter both a start time and an end time.";
  }

  const startTime = Number(startValue);
  const endTime = Number(endValue);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return "Start time and end time must be valid finite numbers.";
  }
  if (startTime < 0) {
    return "Start time must be zero or greater.";
  }
  if (endTime <= startTime) {
    return "End time must be greater than start time.";
  }

  return { startTime, endTime };
}

function readVideoDuration(file: File, signal: AbortSignal) {
  return new Promise<number>((resolve, reject) => {
    const metadataUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;

    function cleanup() {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      signal.removeEventListener("abort", handleAbort);
      URL.revokeObjectURL(metadataUrl);
    }

    function succeed(duration: number) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(duration);
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function handleAbort() {
      fail(new DOMException("Video metadata loading was cancelled.", "AbortError"));
    }

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        succeed(duration);
      } else {
        fail(new Error("The browser could not determine this video's duration."));
      }
    };
    video.onerror = () => {
      fail(new Error("The browser could not read this video's duration. Try a different video file."));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    video.src = metadataUrl;
  });
}

function formatSeconds(seconds: number) {
  return Number(seconds.toFixed(3)).toString();
}

function getTrimErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "The selected video is too large for the browser memory available. Try a smaller file.";
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("memory") || message.includes("allocation")) {
      return "The trim could not complete because the browser ran out of memory. Try a smaller file.";
    }
    if (message.includes("load") || message.includes("asset") || message.includes("runtime")) {
      return "FFmpeg could not load in this browser. Check your connection and try again.";
    }
    return error.message;
  }

  return "The trim failed. Try a different file or a shorter range.";
}

function TrimVideoWorkspace({ tool }: { tool: ToolDefinition }) {
  const options = tool.options;
  const [video, setVideo] = useState<File | null>(null);
  const [startValue, setStartValue] = useState("0");
  const [endValue, setEndValue] = useState("");
  const [phase, setPhase] = useState<WorkspacePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const mountedRef = useRef(true);
  const downloadUrlRef = useRef<string | null>(null);
  const metadataAbortRef = useRef<AbortController | null>(null);

  const isWorking = phase === "metadata" || phase === "loading" || phase === "processing";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      metadataAbortRef.current?.abort();
      metadataAbortRef.current = null;
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    };
  }, []);

  function replaceDownloadUrl(nextUrl: string | null) {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = null;

    if (nextUrl && !mountedRef.current) {
      URL.revokeObjectURL(nextUrl);
      return;
    }

    downloadUrlRef.current = nextUrl;
    setDownloadUrl(nextUrl);
  }

  function clearResult() {
    replaceDownloadUrl(null);
    setProgress(0);
    setPhase("idle");
    setError(null);
    setNotice(null);
  }

  function selectVideo(file: File | null) {
    clearResult();
    setVideo(file);
    setStartValue("0");
    setEndValue("");
  }

  function updateTime(value: string, setter: (nextValue: string) => void) {
    clearResult();
    setter(value);
  }

  function resetWorkspace() {
    clearResult();
    setVideo(null);
    setStartValue("0");
    setEndValue("");
    setInputKey((current) => current + 1);
  }

  async function trimVideo() {
    if (!video || isWorking) return;

    const range = validateTrimRange(startValue, endValue);
    if (typeof range === "string") {
      setError(range);
      setPhase("error");
      return;
    }

    replaceDownloadUrl(null);
    setError(null);
    setNotice(null);
    setProgress(0);
    setPhase("metadata");

    const metadataAbortController = new AbortController();
    metadataAbortRef.current = metadataAbortController;
    let mediaDuration: number;
    try {
      mediaDuration = await readVideoDuration(video, metadataAbortController.signal);
    } catch (metadataError) {
      if (mountedRef.current) {
        setPhase("error");
        setError(getTrimErrorMessage(metadataError));
      }
      return;
    } finally {
      if (metadataAbortRef.current === metadataAbortController) {
        metadataAbortRef.current = null;
      }
    }

    if (!mountedRef.current) return;

    if (range.startTime >= mediaDuration) {
      setPhase("error");
      setError(`Start time must be less than the video duration of ${formatSeconds(mediaDuration)} seconds.`);
      return;
    }

    const effectiveEndTime = Math.min(range.endTime, mediaDuration);
    if (range.endTime > mediaDuration) {
      setNotice(`End time was limited to the video duration of ${formatSeconds(mediaDuration)} seconds.`);
    }

    const inputFile = `trim-${safeInputName(0, video)}`;
    const tempFiles = [inputFile, TRIM_OUTPUT_FILE];

    if (!tryAcquireFFmpegOperation()) {
      setPhase("error");
      setError("FFmpeg is already busy processing another video. Wait for it to finish and try again.");
      return;
    }

    try {
      setPhase("loading");

      await loadFFmpegClient();
      if (mountedRef.current) setPhase("processing");
      await writeFFmpegInputFile(inputFile, video);

      const duration = effectiveEndTime - range.startTime;
      await execFFmpeg([
        "-y",
        "-ss", String(range.startTime),
        "-i", inputFile,
        "-t", String(duration),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        TRIM_OUTPUT_FILE,
      ], (nextProgress) => {
        if (mountedRef.current) setProgress(nextProgress);
      });

      const output = await readFFmpegOutputFile(TRIM_OUTPUT_FILE);
      const nextDownloadUrl = createMp4ObjectUrl(output);
      replaceDownloadUrl(nextDownloadUrl);
      if (mountedRef.current) {
        setProgress(1);
        setPhase("complete");
      }
    } catch (trimError) {
      if (mountedRef.current) {
        setPhase("error");
        setError(getTrimErrorMessage(trimError));
        setNotice(null);
      }
    } finally {
      try {
        await deleteFFmpegFiles(tempFiles);
      } finally {
        releaseFFmpegOperation();
      }
    }
  }

  return (
    <section className="workspace">
      <label className="dropzone">
        <input
          key={inputKey}
          type="file"
          accept={tool.input.accept}
          multiple={tool.input.multiple}
          disabled={isWorking}
          aria-label="Select a video file to trim"
          onChange={(event) => selectVideo(event.target.files?.[0] ?? null)}
        />
        <span className="drop-icon">↑</span>
        <strong>Select a video</strong>
        <small>Choose one video. It stays on your device and is processed in your browser.</small>
      </label>

      {video ? (
        <div className="selection stack">
          <div className="selection-heading">
            <div>
              <strong>{video.name}</strong>
              <small>{formatMegabytes(video.size)}</small>
            </div>
            <button type="button" className="secondary" onClick={resetWorkspace} disabled={isWorking}>Reset</button>
          </div>

          <div className="time-fields">
            <label>
              <span>{options.startTime.label}</span>
              <input
                type="number"
                min={options.startTime.min}
                step={options.startTime.step}
                value={startValue}
                disabled={isWorking}
                aria-invalid={Boolean(error)}
                onChange={(event) => updateTime(event.target.value, setStartValue)}
              />
            </label>
            <label>
              <span>{options.endTime.label}</span>
              <input
                type="number"
                min={options.endTime.min}
                step={options.endTime.step}
                value={endValue}
                disabled={isWorking}
                aria-invalid={Boolean(error)}
                onChange={(event) => updateTime(event.target.value, setEndValue)}
              />
            </label>
          </div>

          {isWorking ? (
            <div>
              <small>{phase === "metadata" ? "Reading video duration…" : phase === "loading" ? "Loading FFmpeg in your browser…" : "Trimming video…"}</small>
              <div className="progress" aria-label="Trim progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} role="progressbar">
                <span style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
              </div>
            </div>
          ) : null}

          {error ? <p className="error" role="alert">{error}</p> : null}
          {notice ? <p role="status"><small>{notice}</small></p> : null}

          <div className="workspace-actions">
            <button type="button" onClick={trimVideo} disabled={isWorking}>{phase === "error" ? "Retry Trim Video" : "Start Trim Video"}</button>
            {downloadUrl ? <a className="download" href={downloadUrl} download="lafryhi-trimmed-video.mp4">Download MP4</a> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

type CinematicMedia = {
  id: string;
  file: File;
  kind: "image" | "video";
  previewUrl: string;
  duration: number | null;
};

type CinematicStage =
  | "Reading media…"
  | "Loading video engine…"
  | "Preparing images and videos…"
  | "Creating cinematic motion…"
  | "Blending scenes…"
  | "Mixing audio…"
  | "Finalizing MP4…";

const CINEMATIC_MIN_FILES = 2;
const CINEMATIC_MAX_FILES = 3;
const IMAGE_DURATION = 3.5;
const TRANSITION_DURATION = 0.6;
const FINAL_FADE_DURATION = 0.38;
const CINEMATIC_OUTPUT_FILE = "cinematic-transition-output.mp4";
const SUPPORTED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function validateImage(file: File) {
  return new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
    image.onload = () => {
      cleanup();
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve();
      else reject(new Error(`"${file.name}" is empty or unreadable.`));
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(`"${file.name}" is not a readable image.`));
    };
    image.src = url;
  });
}

function cinematicErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "The selected files are too large for the browser memory available. Try smaller files.";
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("memory") || message.includes("allocation")) {
      return "The selected files are too large for the browser memory available. Try smaller files.";
    }
    if (message.includes("load") || message.includes("asset") || message.includes("runtime")) {
      return "The video engine could not load in this browser. Check your connection and try again.";
    }
    if (message.includes("metadata") || message.includes("duration")) {
      return error.message;
    }
    if (message.includes("output")) {
      return "The cinematic transition finished without a readable output. Try different files.";
    }
    if (message.includes("ffmpeg") || message.includes("codec") || message.includes("decode")) {
      return "The cinematic transition could not be created. One of the video codecs may not be supported.";
    }
    return error.message;
  }
  return "The cinematic transition could not be created.";
}

function imageMotionFilter(index: number, count: number) {
  const frames = Math.round(IMAGE_DURATION * 30);
  const middle = count === 3 && index === 1;
  const final = index === count - 1;
  const zoom = middle
    ? `1.07-0.07*on/${frames - 1}`
    : `1+${final ? "0.06" : "0.07"}*on/${frames - 1}`;
  const x = middle
    ? `(iw-iw/zoom)/2+(on/${frames - 1})*10`
    : `(iw-iw/zoom)/2-(on/${frames - 1})*10`;
  const y = final
    ? `(ih-ih/zoom)/2-(on/${frames - 1})*10`
    : `(ih-ih/zoom)/2`;
  return `scale=1408:792:force_original_aspect_ratio=increase,crop=1408:792,zoompan=z='${zoom}':x='${x}':y='${y}':d=${frames}:s=1280x720:fps=30,setsar=1,format=yuv420p`;
}

function buildTransitionFilter(durations: number[]) {
  let videoLabel = "0:v";
  let audioLabel = "0:a";
  let elapsed = durations[0];
  const filters: string[] = [];

  for (let index = 1; index < durations.length; index += 1) {
    const nextVideo = `vx${index}`;
    const nextAudio = `ax${index}`;
    const offset = elapsed - TRANSITION_DURATION;
    filters.push(
      `[${videoLabel}][${index}:v]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${offset.toFixed(3)}[${nextVideo}]`,
      `[${audioLabel}][${index}:a]acrossfade=d=${TRANSITION_DURATION}:c1=tri:c2=tri[${nextAudio}]`
    );
    videoLabel = nextVideo;
    audioLabel = nextAudio;
    elapsed += durations[index] - TRANSITION_DURATION;
  }

  const fadeStart = Math.max(0, elapsed - FINAL_FADE_DURATION);
  filters.push(
    `[${videoLabel}]fade=t=out:st=${fadeStart.toFixed(3)}:d=${FINAL_FADE_DURATION},format=yuv420p[vout]`,
    `[${audioLabel}]afade=t=out:st=${fadeStart.toFixed(3)}:d=${FINAL_FADE_DURATION}[aout]`
  );
  return filters.join(";");
}

function CinematicTransitionWorkspace({ tool }: { tool: ToolDefinition }) {
  const [media, setMedia] = useState<CinematicMedia[]>([]);
  const [phase, setPhase] = useState<WorkspacePhase>("idle");
  const [stage, setStage] = useState<CinematicStage>("Reading media…");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const downloadUrlRef = useRef<string | null>(null);
  const mediaRef = useRef<CinematicMedia[]>([]);
  const selectionVersionRef = useRef(0);

  const isWorking = phase === "metadata" || phase === "loading" || phase === "processing";
  const canGenerate = media.length >= CINEMATIC_MIN_FILES && !isWorking;

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  useEffect(() => () => {
    selectionVersionRef.current += 1;
    mediaRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
  }, []);

  function replaceDownloadUrl(url: string | null) {
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = url;
    setDownloadUrl(url);
  }

  function clearResult() {
    replaceDownloadUrl(null);
    setProgress(0);
    setPhase("idle");
    setError(null);
  }

  async function addFiles(files: File[]) {
    const version = selectionVersionRef.current + 1;
    selectionVersionRef.current = version;
    clearResult();

    if (media.length + files.length > CINEMATIC_MAX_FILES) {
      setPhase("error");
      setError("Select no more than three images or videos.");
      setInputKey((current) => current + 1);
      return;
    }
    const invalid = files.find((file) => !SUPPORTED_MEDIA_TYPES.has(file.type));
    if (invalid) {
      setPhase("error");
      setError(`"${invalid.name}" is not a supported image or video format.`);
      setInputKey((current) => current + 1);
      return;
    }
    const empty = files.find((file) => file.size <= 0);
    if (empty) {
      setPhase("error");
      setError(`"${empty.name}" is empty or unreadable.`);
      setInputKey((current) => current + 1);
      return;
    }

    setPhase("metadata");
    setStage("Reading media…");
    const createdUrls: string[] = [];
    try {
      const nextItems = await Promise.all(files.map(async (file, index) => {
        const kind = file.type.startsWith("image/") ? "image" : "video";
        let duration: number | null = null;
        if (kind === "image") {
          await validateImage(file);
        } else {
          duration = await readVideoDuration(file, new AbortController().signal);
        }
        const previewUrl = URL.createObjectURL(file);
        createdUrls.push(previewUrl);
        return {
          id: `${Date.now()}-${index}-${file.name}-${file.size}-${file.lastModified}`,
          file,
          kind,
          previewUrl,
          duration,
        } satisfies CinematicMedia;
      }));
      if (selectionVersionRef.current !== version) {
        createdUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      setMedia((current) => [...current, ...nextItems]);
      setPhase("idle");
    } catch (metadataError) {
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
      if (selectionVersionRef.current === version) {
        setPhase("error");
        setError(cinematicErrorMessage(metadataError));
      }
    } finally {
      setInputKey((current) => current + 1);
    }
  }

  function moveItem(index: number, direction: -1 | 1) {
    clearResult();
    setMedia((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeItem(id: string) {
    clearResult();
    setMedia((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  function resetWorkspace() {
    selectionVersionRef.current += 1;
    mediaRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setMedia([]);
    clearResult();
    setInputKey((current) => current + 1);
  }

  async function generateTransition() {
    if (media.length < CINEMATIC_MIN_FILES) {
      setPhase("error");
      setError("Select at least two images or videos before generating a transition.");
      return;
    }
    if (!tryAcquireFFmpegOperation()) {
      setPhase("error");
      setError("The video engine is already processing another operation. Wait for it to finish and try again.");
      return;
    }

    const inputFiles = media.map(({ file }, index) => `cinematic-${safeInputName(index, file)}`);
    const normalizedFiles = media.map((_, index) => `cinematic-normalized-${index}.mp4`);
    const tempFiles = [...inputFiles, ...normalizedFiles, CINEMATIC_OUTPUT_FILE];

    try {
      replaceDownloadUrl(null);
      setError(null);
      setProgress(0);
      setPhase("loading");
      setStage("Loading video engine…");
      await loadFFmpegClient();

      setPhase("processing");
      setStage("Preparing images and videos…");
      await Promise.all(media.map(({ file }, index) => writeFFmpegInputFile(inputFiles[index], file)));

      const durations = media.map((item) => item.kind === "image" ? IMAGE_DURATION : item.duration ?? 0);
      for (let index = 0; index < media.length; index += 1) {
        const item = media[index];
        const duration = durations[index];
        if (!(duration > 0)) throw new Error(`The browser could not determine "${item.file.name}" duration.`);
        setStage(item.kind === "image" ? "Creating cinematic motion…" : "Preparing images and videos…");

        if (item.kind === "image") {
          await execFFmpeg([
            "-y", "-loop", "1", "-t", String(IMAGE_DURATION), "-i", inputFiles[index],
            "-f", "lavfi", "-t", String(IMAGE_DURATION), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-filter:v", imageMotionFilter(index, media.length),
            "-map", "0:v:0", "-map", "1:a:0",
            "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest",
            normalizedFiles[index],
          ], (value) => setProgress((index + value) / (media.length + 1)));
        } else {
          const hasAudio = await ffmpegInputHasAudio(inputFiles[index]);
          const args = ["-y", "-i", inputFiles[index]];
          if (!hasAudio) {
            args.push("-f", "lavfi", "-t", String(duration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
          }
          args.push(
            "-filter:v", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,setpts=PTS-STARTPTS,format=yuv420p",
            "-filter:a", hasAudio
              ? `aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=0:${duration}`
              : `asetpts=PTS-STARTPTS,atrim=0:${duration}`,
            "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0",
            "-t", String(duration), "-r", "30", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "22", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
            normalizedFiles[index]
          );
          await execFFmpeg(args, (value) => setProgress((index + value) / (media.length + 1)));
        }
      }

      setStage("Blending scenes…");
      const finalArgs = ["-y"];
      normalizedFiles.forEach((file) => finalArgs.push("-i", file));
      finalArgs.push(
        "-filter_complex", buildTransitionFilter(durations),
        "-map", "[vout]", "-map", "[aout]",
        "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", CINEMATIC_OUTPUT_FILE
      );
      setStage("Mixing audio…");
      await execFFmpeg(finalArgs, (value) => setProgress((media.length + value) / (media.length + 1)));

      setStage("Finalizing MP4…");
      const output = await readFFmpegOutputFile(CINEMATIC_OUTPUT_FILE);
      if (!output.byteLength) throw new Error("Missing output file.");
      replaceDownloadUrl(createMp4ObjectUrl(output));
      setProgress(1);
      setPhase("complete");
    } catch (processingError) {
      setPhase("error");
      setError(cinematicErrorMessage(processingError));
    } finally {
      try {
        await deleteFFmpegFiles(tempFiles);
      } finally {
        releaseFFmpegOperation();
      }
    }
  }

  return (
    <section className="workspace cinematic-workspace">
      <label className="dropzone">
        <input
          key={inputKey}
          type="file"
          accept={tool.input.accept}
          multiple
          disabled={isWorking || media.length >= CINEMATIC_MAX_FILES}
          aria-label="Select two or three images or videos"
          onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
        />
        <span className="drop-icon">↑</span>
        <strong>Select 2–3 images or videos</strong>
        <small>Your files stay on your device. Cinematic motion and transitions are created automatically in your browser.</small>
      </label>

      {media.length ? (
        <div className="selection stack cinematic-selection">
          <div className="selection-heading">
            <div><strong>{media.length} of 3 files selected</strong><small>{formatMegabytes(media.reduce((sum, item) => sum + item.file.size, 0))}</small></div>
            <button type="button" className="secondary" onClick={resetWorkspace} disabled={isWorking}>Reset workspace</button>
          </div>

          <ol className="file-list media-list" aria-label="Selected media in transition order">
            {media.map((item, index) => (
              <li key={item.id}>
                {item.kind === "image"
                  ? <NextImage className="media-thumbnail" src={item.previewUrl} alt="" width={96} height={62} unoptimized />
                  : <video className="media-thumbnail" src={item.previewUrl} muted preload="metadata" aria-label={`Preview of ${item.file.name}`} />}
                <div className="media-details">
                  <span className="media-badge">{item.kind === "image" ? "Image" : "Video"}</span>
                  <strong title={item.file.name}>{item.file.name}</strong>
                  <small>{formatMegabytes(item.file.size)}{item.duration ? ` · ${formatDuration(item.duration)}` : ""}</small>
                </div>
                <div className="file-actions">
                  <button type="button" className="secondary" onClick={() => moveItem(index, -1)} disabled={isWorking || index === 0} aria-label={`Move ${item.file.name} earlier`}>↑</button>
                  <button type="button" className="secondary" onClick={() => moveItem(index, 1)} disabled={isWorking || index === media.length - 1} aria-label={`Move ${item.file.name} later`}>↓</button>
                  <button type="button" className="secondary" onClick={() => removeItem(item.id)} disabled={isWorking} aria-label={`Remove ${item.file.name}`}>Remove</button>
                </div>
              </li>
            ))}
          </ol>

          <aside className="cinematic-info">
            <strong>Automatic cinematic transition</strong>
            <p>We automatically animate still images, normalize videos, blend scenes smoothly and preserve video audio when available.</p>
          </aside>

          {media.length < CINEMATIC_MIN_FILES && phase !== "metadata" ? <p className="error">Select at least two images or videos.</p> : null}
          {isWorking ? (
            <div aria-live="polite">
              <small>{stage}</small>
              <div className="progress" aria-label="Cinematic transition progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} role="progressbar">
                <span style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
              </div>
            </div>
          ) : null}
          {error ? <p className="error" role="alert">{error}</p> : null}

          {downloadUrl && phase === "complete" ? (
            <div className="cinematic-result">
              <video src={downloadUrl} controls preload="metadata">Your browser cannot preview this MP4.</video>
              <div className="workspace-actions">
                <a className="download" href={downloadUrl} download="lafryhi-cinematic-transition.mp4">Download MP4</a>
                <button type="button" className="secondary" onClick={resetWorkspace}>Create another transition</button>
              </div>
            </div>
          ) : (
            <div className="workspace-actions">
              <button type="button" onClick={generateTransition} disabled={!canGenerate}>{phase === "error" ? "Retry transition" : "Generate transition"}</button>
            </div>
          )}
        </div>
      ) : error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}

function ComingSoonWorkspace({ tool }: { tool: ToolDefinition }) {
  const [files, setFiles] = useState<File[]>([]);
  const [showPlaceholder, setShowPlaceholder] = useState(false);

  const totalSize = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files]
  );

  function processFile() {
    if (!files[0]) return;
    setShowPlaceholder(true);
  }

  return (
    <section className="workspace">
      <label className="dropzone">
        <input
          type="file"
          accept={tool.input.accept}
          multiple={tool.input.multiple}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []));
            setShowPlaceholder(false);
          }}
        />
        <span className="drop-icon">↑</span>
        <strong>Select {tool.input.multiple ? "files" : "a file"}</strong>
        <small>Files stay on your device and are processed in your browser.</small>
      </label>

      {files.length ? (
        <div className="selection">
          <div>
            <strong>
              {files.length === 1 ? files[0].name : `${files.length} files selected`}
            </strong>
            <small>{formatMegabytes(totalSize)}</small>
          </div>
          <button type="button" onClick={processFile}>{`Start ${tool.title}`}</button>
        </div>
      ) : null}

      {showPlaceholder ? <p className="error">{TOOL_STATUS_MESSAGES[tool.status]}</p> : null}
    </section>
  );
}

export function ToolWorkspace({ tool }: { tool: ToolDefinition }) {
  if (tool.route.slug === "merge-videos") {
    return <MergeVideosWorkspace tool={tool} />;
  }

  if (tool.route.slug === "trim-video") {
    return <TrimVideoWorkspace tool={tool} />;
  }

  if (tool.route.slug === "cinematic-transition") {
    return <CinematicTransitionWorkspace tool={tool} />;
  }

  return <ComingSoonWorkspace tool={tool} />;
}
