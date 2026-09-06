import JSZip, { type JSZipObject } from "jszip";
import { assetName, getLocalAsset, registerAsset, releaseLocalAssetIds, type LocalAssetKind } from "./assets";
import { mediaUrl } from "./api";
import type { Project } from "./types";

export const LVF_MIME_TYPE = "application/vnd.lafryhi-video-factory.project+zip";
export const LVF_PACKAGE_VERSION = 1;
const MANIFEST_PATH = "manifest.json";
const PROJECT_PATH = "project.json";
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const TOKEN_PREFIX = "lvf:asset:";

const extensions: Record<LocalAssetKind, Set<string>> = {
  image: new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]),
  voice: new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]),
  music: new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]),
  narration: new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]),
};

type ProgressCallback = (progress: number, stage: string) => void;
type AssetResolver = (source: string, kind: LocalAssetKind, signal?: AbortSignal) => Promise<File>;
type MediaReference = { source: string; kind: LocalAssetKind; required: boolean; set(value: string): void };

export type LvfAssetManifest = {
  id: string;
  path: string;
  kind: LocalAssetKind;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  lastModified: number;
};

export type LvfManifest = {
  format: "lafryhi-video-factory-project";
  packageVersion: number;
  projectSchemaVersion: number;
  appVersion: string;
  projectName: string;
  createdAt: string;
  projectPath: "project.json";
  projectSha256: string;
  assetCount: number;
  totalMediaBytes: number;
  assets: LvfAssetManifest[];
};

export type PackageProgressOptions = {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
};

export type CreatePackageOptions = PackageProgressOptions & {
  projectName: string;
  resolveAsset?: AssetResolver;
};

export type OpenedLvfProject = {
  project: Partial<Project>;
  projectName: string;
  assetIds: string[];
  assetCount: number;
  totalMediaBytes: number;
};

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Project operation cancelled", "AbortError");
}

function update(onProgress: ProgressCallback | undefined, progress: number, stage: string): void {
  onProgress?.(Math.max(0, Math.min(1, progress)), stage);
}

function extensionOf(name: string): string {
  const match = /(?:^|\/)([^/]+?)(\.[^.\/]+)$/.exec(name);
  return match?.[2]?.toLowerCase() || "";
}

function safeFilename(name: string, fallback: string): string {
  const leaf = name.split(/[\\/]/).pop()?.normalize("NFC") || fallback;
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[:*?\"<>|]/g, "-").replace(/^\.+/, "").trim();
  return (cleaned || fallback).slice(0, 180);
}

function validateMediaFile(file: Blob & { name?: string }, kind: LocalAssetKind): void {
  const name = file.name || "";
  if (!extensions[kind].has(extensionOf(name))) throw new Error(`${name || "Media file"} is not a supported ${kind} file.`);
  if (file.size <= 0) throw new Error(`${name || "Media file"} is empty.`);
  if (file.size > MAX_ENTRY_BYTES) throw new Error(`${name || "Media file"} is larger than the 1 GB per-file limit.`);
}

function portableToken(id: string): string {
  return `${TOKEN_PREFIX}${id}`;
}

function tokenId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(TOKEN_PREFIX)) throw new Error("The project contains a non-portable media reference.");
  const id = value.slice(TOKEN_PREFIX.length);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("The project contains an invalid asset identifier.");
  return id;
}

