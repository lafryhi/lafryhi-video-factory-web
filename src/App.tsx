import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { getLocalAsset, localAssetIds, registerAsset, releaseLocalAssetIds, releaseLocalAssets } from "./assets";
import { Inspector } from "./components/Inspector";
import { MediaLibrary } from "./components/MediaLibrary";
import { ExportProgressPopup, PackageProgressPopup, usePopups, type ExportPopupState, type PackagePopupState } from "./components/PopupSystem";
import { PreviewPanel } from "./components/PreviewPanel";
import { TimelineEditor } from "./components/TimelineEditor";
import { Toolbar } from "./components/Toolbar";
import { audioSegments, buildLocalTimeline, cutSelectedTimelineClip, DEFAULT_AUDIO_REMOVED_RANGES, DEFAULT_AUDIO_TIMELINE_CUTS, DEFAULT_AUDIO_TIMELINE_GAPS, DEFAULT_IMAGE_CROP, duplicateScene, moveAudioTimelineClip, normalizeAudioTimelineCuts, normalizeProject, patchScene, progressFraction, removeScene as removeSceneFromProject, removeTimelineRange, removeTimelineSelections, reorderScenes, sceneAtTime, setSceneDuration, splitScene, timelineSelectionKey, totalDuration, updateAssignment } from "./domain";
import { useProjectHistory } from "./hooks";
import { createLvfPackage, isLvfPackage, openLvfPackage } from "./projectPackage";
import { isDesktopRuntime, openDesktopVideo } from "./runtime";
import type { Capabilities, NarrationAssignment, Project, Scene, TextOverlay, Timeline, TimelineRangeSelection, TimelineSelection } from "./types";

const audioAccept = ".wav,.mp3,.m4a,.aac,.flac,.ogg";
const imageAccept = ".bmp,.gif,.jpeg,.jpg,.png,.tif,.tiff,.webp";
const emptyExport: ExportPopupState = { open: false, status: "running", progress: 0, stage: "Preparing export", logs: [] };
const emptyPackage: PackagePopupState = { open: false, mode: "save", status: "running", progress: 0, stage: "Preparing project" };

function localScene(file: File): Scene {
  return { sceneId: crypto.randomUUID(), imagePath: registerAsset(file, "image"), durationSeconds: 6, motion: "ZoomIn", motionIntensity: .25, startZoom: 1, endZoom: 1.15, transition: "fade", transitionDurationSeconds: .6, timingWeight: 1, crop: { ...DEFAULT_IMAGE_CROP }, texts: [] };
}

