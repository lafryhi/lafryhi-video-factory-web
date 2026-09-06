import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, mediaUrl, request } from "./api";

afterEach(() => vi.restoreAllMocks());

describe("web API client", () => {
  it("returns JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(request<{ ok: boolean }>("/health")).resolves.toEqual({ ok: true });
  });

  it("includes server request IDs in readable errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Bad media" }), { status: 400, headers: { "content-type": "application/json", "x-request-id": "abc123" } })));
    await expect(request("/preview")).rejects.toThrow("Bad media (request abc123)");
  });

  it("encodes managed media URLs and download intent", () => {
    expect(apiUrl("health")).toMatch(/\/api\/health$/);
    expect(mediaUrl("/tmp/a b.mp4", true)).toMatch(/\/api\/media\?path=%2Ftmp%2Fa%20b.mp4&download=true$/);
  });

  it("treats user cancellation as a quiet abort", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")));
    await expect(request("/render", { signal: new AbortController().signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(errorLog).not.toHaveBeenCalled();
  });
});
