import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Scene, TimelineSelection } from "../types";
import { TimelineEditor } from "./TimelineEditor";

afterEach(() => cleanup());

const scene = (sceneId: string): Scene => ({ sceneId, imagePath: `/${sceneId}.jpg`, durationSeconds: 2, motion: "Static", motionIntensity: .25, startZoom: 1, endZoom: 1, transition: "none", transitionDurationSeconds: 0, timingWeight: 1 });
const project: Project = {
  schemaVersion: 2, sessionId: "test", baseDir: "/tmp", imagesFolder: "/tmp", voiceFile: "/voice.mp3", musicFile: "/music.mp3", outputFolder: "/tmp/out", outputName: "video.mp4", videoFormat: "landscape_16_9", resolution: "1920x1080", fps: 30, fillMode: "Fit with blurred background", minimumSceneDuration: 1, motionIntensity: "Low", musicVolume: .18,
  audioTiming: { mode: "manual", silenceThresholdDb: -35, minimumSilenceSeconds: .35, minimumSceneSeconds: 1, weights: null },
  narrationMapping: { mismatchStrategy: "outro", defaultOutroSeconds: 4, extendLastWeights: [1, 1], assignments: [{ sceneId: "a", audioPath: "/a.mp3", trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: true }] },
  scenes: [scene("a"), scene("b")],
};

function renderTimeline(selectedId: string | null, onRemove = vi.fn(), onSelect = vi.fn()) {
  render(<TimelineEditor project={project} timeline={null} selectedId={selectedId} playhead={0} onSelect={onSelect} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onRemove={onRemove}/>);
  return { onRemove, onSelect };
}

