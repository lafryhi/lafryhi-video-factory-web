import { describe, expect, it } from "vitest";
import productionHtml from "../index.html?raw";

describe("browser security configuration", () => {
  it("allows the production video API for requests and rendered media", () => {
    const apiOrigin = "https://lafryhi-video-factory-api-production.up.railway.app";
    const policy = productionHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";

    expect(policy).toContain(`connect-src 'self' ${apiOrigin}`);
    expect(policy).toContain(`media-src 'self' blob: ${apiOrigin}`);
    expect(policy).toContain(`img-src 'self' data: blob: ${apiOrigin}`);
    expect(policy).not.toContain("frame-ancestors");
  });
});
