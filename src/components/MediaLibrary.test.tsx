import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types";
import { MediaLibrary } from "./MediaLibrary";

afterEach(() => cleanup());

const project: Project = {
  schemaVersion: 2,
  sessionId: "demo-test",
  baseDir: "/tmp",
  imagesFolder: "",
  voiceFile: "",
  musicFile: "",
  outputFolder: "/tmp/out",
  outputName: "video.mp4",
  videoFormat: "landscape_16_9",
  resolution: "1920x1080",
  fps: 30,
  fillMode: "Fit with blurred background",
  minimumSceneDuration: 4,
  motionIntensity: "Low",
  musicVolume: .18,
  audioTiming: { mode: "manual", silenceThresholdDb: -35, minimumSilenceSeconds: .35, minimumSceneSeconds: 1, weights: null },
  narrationMapping: { mismatchStrategy: "outro", defaultOutroSeconds: 4, extendLastWeights: [1, 1], assignments: [] },
  scenes: [],
};

describe("MediaLibrary demo variants", () => {
  it("exposes separate landscape and portrait demo actions", async () => {
    const onDemo = vi.fn();
    render(<MediaLibrary project={project} selectedId={null} onSelect={() => {}} onImportImages={() => {}} onVoice={() => {}} onMusic={() => {}} onNarrationFolder={() => {}} onDemo={onDemo} onReorder={() => {}} onDropImages={() => {}} onDropAudio={() => {}}/>);

    await userEvent.click(screen.getByTestId("load-demo"));
    await userEvent.click(screen.getByTestId("load-demo-portrait"));

    expect(onDemo).toHaveBeenNthCalledWith(1, "landscape");
    expect(onDemo).toHaveBeenNthCalledWith(2, "portrait");
  });

  it("displays 'Import media' and supported formats when empty", () => {
    render(<MediaLibrary project={project} selectedId={null} onSelect={() => {}} onImportImages={() => {}} onVoice={() => {}} onMusic={() => {}} onNarrationFolder={() => {}} onDemo={() => {}} onReorder={() => {}} onDropImages={() => {}} onDropAudio={() => {}}/>);

    expect(screen.getByText("Import media")).toBeInTheDocument();
    expect(screen.getByText("MP4, MOV, WebM, PNG, JPG, WebP")).toBeInTheDocument();
  });

  it("accepts video files through drag and drop", () => {
    const onDropImages = vi.fn();
    const { container } = render(<MediaLibrary project={project} selectedId={null} onSelect={() => {}} onImportImages={() => {}} onVoice={() => {}} onMusic={() => {}} onNarrationFolder={() => {}} onDemo={() => {}} onReorder={() => {}} onDropImages={onDropImages} onDropAudio={() => {}}/>);

    const videoFile = new File(["dummy video"], "flow-clip-01.mp4", { type: "video/mp4" });
    const panel = container.querySelector(".media-panel")!;

    const dragEvent = {
      dataTransfer: {
        files: [videoFile],
        types: ["Files"],
      },
      preventDefault: vi.fn(),
    };

    fireEvent.dragEnter(panel, dragEvent);
    fireEvent.drop(panel, dragEvent);

    expect(onDropImages).toHaveBeenCalledTimes(1);
    expect(onDropImages).toHaveBeenCalledWith([videoFile]);
  });
});