describe("TimelineEditor scene deletion", () => {
  it("deletes the selected clip from the timeline toolbar", async () => {
    const { onRemove } = renderTimeline("b");
    await userEvent.click(screen.getByTestId("delete-selected-scene"));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("targets the exact clip from its inline delete button", async () => {
    const { onRemove, onSelect } = renderTimeline("a");
    await userEvent.click(screen.getByRole("button", { name: "Delete scene 2" }));
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("disables toolbar deletion when no scene is selected", () => {
    renderTimeline(null);
    expect(screen.getByTestId("delete-selected-scene")).toBeDisabled();
  });
});

describe("TimelineEditor audio cutting", () => {
  it("moves an audio clip horizontally to create an intentional gap", () => {
    const onMoveAudio = vi.fn();
    const edited = { ...project, audioTimelineCuts: { voice: [1, 2], music: [], narration: {} }, audioTimelineRemovedRanges: { voice: [{ startSeconds: 1, endSeconds: 2 }], music: [], narration: {} } };
    render(<TimelineEditor project={edited} timeline={null} selectedId="a" selectedClip={{ kind: "voice", startSeconds: 2 }} playhead={1} onSelect={() => {}} onSelectClip={() => {}} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onMoveAudio={onMoveAudio} onRemove={() => {}}/>);
    const clip = screen.getByTestId("timeline-voice-1");
    const panel = screen.getByRole("region", { name: "Video timeline" });
    fireEvent.pointerDown(clip, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 162 });
    fireEvent.pointerUp(panel, { pointerId: 1, clientX: 162 });
    expect(onMoveAudio).toHaveBeenCalledWith({ kind: "voice", startSeconds: 2 }, 1);
  });

  it.each([
    ["voice", { kind: "voice", startSeconds: 0 }],
    ["music", { kind: "music", startSeconds: 0 }],
  ] as const)("cuts the selected %s clip at the playhead", async (_label, selection) => {
    const onCut = vi.fn();
    render(<TimelineEditor project={project} timeline={null} selectedId="a" selectedClip={selection} playhead={1} onSelect={() => {}} onSelectClip={() => {}} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={onCut} onRemove={() => {}}/>);
    await userEvent.click(screen.getByTestId("split-scene"));
    expect(onCut).toHaveBeenCalledWith(selection, 1);
  });

  it("selects and cuts a per-scene narration clip", async () => {
    const onSelectClip = vi.fn(); const onCut = vi.fn();
    const selection: TimelineSelection = { kind: "narration", sceneId: "a", startSeconds: 0 };
    const { rerender } = render(<TimelineEditor project={project} timeline={null} selectedId="a" selectedClip={null} playhead={1} onSelect={() => {}} onSelectClip={onSelectClip} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={onCut} onRemove={() => {}}/>);
    await userEvent.click(screen.getByTestId("timeline-narration-0-0"));
    expect(onSelectClip).toHaveBeenCalledWith(selection, false);
    rerender(<TimelineEditor project={project} timeline={null} selectedId="a" selectedClip={selection} playhead={1} onSelect={() => {}} onSelectClip={onSelectClip} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={onCut} onRemove={() => {}}/>);
    await userEvent.click(screen.getByTestId("split-scene"));
    expect(onCut).toHaveBeenCalledWith(selection, 1);
  });

  it("renders independently selectable segments and protects clip edges", () => {
    const cutProject = { ...project, audioTimelineCuts: { voice: [1], music: [2], narration: { a: [.75] } } };
    render(<TimelineEditor project={cutProject} timeline={null} selectedId="a" selectedClip={{ kind: "voice", startSeconds: 0 }} playhead={0} onSelect={() => {}} onSelectClip={() => {}} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={() => {}} onRemoveRange={() => {}} onRemove={() => {}}/>);
    expect(screen.getAllByTestId(/^timeline-voice-/)).toHaveLength(2);
    expect(screen.getAllByTestId(/^timeline-music-/)).toHaveLength(2);
    expect(screen.getAllByTestId(/^timeline-narration-0-/)).toHaveLength(2);
    expect(screen.getByTestId("split-scene")).toBeDisabled();
    expect(screen.getByTestId("delete-selected-scene")).toBeEnabled();
  });

  it.each([
    ["voice", { kind: "voice", startSeconds: 1 }, { kind: "voice", startSeconds: 1, endSeconds: 4 }],
    ["music", { kind: "music", startSeconds: 2 }, { kind: "music", startSeconds: 2, endSeconds: 4 }],
    ["narration", { kind: "narration", sceneId: "a", startSeconds: .75 }, { kind: "narration", sceneId: "a", startSeconds: .75, endSeconds: 2 }],
  ] as const)("removes the exact selected %s segment with the toolbar trash button", async (_label, selection, range) => {
    const cutProject = { ...project, audioTimelineCuts: { voice: [1], music: [2], narration: { a: [.75] } } };
    const onRemoveRange = vi.fn();
    render(<TimelineEditor project={cutProject} timeline={null} selectedId="a" selectedClip={selection} playhead={1} onSelect={() => {}} onSelectClip={() => {}} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={() => {}} onRemoveRange={onRemoveRange} onRemove={() => {}}/>);
    await userEvent.click(screen.getByTestId("delete-selected-scene"));
    expect(onRemoveRange).toHaveBeenCalledWith(range);
  });
});

describe("TimelineEditor multi-selection", () => {
  it("reports Cmd/Ctrl-click as additive selection", () => {
    const onSelectClip = vi.fn();
    const cutProject = { ...project, audioTimelineCuts: { voice: [1], music: [2], narration: { a: [.75] } } };
    render(<TimelineEditor project={cutProject} timeline={null} selectedId="a" selectedClips={[{ kind: "voice", startSeconds: 0 }]} playhead={1} onSelect={() => {}} onSelectClip={onSelectClip} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={() => {}} onRemove={() => {}}/>);
    fireEvent.click(screen.getByTestId("timeline-voice-1"), { metaKey: true });
    expect(onSelectClip).toHaveBeenLastCalledWith({ kind: "voice", startSeconds: 1 }, true);
    fireEvent.click(screen.getByTestId("timeline-music-1"), { ctrlKey: true });
    expect(onSelectClip).toHaveBeenLastCalledWith({ kind: "music", startSeconds: 2 }, true);
  });

  it("highlights mixed-track selections and removes the whole batch once", async () => {
    const onRemoveSelected = vi.fn();
    const selectedClips: TimelineSelection[] = [{ kind: "scene", sceneId: "b" }, { kind: "voice", startSeconds: 0 }, { kind: "music", startSeconds: 0 }];
    render(<TimelineEditor project={project} timeline={null} selectedId="b" selectedClips={selectedClips} playhead={1} onSelect={() => {}} onSelectClip={() => {}} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={() => {}} onRemoveSelected={onRemoveSelected} onRemove={() => {}}/>);
    expect(screen.getByText("3 clips selected")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-scene-1")).toHaveClass("selected");
    expect(screen.getByTestId("timeline-voice-0")).toHaveClass("selected");
    expect(screen.getByTestId("timeline-music-0")).toHaveClass("selected");
    expect(screen.getByTestId("split-scene")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove 3 selected clips" }));
    expect(onRemoveSelected).toHaveBeenCalledOnce();
  });
});

describe("TimelineEditor range removal", () => {
  it("commits a fast pointer drag even before React rerenders the draft", async () => {
    const onSelectRange = vi.fn();
    render(<TimelineEditor project={project} timeline={null} selectedId="a" selectedClip={{ kind: "voice", startSeconds: 0 }} playhead={0} onSelect={() => {}} onSelectClip={() => {}} onSelectRange={onSelectRange} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={() => {}} onRemoveRange={() => {}} onRemove={() => {}}/>);
    await userEvent.click(screen.getByTestId("timeline-range-tool"));
    const canvas = document.querySelector<HTMLElement>(".timeline-canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 272, width: 800, height: 272, toJSON: () => ({}) });
    const voice = screen.getByTestId("timeline-voice-0");
    const panel = screen.getByRole("region", { name: "Video timeline" });
    fireEvent.pointerDown(voice, { pointerId: 1, clientX: 62 });
    fireEvent.pointerMove(panel, { pointerId: 1, clientX: 124 });
    fireEvent.pointerUp(panel, { pointerId: 1, clientX: 124 });
    expect(onSelectRange).toHaveBeenLastCalledWith({ kind: "voice", startSeconds: 1, endSeconds: 2 });
  });

  it("enables range mode and removes the selected range from the toolbar", async () => {
    const onSelectRange = vi.fn(); const onRemoveRange = vi.fn();
    const selectedRange = { kind: "voice", startSeconds: 1, endSeconds: 2 } as const;
    render(<TimelineEditor project={project} timeline={null} selectedId="a" selectedClip={{ kind: "voice", startSeconds: 0 }} selectedRange={selectedRange} playhead={1} onSelect={() => {}} onSelectClip={() => {}} onSelectRange={onSelectRange} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onCut={() => {}} onRemoveRange={onRemoveRange} onRemove={() => {}}/>);
    expect(screen.getByText("1.00s selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove selected timeline range" }));
    expect(onRemoveRange).toHaveBeenCalledWith(selectedRange);
    await userEvent.click(screen.getByTestId("timeline-range-tool"));
    expect(onSelectRange).toHaveBeenCalledWith(null);
  });

  it("removes audio portions and ripple-closes the visual gap", () => {
    const edited = { ...project, audioTimelineCuts: { voice: [1, 2], music: [], narration: {} }, audioTimelineRemovedRanges: { voice: [{ startSeconds: 1, endSeconds: 2 }], music: [], narration: {} } };
    render(<TimelineEditor project={edited} timeline={null} selectedId="a" selectedClip={{ kind: "voice", startSeconds: 1 }} playhead={1.5} onSelect={() => {}} onPlayhead={() => {}} onReorder={() => {}} onResize={() => {}} onSplit={() => {}} onRemove={() => {}}/>);
    expect(screen.queryByText("Removed · silence")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^timeline-voice-/)).toHaveLength(2);
    expect(screen.getByTestId("timeline-voice-1")).toHaveAttribute("data-source-start", "2");
    expect(screen.getByTestId("timeline-voice-1")).toHaveAttribute("data-timeline-start", "1");
  });
});
