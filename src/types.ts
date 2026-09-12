export type Scene = {
  mediaType?: "image" | "video";
  sourceStartSeconds?: number;
  sourceEndSeconds?: number;
  sourceDurationSeconds?: number;
  sourceAudio?: boolean;
  aiVideo?: import("./aiEditor").AIEditPlan["video"];
  aiAudio?: import("./aiEditor").AIEditPlan["audio"];
  subtitleStyle?: import("./aiEditor").AIEditPlan["subtitleStyle"];
  sceneId: string;
  imagePath: string;
  durationSeconds: number;
  motion: string;
  motionIntensity: number;
  startZoom: number;
  endZoom: number;
  transition: string;
  transitionDurationSeconds: number;
  timingWeight: number;
  crop?: ImageCrop;
  texts?: TextOverlay[];
};

export type ImageCrop = {
  enabled: boolean;
  x: number;
  y: number;
  zoom: number;
};

export type TextOverlay = {
  id: string;
  text: string;
  fontFamily: "Outfit" | "Rubik";
  fontSize: number;
  color: string;
  x: number;
  y: number;
  startSeconds: number;
  endSeconds: number | null;
};

export type NarrationAssignment = {
  sceneId: string;
  audioPath: string | null;
  trimStartSeconds: number;
  trimEndSeconds: number | null;
  leadingPaddingSeconds: number;
  trailingPaddingSeconds: number;
  enabled: boolean;
};

export type AudioTimelineCuts = {
  voice: number[];
  music: number[];
  narration: Record<string, number[]>;
};

export type TimelineTimeRange = { startSeconds: number; endSeconds: number };

export type AudioTimelineRemovedRanges = {
  voice: TimelineTimeRange[];
  music: TimelineTimeRange[];
  narration: Record<string, TimelineTimeRange[]>;
};

export type AudioTimelineGap = { atSeconds: number; durationSeconds: number };

export type AudioTimelineGaps = {
  voice: AudioTimelineGap[];
  music: AudioTimelineGap[];
  narration: Record<string, AudioTimelineGap[]>;
};

export type TimelineSelection =
  | { kind: "scene"; sceneId: string }
  | { kind: "voice" | "music"; startSeconds: number }
  | { kind: "narration"; sceneId: string; startSeconds: number };

export type TimelineRangeSelection =
  | { kind: "scene" | "narration"; sceneId: string; startSeconds: number; endSeconds: number }
  | { kind: "voice" | "music"; startSeconds: number; endSeconds: number };

export type Project = {
  aiEdits?: { analysisId: string; plan: import("./aiEditor").AIEditPlan }[];
  schemaVersion: number;
  sessionId: string;
  baseDir: string;
  imagesFolder: string;
  voiceFile: string;
  musicFile: string;
  voiceTrimStartSeconds?: number;
  voiceTrimEndSeconds?: number | null;
  musicTrimStartSeconds?: number;
  musicTrimEndSeconds?: number | null;
  outputFolder: string;
  outputName: string;
  videoFormat: string;
  resolution: string;
  fps: number;
  fillMode: string;
  minimumSceneDuration: number;
  motionIntensity: string;
  musicVolume: number;
  audioTiming: {
    mode: string;
    silenceThresholdDb: number;
    minimumSilenceSeconds: number;
    minimumSceneSeconds: number;
    weights: number[] | null;
  };
  narrationMapping: {
    mismatchStrategy: string;
    defaultOutroSeconds: number;
    extendLastWeights: number[];
    assignments: NarrationAssignment[];
  };
  audioTimelineCuts?: AudioTimelineCuts;
  audioTimelineRemovedRanges?: AudioTimelineRemovedRanges;
  audioTimelineGaps?: AudioTimelineGaps;
  scenes: Scene[];
};

export type Capability = { value?: string; key?: string; name: string; width?: number; height?: number };
export type Capabilities = {
  schemaVersion: number;
  formats: Capability[];
  motions: Capability[];
  timingModes: Capability[];
  mismatchStrategies: Capability[];
  defaults: Project;
};

export type ResolvedScene = Scene & { startFrame: number; endFrame: number; frameCount: number; sourcePath: string };
export type Timeline = {
  timelineId: string;
  fps: number;
  totalFrames: number;
  durationSeconds: number;
  timingMode: string;
  warnings: string[];
  silenceBoundaries: number[];
  scenes: Array<{ sceneId: string; sourcePath: string; startFrame: number; endFrame: number; frameCount: number; durationSeconds: number; timingWeight: number }>;
  narrationClips: Array<{ scene_id: string; audio_path: string | null; duration_seconds: number; warning?: string | null }>;
};

export type BridgeEvent = { type: string; message?: string; value?: number; stage?: string; outputPath?: string; [key: string]: unknown };
export type PythonResult = BridgeEvent & { timeline?: Timeline; previewPath?: string; scenes?: Scene[]; folder?: string; project?: Project };
export type FileFilter = { name: string; extensions: string[] };
export type RenderJob = { id: string; status: "queued" | "running" | "cancelling" | "cancelled" | "complete" | "error"; progress: number; stage: string; events: BridgeEvent[]; error: string | null; outputPath: string | null };
