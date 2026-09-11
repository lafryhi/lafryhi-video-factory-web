import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowProductionAssistant } from "./FlowProductionAssistant";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function openAssistant() {
  const user = userEvent.setup();
  render(<FlowProductionAssistant/>);
  await user.click(screen.getByRole("button", { name: "Prepare for Google Flow" }));
  const panel = within(screen.getByRole("dialog"));
  fireEvent.change(panel.getByLabelText("Idea (English)"), { target: { value: "A fox learns colors." } });
  await user.click(panel.getByRole("button", { name: "Prepare for Google Flow" }));
  return { user, panel };
}
describe("Flow production assistant", () => {
  it("prepares locally, copies updated prompts, and preserves the draft after closing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { user, panel } = await openAssistant();
    expect(panel.getByText("Production package · 30s · 9:16")).toBeInTheDocument();
    fireEvent.change(panel.getByLabelText("Master Character Description"), { target: { value: "Fox cub with a purple scarf." } });
    await user.click(panel.getByRole("button", { name: "Copy All Prompts" }));
    expect(await navigator.clipboard.readText()).toContain("Fox cub with a purple scarf.");
    await user.click(panel.getByRole("button", { name: "Back to editor" }));
    await user.click(screen.getByRole("button", { name: "Prepare for Google Flow" }));
    expect(panel.getByLabelText("Master Character Description")).toHaveValue("Fox cub with a purple scarf.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("supports custom runtime and blocks stale package copying until rebuilt", async () => {
    const { user, panel } = await openAssistant();
    await user.selectOptions(panel.getByLabelText("Target duration"), "custom");
    fireEvent.change(panel.getByLabelText("Custom duration (seconds)"), { target: { value: "47" } });
    expect(panel.getByRole("button", { name: "Copy All Prompts" })).toBeDisabled();
    await user.click(panel.getByRole("button", { name: "Prepare for Google Flow again (replace scenes)" }));
    expect(panel.getByText("Production package · 47s · 9:16")).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Copy All Prompts" })).toBeEnabled();
  });
  it("offers a manual fallback when clipboard access fails", async () => {
    const { user, panel } = await openAssistant();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Denied"));
    await user.click(panel.getByRole("button", { name: "Copy Master Prompt" }));
    expect(panel.getByRole("alert")).toHaveTextContent("Select and copy");
  });
  it("downloads each package format and copies individual scene and character text", async () => {
    const { user, panel } = await openAssistant();
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    const blobs = vi.spyOn(URL, "createObjectURL");
    for (const name of ["Export TXT", "Export Markdown", "Export JSON"]) {
      await user.click(panel.getByRole("button", { name }));
    }
    expect(downloads).toEqual(["google-flow-production.txt", "google-flow-production.md", "google-flow-production.json"]);
    expect(blobs.mock.calls.map(([blob]) => (blob as Blob).type)).toEqual(["text/plain;charset=utf-8", "text/markdown;charset=utf-8", "application/json;charset=utf-8"]);
    await user.click(panel.getByRole("button", { name: "Copy Master Character" }));
    expect(await navigator.clipboard.readText()).toContain("Main subject: A fox.");
    await user.click(panel.getAllByRole("button", { name: "Copy Scene Prompt" })[0]);
    expect(await navigator.clipboard.readText()).toContain("Scene 1 of 4");
  });
});
