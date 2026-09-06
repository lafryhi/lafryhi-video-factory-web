import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocalAsset, releaseLocalAssets } from "./assets";
import { createLvfPackage, isLvfPackage, LVF_PACKAGE_VERSION, openLvfPackage } from "./projectPackage";
import type { Project, Scene } from "./types";

afterEach(() => { releaseLocalAssets(); vi.restoreAllMocks(); });

const scene = (sceneId: string, imagePath: string): Scene => ({ sceneId, imagePath, durationSeconds: 3, motion: "ZoomIn", motionIntensity: .25, startZoom: 1, endZoom: 1.15, transition: "fade", transitionDurationSeconds: .6, timingWeight: 1, crop: { enabled: true, x: 72, y: 38, zoom: 1.8 }, texts: [{ id: `text-${sceneId}`, text: "مرحبا Hello", fontFamily: "Rubik", fontSize: 64, color: "#ffffff", x: 50, y: 70, startSeconds: 0, endSeconds: null }] });
const project = (): Project => ({
  schemaVersion: 2, sessionId: "browser-session", baseDir: "/private/session", imagesFolder: "Browser-local media",
  voiceFile: "source:voice", musicFile: "source:music", voiceTrimStartSeconds: 1.25, voiceTrimEndSeconds: 3.5, musicTrimStartSeconds: 2, musicTrimEndSeconds: 6, outputFolder: "/private/output", outputName: "video.mp4",
  videoFormat: "landscape_16_9", resolution: "1920x1080", fps: 30, fillMode: "Fit with blurred background",
  minimumSceneDuration: 1, motionIntensity: "Low", musicVolume: .18,
  audioTiming: { mode: "manual", silenceThresholdDb: -35, minimumSilenceSeconds: .35, minimumSceneSeconds: 1, weights: null },
  narrationMapping: { mismatchStrategy: "outro", defaultOutroSeconds: 4, extendLastWeights: [1, 1], assignments: [{ sceneId: "a", audioPath: "source:narration", trimStartSeconds: .5, trimEndSeconds: 2, leadingPaddingSeconds: .2, trailingPaddingSeconds: .3, enabled: true }] },
  audioTimelineCuts: { voice: [1.5], music: [2.25, 4.5], narration: { a: [.75] } },
  audioTimelineRemovedRanges: { voice: [{ startSeconds: 1.5, endSeconds: 2 }], music: [{ startSeconds: 2.25, endSeconds: 4.5 }], narration: { a: [{ startSeconds: .75, endSeconds: 1.25 }] } },
  audioTimelineGaps: { voice: [{ atSeconds: 2, durationSeconds: .5 }], music: [], narration: { a: [{ atSeconds: 1.25, durationSeconds: .25 }] } },
  scenes: [scene("a", "source:image"), scene("b", "source:image")],
});

const files: Record<string, File> = {
  "source:image": new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "photo.png", { type: "image/png", lastModified: 10 }),
  "source:image-copy": new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "copied-photo.png", { type: "image/png", lastModified: 11 }),
  "source:voice": new File([new Uint8Array([73, 68, 51, 4, 5, 6])], "voice.mp3", { type: "audio/mpeg", lastModified: 20 }),
  "source:music": new File([new Uint8Array([73, 68, 51, 7, 8, 9])], "music.mp3", { type: "audio/mpeg", lastModified: 30 }),
  "source:narration": new File([new Uint8Array([82, 73, 70, 70, 10, 11])], "scene.wav", { type: "audio/wav", lastModified: 40 }),
};
const resolveAsset = async (source: string) => files[source];
const asFile = (blob: Blob, name = "roundtrip.lvf") => new File([blob], name, { type: blob.type });

