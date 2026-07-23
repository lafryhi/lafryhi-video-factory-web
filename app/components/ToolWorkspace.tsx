"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TOOL_STATUS_MESSAGES } from "../lib/tools";
import type { ToolDefinition } from "../lib/tools";

const FFMPEG_VERSION = "0.12.15";
const FFMPEG_UTIL_VERSION = "0.12.2";
const FFMPEG_CORE_VERSION = "0.12.10";

const FFMPEG_SCRIPT_URL = `https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/ffmpeg.js`;
const FFMPEG_UTIL_SCRIPT_URL = `https://unpkg.com/@ffmpeg/util@${FFMPEG_UTIL_VERSION}/dist/umd/index.js`;
const FFMPEG_CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;

type FFmpegProgress = {
  progress?: number;
};

type FFmpegInstance = {
  load: (config?: { coreURL?: string; wasmURL?: string }) => Promise<void>;
  writeFile: (path: string, data: Uint8Array | string) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<void>;
  on: (event: "progress", callback: (progress: FFmpegProgress) => void) => void;
  off: (event: "progress", callback: (progress: FFmpegProgress) => void) => void;
};

declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegInstance };
    FFmpegUtil?: {
      fetchFile: (file: File) => Promise<Uint8Array>;
      toBlobURL: (url: string, mimeType: string) => Promise<string>;
    };
  }
}

let ffmpeg: FFmpegInstance | null = null;
let ffmpegLoadPromise: Promise<FFmpegInstance> | null = null;
let ffmpegOperationLocked = false;

function tryAcquireFFmpegOperation() {
  if (ffmpegOperationLocked) return false;
  ffmpegOperationLocked = true;
  return true;
}

function releaseFFmpegOperation() {
  ffmpegOperationLocked = false;
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-ffmpeg-src="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing ?? document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.ffmpegSrc = src;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load FFmpeg asset: ${src}`)), { once: true });

    if (!existing) document.head.appendChild(script);
  });
}

async function loadFFmpegClient(): Promise<FFmpegInstance> {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    try {
      await Promise.all([loadScript(FFMPEG_SCRIPT_URL), loadScript(FFMPEG_UTIL_SCRIPT_URL)]);

      if (!window.FFmpegWASM || !window.FFmpegUtil) {
        throw new Error("FFmpeg browser runtime did not initialize correctly.");
      }

      const instance = new window.FFmpegWASM.FFmpeg();
      const { toBlobURL } = window.FFmpegUtil;
      await instance.load({
        coreURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpeg = instance;
      return instance;
    } catch (error) {
      ffmpegLoadPromise = null;
      throw error;
    }
  })();

  return ffmpegLoadPromise;
}

async function writeFFmpegInputFile(path: string, file: File) {
  const instance = await loadFFmpegClient();
  if (!window.FFmpegUtil) throw new Error("FFmpeg utilities are not loaded.");
  await instance.writeFile(path, await window.FFmpegUtil.fetchFile(file));
}

async function execFFmpeg(args: string[], onProgress: (progress: number) => void) {
  const instance = await loadFFmpegClient();
  const progressCallback = ({ progress }: FFmpegProgress) => {
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

  return <ComingSoonWorkspace tool={tool} />;
}
