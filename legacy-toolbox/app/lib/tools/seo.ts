import type { ToolSeo, ToolSlug } from "./types";

export const TOOL_SEO = {
  "merge-videos": { title: "Merge Videos", description: "Combine several video clips into one file." },
  "trim-video": { title: "Trim Video", description: "Cut the beginning or end of a video quickly." },
  "cinematic-transition": {
    title: "Cinematic Transition",
    description: "Seamlessly connect images and videos with automatic cinematic motion.",
  },
  "compress-video": { title: "Compress Video", description: "Reduce video file size while preserving quality." },
  "resize-video": { title: "Resize for Social Media", description: "Resize videos for TikTok, Reels, Shorts and more." },
  "remove-audio": { title: "Remove Audio", description: "Create a silent copy of your video." },
  "convert-mp4": { title: "Convert to MP4", description: "Convert common video formats to MP4." },
  "extract-audio": { title: "Extract Audio", description: "Save the audio track from a video." },
  "image-to-video": { title: "Image to Video", description: "Turn one or more images into a video." },
  "video-speed": { title: "Video Speed", description: "Speed up or slow down a video." },
  "reverse-video": { title: "Reverse Video", description: "Play a video backwards and export it." },
} as const satisfies Record<ToolSlug, ToolSeo>;
