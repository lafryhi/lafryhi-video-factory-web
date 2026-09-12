import { describe, expect, it } from "vitest";
import { appendAIEdit, sliceVideoScene } from "./aiEditor";
import { removeTimelineRange, splitScene } from "./domain";
import type { Project, Scene } from "./types";

const scene: Scene = { sceneId: "v1", imagePath: "clip.mp4", durationSeconds: 8, motion: "Static", motionIntensity: 0, startZoom: 1, endZoom: 1, transition: "none", transitionDurationSeconds: 0, timingWeight: 1, mediaType: "video", sourceStartSeconds: 2, sourceEndSeconds: 10, sourceDurationSeconds: 12, texts: [{ id: "t", text: "Hello", fontFamily: "Rubik", fontSize: 48, color: "#ffffff", x: 50, y: 85, startSeconds: 2, endSeconds: 5 }] };

describe("editable AI scenes", () => {
  it("splits source trims and retimes captions", () => {
    const [a, b] = splitScene([scene], "v1", 3);
    expect([a.sourceStartSeconds, a.sourceEndSeconds, b.sourceStartSeconds, b.sourceEndSeconds]).toEqual([2, 5, 5, 10]);
    expect(b.texts?.[0].startSeconds).toBe(0);
    expect(b.texts?.[0].endSeconds).toBe(2);
    expect(scene.durationSeconds).toBe(8);
  });
  it("removes the selected video range rather than shortening its tail", () => {
    const project = { scenes: [scene], audioTiming: { mode: "manual" } } as Project;
    const next = removeTimelineRange(project, { kind: "scene", sceneId: "v1", startSeconds: 2, endSeconds: 4 });
    expect(next?.scenes.map(s => [s.sourceStartSeconds, s.sourceEndSeconds])).toEqual([[2, 4], [6, 10]]);
  });
  it("appends AI results and preserves original tracks and metadata", () => {
    const current = { scenes: [], musicFile: "music.wav", audioTiming: {}, aiEdits: [] } as unknown as Project;
    const result = { scenes: [scene], resolution: "1080x1920", videoFormat: "vertical_9_16", aiEdits: [] } as unknown as Project;
    const next = appendAIEdit(current, result);
    expect(next.musicFile).toBe("music.wav");
    expect(next.scenes[0].mediaType).toBe("video");
    expect(current.scenes).toHaveLength(0);
    expect(sliceVideoScene(scene, 1, 2).sourceStartSeconds).toBe(3);
  });
});
