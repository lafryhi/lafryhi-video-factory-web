import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioTrimControl } from "./AudioTrimControl";
import { ImageCropEditor } from "./ImageCropEditor";

afterEach(() => cleanup());

describe("media editing controls", () => {
  it("enables, adjusts, and resets a scene crop", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ImageCropEditor imagePath="/scene.jpg" crop={{ enabled: false, x: 50, y: 50, zoom: 1 }} portrait={false} onChange={onChange}/>);
    await userEvent.click(screen.getByTestId("toggle-image-crop"));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, x: 50, y: 50, zoom: 1 });
    rerender(<ImageCropEditor imagePath="/scene.jpg" crop={{ enabled: true, x: 50, y: 50, zoom: 1 }} portrait={false} onChange={onChange}/>);
    const canvas = screen.getByTestId("crop-canvas");
    Object.defineProperty(canvas, "setPointerCapture", { configurable: true, value: vi.fn() });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 160, clientY: 45 });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, x: 75, y: 25, zoom: 1 });
    fireEvent.change(screen.getByRole("slider", { name: "Image crop zoom" }), { target: { value: "2.5" } });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, x: 50, y: 50, zoom: 2.5 });
    await userEvent.click(screen.getByRole("button", { name: "Reset crop" }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false, x: 50, y: 50, zoom: 1 });
  });

  it("loads audio duration and keeps trim handles ordered", () => {
    const onChange = vi.fn();
    const { container } = render(<AudioTrimControl label="Main voice" source="/voice.mp3" start={1} end={null} onChange={onChange}/>);
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, value: 10 });
    fireEvent.loadedMetadata(audio);
    fireEvent.change(screen.getByRole("slider", { name: "Main voice trim start" }), { target: { value: "3.25" } });
    expect(onChange).toHaveBeenLastCalledWith(3.25, null);
    fireEvent.change(screen.getByRole("slider", { name: "Main voice trim end" }), { target: { value: "7.5" } });
    expect(onChange).toHaveBeenLastCalledWith(1, 7.5);
  });

  it("handles a missing audio source without exposing invalid sliders", () => {
    render(<AudioTrimControl label="Background music" source="" start={0} end={null} onChange={() => {}}/>);
    expect(screen.getByText("Add an audio file to select the part you want to keep.")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});
