import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AIEditorAssistant } from "./AIEditorAssistant";
import { aiEditorApi } from "../aiEditor";

vi.mock("../aiEditor", () => ({ aiEditorApi: { capabilities: vi.fn(), upload: vi.fn(), analyze: vi.fn(), plan: vi.fn(), job: vi.fn(), render: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; });

it("provides the entry point and safely handles a backend without AI endpoints", async () => {
  vi.mocked(aiEditorApi.capabilities).mockRejectedValue(new Error("404"));
  render(<AIEditorAssistant sessionId={"a".repeat(32)} onApply={vi.fn()}/>);
  fireEvent.click(screen.getByText("Edit with AI"));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Analyze Video" })).toBeDisabled();
  expect(screen.getByText("AI Video Editor")).toBeInTheDocument();
});

it("uploads selected footage, analyzes it and shows a reviewable plan", async () => {
  vi.mocked(aiEditorApi.capabilities).mockResolvedValue({ transcription: false });
  vi.mocked(aiEditorApi.upload).mockResolvedValue({ id: "clip", name: "clip.mp4", path: "clip.mp4", duration: 10, hasAudio: true });
  vi.mocked(aiEditorApi.analyze).mockResolvedValue({ jobId: "analysis" });
  vi.mocked(aiEditorApi.job).mockResolvedValue({ id: "analysis", status: "complete", stage: "Ready", progress: 1, warnings: [] });
  vi.mocked(aiEditorApi.plan).mockResolvedValue({ plan: { operations: [], targetDuration: 10, aspectRatio: "9:16", warnings: [], video: { colorPreset: "original", cropMode: "center" } } as never });
  render(<AIEditorAssistant sessionId={"a".repeat(32)} onApply={vi.fn()}/>);
  fireEvent.click(screen.getByText("Edit with AI"));
  await waitFor(() => expect(screen.getByLabelText("AI video clips")).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("AI video clips"), { target: { files: [new File(["media"], "clip.mp4", { type: "video/mp4" })] } });
  await waitFor(() => expect(screen.getByText("Analyze Video")).not.toBeDisabled());
  fireEvent.click(screen.getByText("Analyze Video"));
  await screen.findByText("Structured edit plan");
  expect(screen.getByText("Apply AI Edit")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Editing instruction"), { target: { value: "new instruction" } });
  expect(screen.queryByText("Apply AI Edit")).not.toBeInTheDocument();
});
