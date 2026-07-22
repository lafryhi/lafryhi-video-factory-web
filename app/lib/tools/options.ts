import type { ToolOptionSchema, ToolSlug } from "./types";

export const TOOL_OPTION_SCHEMAS = {
  "merge-videos": {},
  "trim-video": {},
  "compress-video": {},
  "resize-video": {},
  "remove-audio": {},
  "convert-mp4": {},
  "extract-audio": {},
  "image-to-video": {},
  "video-speed": {},
  "reverse-video": {},
} as const satisfies Record<ToolSlug, ToolOptionSchema>;
