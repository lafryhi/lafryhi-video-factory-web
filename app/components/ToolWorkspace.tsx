"use client";

import { useEffect, useMemo, useState } from "react";
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

async function deleteFFmpegFiles(paths: string[]) {
  if (!ffmpeg) return;
  await Promise.allSettled(paths.map((path) => ffmpeg?.deleteFile(path)));
}

type SelectedVideo = {
  id: string;
  file: File;
};

type WorkspacePhase = "idle" | "loading" | "processing" | "complete" | "error";

const MIN_MERGE_FILES = 2;
const OUTPUT_FILE = "merged-output.mp4";

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
      const outputBuffer = new ArrayBuffer(output.byteLength);
      new Uint8Array(outputBuffer).set(output);
      const blob = new Blob([outputBuffer], { type: "video/mp4" });
      setDownloadUrl(URL.createObjectURL(blob));
      setProgress(1);
      setPhase("complete");
    } catch (mergeError) {
      setPhase("error");
      setError(getErrorMessage(mergeError));
    } finally {
      await deleteFFmpegFiles(tempFiles);
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

  return <ComingSoonWorkspace tool={tool} />;
}
