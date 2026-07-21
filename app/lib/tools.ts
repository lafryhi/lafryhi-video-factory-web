export type ToolDefinition = {
  slug: string;
  title: string;
  description: string;
  icon: string;
  accept: string;
  multiple?: boolean;
  status: "ready" | "coming";
};

export const tools: ToolDefinition[] = [
  { slug: "merge-videos", title: "Merge Videos", description: "Combine several video clips into one file.", icon: "⊕", accept: "video/*", multiple: true, status: "coming" },
  { slug: "trim-video", title: "Trim Video", description: "Cut the beginning or end of a video quickly.", icon: "✂", accept: "video/*", status: "coming" },
  { slug: "compress-video", title: "Compress Video", description: "Reduce video file size while preserving quality.", icon: "⇩", accept: "video/*", status: "coming" },
  { slug: "resize-video", title: "Resize for Social Media", description: "Resize videos for TikTok, Reels, Shorts and more.", icon: "↔", accept: "video/*", status: "coming" },
  { slug: "remove-audio", title: "Remove Audio", description: "Create a silent copy of your video.", icon: "⌁", accept: "video/*", status: "ready" },
  { slug: "convert-mp4", title: "Convert to MP4", description: "Convert common video formats to MP4.", icon: "MP4", accept: "video/*", status: "coming" },
  { slug: "extract-audio", title: "Extract Audio", description: "Save the audio track from a video.", icon: "♫", accept: "video/*", status: "ready" },
  { slug: "image-to-video", title: "Image to Video", description: "Turn one or more images into a video.", icon: "▣", accept: "image/*", multiple: true, status: "coming" },
  { slug: "video-speed", title: "Video Speed", description: "Speed up or slow down a video.", icon: "×2", accept: "video/*", status: "coming" },
  { slug: "reverse-video", title: "Reverse Video", description: "Play a video backwards and export it.", icon: "↶", accept: "video/*", status: "coming" }
];

export function getTool(slug: string) {
  return tools.find((tool) => tool.slug === slug);
}
