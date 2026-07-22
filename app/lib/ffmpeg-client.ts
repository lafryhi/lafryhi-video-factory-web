const FFMPEG_VERSION = "0.12.15";
const FFMPEG_UTIL_VERSION = "0.12.2";
const FFMPEG_CORE_VERSION = "0.12.10";

const FFMPEG_SCRIPT_URL = `https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/ffmpeg.js`;
const FFMPEG_UTIL_SCRIPT_URL = `https://unpkg.com/@ffmpeg/util@${FFMPEG_UTIL_VERSION}/dist/umd/index.js`;
const FFMPEG_CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;

type FFmpegProgress = {
  progress?: number;
  time?: number;
};

type FFmpegFileData = Uint8Array | string;

type FFmpegInstance = {
  loaded?: boolean;
  load: (config?: { coreURL?: string; wasmURL?: string }) => Promise<void>;
  writeFile: (path: string, data: FFmpegFileData) => Promise<void>;
  exec: (args: string[]) => Promise<number>;
  readFile: (path: string) => Promise<Uint8Array | string>;
  deleteFile: (path: string) => Promise<void>;
  on: (event: "progress", callback: (progress: FFmpegProgress) => void) => void;
  off: (event: "progress", callback: (progress: FFmpegProgress) => void) => void;
};

type FFmpegConstructor = new () => FFmpegInstance;

type FFmpegWasmGlobal = {
  FFmpeg: FFmpegConstructor;
};

type FFmpegUtilGlobal = {
  fetchFile: (file: File) => Promise<Uint8Array>;
  toBlobURL: (url: string, mimeType: string) => Promise<string>;
};

declare global {
  interface Window {
    FFmpegWASM?: FFmpegWasmGlobal;
    FFmpegUtil?: FFmpegUtilGlobal;
  }
}

type FFmpegClientState = {
  isLoading: boolean;
  isLoaded: boolean;
  error: string | null;
};

let ffmpeg: FFmpegInstance | null = null;
let loadPromise: Promise<FFmpegInstance> | null = null;
let state: FFmpegClientState = {
  isLoading: false,
  isLoaded: false,
  error: null,
};

function ensureBrowser() {
  if (typeof window === "undefined") {
    throw new Error("FFmpeg can only be loaded in the browser.");
  }
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

    if (!existing) {
      document.head.appendChild(script);
    }
  });
}

export function getFFmpegClientState(): FFmpegClientState {
  return state;
}

export async function loadFFmpegClient(): Promise<FFmpegInstance> {
  ensureBrowser();

  if (ffmpeg && state.isLoaded) return ffmpeg;
  if (loadPromise) return loadPromise;

  state = { isLoading: true, isLoaded: false, error: null };
  loadPromise = (async () => {
    try {
      await Promise.all([
        loadScript(FFMPEG_SCRIPT_URL),
        loadScript(FFMPEG_UTIL_SCRIPT_URL),
      ]);

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
      state = { isLoading: false, isLoaded: true, error: null };
      return instance;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load FFmpeg.";
      state = { isLoading: false, isLoaded: false, error: message };
      loadPromise = null;
      throw new Error(message);
    }
  })();

  return loadPromise;
}

export async function writeFFmpegInputFile(path: string, file: File) {
  ensureBrowser();
  if (!window.FFmpegUtil) throw new Error("FFmpeg utilities are not loaded.");
  const instance = await loadFFmpegClient();
  await instance.writeFile(path, await window.FFmpegUtil.fetchFile(file));
}

export async function execFFmpeg(args: string[], onProgress?: (progress: number) => void) {
  const instance = await loadFFmpegClient();
  const progressCallback = onProgress
    ? ({ progress }: FFmpegProgress) => {
        if (typeof progress === "number" && Number.isFinite(progress)) {
          onProgress(Math.max(0, Math.min(1, progress)));
        }
      }
    : null;

  if (progressCallback) instance.on("progress", progressCallback);

  try {
    const exitCode = await instance.exec(args);
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}.`);
    }
  } finally {
    if (progressCallback) instance.off("progress", progressCallback);
  }
}

export async function readFFmpegOutputFile(path: string) {
  const instance = await loadFFmpegClient();
  const data = await instance.readFile(path);
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return data;
}

export async function deleteFFmpegFiles(paths: string[]) {
  if (!ffmpeg || !state.isLoaded) return;
  await Promise.allSettled(paths.map((path) => ffmpeg?.deleteFile(path)));
}