function packagePathIsSafe(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

async function sha256(value: Blob | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function defaultAssetResolver(source: string, kind: LocalAssetKind, signal?: AbortSignal): Promise<File> {
  const local = getLocalAsset(source);
  if (local) return local.file;
  abortIfNeeded(signal);
  // Playback commonly leaves partial HTTP 206 responses in the browser cache.
  // Use a distinct, uncached download URL so portable packages always receive
  // the complete media file instead of reusing a streamed audio/video range.
  const response = await fetch(mediaUrl(source, true), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read ${assetName(source)} from the project workspace (${response.status}).`);
  const blob = await response.blob();
  const name = safeFilename(assetName(source), kind === "image" ? "image.png" : "audio.mp3");
  return new File([blob], name, { type: blob.type || response.headers.get("content-type") || "application/octet-stream", lastModified: Date.now() });
}

function generateZipBlob(zip: JSZip, options: PackageProgressOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: ArrayBuffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const stream = zip.generateInternalStream({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, streamFiles: true });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", cancel);
      if (error) { chunks.length = 0; stream.pause(); reject(error); }
      else resolve(new Blob(chunks, { type: LVF_MIME_TYPE }));
    };
    const cancel = () => finish(new DOMException("Project operation cancelled", "AbortError"));
    options.signal?.addEventListener("abort", cancel, { once: true });
    stream.on("data", (chunk, metadata) => {
      if (settled) return;
      const copy = new Uint8Array(chunk.byteLength); copy.set(chunk);
      chunks.push(copy.buffer); outputBytes += copy.byteLength;
      if (outputBytes > MAX_PACKAGE_BYTES) { finish(new Error("The resulting LVF project exceeds the 2 GB browser package limit.")); return; }
      update(options.onProgress, .48 + (metadata.percent / 100) * .51, `Packaging ${metadata.currentFile || "project data"}`);
      if (options.signal?.aborted) cancel();
    });
    stream.on("error", (error) => finish(error));
    stream.on("end", () => finish());
    if (options.signal?.aborted) cancel();
    else stream.resume();
  });
}

function collectReferences(project: Project): MediaReference[] {
  const references: MediaReference[] = project.scenes.map((scene) => ({
    source: scene.imagePath, kind: "image" as const, required: true,
    set: (value: string) => { scene.imagePath = value; },
  }));
  if (project.voiceFile) references.push({ source: project.voiceFile, kind: "voice", required: false, set: (value) => { project.voiceFile = value; } });
  if (project.musicFile) references.push({ source: project.musicFile, kind: "music", required: false, set: (value) => { project.musicFile = value; } });
  for (const assignment of project.narrationMapping.assignments) {
    if (assignment.audioPath) references.push({ source: assignment.audioPath, kind: "narration", required: false, set: (value) => { assignment.audioPath = value; } });
  }
  return references;
}

function portableProject(project: Project): Project {
  return {
    ...structuredClone(project),
    sessionId: "",
    baseDir: "",
    imagesFolder: "Portable LVF project",
    outputFolder: "",
  };
}

export async function createLvfPackage(project: Project, options: CreatePackageOptions): Promise<Blob> {
  abortIfNeeded(options.signal);
  const packaged = portableProject(project);
  const references = collectReferences(packaged);
  if (!references.length || !packaged.scenes.length) throw new Error("Add at least one image before saving a full project.");
  if (references.length > MAX_ENTRIES - 2) throw new Error(`This project contains more than ${MAX_ENTRIES - 2} media references.`);
  const zip = new JSZip();
  const resolveAsset = options.resolveAsset || defaultAssetResolver;
  const manifestAssets: LvfAssetManifest[] = [];
  const byReference = new Map<string, LvfAssetManifest>();
  const byContent = new Map<string, LvfAssetManifest>();
  let totalMediaBytes = 0;
  update(options.onProgress, .01, "Collecting project media");

  for (let index = 0; index < references.length; index++) {
    abortIfNeeded(options.signal);
    const reference = references[index];
    if (!reference.source) {
      if (reference.required) throw new Error("A scene is missing its source image.");
      continue;
    }
    const key = `${reference.kind}\0${reference.source}`;
    let asset = byReference.get(key);
    if (!asset) {
      update(options.onProgress, .03 + (index / references.length) * .42, `Reading ${assetName(reference.source)}`);
      const file = await resolveAsset(reference.source, reference.kind, options.signal);
      validateMediaFile(file, reference.kind);
      const id = `asset-${manifestAssets.length + 1}`;
      const name = safeFilename(file.name, reference.kind === "image" ? `${id}.png` : `${id}.mp3`);
      const folder = reference.kind === "image" ? "images" : "audio";
      const path = `media/${folder}/${id}/${name}`;
      const checksum = await sha256(file);
      abortIfNeeded(options.signal);
      const contentKey = `${reference.kind}\0${file.size}\0${checksum}`;
      asset = byContent.get(contentKey);
      if (!asset) {
        totalMediaBytes += file.size;
        if (totalMediaBytes > MAX_MEDIA_BYTES) throw new Error("Project media exceeds the 2 GB browser package limit.");
        asset = { id, path, kind: reference.kind, name, mimeType: file.type || "application/octet-stream", size: file.size, sha256: checksum, lastModified: file.lastModified || Date.now() };
        manifestAssets.push(asset);
        byContent.set(contentKey, asset);
        zip.file(path, file, { binary: true, compression: "STORE", createFolders: false });
      }
      byReference.set(key, asset);
    }
    reference.set(portableToken(asset.id));
  }

  const projectJson = JSON.stringify(packaged, null, 2);
  if (new Blob([projectJson]).size > MAX_JSON_BYTES) throw new Error("Project metadata exceeds the 10 MB limit.");
  const manifest: LvfManifest = {
    format: "lafryhi-video-factory-project",
    packageVersion: LVF_PACKAGE_VERSION,
    projectSchemaVersion: project.schemaVersion,
    appVersion: "2.0.0",
    projectName: options.projectName.trim().slice(0, 500) || "Untitled project",
    createdAt: new Date().toISOString(),
    projectPath: PROJECT_PATH,
    projectSha256: await sha256(projectJson),
    assetCount: manifestAssets.length,
    totalMediaBytes,
    assets: manifestAssets,
  };
  zip.file(PROJECT_PATH, projectJson, { compression: "DEFLATE" });
  zip.file(MANIFEST_PATH, JSON.stringify(manifest, null, 2), { compression: "DEFLATE" });
  update(options.onProgress, .48, "Compressing portable project");
  const output = await generateZipBlob(zip, options);
  abortIfNeeded(options.signal);
  if (output.size > MAX_PACKAGE_BYTES) throw new Error("The resulting LVF project exceeds the 2 GB browser package limit.");
  update(options.onProgress, 1, "Project package ready");
  return output;
}

function uncompressedSize(entry: JSZipObject): number | undefined {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : undefined;
}

function validateRawZipEntries(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error(`The LVF package contains more than ${MAX_ENTRIES} entries.`);
  let totalBytes = 0;
  for (const entry of entries) {
    const unsafeOriginalName = (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
    const checkedName = entry.dir && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (!packagePathIsSafe(checkedName) || (unsafeOriginalName && unsafeOriginalName !== entry.name)) throw new Error("The LVF package contains an unsafe file path.");
    if (entry.dir) continue;
    const size = uncompressedSize(entry);
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) throw new Error(`The LVF entry has invalid size metadata: ${entry.name}`);
    const limit = entry.name === MANIFEST_PATH || entry.name === PROJECT_PATH ? MAX_JSON_BYTES : MAX_ENTRY_BYTES;
    if (size > limit) throw new Error(`The LVF entry is too large: ${entry.name}`);
    totalBytes += size;
    if (totalBytes > MAX_MEDIA_BYTES + MAX_JSON_BYTES * 2) throw new Error("The LVF package expands beyond the 2 GB media limit.");
  }
}

function rejectDangerousJson(value: unknown, depth = 0): void {
  if (depth > 100) throw new Error("Project metadata is nested too deeply.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Project metadata contains an unsafe property.");
    rejectDangerousJson(child, depth + 1);
  }
}

function parseManifest(value: unknown): LvfManifest {
  rejectDangerousJson(value);
  if (!value || typeof value !== "object") throw new Error("The LVF manifest is not an object.");
  const manifest = value as Partial<LvfManifest>;
  if (manifest.format !== "lafryhi-video-factory-project") throw new Error("This ZIP is not a LAFRYHI Video Factory project.");
  if (manifest.packageVersion !== LVF_PACKAGE_VERSION) throw new Error(`LVF package version ${String(manifest.packageVersion)} is not supported by this app.`);
  if (!Number.isSafeInteger(manifest.projectSchemaVersion) || Number(manifest.projectSchemaVersion) < 1 || Number(manifest.projectSchemaVersion) > 2) throw new Error(`Project schema version ${String(manifest.projectSchemaVersion)} is not supported by this app.`);
  if (manifest.projectPath !== PROJECT_PATH) throw new Error("The LVF project document path is invalid.");
  if (!/^[a-f0-9]{64}$/.test(manifest.projectSha256 || "")) throw new Error("The LVF project checksum is invalid.");
  if (!Array.isArray(manifest.assets) || manifest.assets.length > MAX_ENTRIES - 2) throw new Error("The LVF asset list is invalid or too large.");
  if (manifest.assetCount !== manifest.assets.length) throw new Error("The LVF asset count does not match its manifest.");
  if (!Number.isSafeInteger(manifest.totalMediaBytes) || Number(manifest.totalMediaBytes) < 0 || Number(manifest.totalMediaBytes) > MAX_MEDIA_BYTES) throw new Error("The LVF media size is invalid.");
  if (typeof manifest.projectName !== "string" || manifest.projectName.length > 500) throw new Error("The LVF project name is invalid.");
  if (typeof manifest.appVersion !== "string" || manifest.appVersion.length > 100) throw new Error("The LVF app version is invalid.");
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("The LVF creation date is invalid.");
  const ids = new Set<string>(); const paths = new Set<string>(); let declaredBytes = 0;
  for (const item of manifest.assets) {
    if (!item || typeof item !== "object") throw new Error("The LVF manifest contains an invalid asset.");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) throw new Error("The LVF manifest contains a duplicate or invalid asset ID.");
    if (!packagePathIsSafe(item.path) || !item.path.startsWith("media/") || paths.has(item.path)) throw new Error("The LVF manifest contains a duplicate or unsafe media path.");
    if (!Object.hasOwn(extensions, item.kind)) throw new Error("The LVF manifest contains an unknown media kind.");
    if (safeFilename(item.name, "invalid") !== item.name || !extensions[item.kind].has(extensionOf(item.name))) throw new Error(`The LVF asset name is invalid: ${item.name}`);
    const expectedFolder = item.kind === "image" ? "media/images/" : "media/audio/";
    if (!item.path.startsWith(expectedFolder) || !item.path.endsWith(`/${item.name}`)) throw new Error(`The LVF asset path does not match its media kind: ${item.name}`);
    if (!Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_ENTRY_BYTES) throw new Error(`The LVF asset size is invalid: ${item.name}`);
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`The LVF asset checksum is invalid: ${item.name}`);
    if (typeof item.mimeType !== "string" || item.mimeType.length > 200 || /[\u0000-\u001f\u007f]/.test(item.mimeType)) throw new Error(`The LVF asset media type is invalid: ${item.name}`);
    if (!Number.isSafeInteger(item.lastModified) || item.lastModified < 0 || item.lastModified > 8_640_000_000_000_000) throw new Error(`The LVF asset timestamp is invalid: ${item.name}`);
    ids.add(item.id); paths.add(item.path); declaredBytes += item.size;
  }
  if (declaredBytes !== manifest.totalMediaBytes) throw new Error("The LVF media byte count does not match its manifest.");
  return manifest as LvfManifest;
}

function validateZipEntries(zip: JSZip, manifest: LvfManifest): void {
  const entries = Object.values(zip.files);
  const files = entries.filter((entry) => !entry.dir);
  if (files.length > MAX_ENTRIES) throw new Error(`The LVF package contains more than ${MAX_ENTRIES} files.`);
  const expected = new Set([MANIFEST_PATH, PROJECT_PATH, ...manifest.assets.map((asset) => asset.path)]);
  for (const entry of files) {
    const unsafeOriginalName = (entry as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
    if (!packagePathIsSafe(entry.name) || (unsafeOriginalName && unsafeOriginalName !== entry.name)) throw new Error("The LVF package contains an unsafe file path.");
    if (!expected.has(entry.name)) throw new Error(`The LVF package contains an unexpected file: ${entry.name}`);
    const size = uncompressedSize(entry);
    const limit = entry.name === MANIFEST_PATH || entry.name === PROJECT_PATH ? MAX_JSON_BYTES : MAX_ENTRY_BYTES;
    if (size !== undefined && size > limit) throw new Error(`The LVF entry is too large: ${entry.name}`);
  }
  for (const path of expected) if (!zip.file(path)) throw new Error(`The LVF package is missing ${path}.`);
}

function hydrateProject(project: Partial<Project>, manifest: LvfManifest, resolved: Map<string, string>): Partial<Project> {
  if (!Array.isArray(project.scenes) || !project.narrationMapping || !Array.isArray(project.narrationMapping.assignments)) throw new Error("The LVF project document has an invalid structure.");
  if (project.scenes.length < 1 || project.scenes.length > MAX_ENTRIES - 2) throw new Error("The LVF project has an invalid number of scenes.");
  if (project.narrationMapping.assignments.length > project.scenes.length) throw new Error("The LVF project contains too many narration assignments.");
  const sceneIds = new Set<string>();
  for (const scene of project.scenes) {
    if (!scene || typeof scene.sceneId !== "string" || !scene.sceneId.trim() || sceneIds.has(scene.sceneId)) throw new Error("The LVF project contains duplicate or invalid scene IDs.");
    sceneIds.add(scene.sceneId);
  }
  const assignmentIds = new Set<string>();
  for (const assignment of project.narrationMapping.assignments) {
    if (!assignment || typeof assignment.sceneId !== "string" || !sceneIds.has(assignment.sceneId) || assignmentIds.has(assignment.sceneId)) throw new Error("The LVF project contains an orphaned or duplicate narration assignment.");
    assignmentIds.add(assignment.sceneId);
  }
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const read = (value: unknown, expected: LocalAssetKind, required: boolean): string => {
    if (!value && !required) return "";
    const id = tokenId(value);
    const asset = assets.get(id);
    if (!asset || asset.kind !== expected) throw new Error(`The project references a missing or incompatible ${expected} asset.`);
    const local = resolved.get(id);
    if (!local) throw new Error(`The project asset was not restored: ${asset.name}`);
    return local;
  };
  const hydrated = structuredClone(project) as Partial<Project>;
  hydrated.scenes = hydrated.scenes!.map((scene) => ({ ...scene, imagePath: read(scene.imagePath, "image", true) }));
  hydrated.voiceFile = read(hydrated.voiceFile, "voice", false);
  hydrated.musicFile = read(hydrated.musicFile, "music", false);
  hydrated.narrationMapping = {
    ...hydrated.narrationMapping!,
    assignments: hydrated.narrationMapping!.assignments.map((assignment) => ({ ...assignment, audioPath: assignment.audioPath ? read(assignment.audioPath, "narration", false) : null })),
  };
  const referenced = new Set<string>();
  for (const scene of project.scenes) referenced.add(tokenId(scene.imagePath));
  if (project.voiceFile) referenced.add(tokenId(project.voiceFile));
  if (project.musicFile) referenced.add(tokenId(project.musicFile));
  for (const assignment of project.narrationMapping.assignments) if (assignment.audioPath) referenced.add(tokenId(assignment.audioPath));
  if (referenced.size !== manifest.assets.length) throw new Error("The LVF package contains media that is not referenced by the project.");
  return hydrated;
}

export async function openLvfPackage(file: File, options: PackageProgressOptions = {}): Promise<OpenedLvfProject> {
  if (file.size <= 0) throw new Error("The selected LVF project is empty.");
  if (file.size > MAX_PACKAGE_BYTES) throw new Error("The selected LVF project exceeds the 2 GB browser package limit.");
  abortIfNeeded(options.signal);
  update(options.onProgress, .01, "Reading LVF package");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file, { createFolders: false });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The selected .lvf file is not a readable ZIP package or is damaged.");
  }
  abortIfNeeded(options.signal);
  validateRawZipEntries(zip);
  const manifestEntry = zip.file(MANIFEST_PATH);
  if (!manifestEntry) throw new Error("This file is missing manifest.json and is not a valid LVF project.");
  const manifestText = await manifestEntry.async("string");
  if (new Blob([manifestText]).size > MAX_JSON_BYTES) throw new Error("The LVF manifest exceeds the 10 MB metadata limit.");
  let manifestValue: unknown;
  try { manifestValue = JSON.parse(manifestText); } catch { throw new Error("The LVF manifest contains invalid JSON."); }
  const manifest = parseManifest(manifestValue);
  validateZipEntries(zip, manifest);
  update(options.onProgress, .08, "Validating project document");
  const projectText = await zip.file(PROJECT_PATH)!.async("string");
  if (new Blob([projectText]).size > MAX_JSON_BYTES) throw new Error("The LVF project document exceeds the 10 MB metadata limit.");
  if (await sha256(projectText) !== manifest.projectSha256) throw new Error("The LVF project document is damaged or has been modified.");
  let project: Partial<Project>;
  try { project = JSON.parse(projectText) as Partial<Project>; } catch { throw new Error("The LVF project document contains invalid JSON."); }
  rejectDangerousJson(project);
  if (project.schemaVersion !== manifest.projectSchemaVersion) throw new Error("The project schema does not match the LVF manifest.");

  const extracted = new Map<string, File>();
  for (let index = 0; index < manifest.assets.length; index++) {
    abortIfNeeded(options.signal);
    const asset = manifest.assets[index];
    update(options.onProgress, .1 + (index / Math.max(1, manifest.assets.length)) * .78, `Checking ${asset.name}`);
    const blob = await zip.file(asset.path)!.async("blob");
    abortIfNeeded(options.signal);
    if (blob.size !== asset.size) throw new Error(`The stored size does not match for ${asset.name}.`);
    if (await sha256(blob) !== asset.sha256) throw new Error(`Integrity check failed for ${asset.name}.`);
    abortIfNeeded(options.signal);
    const restored = new File([blob], asset.name, { type: asset.mimeType, lastModified: asset.lastModified });
    validateMediaFile(restored, asset.kind);
    extracted.set(asset.id, restored);
  }
  abortIfNeeded(options.signal);
  update(options.onProgress, .9, "Restoring browser-local media");
  const resolved = new Map<string, string>();
  const assetIds: string[] = [];
  try {
    for (const asset of manifest.assets) {
      const id = registerAsset(extracted.get(asset.id)!, asset.kind);
      resolved.set(asset.id, id); assetIds.push(id);
    }
    const hydrated = hydrateProject(project, manifest, resolved);
    update(options.onProgress, 1, "Project restored");
    return { project: hydrated, projectName: manifest.projectName || file.name.replace(/\.lvf$/i, ""), assetIds, assetCount: manifest.assets.length, totalMediaBytes: manifest.totalMediaBytes };
  } catch (error) {
    releaseLocalAssetIds(assetIds);
    throw error;
  }
}

export async function isLvfPackage(file: File): Promise<boolean> {
  if (/\.lvf$/i.test(file.name)) return true;
  if (file.size < 4) return false;
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return signature[0] === 0x50 && signature[1] === 0x4b && [0x03, 0x05, 0x07].includes(signature[2]) && [0x04, 0x06, 0x08].includes(signature[3]);
}
