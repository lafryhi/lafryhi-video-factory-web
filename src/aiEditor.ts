import { request } from "./api";
import type { Project, Scene } from "./types";

export type AIPreset = "silence" | "fillers" | "subtitles" | "reel" | "talking" | "bright" | "audio";
export type AIEditPlan = {
  version: 1; sourceDuration: number; targetDuration: number; aspectRatio: "9:16" | "16:9";
  instruction: string; language: "en" | "fr" | "ar"; planner: "conservative-rules-v1"; warnings: string[];
  operations: { sourceId: string; type: "cut" | "remove_filler" | "subtitle"; start: number; end: number; text: string; reason: string }[];
  audio: { crossfadeMs: number; normalize: boolean };
  video: { colorPreset: "original" | "bright" | "warm" | "cool" | "contrast" | "soft"; cropMode: "center" | "fit" };
  subtitleStyle: { fontSize: number; position: "bottom" | "center" | "top"; background: boolean; outline: number; maxCharsPerLine: number };
};
export type AISource = { id: string; name: string; duration: number; hasAudio: boolean; path: string };
export type AIJob = { id: string; status: "queued" | "running" | "complete" | "error"; stage: string; progress: number; warnings: string[]; error?: string; project?: Project; outputPath?: string; review?: { checks: Record<string, boolean> } };
const post = <T,>(path: string, body: unknown) => request<T>(`/ai-editor/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const aiEditorApi = {
  capabilities: () => request<{ transcription: boolean }>("/ai-editor/capabilities"),
  upload: (session: string, file: File) => {
    if (!/\.(mp4|mov|webm|mkv)$/i.test(file.name) || file.size <= 0 || file.size > 200 * 1024 * 1024) throw new Error("Choose a nonempty MP4, MOV, WebM or MKV under 200 MB.");
    const body = new FormData(); body.append("session_id", session); body.append("file", file);
    return request<AISource>("/ai-editor/uploads", { method: "POST", body });
  },
  analyze: (sessionId: string, sourceIds: string[], language: string) => post<{ jobId: string }>("analyze", { sessionId, sourceIds, language }),
  plan: (sessionId: string, analysisId: string, instruction: string, presets: AIPreset[]) => post<{ plan: AIEditPlan }>("plan", { sessionId, analysisId, instruction, presets }),
  render: (sessionId: string, analysisId: string, plan: AIEditPlan) => post<{ jobId: string }>("render", { sessionId, analysisId, plan }),
  job: (sessionId: string, jobId: string) => request<AIJob>(`/ai-editor/jobs/${encodeURIComponent(jobId)}?session_id=${encodeURIComponent(sessionId)}`),
};

export function appendAIEdit(current: Project, result: Project): Project {
  if (!result.scenes.length || result.scenes.some(s => s.mediaType !== "video")) throw new Error("The AI job did not return editable video scenes.");
  return { ...current, scenes: [...current.scenes, ...result.scenes], videoFormat: result.videoFormat, resolution: result.resolution,
    audioTiming: { ...current.audioTiming, mode: "manual" }, aiEdits: [...current.aiEdits || [], ...result.aiEdits || []] };
}

export function sliceVideoScene(scene: Scene, start: number, end: number, sceneId = scene.sceneId): Scene {
  return { ...scene, sceneId, sourceStartSeconds: (scene.sourceStartSeconds || 0) + start,
    sourceEndSeconds: (scene.sourceStartSeconds || 0) + end, durationSeconds: end - start,
    texts: (scene.texts || []).filter(t => t.startSeconds < end && (t.endSeconds ?? scene.durationSeconds) > start).map(t => ({ ...t, id: crypto.randomUUID(), startSeconds: Math.max(0, t.startSeconds - start), endSeconds: Math.min(end, t.endSeconds ?? scene.durationSeconds) - start })) };
}
