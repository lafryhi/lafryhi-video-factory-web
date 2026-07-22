import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

type FFmpegProgress = {
  progress?: number;
  time?: number;
};

type FFmpegClientState = {
  isLoading: boolean;
  isLoaded: boolean;
  error: string | null;
};

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

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

export function getFFmpegClientState(): FFmpegClientState {
  return state;
}

export async function loadFFmpegClient(): Promise<FFmpeg> {
  ensureBrowser();

  if (ffmpeg && state.isLoaded) {
    return ffmpeg;
  }

  if (loadPromise) {
    return loadPromise;
  }

  state = {
    isLoading: true,
    isLoaded: false,
    error: null,
  };

  loadPromise = (async () => {
    try {
      const instance = new FFmpeg();

      const coreURL = new URL(
        "../../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js",
        import.meta.url,
      ).href;

      const wasmURL = new URL(
        "../../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm",
        import.meta.url,
      ).href;

      await instance.load({
        coreURL,
        wasmURL,
      });

      ffmpeg = instance;

      state = {
        isLoading: false,
        isLoaded: true,
        error: null,
      };

      return instance;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load FFmpeg.";

      ffmpeg = null;
      loadPromise = null;

      state = {
        isLoading: false,
        isLoaded: false,
        error: message,
      };

      throw new Error(message);
    }
  })();

  return loadPromise;
}

export async function writeFFmpegInputFile(path: string, file: File) {
  const instance = await loadFFmpegClient();
  const data = await fetchFile(file);

  await instance.writeFile(path, data);
}

export async function execFFmpeg(
  args: string[],
  onProgress?: (progress: number) => void,
) {
  const instance = await loadFFmpegClient();

  const progressCallback = onProgress
    ? ({ progress }: FFmpegProgress) => {
        if (typeof progress === "number" && Number.isFinite(progress)) {
          onProgress(Math.max(0, Math.min(1, progress)));
        }
      }
    : null;

  if (progressCallback) {
    instance.on("progress", progressCallback);
  }

  try {
    const exitCode = await instance.exec(args);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode}.`);
    }
  } finally {
    if (progressCallback) {
      instance.off("progress", progressCallback);
    }
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
  if (!ffmpeg || !state.isLoaded) {
    return;
  }

  await Promise.allSettled(
    paths.map(async (path) => {
      if (ffmpeg) {
        await ffmpeg.deleteFile(path);
      }
    }),
  );
}
