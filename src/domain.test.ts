import { describe, expect, it } from "vitest";
import { audioSegments, audioSourceAtTimeline, audioTrackLayout, buildLocalTimeline, cutSelectedTimelineClip, duplicateScene, formatTime, moveAudioTimelineClip, normalizeAudioTrim, normalizeCutPoints, normalizeImageCrop, normalizeProject, normalizeTimeRanges, patchScene, progressFraction, removeScene, removeTimelineRange, removeTimelineSelections, reorderScenes, sceneDuration, setSceneDuration, splitScene, timelineSelectionRange, totalDuration, updateAssignment } from "./domain";
import type { Project, Scene } from "./types";

const scene = (sceneId: string, durationSeconds: number): Scene => ({ sceneId, imagePath: `/${sceneId}.jpg`, durationSeconds, motion: "ZoomIn", motionIntensity: .25, startZoom: 1, endZoom: 1.15, transition: "fade", transitionDurationSeconds: .6, timingWeight: 1 });
const project = (): Project => ({ schemaVersion: 2, sessionId: "test", baseDir: "/tmp", imagesFolder: "/tmp", voiceFile: "", musicFile: "", outputFolder: "/tmp/out", outputName: "video.mp4", videoFormat: "landscape_16_9", resolution: "1920x1080", fps: 30, fillMode: "Fit with blurred background", minimumSceneDuration: 4, motionIntensity: "Low", musicVolume: .18, audioTiming: { mode: "manual", silenceThresholdDb: -35, minimumSilenceSeconds: .35, minimumSceneSeconds: 1, weights: null }, narrationMapping: { mismatchStrategy: "outro", defaultOutroSeconds: 4, extendLastWeights: [1, 1], assignments: [] }, scenes: [scene("a", 2), scene("b", 3), scene("c", 4)] });

