import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportProgressPopup, PackageProgressPopup, PopupProvider, usePopups, type ExportPopupState, type PackagePopupState } from "./PopupSystem";

afterEach(() => cleanup());

function Harness({ result }: { result: (value: unknown) => void }) {
  const popup = usePopups();
  return <>
    <button onClick={() => void popup.confirm({ tone: "warning", title: "Remove scene?", message: "This can be undone." }).then(result)}>Confirm</button>
    <button onClick={() => void popup.prompt({ title: "Name it", message: "Choose a name", label: "Project name", value: "My video" }).then(result)}>Prompt</button>
    <button onClick={() => popup.toast({ tone: "success", title: "Saved", message: "Project downloaded" })}>Toast</button>
  </>;
}

describe("popup system", () => {
  it("returns explicit confirmation decisions", async () => {
    const result = vi.fn();
    render(<PopupProvider><Harness result={result}/></PopupProvider>);
    await userEvent.click(screen.getByText("Confirm"));
    expect(screen.getByRole("dialog", { name: "Remove scene?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(result).toHaveBeenCalledWith(true);
  });

  it("supports named prompts and cancellation", async () => {
    const result = vi.fn();
    render(<PopupProvider><Harness result={result}/></PopupProvider>);
    await userEvent.click(screen.getByText("Prompt"));
    const input = screen.getByLabelText("Project name");
    await userEvent.clear(input); await userEvent.type(input, "Launch film");
    await userEvent.click(screen.getByRole("button", { name: "Save project" }));
    expect(result).toHaveBeenCalledWith("Launch film");
  });

  it("keeps keyboard focus inside dialogs and closes prompts with Escape", async () => {
    const result = vi.fn();
    const user = userEvent.setup();
    render(<PopupProvider><Harness result={result}/></PopupProvider>);
    await user.click(screen.getByText("Prompt"));
    const input = screen.getByLabelText("Project name");
    const close = screen.getByRole("button", { name: "Close dialog" });
    const save = screen.getByRole("button", { name: "Save project" });
    await waitFor(() => expect(input).toHaveFocus());
    save.focus();
    await user.tab();
    expect(close).toHaveFocus();
    close.focus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(result).toHaveBeenCalledWith(null));
  });

  it("renders themed success notifications", async () => {
    render(<PopupProvider><Harness result={() => {}}/></PopupProvider>);
    await userEvent.click(screen.getByText("Toast"));
    expect(screen.getByTestId("toast")).toHaveClass("success");
    expect(screen.getByText("Project downloaded")).toBeInTheDocument();
  });
});

describe("export progress popup", () => {
  const callbacks = { onCancel: vi.fn(), onClose: vi.fn(), onShowVideo: vi.fn(), onOpenVideo: vi.fn(), onRetry: vi.fn() };
  it("shows progress and offers cancellation while rendering", () => {
    const state: ExportPopupState = { open: true, status: "running", progress: .42, stage: "Rendering video", logs: ["Preparing scenes"] };
    render(<ExportProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByRole("progressbar", { name: "Export progress" })).toHaveAttribute("aria-valuenow", "42");
    fireEvent.click(screen.getByTestId("cancel-export"));
    expect(callbacks.onCancel).toHaveBeenCalled();
  });

  it("shows the completed-video action", () => {
    const state: ExportPopupState = { open: true, status: "success", progress: 1, stage: "Completed", logs: [], output: "/video.mp4" };
    render(<ExportProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByText("Your video is ready")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("show-export"));
    expect(callbacks.onShowVideo).toHaveBeenCalled();
    expect(screen.getByTestId("download-export")).toHaveAttribute("href", expect.stringMatching(/\/api\/media\?path=%2Fvideo.mp4&download=true$/));
  });

  it("embeds the completed MP4 without opening a popup window", () => {
    const state: ExportPopupState = { open: true, status: "success", progress: 1, stage: "Completed", logs: [], output: "/video.mp4", showVideo: true };
    render(<ExportProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByTestId("export-video")).toHaveAttribute("src", expect.stringMatching(/\/api\/media\?path=%2Fvideo.mp4$/));
    expect(screen.getByTestId("show-export")).toHaveTextContent("Hide video");
  });

  it("opens the rendered file instead of offering a download in desktop mode", () => {
    const state: ExportPopupState = { open: true, status: "success", progress: 1, stage: "Completed", logs: [], output: "/video.mp4" };
    render(<ExportProgressPopup state={state} desktop {...callbacks}/>);
    expect(screen.queryByTestId("download-export")).not.toBeInTheDocument();
    expect(screen.queryByTestId("show-export")).not.toBeInTheDocument();
    expect(screen.getByText(/ready to open/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("open-export"));
    expect(callbacks.onOpenVideo).toHaveBeenCalledOnce();
  });

  it("uses a clear stopped state after cancellation", () => {
    const state: ExportPopupState = { open: true, status: "cancelled", progress: .83, stage: "Export cancelled", logs: [] };
    render(<ExportProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByText("Export cancelled")).toBeInTheDocument();
    expect(screen.getByText("Stopped", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByTestId("retry-export")).toBeInTheDocument();
  });
});

describe("project package progress popup", () => {
  const callbacks = { onCancel: vi.fn(), onClose: vi.fn(), onRetry: vi.fn() };

  it("shows save progress and supports cancellation", () => {
    const state: PackagePopupState = { open: true, mode: "save", status: "running", progress: .37, stage: "Packaging images", fileName: "Project.lvf" };
    render(<PackageProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByRole("progressbar", { name: "Project save progress" })).toHaveAttribute("aria-valuenow", "37");
    fireEvent.click(screen.getByTestId("cancel-package"));
    expect(callbacks.onCancel).toHaveBeenCalled();
  });

  it("shows a verified open result", () => {
    const state: PackagePopupState = { open: true, mode: "open", status: "success", progress: 1, stage: "Project restored", fileName: "Project.lvf" };
    render(<PackageProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByText("Project opened")).toBeInTheDocument();
    expect(screen.getByText(/restored and ready to edit/)).toBeInTheDocument();
  });

  it("offers retry after a damaged package error", () => {
    const state: PackagePopupState = { open: true, mode: "open", status: "error", progress: .12, stage: "Open failed", error: "Integrity check failed" };
    render(<PackageProgressPopup state={state} {...callbacks}/>);
    expect(screen.getByText("Integrity check failed")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("retry-package"));
    expect(callbacks.onRetry).toHaveBeenCalled();
  });
});
