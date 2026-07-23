import type { ToolStatus } from "./types";

export const TOOL_STATUS_LABELS = {
  ready: "LIVE",
  "coming-soon": "Coming Soon",
} as const satisfies Record<ToolStatus, string>;

export const TOOL_STATUS_MESSAGES = {
  ready: "Ready to process in your browser.",
  "coming-soon": "Coming Soon. Video processing will be enabled in a future development phase.",
} as const satisfies Record<ToolStatus, string>;

export const TOOL_STATUS_BADGE_CLASSES = {
  ready: "badge ready",
  "coming-soon": "badge",
} as const satisfies Record<ToolStatus, string>;
