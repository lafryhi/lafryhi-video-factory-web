import type { ToolOptionSchema, ToolSlug } from "./types";

export const TOOL_OPTION_SCHEMAS = {
  "merge-videos": {},
  "trim-video": {
    startTime: { kind: "number", label: "Start time (seconds)", min: 0, step: 0.1 },
    endTime: { kind: "number", label: "End time (seconds)", min: 0, step: 0.1 },
  },
  "cinematic-transition": {},
  "compress-video": {},
  "resize-video": {},
  "remove-audio": {},
  "convert-mp4": {},
  "extract-audio": {},
  "image-to-video": {},
  "video-speed": {},
  "reverse-video": {},
} as const satisfies Record<ToolSlug, ToolOptionSchema>;
