import type { Capabilities, Project, PythonResult, RenderJob } from "./types";

const configuredApiBase = String(import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
const apiBase = configuredApiBase
  ? `${configuredApiBase}${configuredApiBase.endsWith("/api") ? "" : "/api"}`
  : "/api";

export function apiUrl(path: string): string {
  return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), init);
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = typeof body === "object" && body ? body.detail : body;
      const requestId = response.headers.get("x-request-id");
      throw new Error(`${String(detail || `Request failed with ${response.status}.`)}${requestId ? ` (request ${requestId})` : ""}`);
    }
    return body as T;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) console.error(`[LAFRYHI API] ${path}`, error);
    throw error;
  }
}

export const api = {
  capabilities: () => request<Capabilities>("/capabilities"),
  uploadImages: (sessionId: string, files: File[], signal?: AbortSignal) => upload<{ folder: string; count: number; scenes: Project["scenes"] }>("/uploads/images", sessionId, files, signal),
  uploadAudio: (sessionId: string, kind: "voice" | "music" | "narration", file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append("session_id", sessionId);
    form.append("kind", kind);
    form.append("file", file);
    return request<{ path: string; name: string }>("/uploads/audio", { method: "POST", body: form, signal });
  },
  uploadNarration: (sessionId: string, files: File[]) => upload<{ folder: string; count: number }>("/uploads/narration", sessionId, files),
  demo: (sessionId: string, orientation: "landscape" | "portrait" = "landscape") => request<PythonResult & { scenes?: Project["scenes"]; defaultNarration?: string; defaultMusic?: string; outputName?: string; imagesFolder?: string; warnings?: string[]; orientation?: string; videoFormat?: string; resolution?: string }>("/demo", json({ sessionId, orientation })),
  analyze: (project: Project) => request<PythonResult>("/analyze", json({ project })),
  preview: (project: Project, sceneId: string) => request<PythonResult>("/preview", json({ project, sceneId })),
  mapNarration: (project: Project) => request<PythonResult & { narrationMapping?: Project["narrationMapping"] }>("/map-narration", json({ project })),
  render: (project: Project, signal?: AbortSignal) => request<{ jobId: string }>("/render", { ...json({ project }), signal }),
  job: (jobId: string, signal?: AbortSignal) => request<RenderJob>(`/jobs/${jobId}`, { signal }),
  cancel: (jobId: string) => request<{ cancelled: boolean }>(`/jobs/${jobId}`, { method: "DELETE" }),
};

function json(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

function upload<T>(path: string, sessionId: string, files: File[], signal?: AbortSignal): Promise<T> {
  const form = new FormData();
  form.append("session_id", sessionId);
  files.forEach((file) => form.append("files", file));
  return request<T>(path, { method: "POST", body: form, signal });
}

export function mediaUrl(filePath?: string | null, download = false): string {
  if (!filePath) return "";
  return apiUrl(`/media?path=${encodeURIComponent(filePath)}${download ? "&download=true" : ""}`);
}