describe("portable LVF project packages", () => {
  it("round-trips the full project and deduplicates repeated media", async () => {
    const progress: Array<[number, string]> = [];
    const blob = await createLvfPackage(project(), { projectName: "My complete project", resolveAsset, onProgress: (value, stage) => progress.push([value, stage]) });
    const zip = await JSZip.loadAsync(blob);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const storedProject = await zip.file("project.json")!.async("string");

    expect(blob.type).toBe("application/vnd.lafryhi-video-factory.project+zip");
    expect(manifest).toMatchObject({ packageVersion: LVF_PACKAGE_VERSION, projectName: "My complete project", assetCount: 4 });
    expect(storedProject).not.toContain("source:image");
    expect(storedProject).not.toContain("/private/session");
    expect(progress.at(-1)).toEqual([1, "Project package ready"]);

    const opened = await openLvfPackage(asFile(blob));
    expect(opened.projectName).toBe("My complete project");
    expect(opened.assetCount).toBe(4);
    expect(opened.project.scenes).toHaveLength(2);
    expect(opened.project.scenes![0].imagePath).toBe(opened.project.scenes![1].imagePath);
    expect(opened.project.scenes![0].texts?.[0].text).toBe("مرحبا Hello");
    expect(opened.project.scenes![0].crop).toEqual({ enabled: true, x: 72, y: 38, zoom: 1.8 });
    expect(opened.project.voiceTrimStartSeconds).toBe(1.25);
    expect(opened.project.voiceTrimEndSeconds).toBe(3.5);
    expect(opened.project.musicTrimStartSeconds).toBe(2);
    expect(opened.project.musicTrimEndSeconds).toBe(6);
    expect(opened.project.audioTimelineCuts).toEqual({ voice: [1.5], music: [2.25, 4.5], narration: { a: [.75] } });
    expect(opened.project.audioTimelineRemovedRanges).toEqual({ voice: [{ startSeconds: 1.5, endSeconds: 2 }], music: [{ startSeconds: 2.25, endSeconds: 4.5 }], narration: { a: [{ startSeconds: .75, endSeconds: 1.25 }] } });
    expect(opened.project.audioTimelineGaps).toEqual({ voice: [{ atSeconds: 2, durationSeconds: .5 }], music: [], narration: { a: [{ atSeconds: 1.25, durationSeconds: .25 }] } });
    expect(getLocalAsset(opened.project.scenes![0].imagePath)?.file.name).toBe("photo.png");
    expect(getLocalAsset(opened.project.voiceFile)?.file.name).toBe("voice.mp3");
    expect(getLocalAsset(opened.project.musicFile)?.file.name).toBe("music.mp3");
    expect(getLocalAsset(opened.project.narrationMapping!.assignments[0].audioPath)?.file.name).toBe("scene.wav");
  });

  it("detects LVF files by extension or ZIP signature", async () => {
    expect(await isLvfPackage(new File(["bad"], "named.lvf"))).toBe(true);
    expect(await isLvfPackage(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "project.bin"))).toBe(true);
    expect(await isLvfPackage(new File(["json"], "project.json"))).toBe(false);
  });

  it("deduplicates byte-identical media even when it has different browser references", async () => {
    const value = project();
    value.scenes[1].imagePath = "source:image-copy";
    const zip = await JSZip.loadAsync(await createLvfPackage(value, { projectName: "Content dedupe", resolveAsset }));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const stored = JSON.parse(await zip.file("project.json")!.async("string"));
    expect(manifest.assetCount).toBe(4);
    expect(stored.scenes[0].imagePath).toBe(stored.scenes[1].imagePath);
  });

  it("round-trips an image-only project without inventing audio", async () => {
    const value = project(); value.voiceFile = ""; value.musicFile = ""; value.narrationMapping.assignments = [];
    const opened = await openLvfPackage(asFile(await createLvfPackage(value, { projectName: "Silent", resolveAsset })));
    expect(opened.assetCount).toBe(1);
    expect(opened.project.voiceFile).toBe("");
    expect(opened.project.musicFile).toBe("");
  });

  it("packages backend-managed media through the secure media endpoint", async () => {
    const value = project();
    value.scenes = [scene("managed", "/managed/session/image.png")]; value.voiceFile = ""; value.musicFile = ""; value.narrationMapping.assignments = [];
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80, 78, 71, 2, 4, 6]), { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const opened = await openLvfPackage(asFile(await createLvfPackage(value, { projectName: "Managed media" })));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/media\?path=%2Fmanaged%2Fsession%2Fimage.png&download=true$/),
      { signal: undefined, cache: "no-store" },
    );
    expect(opened.assetCount).toBe(1);
    expect(getLocalAsset(opened.project.scenes![0].imagePath)?.file.name).toBe("image.png");
  });

  it("reports malformed LVF files without leaking ZIP implementation details", async () => {
    await expect(openLvfPackage(new File(["not a zip"], "broken.lvf"))).rejects.toThrow("not a readable ZIP package or is damaged");
  });

  it("rejects a modified media entry using its SHA-256 checksum", async () => {
    const blob = await createLvfPackage(project(), { projectName: "Integrity", resolveAsset });
    const zip = await JSZip.loadAsync(blob);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    zip.file(manifest.assets[0].path, new Uint8Array(manifest.assets[0].size).fill(9), { compression: "STORE" });
    const damaged = await zip.generateAsync({ type: "blob" });
    await expect(openLvfPackage(asFile(damaged, "damaged.lvf"))).rejects.toThrow(/Integrity check failed/);
  });

  it("rejects a modified project document", async () => {
    const blob = await createLvfPackage(project(), { projectName: "Integrity", resolveAsset });
    const zip = await JSZip.loadAsync(blob);
    zip.file("project.json", JSON.stringify({ scenes: [] }));
    await expect(openLvfPackage(asFile(await zip.generateAsync({ type: "blob" })))).rejects.toThrow(/project document is damaged/);
  });

  it("rejects missing, unexpected, and path-traversal entries", async () => {
    const blob = await createLvfPackage(project(), { projectName: "Structure", resolveAsset });
    const missing = await JSZip.loadAsync(blob);
    missing.remove("project.json");
    await expect(openLvfPackage(asFile(await missing.generateAsync({ type: "blob" })))).rejects.toThrow(/missing project.json/);

    const unexpected = await JSZip.loadAsync(blob);
    unexpected.file("extra.txt", "unexpected");
    await expect(openLvfPackage(asFile(await unexpected.generateAsync({ type: "blob" })))).rejects.toThrow(/unexpected file/);

    const traversal = await JSZip.loadAsync(blob);
    traversal.file("../escape.txt", "unsafe");
    await expect(openLvfPackage(asFile(await traversal.generateAsync({ type: "blob" })))).rejects.toThrow(/unsafe file path/);
  });

  it("rejects unsupported package versions and unsafe JSON properties", async () => {
    const blob = await createLvfPackage(project(), { projectName: "Version", resolveAsset });
    const versioned = await JSZip.loadAsync(blob);
    const manifest = JSON.parse(await versioned.file("manifest.json")!.async("string"));
    manifest.packageVersion = 999;
    versioned.file("manifest.json", JSON.stringify(manifest));
    await expect(openLvfPackage(asFile(await versioned.generateAsync({ type: "blob" })))).rejects.toThrow(/version 999 is not supported/);

    const schema = await JSZip.loadAsync(blob);
    const schemaManifest = JSON.parse(await schema.file("manifest.json")!.async("string"));
    schemaManifest.projectSchemaVersion = 999;
    schema.file("manifest.json", JSON.stringify(schemaManifest));
    await expect(openLvfPackage(asFile(await schema.generateAsync({ type: "blob" })))).rejects.toThrow(/schema version 999 is not supported/);

    const mismatch = await JSZip.loadAsync(blob);
    const mismatchProject = JSON.parse(await mismatch.file("project.json")!.async("string"));
    mismatchProject.schemaVersion = 1;
    const mismatchText = JSON.stringify(mismatchProject);
    const mismatchManifest = JSON.parse(await mismatch.file("manifest.json")!.async("string"));
    const checksum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mismatchText));
    mismatchManifest.projectSha256 = [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    mismatch.file("project.json", mismatchText); mismatch.file("manifest.json", JSON.stringify(mismatchManifest));
    await expect(openLvfPackage(asFile(await mismatch.generateAsync({ type: "blob" })))).rejects.toThrow(/schema does not match/);

    const unsafe = await JSZip.loadAsync(blob);
    unsafe.file("manifest.json", "{\"format\":\"lafryhi-video-factory-project\",\"packageVersion\":1,\"constructor\":{}}");
    await expect(openLvfPackage(asFile(await unsafe.generateAsync({ type: "blob" })))).rejects.toThrow(/unsafe property/);
  });

  it("rejects unsupported media and projects without images", async () => {
    await expect(createLvfPackage(project(), { projectName: "Bad media", resolveAsset: async (source) => source === "source:image" ? new File(["bad"], "bad.exe") : files[source] })).rejects.toThrow(/not a supported image/);
    await expect(createLvfPackage({ ...project(), scenes: [] }, { projectName: "Empty", resolveAsset })).rejects.toThrow(/Add at least one image/);
  });

  it("honors cancellation before saving or opening", async () => {
    const saveController = new AbortController(); saveController.abort();
    await expect(createLvfPackage(project(), { projectName: "Cancelled", resolveAsset, signal: saveController.signal })).rejects.toMatchObject({ name: "AbortError" });
    const blob = await createLvfPackage(project(), { projectName: "Open cancellation", resolveAsset });
    const openController = new AbortController(); openController.abort();
    await expect(openLvfPackage(asFile(blob), { signal: openController.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("honors cancellation during compression and extraction", async () => {
    const saveController = new AbortController();
    await expect(createLvfPackage(project(), { projectName: "Cancel compression", resolveAsset, signal: saveController.signal, onProgress: (value) => { if (value >= .48) saveController.abort(); } })).rejects.toMatchObject({ name: "AbortError" });

    const blob = await createLvfPackage(project(), { projectName: "Cancel extraction", resolveAsset });
    const openController = new AbortController();
    await expect(openLvfPackage(asFile(blob), { signal: openController.signal, onProgress: (value) => { if (value >= .1) openController.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
  });
});
