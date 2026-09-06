import { cleanup, render, screen } from "@testing-library/react";
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
});
