import type { Metadata } from "next";

export type ToolSlug =
  | "merge-videos"
  | "trim-video"
  | "compress-video"
  | "resize-video"
  | "remove-audio"
  | "convert-mp4"
  | "extract-audio"
  | "image-to-video"
  | "video-speed"
  | "reverse-video";

export type ToolStatus = "ready" | "coming-soon";

export type ToolInputKind = "video" | "image";
export type ToolOutputKind = "video" | "audio";

export type ToolCategory =
  | "combine"
  | "edit"
  | "optimize"
  | "format"
  | "audio"
  | "create";

export type ToolOptionSchema = Record<string, never>;

export type ToolRoute = {
  slug: ToolSlug;
  path: `/tools/${ToolSlug}`;
};

export type ToolInput = {
  kind: ToolInputKind;
  accept: string;
  multiple: boolean;
};

export type ToolOutput = {
  kind: ToolOutputKind;
  formatLabel: string;
};

export type ToolSeo = Pick<Metadata, "title" | "description">;

export type ToolDefinition = {
  route: ToolRoute;
  title: string;
  description: string;
  icon: string;
  status: ToolStatus;
  input: ToolInput;
  output: ToolOutput;
  analyticsCategory: ToolCategory;
  seo: ToolSeo;
  options: ToolOptionSchema;
};