describe("timeline domain", () => {
  it("formats editor timecodes", () => expect(formatTime(65.25)).toBe("01:05.3"));
  it("reorders scenes without mutation", () => { const original = project().scenes; const result = reorderScenes(original, "c", "a"); expect(result.map((x) => x.sceneId)).toEqual(["c", "a", "b"]); expect(original.map((x) => x.sceneId)).toEqual(["a", "b", "c"]); });
  it("removes a scene and its aligned timing and narration data without mutation", () => {
    const original = project();
    original.audioTiming.weights = [1, 2, 3];
    original.narrationMapping.assignments = [
      { sceneId: "a", audioPath: "/a.mp3", trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: true },
      { sceneId: "b", audioPath: "/b.mp3", trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: true },
    ];
    original.audioTimelineCuts = { voice: [1], music: [2], narration: { a: [.5], b: [1] } };
    const result = removeScene(original, "b");
    expect(result.scenes.map((item) => item.sceneId)).toEqual(["a", "c"]);
    expect(result.audioTiming.weights).toEqual([1, 3]);
    expect(result.narrationMapping.assignments.map((item) => item.sceneId)).toEqual(["a"]);
    expect(result.audioTimelineCuts).toEqual({ voice: [1], music: [2], narration: { a: [.5] } });
    expect(original.scenes.map((item) => item.sceneId)).toEqual(["a", "b", "c"]);
  });
  it("returns the same project when the requested scene no longer exists", () => { const original = project(); expect(removeScene(original, "missing")).toBe(original); });
  it("keeps voice and music splits when deleting a separately split image scene", () => {
    const original = project();
    original.voiceFile = "/voice.mp3";
    original.musicFile = "/music.mp3";
    original.audioTimelineCuts = { voice: [2, 4, 7], music: [2, 5, 8], narration: { b: [1] } };
    original.audioTimelineRemovedRanges = { voice: [{ startSeconds: 2, endSeconds: 3 }], music: [{ startSeconds: 4, endSeconds: 5 }], narration: { b: [{ startSeconds: .5, endSeconds: 1 }] } };
    const result = removeScene(original, "b");
    expect(result.audioTimelineCuts).toEqual({ voice: [2, 4, 7], music: [2, 5, 8], narration: {} });
    expect(result.audioTimelineRemovedRanges).toEqual({ voice: [{ startSeconds: 2, endSeconds: 3 }], music: [{ startSeconds: 4, endSeconds: 5 }], narration: {} });
  });
  it("clamps trimmed durations", () => expect(setSceneDuration(project().scenes, "a", -4)[0].durationSeconds).toBe(.25));
  it("keeps transitions shorter when a scene is trimmed", () => expect(setSceneDuration(project().scenes, "a", .5)[0]).toMatchObject({ durationSeconds: .5, transitionDurationSeconds: .25 }));
  it("clamps an invalid transition entered in the inspector", () => expect(patchScene(project().scenes, "a", { transitionDurationSeconds: 2 })[0].transitionDurationSeconds).toBe(1));
  it("duplicates the selected scene beside it", () => expect(duplicateScene(project().scenes, "b").map((x) => x.sceneId)).toEqual(["a", "b", "new-scene-id", "c"]));
  it("splits a scene at the playhead without changing total duration", () => { const scenes = splitScene(project().scenes, "b", 3); expect(scenes).toHaveLength(4); expect(scenes[1].durationSeconds).toBe(1); expect(scenes[2].durationSeconds).toBe(2); expect(scenes.reduce((sum, item) => sum + item.durationSeconds, 0)).toBe(9); });
  it("does not let a stale browser timeline override a manual scene edit", () => { const original = project(); const timeline = buildLocalTimeline(original); const edited = { ...original.scenes[0], durationSeconds: 9 }; expect(sceneDuration(edited, timeline)).toBe(9); expect(totalDuration({ ...original, scenes: [edited, ...original.scenes.slice(1)] }, timeline)).toBe(16); });
  it("normalizes both percentage and fractional job progress", () => { expect(progressFraction(42)).toBe(.42); expect(progressFraction(.42)).toBe(.42); expect(progressFraction(140)).toBe(1); expect(progressFraction(undefined)).toBe(0); });
  it("clamps image crop metadata to safe non-destructive limits", () => expect(normalizeImageCrop({ enabled: true, x: -20, y: 130, zoom: 99 })).toEqual({ enabled: true, x: 0, y: 100, zoom: 5 }));
  it("normalizes audio trims and preserves an open-ended selection", () => { expect(normalizeAudioTrim(-2, null, 10)).toEqual({ start: 0, end: null }); expect(normalizeAudioTrim(8, 4, 10)).toEqual({ start: 8, end: 8.05 }); expect(normalizeAudioTrim(30, null, 10).start).toBe(9.95); });
  it("normalizes, deduplicates, and bounds audio edit points", () => { expect(normalizeCutPoints([2, 1, 2.0001, -4, Number.NaN, 9.98], 10)).toEqual([1, 2]); expect(audioSegments(4, [1, 3])).toEqual([{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]); });
  it("normalizes and merges overlapping removed ranges", () => expect(normalizeTimeRanges([{ startSeconds: 2, endSeconds: 4 }, { startSeconds: 1, endSeconds: 2.5 }, { startSeconds: -2, endSeconds: 1 }, { startSeconds: 9.98, endSeconds: 12 }], 10)).toEqual([{ startSeconds: 0, endSeconds: 4 }]));
  it("ripple-closes deleted audio and maps preview time back to source time", () => {
    const layout = audioTrackLayout(4, [1, 2], [{ startSeconds: 1, endSeconds: 2 }], []);
    expect(layout).toEqual([
      { start: 0, end: 1, timelineStart: 0, timelineEnd: 1 },
      { start: 2, end: 4, timelineStart: 1, timelineEnd: 3 },
    ]);
    expect(audioSourceAtTimeline(4, [1, 2], [{ startSeconds: 1, endSeconds: 2 }], [], 1.5)).toBe(2.5);
  });
  it("turns deleted room into an intentional silent gap only when a clip is moved right", () => {
    const original = project(); original.voiceFile = "/voice.mp3";
    original.audioTimelineCuts = { voice: [1, 2], music: [], narration: {} };
    original.audioTimelineRemovedRanges = { voice: [{ startSeconds: 1, endSeconds: 2 }], music: [], narration: {} };
    const moved = moveAudioTimelineClip(original, { kind: "voice", startSeconds: 2 }, .75);
    expect(moved?.audioTimelineGaps?.voice).toEqual([{ atSeconds: 2, durationSeconds: .75 }]);
    expect(audioSourceAtTimeline(4, [1, 2], [{ startSeconds: 1, endSeconds: 2 }], moved?.audioTimelineGaps?.voice, 1.25)).toBeNull();
    expect(audioSourceAtTimeline(4, [1, 2], [{ startSeconds: 1, endSeconds: 2 }], moved?.audioTimelineGaps?.voice, 2)).toBe(2.25);
  });
  it("cuts the selected main voice segment and selects the new right side", () => {
    const original = project(); original.voiceFile = "/voice.mp3";
    const first = cutSelectedTimelineClip(original, { kind: "voice", startSeconds: 0 }, 2);
    expect(first?.project.audioTimelineCuts?.voice).toEqual([2]);
    expect(first?.selection).toEqual({ kind: "voice", startSeconds: 2 });
    const second = first && cutSelectedTimelineClip(first.project, first.selection, 3.5);
    expect(second?.project.audioTimelineCuts?.voice).toEqual([2, 3.5]);
  });
  it("cuts music and scene narration without changing media or scene duration", () => {
    const original = project(); original.musicFile = "/music.mp3";
    original.narrationMapping.assignments = [{ sceneId: "b", audioPath: "/b.mp3", trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: true }];
    const music = cutSelectedTimelineClip(original, { kind: "music", startSeconds: 0 }, 4);
    const narration = cutSelectedTimelineClip(music!.project, { kind: "narration", sceneId: "b", startSeconds: 0 }, 3.25);
    expect(narration?.project.audioTimelineCuts).toEqual({ voice: [], music: [4], narration: { b: [1.25] } });
    expect(narration?.project.scenes).toEqual(original.scenes);
    expect(narration?.project.musicFile).toBe("/music.mp3");
  });
  it("resolves the exact selected voice, music, narration, and scene clip ranges", () => {
    const original = project();
    original.audioTimelineCuts = { voice: [1, 4], music: [2, 5], narration: { b: [.5, 2] } };
    expect(timelineSelectionRange(original, { kind: "voice", startSeconds: 1 })).toEqual({ kind: "voice", startSeconds: 1, endSeconds: 4 });
    expect(timelineSelectionRange(original, { kind: "music", startSeconds: 2 })).toEqual({ kind: "music", startSeconds: 2, endSeconds: 5 });
    expect(timelineSelectionRange(original, { kind: "narration", sceneId: "b", startSeconds: .5 })).toEqual({ kind: "narration", sceneId: "b", startSeconds: 2.5, endSeconds: 4 });
    expect(timelineSelectionRange(original, { kind: "scene", sceneId: "b" })).toEqual({ kind: "scene", sceneId: "b", startSeconds: 2, endSeconds: 5 });
    expect(timelineSelectionRange(original, { kind: "voice", startSeconds: 8 })).toBeNull();
  });
  it("removes a deduplicated mixed-track clip selection in one project operation", () => {
    const original = project();
    original.voiceFile = "/voice.mp3"; original.musicFile = "/music.mp3";
    original.audioTimelineCuts = { voice: [1, 2, 4], music: [1, 3], narration: { b: [.5, 1.5] } };
    original.narrationMapping.assignments = [{ sceneId: "b", audioPath: "/b.mp3", trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: true }];
    const voice = { kind: "voice", startSeconds: 1 } as const;
    const result = removeTimelineSelections(original, [voice, voice, { kind: "music", startSeconds: 1 }, { kind: "narration", sceneId: "b", startSeconds: .5 }, { kind: "scene", sceneId: "c" }]);
    expect(result?.scenes.map((item) => item.sceneId)).toEqual(["a", "b"]);
    expect(result?.audioTimelineCuts).toEqual(original.audioTimelineCuts);
    expect(result?.audioTimelineRemovedRanges).toEqual({
      voice: [{ startSeconds: 1, endSeconds: 2 }],
      music: [{ startSeconds: 1, endSeconds: 3 }],
      narration: { b: [{ startSeconds: .5, endSeconds: 1.5 }] },
    });
    expect(original.audioTimelineRemovedRanges).toBeUndefined();
  });
  it("rejects cuts on empty tracks, clip edges, missing scenes, and outside the selected segment", () => {
    const original = project();
    expect(cutSelectedTimelineClip(original, { kind: "voice", startSeconds: 0 }, 1)).toBeNull();
    original.voiceFile = "/voice.mp3"; original.audioTimelineCuts = { voice: [2], music: [], narration: {} };
    expect(cutSelectedTimelineClip(original, { kind: "voice", startSeconds: 0 }, 0)).toBeNull();
    expect(cutSelectedTimelineClip(original, { kind: "voice", startSeconds: 0 }, 3)).toBeNull();
    expect(cutSelectedTimelineClip(original, { kind: "narration", sceneId: "missing", startSeconds: 0 }, 1)).toBeNull();
  });
  it("removes exact voice and music ranges as silent editable segments", () => {
    const original = project(); original.voiceFile = "/voice.mp3"; original.musicFile = "/music.mp3";
    const voice = removeTimelineRange(original, { kind: "voice", startSeconds: 1, endSeconds: 2.5 });
    const music = removeTimelineRange(voice!, { kind: "music", startSeconds: 3, endSeconds: 4 });
    expect(music?.audioTimelineCuts).toEqual({ voice: [1, 2.5], music: [3, 4], narration: {} });
    expect(music?.audioTimelineRemovedRanges).toEqual({ voice: [{ startSeconds: 1, endSeconds: 2.5 }], music: [{ startSeconds: 3, endSeconds: 4 }], narration: {} });
    expect(music?.scenes).toEqual(original.scenes);
  });
  it("stores narration removals relative to the owning scene", () => {
    const original = project(); original.narrationMapping.assignments = [{ sceneId: "b", audioPath: "/b.mp3", trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: true }];
    const result = removeTimelineRange(original, { kind: "narration", sceneId: "b", startSeconds: 2.5, endSeconds: 3.75 });
    expect(result?.audioTimelineCuts?.narration.b).toEqual([.5, 1.75]);
    expect(result?.audioTimelineRemovedRanges?.narration.b).toEqual([{ startSeconds: .5, endSeconds: 1.75 }]);
  });
  it("shortens a visual scene and shifts later global audio edits", () => {
    const original = project(); original.audioTimelineCuts = { voice: [1, 4, 7], music: [3, 8], narration: {} }; original.audioTimelineRemovedRanges = { voice: [{ startSeconds: 6, endSeconds: 8 }], music: [], narration: {} };
    const result = removeTimelineRange(original, { kind: "scene", sceneId: "b", startSeconds: 3, endSeconds: 4 });
    expect(result?.scenes[1].durationSeconds).toBe(2);
    expect(result?.audioTimelineCuts?.voice).toEqual([1, 3, 6]);
    expect(result?.audioTimelineCuts?.music).toEqual([3, 7]);
    expect(result?.audioTimelineRemovedRanges?.voice).toEqual([{ startSeconds: 5, endSeconds: 7 }]);
    expect(totalDuration(result!)).toBe(8);
  });
  it("rejects tiny or empty-media range removals", () => { const original = project(); expect(removeTimelineRange(original, { kind: "voice", startSeconds: 1, endSeconds: 2 })).toBeNull(); original.voiceFile = "/voice.mp3"; expect(removeTimelineRange(original, { kind: "voice", startSeconds: 1, endSeconds: 1.01 })).toBeNull(); });
  it("builds an immediate local timeline without the backend", () => { const timeline = buildLocalTimeline(project()); expect(timeline.timingMode).toBe("browser-local"); expect(timeline.scenes).toHaveLength(3); expect(timeline.durationSeconds).toBe(9); });
  it("uses resolved timeline durations", () => expect(totalDuration(project(), { timelineId: "x", fps: 30, totalFrames: 300, durationSeconds: 10, timingMode: "even", warnings: [], silenceBoundaries: [], narrationClips: [], scenes: [{ sceneId: "a", sourcePath: "/a", startFrame: 0, endFrame: 150, frameCount: 150, durationSeconds: 5, timingWeight: 1 }] })).toBe(12));
  it("creates and updates narration assignments", () => { const result = updateAssignment(project(), "b", { audioPath: "/b.wav", trimStartSeconds: 1 }); expect(result.narrationMapping.assignments[0]).toMatchObject({ sceneId: "b", audioPath: "/b.wav", trimStartSeconds: 1, enabled: true }); });
  it("merges nested defaults when opening older projects", () => { const defaults = project(); const result = normalizeProject({ outputName: "old.mp4", scenes: defaults.scenes, audioTiming: { ...defaults.audioTiming, mode: "even" } }, defaults); expect(result.outputName).toBe("old.mp4"); expect(result.narrationMapping.mismatchStrategy).toBe("outro"); expect(result.scenes[0].crop).toEqual({ enabled: false, x: 50, y: 50, zoom: 1 }); expect(result.voiceTrimStartSeconds).toBe(0); expect(result.audioTimelineCuts).toEqual({ voice: [], music: [], narration: {} }); expect(result.audioTimelineRemovedRanges).toEqual({ voice: [], music: [], narration: {} }); });
});