function messageOf(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function safeProjectFilename(name: string): string {
  const cleaned = name.replace(/\.lvf$/i, "").normalize("NFC").replace(/[\u0000-\u001f\u007f\\/:*?\"<>|]/g, "-").replace(/\s+/g, " ").replace(/^\.+|[. ]+$/g, "").trim();
  return `${(cleaned || "Untitled project").slice(0, 160)}.lvf`;
}

function Editor({ capabilities }: { capabilities: Capabilities }) {
  const history = useProjectHistory(structuredClone(capabilities.defaults));
  const { project, setProject, reset, undo, redo, canUndo, canRedo } = history;
  const popups = usePopups();
  const [selectedId, setSelectedId] = useState<string | null>(project.scenes[0]?.sceneId || null);
  const [selectedClips, setSelectedClips] = useState<TimelineSelection[]>(() => project.scenes[0] ? [{ kind: "scene", sceneId: project.scenes[0].sceneId }] : []);
  const selectedClip = selectedClips.at(-1) || null;
  const [selectedRange, setSelectedRange] = useState<TimelineRangeSelection | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [projectName, setProjectName] = useState("Untitled project");
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(capabilities.defaults));
  const [busy, setBusy] = useState(false);
  const [exportPopup, setExportPopup] = useState<ExportPopupState>(emptyExport);
  const [packagePopup, setPackagePopup] = useState<PackagePopupState>(emptyPackage);
  const [theme, setTheme] = useState<"dark" | "light">(() => localStorage.getItem("lafryhi-theme") === "light" ? "light" : "dark");
  const activeJob = useRef<string | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const packageController = useRef<AbortController | null>(null);
  const packageFile = useRef<File | null>(null);
  const cancelRequested = useRef(false);
  const selected = useMemo(() => project.scenes.find((scene) => scene.sceneId === selectedId), [project.scenes, selectedId]);
  const totalSeconds = useMemo(() => project.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), [project.scenes]);
  const isDirty = useMemo(() => JSON.stringify(project) !== savedSnapshot, [project, savedSnapshot]);
  const timedScene = useMemo(() => sceneAtTime(project, playhead), [project, playhead]);
  const previewScene = playing || playhead > 0 ? timedScene.scene : selected;
  const previewProgress = previewScene === timedScene.scene ? timedScene.progress : 0;
  const imageInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);
  const narrationFolderInput = useRef<HTMLInputElement>(null);
  const sceneNarrationInput = useRef<HTMLInputElement>(null);
  const openInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lafryhi-theme", theme);
  }, [theme]);
  useEffect(() => {
    imageInput.current?.setAttribute("webkitdirectory", "");
    narrationFolderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
        if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && (selectedRange || selectedClips.length)) {
        event.preventDefault();
        if (selectedRange) removeSelectedRange(selectedRange);
        else void removeSelectedTimelineClips(selectedClips);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [isDirty]);
  useEffect(() => {
    if (!playing) return;
    const base = playhead >= totalSeconds ? 0 : playhead;
    if (playhead >= totalSeconds) setPlayhead(0);
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = base + (now - started) / 1000;
      if (next >= totalSeconds) { setPlayhead(totalSeconds); setPlaying(false); return; }
      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, totalSeconds]);
  useEffect(() => {
    setSelectedClips((current) => {
      const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
      const valid = current.flatMap((selection): TimelineSelection[] => {
        if (selection.kind === "scene") return project.scenes.some((scene) => scene.sceneId === selection.sceneId) ? [selection] : [];
        if (selection.kind === "narration") {
          const scene = project.scenes.find((item) => item.sceneId === selection.sceneId);
          const assignment = project.narrationMapping.assignments.find((item) => item.sceneId === selection.sceneId);
          if (!scene || !assignment?.enabled || !assignment.audioPath) return [];
          return audioSegments(scene.durationSeconds, cuts.narration[selection.sceneId]).some((segment) => Math.abs(segment.start - selection.startSeconds) < .001)
            ? [selection]
            : [{ kind: "narration", sceneId: selection.sceneId, startSeconds: 0 }];
        }
        if (!(selection.kind === "voice" ? project.voiceFile : project.musicFile)) return [];
        return audioSegments(totalSeconds, cuts[selection.kind]).some((segment) => Math.abs(segment.start - selection.startSeconds) < .001)
          ? [selection]
          : [{ kind: selection.kind, startSeconds: 0 }];
      });
      const normalized = [...new Map(valid.map((selection) => [timelineSelectionKey(selection), selection])).values()];
      return normalized.length === current.length && normalized.every((selection, index) => timelineSelectionKey(selection) === timelineSelectionKey(current[index])) ? current : normalized;
    });
  }, [project.audioTimelineCuts, project.musicFile, project.narrationMapping.assignments, project.scenes, project.voiceFile, totalSeconds]);

  function selectScene(sceneId: string) {
    setSelectedId(sceneId);
    setSelectedClips([{ kind: "scene", sceneId }]);
    setSelectedRange(null);
  }

  function selectTimelineClip(selection: TimelineSelection, additive = false) {
    setSelectedClips((current) => {
      if (!additive) return [selection];
      const key = timelineSelectionKey(selection);
      return current.some((item) => timelineSelectionKey(item) === key)
        ? current.filter((item) => timelineSelectionKey(item) !== key)
        : [...current, selection];
    });
    setSelectedRange(null);
  }

  const run = useCallback(async <T,>(task: () => Promise<T>, title: string): Promise<T | null> => {
    setBusy(true);
    try { return await task(); }
    catch (reason) { void popups.alert({ tone: "error", eyebrow: "Something needs attention", title, message: messageOf(reason), detail: "Nothing in your current project was removed." }); return null; }
    finally { setBusy(false); }
  }, [popups]);

  function importImages(files: File[], append = false) {
    const valid = files.filter((file) => file.type.startsWith("image/") || /\.(bmp|gif|jpe?g|png|tiff?|webp)$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!valid.length) { void popups.alert({ tone: "warning", title: "These files cannot be added", message: "Choose PNG, JPG, WebP, GIF, BMP, or TIFF images.", detail: "Audio and unsupported files were ignored." }); return; }
    const scenes = valid.map(localScene);
    setProject((current) => ({ ...current, imagesFolder: "Browser-local media", scenes: append ? [...current.scenes, ...scenes] : scenes, ...(!append ? { audioTimelineCuts: { ...DEFAULT_AUDIO_TIMELINE_CUTS }, audioTimelineRemovedRanges: { ...DEFAULT_AUDIO_REMOVED_RANGES }, audioTimelineGaps: { ...DEFAULT_AUDIO_TIMELINE_GAPS } } : {}) }));
    if (scenes[0]) selectScene(scenes[0].sceneId); else { setSelectedId(null); setSelectedClips([]); }
    setTimeline(null); setPlaying(false); setPlayhead(0);
    popups.toast({ tone: "success", title: `${scenes.length} image${scenes.length === 1 ? "" : "s"} ready`, message: "Stored locally in this browser. Nothing was uploaded." });
  }

  function chooseAudio(field: "voiceFile" | "musicFile", file?: File) {
    if (!file) return;
    const kind = field === "voiceFile" ? "voice" : "music";
    setProject((current) => ({
      ...current,
      [field]: registerAsset(file, kind),
      ...(field === "voiceFile" ? { voiceTrimStartSeconds: 0, voiceTrimEndSeconds: null } : { musicTrimStartSeconds: 0, musicTrimEndSeconds: null }),
      audioTimelineCuts: { ...normalizeAudioTimelineCuts(current.audioTimelineCuts), [kind]: [] },
      audioTimelineRemovedRanges: { ...(current.audioTimelineRemovedRanges || DEFAULT_AUDIO_REMOVED_RANGES), [kind]: [] },
      audioTimelineGaps: { ...(current.audioTimelineGaps || DEFAULT_AUDIO_TIMELINE_GAPS), [kind]: [] },
    }));
    popups.toast({ tone: "success", title: field === "voiceFile" ? "Voice track added" : "Music added", message: `${file.name} remains local until export.` });
  }

  function chooseNarration(file?: File) {
    if (!selectedId || !file) return;
    const audioPath = registerAsset(file, "narration");
    setProject((current) => {
      const cuts = normalizeAudioTimelineCuts(current.audioTimelineCuts);
      const removed = current.audioTimelineRemovedRanges || DEFAULT_AUDIO_REMOVED_RANGES;
      const gaps = current.audioTimelineGaps || DEFAULT_AUDIO_TIMELINE_GAPS;
      return { ...updateAssignment(current, selectedId, { audioPath, enabled: true }), audioTimelineCuts: { ...cuts, narration: { ...cuts.narration, [selectedId]: [] } }, audioTimelineRemovedRanges: { ...removed, narration: { ...removed.narration, [selectedId]: [] } }, audioTimelineGaps: { ...gaps, narration: { ...gaps.narration, [selectedId]: [] } } };
    });
    popups.toast({ tone: "success", title: "Scene narration added", message: file.name });
  }

  function mapNarration(files: File[]) {
    const clips = files.filter((file) => file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!clips.length) { void popups.alert({ tone: "warning", title: "No audio clips found", message: "Choose a folder containing MP3, WAV, M4A, AAC, FLAC, or OGG files." }); return; }
    const assignments: NarrationAssignment[] = project.scenes.map((scene, index) => ({ sceneId: scene.sceneId, audioPath: clips[index] ? registerAsset(clips[index], "narration") : null, trimStartSeconds: 0, trimEndSeconds: null, leadingPaddingSeconds: 0, trailingPaddingSeconds: 0, enabled: Boolean(clips[index]) }));
    setProject((current) => ({ ...current, narrationMapping: { ...current.narrationMapping, assignments }, audioTimelineCuts: { ...normalizeAudioTimelineCuts(current.audioTimelineCuts), narration: {} }, audioTimelineRemovedRanges: { ...(current.audioTimelineRemovedRanges || DEFAULT_AUDIO_REMOVED_RANGES), narration: {} }, audioTimelineGaps: { ...(current.audioTimelineGaps || DEFAULT_AUDIO_TIMELINE_GAPS), narration: {} } }));
    popups.toast({ tone: "success", title: "Narration mapped", message: `${Math.min(clips.length, project.scenes.length)} clips matched by filename order.` });
  }

  async function loadDemo(orientation: "landscape" | "portrait" = "landscape") {
    const label = orientation === "portrait" ? "portrait 9:16" : "landscape 16:9";
    if (!(await guardUnsaved(`Load the ${label} demo?`, "Your current project will be replaced by the demo scenes and audio."))) return;
    const result = await run(() => api.demo(project.sessionId, orientation), "The demo could not be loaded");
    if (!result?.scenes) return;
    const next = { ...project, imagesFolder: String(result.imagesFolder || ""), scenes: result.scenes.map((scene) => ({ ...scene, crop: { ...DEFAULT_IMAGE_CROP } })), voiceFile: String(result.defaultNarration || ""), musicFile: String(result.defaultMusic || ""), voiceTrimStartSeconds: 0, voiceTrimEndSeconds: null, musicTrimStartSeconds: 0, musicTrimEndSeconds: null, audioTimelineCuts: { ...DEFAULT_AUDIO_TIMELINE_CUTS }, audioTimelineRemovedRanges: { ...DEFAULT_AUDIO_REMOVED_RANGES }, audioTimelineGaps: { ...DEFAULT_AUDIO_TIMELINE_GAPS }, outputName: String(result.outputName || project.outputName), videoFormat: String(result.videoFormat || (orientation === "portrait" ? "vertical_9_16" : "landscape_16_9")), resolution: String(result.resolution || (orientation === "portrait" ? "1080x1920" : "1920x1080")) };
    setProject(next);
    if (result.scenes[0]) selectScene(result.scenes[0].sceneId); else { setSelectedId(null); setSelectedClips([]); }
    setTimeline(null); setPlaying(false); setPlayhead(0);
    popups.toast({ tone: result.warnings?.length ? "warning" : "success", title: `${orientation === "portrait" ? "Portrait" : "Landscape"} demo loaded`, message: result.warnings?.join(" · ") || `${result.scenes.length} ${label} scenes are ready to preview.` });
  }

  function analyze() {
    if (!project.scenes.length) { void popups.alert({ tone: "warning", title: "Add images first", message: "The timeline needs at least one scene before it can be analyzed." }); return; }
    const resolved = buildLocalTimeline(project);
    setTimeline(resolved);
    popups.toast({ tone: "success", title: "Timeline ready", message: `${resolved.scenes.length} scenes · ${resolved.durationSeconds.toFixed(1)} seconds · processed locally.` });
  }

  function togglePreview() {
    if (!project.scenes.length) { void popups.alert({ tone: "warning", title: "Nothing to preview yet", message: "Drop or import images, then press Play again." }); return; }
    setTimeline(buildLocalTimeline(project)); setPlaying((value) => !value);
  }

  function setExportStage(stage: string, progress: number) {
    setExportPopup((current) => ({ ...current, stage, progress }));
  }

  async function materializeProject(signal: AbortSignal): Promise<Project> {
    const prepared = structuredClone(project);
    const localScenes = prepared.scenes.map((scene, index) => ({ scene, index, asset: getLocalAsset(scene.imagePath) })).filter((item) => item.asset);
    if (localScenes.length) {
      setExportStage(`Uploading ${localScenes.length} image${localScenes.length === 1 ? "" : "s"}`, .035);
      const uploaded = await api.uploadImages(project.sessionId, localScenes.map((item) => item.asset!.file), signal);
      localScenes.forEach((item, uploadIndex) => { prepared.scenes[item.index].imagePath = uploaded.scenes[uploadIndex].imagePath; });
      prepared.imagesFolder = uploaded.folder;
    }
    let uploadProgress = .055;
    for (const field of ["voiceFile", "musicFile"] as const) {
      const asset = getLocalAsset(prepared[field]);
      if (asset) {
        setExportStage(`Uploading ${field === "voiceFile" ? "voice track" : "background music"}`, uploadProgress);
        prepared[field] = (await api.uploadAudio(project.sessionId, field === "voiceFile" ? "voice" : "music", asset.file, signal)).path;
        uploadProgress += .025;
      }
    }
    const narrationAssets = prepared.narrationMapping.assignments.map((assignment) => ({ assignment, asset: getLocalAsset(assignment.audioPath) })).filter((item) => item.asset);
    for (let index = 0; index < narrationAssets.length; index++) {
      const item = narrationAssets[index];
      setExportStage(`Uploading narration ${index + 1} of ${narrationAssets.length}`, .1 + (index / Math.max(1, narrationAssets.length)) * .03);
      item.assignment.audioPath = (await api.uploadAudio(project.sessionId, "narration", item.asset!.file, signal)).path;
    }
    if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    return prepared;
  }

  async function exportVideo() {
    if (!project.scenes.length) { await popups.alert({ tone: "warning", title: "Add images before exporting", message: "Your video needs at least one scene." }); return; }
    setPlaying(false); setBusy(true); cancelRequested.current = false;
    const controller = new AbortController(); exportController.current = controller;
    setExportPopup({ open: true, status: "running", progress: .01, stage: "Preparing your project", logs: [] });
    try {
      const exportProject = await materializeProject(controller.signal);
      setExportStage("Starting the video engine", .14);
      const { jobId } = await api.render(exportProject, controller.signal);
      activeJob.current = jobId;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const job = await api.job(jobId, controller.signal);
        const progress = .14 + progressFraction(job.progress) * .86;
        const logs = job.events.filter((event) => event.type === "log" && event.message).map((event) => event.message!);
        setExportPopup((current) => ({ ...current, progress, stage: job.stage || "Rendering video", logs }));
        if (job.status === "complete") { setExportPopup((current) => ({ ...current, status: "success", progress: 1, stage: "Completed", output: job.outputPath || undefined })); break; }
        if (job.status === "cancelled") { setExportPopup((current) => ({ ...current, status: "cancelled", stage: "Export cancelled" })); break; }
        if (job.status === "error") throw new Error(job.error || "The video engine could not complete this export.");
      }
    } catch (reason) {
      const cancelled = cancelRequested.current || (reason instanceof DOMException && reason.name === "AbortError");
      setExportPopup((current) => cancelled ? { ...current, status: "cancelled", stage: "Export cancelled" } : { ...current, status: "error", stage: "Export failed", error: messageOf(reason) });
    } finally {
      setBusy(false); activeJob.current = null; exportController.current = null;
    }
  }

  async function cancelExport() {
    if (exportPopup.status !== "running") return;
    cancelRequested.current = true;
    setExportPopup((current) => ({ ...current, stage: "Cancelling safely…" }));
    exportController.current?.abort();
    if (activeJob.current) { try { await api.cancel(activeJob.current); } catch { /* A completed process no longer needs cancellation. */ } }
  }

  async function save(): Promise<boolean> {
    if (!project.scenes.length) {
      await popups.alert({ tone: "warning", title: "Add images before saving", message: "A complete LVF project needs at least one scene and its source image." });
      return false;
    }
    let name = projectName;
    if (name === "Untitled project") {
      const requested = await popups.prompt({ tone: "info", eyebrow: "Save project", title: "Give your project a name", message: "Choose a clear name so it is easy to find later.", label: "Project name", value: "My video", placeholder: "My video" });
      if (!requested) return false;
      name = requested; setProjectName(requested);
    }
    const fileName = safeProjectFilename(name);
    const controller = new AbortController(); packageController.current = controller;
    setBusy(true);
    setPackagePopup({ open: true, mode: "save", status: "running", progress: .01, stage: "Collecting project media", fileName });
    try {
      const blob = await createLvfPackage(project, { projectName: name, signal: controller.signal, onProgress: (progress, stage) => setPackagePopup((current) => ({ ...current, progress, stage })) });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = fileName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      setSavedSnapshot(JSON.stringify(project));
      setPackagePopup({ open: true, mode: "save", status: "success", progress: 1, stage: "Project package downloaded", fileName });
      popups.toast({ tone: "success", title: "Full project saved", message: `${fileName} includes all images, audio, text, and timeline settings.` });
      return true;
    } catch (reason) {
      const cancelled = reason instanceof DOMException && reason.name === "AbortError";
      setPackagePopup((current) => cancelled ? { ...current, status: "cancelled", stage: "Save cancelled" } : { ...current, status: "error", stage: "Save failed", error: messageOf(reason) });
      return false;
    } finally {
      setBusy(false); packageController.current = null;
    }
  }

  async function guardUnsaved(title: string, message: string): Promise<boolean> {
    if (!isDirty) return true;
    const choice = await popups.choose({ tone: "warning", eyebrow: "Unsaved changes", title, message, detail: "Saving first is recommended so your timeline settings are not lost.", cancelId: "cancel", actions: [{ id: "cancel", label: "Keep editing", variant: "secondary" }, { id: "discard", label: "Discard changes", variant: "danger" }, { id: "save", label: "Save first", variant: "primary", icon: "save" }] });
    if (choice === "save") return save();
    return choice === "discard";
  }

  async function requestOpen() {
    if (await guardUnsaved("Open another project?", "Opening a project will replace the editor's current contents.")) openInput.current?.click();
  }

  async function requestImages() {
    if (!project.scenes.length || await guardUnsaved("Replace the current scene collection?", "Importing a new image folder replaces the scenes currently on the timeline.")) imageInput.current?.click();
  }

  async function openProject(file?: File) {
    if (!file) return;
    packageFile.current = file;
    let openedAssetIds: string[] = [];
    let portable = false;
    try {
      portable = await isLvfPackage(file);
      let loaded: Project;
      let restoredCount = 0;
      let openedName = file.name.replace(/\.(lvf|lafryhi|json)$/i, "");
      if (portable) {
        const controller = new AbortController(); packageController.current = controller;
        setBusy(true);
        setPackagePopup({ open: true, mode: "open", status: "running", progress: .01, stage: "Reading LVF package", fileName: file.name });
        const existingAssetIds = localAssetIds();
        const opened = await openLvfPackage(file, { signal: controller.signal, onProgress: (progress, stage) => setPackagePopup((current) => ({ ...current, progress, stage })) });
        openedAssetIds = opened.assetIds;
        const normalized = normalizeProject(opened.project, capabilities.defaults);
        loaded = { ...normalized, sessionId: capabilities.defaults.sessionId, baseDir: capabilities.defaults.baseDir, outputFolder: capabilities.defaults.outputFolder, imagesFolder: "Portable LVF project" };
        restoredCount = opened.assetCount;
        releaseLocalAssetIds(existingAssetIds);
        openedName = opened.projectName || openedName;
        setPackagePopup({ open: true, mode: "open", status: "success", progress: 1, stage: "Project restored", fileName: file.name });
      } else {
        const candidate = JSON.parse(await file.text()) as Partial<Project>;
        loaded = normalizeProject(candidate, capabilities.defaults);
        if (loaded.scenes.some((scene) => scene.imagePath.startsWith("local:"))) throw new Error("This legacy project references temporary browser media. Open a complete .lvf package or re-add its images and audio files.");
      }
      reset(loaded); setSavedSnapshot(JSON.stringify(loaded)); setProjectName(openedName);
      if (loaded.scenes[0]) selectScene(loaded.scenes[0].sceneId); else { setSelectedId(null); setSelectedClips([]); setSelectedRange(null); }
      setTimeline(null); setPlaying(false); setPlayhead(0);
      popups.toast({ tone: "success", title: "Project opened", message: `${loaded.scenes.length} scenes${restoredCount ? ` and ${restoredCount} media files` : ""} restored from ${file.name}.` });
    } catch (reason) {
      releaseLocalAssetIds(openedAssetIds);
      const cancelled = reason instanceof DOMException && reason.name === "AbortError";
      if (portable) setPackagePopup((current) => cancelled ? { ...current, status: "cancelled", stage: "Open cancelled" } : { ...current, status: "error", stage: "Open failed", error: messageOf(reason) });
      else await popups.alert({ tone: "error", eyebrow: "Open project", title: "This project could not be opened", message: messageOf(reason), detail: "The project currently in the editor was left unchanged." });
    } finally {
      setBusy(false); packageController.current = null;
    }
  }

  async function createNew() {
    if (!(await guardUnsaved("Start a new project?", "The current timeline, text, audio, and settings will be cleared."))) return;
    releaseLocalAssets();
    const fresh = structuredClone(capabilities.defaults);
    reset(fresh); setSavedSnapshot(JSON.stringify(fresh)); setProjectName("Untitled project"); setSelectedId(null); setSelectedClips([]); setSelectedRange(null); setTimeline(null); setPlaying(false); setPlayhead(0);
    popups.toast({ tone: "success", title: "New project ready", message: "A clean browser-local workspace has been created." });
  }

  async function requestRemoveScene(sceneId: string) {
    const index = project.scenes.findIndex((item) => item.sceneId === sceneId);
    if (index < 0) return;
    const confirmed = await popups.confirm({ tone: "warning", eyebrow: "Remove scene", title: "Remove this scene?", message: "The image, timing, text overlays, and narration assignment will be removed from the timeline.", detail: "You can also use Undo immediately afterward.", confirmLabel: "Remove scene", cancelLabel: "Keep scene" });
    if (!confirmed) return;
    const nextProject = removeSceneFromProject(project, sceneId);
    const scenes = nextProject.scenes;
    setProject(nextProject);
    const nextId = scenes[Math.min(index, scenes.length - 1)]?.sceneId || null;
    if (nextId) selectScene(nextId); else { setSelectedId(null); setSelectedClips([]); }
    setTimeline(null); setPlaying(false); setPlayhead((current) => Math.min(current, totalDuration(nextProject)));
    popups.toast({ tone: "success", title: "Scene removed", message: "Use Undo if you removed it by mistake." });
  }

  async function removeSelectedTimelineClips(selections: TimelineSelection[]) {
    const unique = [...new Map(selections.map((selection) => [timelineSelectionKey(selection), selection])).values()];
    if (!unique.length) return;
    const sceneIds = unique.flatMap((selection) => selection.kind === "scene" ? [selection.sceneId] : []);
    if (sceneIds.length) {
      const singleScene = unique.length === 1 && sceneIds.length === 1;
      const confirmed = await popups.confirm({
        tone: "warning",
        eyebrow: "Remove selected clips",
        title: singleScene ? "Remove this scene?" : `Remove ${unique.length} selected clips?`,
        message: singleScene
          ? "The image, timing, text overlays, and narration assignment will be removed from the timeline."
          : `${sceneIds.length} visual scene${sceneIds.length === 1 ? "" : "s"} and ${unique.length - sceneIds.length} audio segment${unique.length - sceneIds.length === 1 ? "" : "s"} will be removed together.`,
        detail: "One Undo restores the complete selection.",
        confirmLabel: singleScene ? "Remove scene" : `Remove ${unique.length} clips`,
        cancelLabel: singleScene ? "Keep scene" : "Keep clips",
      });
      if (!confirmed) return;
    }
    const next = removeTimelineSelections(project, unique, timeline);
    if (!next) return;
    const removedAudio = unique.length - sceneIds.length;
    setProject(next);
    setSelectedRange(null); setTimeline(null); setPlaying(false);
    setPlayhead((current) => Math.min(current, totalDuration(next)));
    if (sceneIds.length) {
      const firstIndex = Math.min(...sceneIds.map((sceneId) => project.scenes.findIndex((scene) => scene.sceneId === sceneId)).filter((index) => index >= 0));
      const fallback = next.scenes[Math.min(firstIndex, Math.max(0, next.scenes.length - 1))];
      if (fallback) selectScene(fallback.sceneId); else { setSelectedId(null); setSelectedClips([]); }
    } else setSelectedClips([]);
    const removedCount = removedAudio + sceneIds.length;
    popups.toast({ tone: "success", title: `${removedCount} clip${removedCount === 1 ? "" : "s"} removed`, message: "Use Undo once to restore the complete selection." });
  }

  const patchSelected = (patch: Partial<Scene>) => {
    if (!selectedId) return;
    setProject((current) => ({ ...current, scenes: patchScene(current.scenes, selectedId, patch) }));
    setTimeline(null);
  };
  const patchProject = (patch: Partial<Project>) => { setProject((current) => ({ ...current, ...patch })); setTimeline(null); };
  const patchTiming = (patch: Partial<Project["audioTiming"]>) => { setProject((current) => ({ ...current, audioTiming: { ...current.audioTiming, ...patch } })); setTimeline(null); };
  const patchNarration = (patch: Record<string, unknown>) => { if (selectedId) setProject((current) => updateAssignment(current, selectedId, patch)); setTimeline(null); };
  const addText = () => patchSelected({ texts: [...(selected?.texts || []), { id: crypto.randomUUID(), text: "Your title", fontFamily: "Outfit", fontSize: 64, color: "#ffffff", x: 50, y: 78, startSeconds: 0, endSeconds: null }] });
  const patchText = (id: string, patch: Partial<TextOverlay>) => selected && patchSelected({ texts: (selected.texts || []).map((text) => text.id === id ? { ...text, ...patch } : text) });
  const removeText = (id: string) => selected && patchSelected({ texts: (selected.texts || []).filter((text) => text.id !== id) });
  const reorder = (from: string, to: string) => { setProject((current) => ({ ...current, scenes: reorderScenes(current.scenes, from, to) })); setTimeline(null); };
  const split = (id: string, at: number) => {
    setTimeline(null);
    setProject((current) => {
      const scenes = splitScene(current.scenes, id, at);
      const index = scenes.findIndex((scene) => scene.sceneId === id);
      const nextId = scenes[index + 1]?.sceneId || id;
      setSelectedId(nextId); setSelectedClips([{ kind: "scene", sceneId: nextId }]);
      return { ...current, scenes, audioTiming: { ...current.audioTiming, mode: "manual" } };
    });
  };

  const cutAudio = (selection: TimelineSelection, at: number) => {
    const result = cutSelectedTimelineClip(project, selection, at, timeline);
    if (!result) {
      popups.toast({ tone: "warning", title: "This clip cannot be cut here", message: "Move the playhead inside the selected audio segment, away from either edge." });
      return;
    }
    setProject(result.project); setSelectedClips([result.selection]); setTimeline(null); setPlaying(false);
    popups.toast({ tone: "success", title: "Audio clip cut", message: `Created a new ${selection.kind} segment at ${at.toFixed(2)} seconds. Use Undo to join it again.` });
  };

  const moveAudio = (selection: TimelineSelection, deltaSeconds: number) => {
    const next = moveAudioTimelineClip(project, selection, deltaSeconds, timeline);
    if (!next) return;
    setProject(next); setTimeline(null); setPlaying(false);
    popups.toast({ tone: "success", title: "Audio clip moved", message: "The empty space before it will play as silence. Use Undo to restore its position." });
  };

  const removeSelectedRange = (selection: TimelineRangeSelection) => {
    const next = removeTimelineRange(project, selection, timeline);
    if (!next) {
      popups.toast({ tone: "warning", title: "This range cannot be removed", message: "Select at least 0.05 seconds inside a clip that contains media." });
      return;
    }
    setProject(next); setSelectedRange(null); setTimeline(null); setPlaying(false); setPlayhead(Math.min(selection.startSeconds, totalDuration(next)));
    if (selection.kind === "scene" && !next.scenes.some((scene) => scene.sceneId === selection.sceneId)) {
      const fallback = next.scenes[0];
      if (fallback) selectScene(fallback.sceneId); else { setSelectedId(null); setSelectedClips([]); }
    }
    popups.toast({ tone: "success", title: "Timeline range removed", message: `${Math.abs(selection.endSeconds - selection.startSeconds).toFixed(2)} seconds removed from ${selection.kind}. Use Undo to restore it.` });
  };

  return <div className="app-shell">
    <div className="hidden-inputs" aria-hidden="true">
      <input data-testid="image-upload" ref={imageInput} type="file" accept={imageAccept} multiple onChange={(event) => { importImages([...event.target.files || []]); event.target.value = ""; }}/>
      <input data-testid="voice-upload" ref={voiceInput} type="file" accept={audioAccept} onChange={(event) => { chooseAudio("voiceFile", event.target.files?.[0]); event.target.value = ""; }}/>
      <input data-testid="music-upload" ref={musicInput} type="file" accept={audioAccept} onChange={(event) => { chooseAudio("musicFile", event.target.files?.[0]); event.target.value = ""; }}/>
      <input data-testid="narration-upload" ref={narrationFolderInput} type="file" accept={audioAccept} multiple onChange={(event) => { mapNarration([...event.target.files || []]); event.target.value = ""; }}/>
      <input data-testid="scene-narration-upload" ref={sceneNarrationInput} type="file" accept={audioAccept} onChange={(event) => { chooseNarration(event.target.files?.[0]); event.target.value = ""; }}/>
      <input data-testid="project-upload" ref={openInput} type="file" accept=".lvf,.lafryhi,.json,application/zip,application/json" onChange={(event) => { void openProject(event.target.files?.[0]); event.target.value = ""; }}/>
    </div>
    <Toolbar projectName={projectName} dirty={isDirty} busy={busy} playing={playing} theme={theme} canUndo={canUndo} canRedo={canRedo} onNew={() => void createNew()} onOpen={() => void requestOpen()} onSave={() => void save()} onUndo={undo} onRedo={redo} onAnalyze={analyze} onPreview={togglePreview} onExport={() => void exportVideo()} onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}/>
    <div className="workspace">
      <MediaLibrary project={project} selectedId={selectedId} onSelect={selectScene} onImportImages={() => void requestImages()} onVoice={() => voiceInput.current?.click()} onMusic={() => musicInput.current?.click()} onNarrationFolder={() => narrationFolderInput.current?.click()} onDemo={(orientation) => void loadDemo(orientation)} onReorder={reorder} onDropImages={(files) => importImages(files, true)} onDropAudio={chooseAudio}/>
      <PreviewPanel project={project} scene={previewScene} sceneProgress={previewProgress} timeline={timeline} playhead={playhead} playing={playing} onPlayhead={(value) => { setPlaying(false); setPlayhead(value); }} onToggle={togglePreview}/>
      <Inspector project={project} scene={selected} capabilities={capabilities} onScene={patchSelected} onProject={patchProject} onTiming={patchTiming} onNarration={patchNarration} onChooseNarration={() => sceneNarrationInput.current?.click()} onChooseOutput={() => popups.toast({ tone: "info", title: "Export destination", message: "Media uploads only when Export is pressed and stays inside this project's private server workspace." })} onDuplicate={() => { if (!selectedId) return; const scenes = duplicateScene(project.scenes, selectedId); setProject({ ...project, scenes }); selectScene(scenes[scenes.findIndex((item) => item.sceneId === selectedId) + 1]?.sceneId || selectedId); setTimeline(null); }} onRemove={() => selectedId && void requestRemoveScene(selectedId)} onAddText={addText} onText={patchText} onRemoveText={removeText}/>
    </div>
    <TimelineEditor project={project} timeline={timeline} selectedId={selectedId} selectedClips={selectedClips} selectedRange={selectedRange} playhead={playhead} onSelect={setSelectedId} onSelectClip={selectTimelineClip} onSelectRange={setSelectedRange} onPlayhead={(value) => { setPlaying(false); setPlayhead(value); }} onReorder={reorder} onResize={(id, seconds) => { setProject((current) => ({ ...current, scenes: setSceneDuration(current.scenes, id, seconds), audioTiming: { ...current.audioTiming, mode: "manual" } })); setTimeline(null); }} onSplit={split} onCut={cutAudio} onMoveAudio={moveAudio} onRemoveRange={removeSelectedRange} onRemoveSelected={() => void removeSelectedTimelineClips(selectedClips)} onRemove={(id) => void requestRemoveScene(id)}/>
    <ExportProgressPopup state={exportPopup} desktop={isDesktopRuntime} onCancel={() => void cancelExport()} onClose={() => setExportPopup((current) => ({ ...current, open: false, showVideo: false }))} onShowVideo={() => setExportPopup((current) => ({ ...current, showVideo: !current.showVideo }))} onOpenVideo={() => { if (!exportPopup.output) return; void openDesktopVideo(exportPopup.output).catch((reason) => popups.alert({ tone: "error", title: "The video could not be opened", message: messageOf(reason), detail: "The exported file remains available in the local project workspace." })); }} onRetry={() => void exportVideo()}/>
    <PackageProgressPopup state={packagePopup} onCancel={() => packageController.current?.abort()} onClose={() => setPackagePopup((current) => ({ ...current, open: false }))} onRetry={() => packagePopup.mode === "save" ? void save() : packageFile.current ? void openProject(packageFile.current) : undefined}/>
  </div>;
}

export default function App() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  useEffect(() => { api.capabilities().then(setCapabilities).catch((reason) => setStartupError(String(reason))); }, []);
  if (startupError) return <div className="startup"><div className="startup-logo">VF</div><h1>Could not connect to the video engine</h1><p>{startupError}</p><p>Start the FastAPI service, then reload this page.</p></div>;
  if (!capabilities) return <div className="startup"><div className="startup-logo">VF</div><h1>Starting Video Factory…</h1><p>Preparing your private browser-local editing workspace.</p></div>;
  return <Editor capabilities={capabilities}/>;
}
