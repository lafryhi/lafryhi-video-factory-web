import type { AudioTimelineCuts, AudioTimelineGap, AudioTimelineGaps, AudioTimelineRemovedRanges, ImageCrop, Project, Scene, Timeline, TimelineRangeSelection, TimelineSelection, TimelineTimeRange } from "./types";
import { sliceVideoScene } from "./aiEditor";

export const DEFAULT_IMAGE_CROP: ImageCrop = { enabled: false, x: 50, y: 50, zoom: 1 };
export const DEFAULT_AUDIO_TIMELINE_CUTS: AudioTimelineCuts = { voice: [], music: [], narration: {} };
export const DEFAULT_AUDIO_REMOVED_RANGES: AudioTimelineRemovedRanges = { voice: [], music: [], narration: {} };
export const DEFAULT_AUDIO_TIMELINE_GAPS: AudioTimelineGaps = { voice: [], music: [], narration: {} };
export const MIN_AUDIO_SEGMENT_SECONDS = .05;

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

export function normalizeAudioTrim(start: unknown, end: unknown, duration = Number.POSITIVE_INFINITY): { start: number; end: number | null } {
  const maximum = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const safeStart = clamp(Number(start), 0, maximum === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : Math.max(0, maximum - .05));
  if (end === null || end === undefined || end === "") return { start: safeStart, end: null };
  const numericEnd = Number(end);
  if (!Number.isFinite(numericEnd)) return { start: safeStart, end: null };
  return { start: safeStart, end: clamp(numericEnd, safeStart + .05, maximum) };
}

export function normalizeImageCrop(value?: Partial<ImageCrop> | null): ImageCrop {
  return {
    enabled: Boolean(value?.enabled),
    x: clamp(Number(value?.x ?? 50), 0, 100),
    y: clamp(Number(value?.y ?? 50), 0, 100),
    zoom: clamp(Number(value?.zoom ?? 1), 1, 5),
  };
}

export function normalizeCutPoints(points: unknown, duration = Number.POSITIVE_INFINITY): number[] {
  if (!Array.isArray(points)) return [];
  const maximum = Number.isFinite(duration) ? Math.max(0, duration) : Number.POSITIVE_INFINITY;
  const unique = new Set<number>();
  for (const raw of points) {
    const point = Math.round(Number(raw) * 1000) / 1000;
    if (Number.isFinite(point) && point >= MIN_AUDIO_SEGMENT_SECONDS && point <= maximum - MIN_AUDIO_SEGMENT_SECONDS) unique.add(point);
  }
  return [...unique].sort((a, b) => a - b);
}

export function normalizeAudioTimelineCuts(value?: Partial<AudioTimelineCuts> | null): AudioTimelineCuts {
  const narration: Record<string, number[]> = {};
  if (value?.narration && typeof value.narration === "object") {
    for (const [sceneId, points] of Object.entries(value.narration)) {
      const normalized = normalizeCutPoints(points);
      if (normalized.length) narration[sceneId] = normalized;
    }
  }
  return { voice: normalizeCutPoints(value?.voice), music: normalizeCutPoints(value?.music), narration };
}

export function normalizeTimeRanges(value: unknown, duration = Number.POSITIVE_INFINITY): TimelineTimeRange[] {
  if (!Array.isArray(value)) return [];
  const maximum = Number.isFinite(duration) ? Math.max(0, duration) : Number.POSITIVE_INFINITY;
  const ranges = value.flatMap((item): TimelineTimeRange[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Partial<TimelineTimeRange>;
    const start = Math.max(0, Math.round(Number(raw.startSeconds) * 1000) / 1000);
    const end = Math.min(maximum, Math.round(Number(raw.endSeconds) * 1000) / 1000);
    return Number.isFinite(start) && Number.isFinite(end) && end - start >= MIN_AUDIO_SEGMENT_SECONDS ? [{ startSeconds: start, endSeconds: end }] : [];
  }).sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const merged: TimelineTimeRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startSeconds <= previous.endSeconds + .001) previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds);
    else merged.push({ ...range });
  }
  return merged;
}

export function normalizeAudioRemovedRanges(value?: Partial<AudioTimelineRemovedRanges> | null): AudioTimelineRemovedRanges {
  const narration: Record<string, TimelineTimeRange[]> = {};
  if (value?.narration && typeof value.narration === "object") {
    for (const [sceneId, ranges] of Object.entries(value.narration)) {
      const normalized = normalizeTimeRanges(ranges);
      if (normalized.length) narration[sceneId] = normalized;
    }
  }
  return { voice: normalizeTimeRanges(value?.voice), music: normalizeTimeRanges(value?.music), narration };
}

export function normalizeTimelineGaps(value: unknown): AudioTimelineGap[] {
  if (!Array.isArray(value)) return [];
  const byPoint = new Map<number, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<AudioTimelineGap>;
    const atSeconds = Math.max(0, Math.round(Number(raw.atSeconds) * 1000) / 1000);
    const durationSeconds = Math.max(0, Math.round(Number(raw.durationSeconds) * 1000) / 1000);
    if (Number.isFinite(atSeconds) && Number.isFinite(durationSeconds) && durationSeconds >= MIN_AUDIO_SEGMENT_SECONDS) {
      byPoint.set(atSeconds, (byPoint.get(atSeconds) || 0) + durationSeconds);
    }
  }
  return [...byPoint].map(([atSeconds, durationSeconds]) => ({ atSeconds, durationSeconds: Math.round(durationSeconds * 1000) / 1000 })).sort((a, b) => a.atSeconds - b.atSeconds);
}

export function normalizeAudioTimelineGaps(value?: Partial<AudioTimelineGaps> | null): AudioTimelineGaps {
  const narration: Record<string, AudioTimelineGap[]> = {};
  if (value?.narration && typeof value.narration === "object") {
    for (const [sceneId, gaps] of Object.entries(value.narration)) {
      const normalized = normalizeTimelineGaps(gaps);
      if (normalized.length) narration[sceneId] = normalized;
    }
  }
  return { voice: normalizeTimelineGaps(value?.voice), music: normalizeTimelineGaps(value?.music), narration };
}

export function isRangeRemoved(ranges: unknown, start: number, end: number): boolean {
  return normalizeTimeRanges(ranges).some((range) => start >= range.startSeconds - .001 && end <= range.endSeconds + .001);
}

export type AudioSegment = { start: number; end: number };
export type AudioLayoutSegment = AudioSegment & { timelineStart: number; timelineEnd: number };

export function audioSegments(duration: number, points: unknown): AudioSegment[] {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  if (!safeDuration) return [];
  const boundaries = [0, ...normalizeCutPoints(points, safeDuration), safeDuration];
  return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1] }));
}

function durationBefore(ranges: TimelineTimeRange[], point: number): number {
  return ranges.reduce((sum, range) => sum + Math.max(0, Math.min(point, range.endSeconds) - Math.min(point, range.startSeconds)), 0);
}

export function audioTrackLayout(duration: number, points: unknown, removed: unknown, gaps: unknown): AudioLayoutSegment[] {
  const removedRanges = normalizeTimeRanges(removed, duration);
  const normalizedGaps = normalizeTimelineGaps(gaps);
  return audioSegments(duration, points)
    .filter((segment) => !isRangeRemoved(removedRanges, segment.start, segment.end))
    .map((segment) => {
      const deleted = durationBefore(removedRanges, segment.start);
      const inserted = normalizedGaps.filter((gap) => gap.atSeconds <= segment.start + .001).reduce((sum, gap) => sum + gap.durationSeconds, 0);
      const timelineStart = segment.start - deleted + inserted;
      return { ...segment, timelineStart, timelineEnd: timelineStart + segment.end - segment.start };
    });
}

export function audioSourceAtTimeline(duration: number, points: unknown, removed: unknown, gaps: unknown, timelineSeconds: number): number | null {
  const segment = audioTrackLayout(duration, points, removed, gaps).find((item) => timelineSeconds >= item.timelineStart - .001 && timelineSeconds < item.timelineEnd - .001);
  return segment ? segment.start + Math.max(0, timelineSeconds - segment.timelineStart) : null;
}

export function timelineSelectionRange(project: Project, selection: TimelineSelection, timeline?: Timeline | null): TimelineRangeSelection | null {
  if (selection.kind === "scene") {
    const start = sceneStart(project, selection.sceneId, timeline);
    const scene = project.scenes.find((item) => item.sceneId === selection.sceneId);
    return start === null || !scene ? null : { kind: "scene", sceneId: selection.sceneId, startSeconds: start, endSeconds: start + sceneDuration(scene, timeline) };
  }
  const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
  const removed = normalizeAudioRemovedRanges(project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(project.audioTimelineGaps);
  if (selection.kind === "narration") {
    const start = sceneStart(project, selection.sceneId, timeline);
    const scene = project.scenes.find((item) => item.sceneId === selection.sceneId);
    if (start === null || !scene) return null;
    const segment = audioTrackLayout(sceneDuration(scene, timeline), cuts.narration[selection.sceneId], removed.narration[selection.sceneId], gaps.narration[selection.sceneId]).find((item) => Math.abs(item.start - selection.startSeconds) < .001);
    return segment ? { kind: "narration", sceneId: selection.sceneId, startSeconds: start + segment.timelineStart, endSeconds: start + segment.timelineEnd } : null;
  }
  const segment = audioTrackLayout(totalDuration(project, timeline), cuts[selection.kind], removed[selection.kind], gaps[selection.kind]).find((item) => Math.abs(item.start - selection.startSeconds) < .001);
  return segment ? { kind: selection.kind, startSeconds: segment.timelineStart, endSeconds: segment.timelineEnd } : null;
}

export function timelineSelectionKey(selection: TimelineSelection): string {
  if (selection.kind === "scene") return `scene:${selection.sceneId}`;
  if (selection.kind === "narration") return `narration:${selection.sceneId}:${selection.startSeconds.toFixed(3)}`;
  return `${selection.kind}:${selection.startSeconds.toFixed(3)}`;
}

export function removeTimelineSelections(project: Project, selections: TimelineSelection[], timeline?: Timeline | null): Project | null {
  const unique = [...new Map(selections.map((selection) => [timelineSelectionKey(selection), selection])).values()];
  let next = project;
  let changed = false;
  for (const selection of unique) {
    if (selection.kind === "scene") continue;
    const candidate = removeAudioSelection(next, selection, timeline);
    if (candidate) { next = candidate; changed = true; }
  }
  for (const selection of unique) {
    if (selection.kind !== "scene" || !next.scenes.some((scene) => scene.sceneId === selection.sceneId)) continue;
    next = removeScene(next, selection.sceneId);
    changed = true;
  }
  return changed ? next : null;
}

function removeAudioSelection(project: Project, selection: Exclude<TimelineSelection, { kind: "scene" }>, timeline?: Timeline | null): Project | null {
  const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
  const removed = normalizeAudioRemovedRanges(project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(project.audioTimelineGaps);
  const narrationScene = selection.kind === "narration" ? project.scenes.find((scene) => scene.sceneId === selection.sceneId) : null;
  if (selection.kind === "narration" && !narrationScene) return null;
  const duration = narrationScene ? sceneDuration(narrationScene, timeline) : totalDuration(project, timeline);
  if (!Number.isFinite(duration)) return null;
  const points = selection.kind === "narration" ? cuts.narration[selection.sceneId] : cuts[selection.kind];
  const ranges = selection.kind === "narration" ? removed.narration[selection.sceneId] : removed[selection.kind];
  const trackGaps = selection.kind === "narration" ? gaps.narration[selection.sceneId] : gaps[selection.kind];
  const segment = audioTrackLayout(duration, points, ranges, trackGaps).find((item) => Math.abs(item.start - selection.startSeconds) < .001);
  if (!segment) return null;
  const nextRanges = normalizeTimeRanges([...(ranges || []), { startSeconds: segment.start, endSeconds: segment.end }], duration);
  const nextGaps = normalizeTimelineGaps(trackGaps).filter((gap) => Math.abs(gap.atSeconds - segment.start) > .001);
  if (selection.kind === "narration") {
    return {
      ...project,
      audioTimelineRemovedRanges: { ...removed, narration: { ...removed.narration, [selection.sceneId]: nextRanges } },
      audioTimelineGaps: { ...gaps, narration: { ...gaps.narration, [selection.sceneId]: nextGaps } },
    };
  }
  return { ...project, audioTimelineRemovedRanges: { ...removed, [selection.kind]: nextRanges }, audioTimelineGaps: { ...gaps, [selection.kind]: nextGaps } };
}

export function moveAudioTimelineClip(project: Project, selection: TimelineSelection, deltaSeconds: number, timeline?: Timeline | null): Project | null {
  if (selection.kind === "scene" || !Number.isFinite(deltaSeconds) || Math.abs(deltaSeconds) < .01) return null;
  const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
  const removed = normalizeAudioRemovedRanges(project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(project.audioTimelineGaps);
  const scene = selection.kind === "narration" ? project.scenes.find((item) => item.sceneId === selection.sceneId) : null;
  if (selection.kind === "narration" && !scene) return null;
  const duration = scene ? sceneDuration(scene, timeline) : totalDuration(project, timeline);
  const points = selection.kind === "narration" ? cuts.narration[selection.sceneId] : cuts[selection.kind];
  const ranges = selection.kind === "narration" ? removed.narration[selection.sceneId] : removed[selection.kind];
  const trackGaps = normalizeTimelineGaps(selection.kind === "narration" ? gaps.narration[selection.sceneId] : gaps[selection.kind]);
  const layout = audioTrackLayout(duration, points, ranges, trackGaps);
  const segment = layout.find((item) => Math.abs(item.start - selection.startSeconds) < .001);
  if (!segment) return null;
  const current = trackGaps.find((gap) => Math.abs(gap.atSeconds - segment.start) < .001)?.durationSeconds || 0;
  const lastEnd = layout.at(-1)?.timelineEnd || 0;
  const maximum = current + Math.max(0, duration - lastEnd);
  const nextDuration = clamp(Math.round((current + deltaSeconds) * 1000) / 1000, 0, maximum);
  if (Math.abs(nextDuration - current) < .01) return null;
  const nextTrackGaps = normalizeTimelineGaps([
    ...trackGaps.filter((gap) => Math.abs(gap.atSeconds - segment.start) > .001),
    { atSeconds: segment.start, durationSeconds: nextDuration },
  ]);
  if (selection.kind === "narration") return { ...project, audioTimelineGaps: { ...gaps, narration: { ...gaps.narration, [selection.sceneId]: nextTrackGaps } } };
  return { ...project, audioTimelineGaps: { ...gaps, [selection.kind]: nextTrackGaps } };
}

function sceneStart(project: Project, sceneId: string, timeline?: Timeline | null): number | null {
  let cursor = 0;
  for (const scene of project.scenes) {
    if (scene.sceneId === sceneId) return cursor;
    cursor += sceneDuration(scene, timeline);
  }
  return null;
}

export function cutSelectedTimelineClip(project: Project, selection: TimelineSelection, playhead: number, timeline?: Timeline | null): { project: Project; selection: TimelineSelection } | null {
  if (selection.kind === "scene") return null;
  const narrationScene = selection.kind === "narration" ? project.scenes.find((scene) => scene.sceneId === selection.sceneId) : null;
  if (selection.kind === "narration" && !narrationScene) return null;
  const duration = narrationScene ? sceneDuration(narrationScene, timeline) : totalDuration(project, timeline);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (selection.kind === "voice" && !project.voiceFile) return null;
  if (selection.kind === "music" && !project.musicFile) return null;
  if (selection.kind === "narration") {
    const assignment = assignmentFor(project, selection.sceneId);
    if (!assignment?.enabled || !assignment.audioPath) return null;
  }
  const start = selection.kind === "narration" ? sceneStart(project, selection.sceneId, timeline) : 0;
  if (start === null) return null;
  const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
  const removed = normalizeAudioRemovedRanges(project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(project.audioTimelineGaps);
  const current = selection.kind === "narration" ? cuts.narration[selection.sceneId] || [] : cuts[selection.kind];
  const currentRemoved = selection.kind === "narration" ? removed.narration[selection.sceneId] : removed[selection.kind];
  const currentGaps = selection.kind === "narration" ? gaps.narration[selection.sceneId] : gaps[selection.kind];
  const segment = audioTrackLayout(duration, current, currentRemoved, currentGaps).find((item) => Math.abs(item.start - selection.startSeconds) < .001);
  if (!segment) return null;
  const localPlayhead = playhead - start;
  const cut = Math.round((segment.start + localPlayhead - segment.timelineStart) * 1000) / 1000;
  if (!segment || cut < segment.start + MIN_AUDIO_SEGMENT_SECONDS || cut > segment.end - MIN_AUDIO_SEGMENT_SECONDS) return null;
  const nextPoints = normalizeCutPoints([...current, cut], duration);
  const nextCuts: AudioTimelineCuts = selection.kind === "narration"
    ? { ...cuts, narration: { ...cuts.narration, [selection.sceneId]: nextPoints } }
    : { ...cuts, [selection.kind]: nextPoints };
  return { project: { ...project, audioTimelineCuts: nextCuts }, selection: { ...selection, startSeconds: cut } };
}

function shiftPointsAfterRemoval(points: number[], start: number, end: number, duration: number): number[] {
  const removed = end - start;
  return normalizeCutPoints(points.map((point) => point <= start ? point : point >= end ? point - removed : Number.NaN), duration - removed);
}

function shiftRangesAfterRemoval(ranges: TimelineTimeRange[], start: number, end: number, duration: number): TimelineTimeRange[] {
  const removed = end - start;
  return normalizeTimeRanges(ranges.flatMap((range): TimelineTimeRange[] => {
    if (range.endSeconds <= start) return [range];
    if (range.startSeconds >= end) return [{ startSeconds: range.startSeconds - removed, endSeconds: range.endSeconds - removed }];
    const pieces: TimelineTimeRange[] = [];
    if (range.startSeconds < start) pieces.push({ startSeconds: range.startSeconds, endSeconds: start });
    if (range.endSeconds > end) pieces.push({ startSeconds: start, endSeconds: range.endSeconds - removed });
    return pieces;
  }), duration - removed);
}

export function removeTimelineRange(project: Project, selection: TimelineRangeSelection, timeline?: Timeline | null): Project | null {
  const start = Math.min(selection.startSeconds, selection.endSeconds);
  const end = Math.max(selection.startSeconds, selection.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < MIN_AUDIO_SEGMENT_SECONDS) return null;
  const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
  const removedRanges = normalizeAudioRemovedRanges(project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(project.audioTimelineGaps);
  if (selection.kind === "voice" || selection.kind === "music") {
    if (!(selection.kind === "voice" ? project.voiceFile : project.musicFile)) return null;
    const total = totalDuration(project, timeline);
    const layout = audioTrackLayout(total, cuts[selection.kind], removedRanges[selection.kind], gaps[selection.kind]);
    const pieces = layout.flatMap((segment): TimelineTimeRange[] => {
      const displayStart = Math.max(start, segment.timelineStart);
      const displayEnd = Math.min(end, segment.timelineEnd);
      return displayEnd - displayStart >= MIN_AUDIO_SEGMENT_SECONDS ? [{ startSeconds: segment.start + displayStart - segment.timelineStart, endSeconds: segment.start + displayEnd - segment.timelineStart }] : [];
    });
    if (!pieces.length) return null;
    const boundaries = pieces.flatMap((piece) => [piece.startSeconds, piece.endSeconds]);
    return {
      ...project,
      audioTimelineCuts: { ...cuts, [selection.kind]: normalizeCutPoints([...cuts[selection.kind], ...boundaries], total) },
      audioTimelineRemovedRanges: { ...removedRanges, [selection.kind]: normalizeTimeRanges([...removedRanges[selection.kind], ...pieces], total) },
      audioTimelineGaps: { ...gaps, [selection.kind]: gaps[selection.kind].filter((gap) => !pieces.some((piece) => gap.atSeconds >= piece.startSeconds - .001 && gap.atSeconds < piece.endSeconds - .001)) },
    };
  }
  if (selection.kind !== "scene" && selection.kind !== "narration") return null;
  const scene = project.scenes.find((item) => item.sceneId === selection.sceneId);
  const absoluteSceneStart = sceneStart(project, selection.sceneId, timeline);
  if (!scene || absoluteSceneStart === null) return null;
  const sceneLength = sceneDuration(scene, timeline);
  const localStart = clamp(start - absoluteSceneStart, 0, sceneLength);
  const localEnd = clamp(end - absoluteSceneStart, 0, sceneLength);
  if (localEnd - localStart < MIN_AUDIO_SEGMENT_SECONDS) return null;
  if (selection.kind === "narration") {
    const assignment = assignmentFor(project, selection.sceneId);
    if (!assignment?.enabled || !assignment.audioPath) return null;
    const layout = audioTrackLayout(sceneLength, cuts.narration[selection.sceneId], removedRanges.narration[selection.sceneId], gaps.narration[selection.sceneId]);
    const pieces = layout.flatMap((segment): TimelineTimeRange[] => {
      const displayStart = Math.max(localStart, segment.timelineStart);
      const displayEnd = Math.min(localEnd, segment.timelineEnd);
      return displayEnd - displayStart >= MIN_AUDIO_SEGMENT_SECONDS ? [{ startSeconds: segment.start + displayStart - segment.timelineStart, endSeconds: segment.start + displayEnd - segment.timelineStart }] : [];
    });
    if (!pieces.length) return null;
    return {
      ...project,
      audioTimelineCuts: { ...cuts, narration: { ...cuts.narration, [selection.sceneId]: normalizeCutPoints([...(cuts.narration[selection.sceneId] || []), ...pieces.flatMap((piece) => [piece.startSeconds, piece.endSeconds])], sceneLength) } },
      audioTimelineRemovedRanges: { ...removedRanges, narration: { ...removedRanges.narration, [selection.sceneId]: normalizeTimeRanges([...(removedRanges.narration[selection.sceneId] || []), ...pieces], sceneLength) } },
      audioTimelineGaps: { ...gaps, narration: { ...gaps.narration, [selection.sceneId]: (gaps.narration[selection.sceneId] || []).filter((gap) => !pieces.some((piece) => gap.atSeconds >= piece.startSeconds - .001 && gap.atSeconds < piece.endSeconds - .001)) } },
    };
  }
  const removedDuration = localEnd - localStart;
  if (scene.mediaType === "video") {
    const pieces: Scene[] = [];
    if (localStart >= .1) pieces.push(sliceVideoScene(scene, 0, localStart));
    if (sceneLength - localEnd >= .1) pieces.push(sliceVideoScene(scene, localEnd, sceneLength, pieces.length ? crypto.randomUUID() : scene.sceneId));
    return { ...project, scenes: project.scenes.flatMap(s => s.sceneId === scene.sceneId ? pieces : [s]), audioTiming: { ...project.audioTiming, mode: "manual" } };
  }
  if (sceneLength - removedDuration < .25) return removeScene(project, selection.sceneId);
  const nextDuration = sceneLength - removedDuration;
  const total = totalDuration(project, timeline);
  const nextCuts: AudioTimelineCuts = {
    voice: shiftPointsAfterRemoval(cuts.voice, start, end, total),
    music: shiftPointsAfterRemoval(cuts.music, start, end, total),
    narration: { ...cuts.narration, [selection.sceneId]: shiftPointsAfterRemoval(cuts.narration[selection.sceneId] || [], localStart, localEnd, sceneLength) },
  };
  const nextRemoved: AudioTimelineRemovedRanges = {
    voice: shiftRangesAfterRemoval(removedRanges.voice, start, end, total),
    music: shiftRangesAfterRemoval(removedRanges.music, start, end, total),
    narration: { ...removedRanges.narration, [selection.sceneId]: shiftRangesAfterRemoval(removedRanges.narration[selection.sceneId] || [], localStart, localEnd, sceneLength) },
  };
  return { ...project, scenes: setSceneDuration(project.scenes, selection.sceneId, nextDuration), audioTimelineCuts: nextCuts, audioTimelineRemovedRanges: nextRemoved, audioTimelineGaps: gaps, audioTiming: { ...project.audioTiming, mode: "manual" } };
}

export function progressFraction(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(1, numeric > 1 ? numeric / 100 : numeric);
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

export function sceneDuration(scene: Scene, timeline?: Timeline | null): number {
  // Browser-local timelines are snapshots used for playback metadata. Manual
  // edits must remain authoritative so a split/resize never reuses stale
  // durations from the last time Play or Analyze was pressed.
  if (timeline?.timingMode === "browser-local") return scene.durationSeconds;
  return timeline?.scenes.find((item) => item.sceneId === scene.sceneId)?.durationSeconds ?? scene.durationSeconds;
}

export function totalDuration(project: Project, timeline?: Timeline | null): number {
  return project.scenes.reduce((total, scene) => total + sceneDuration(scene, timeline), 0);
}

export function buildLocalTimeline(project: Project): Timeline {
  let frame = 0;
  const scenes = project.scenes.map((scene) => {
    const frameCount = Math.max(1, Math.round(scene.durationSeconds * project.fps));
    const item = { ...scene, sourcePath: scene.imagePath, startFrame: frame, endFrame: frame + frameCount, frameCount, durationSeconds: frameCount / project.fps, timingWeight: scene.timingWeight };
    frame += frameCount;
    return item;
  });
  return { timelineId: `local-${Date.now()}`, fps: project.fps, totalFrames: frame, durationSeconds: frame / project.fps, timingMode: "browser-local", warnings: [], silenceBoundaries: [], narrationClips: [], scenes };
}

export function sceneAtTime(project: Project, seconds: number): { scene?: Scene; progress: number } {
  let cursor = 0;
  for (const scene of project.scenes) {
    const end = cursor + scene.durationSeconds;
    if (seconds < end || scene === project.scenes.at(-1)) return { scene, progress: Math.max(0, Math.min(1, (seconds - cursor) / Math.max(scene.durationSeconds, .01))) };
    cursor = end;
  }
  return { scene: undefined, progress: 0 };
}

export function reorderScenes(scenes: Scene[], fromId: string, toId: string): Scene[] {
  const from = scenes.findIndex((scene) => scene.sceneId === fromId);
  const to = scenes.findIndex((scene) => scene.sceneId === toId);
  if (from < 0 || to < 0 || from === to) return scenes;
  const copy = [...scenes];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

export function removeScene(project: Project, sceneId: string): Project {
  const index = project.scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (index < 0) return project;
  const weights = project.audioTiming.weights;
  const cuts = normalizeAudioTimelineCuts(project.audioTimelineCuts);
  const removedRanges = normalizeAudioRemovedRanges(project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(project.audioTimelineGaps);
  const { [sceneId]: _removedCuts, ...remainingNarrationCuts } = cuts.narration;
  const { [sceneId]: _removedAudio, ...remainingNarrationRemoved } = removedRanges.narration;
  const { [sceneId]: _removedGaps, ...remainingNarrationGaps } = gaps.narration;
  return {
    ...project,
    scenes: project.scenes.filter((scene) => scene.sceneId !== sceneId),
    audioTiming: {
      ...project.audioTiming,
      weights: weights ? weights.filter((_, weightIndex) => weightIndex !== index) : null,
    },
    narrationMapping: {
      ...project.narrationMapping,
      assignments: project.narrationMapping.assignments.filter((assignment) => assignment.sceneId !== sceneId),
    },
    // Voice and music are independent tracks. Deleting a visual scene must not
    // silently erase or re-time edits the user already made on those tracks.
    audioTimelineCuts: { voice: cuts.voice, music: cuts.music, narration: remainingNarrationCuts },
    audioTimelineRemovedRanges: { voice: removedRanges.voice, music: removedRanges.music, narration: remainingNarrationRemoved },
    audioTimelineGaps: { voice: gaps.voice, music: gaps.music, narration: remainingNarrationGaps },
  };
}

export function setSceneDuration(scenes: Scene[], sceneId: string, duration: number): Scene[] {
  return scenes.map((scene) => scene.sceneId === sceneId
    ? validSceneTiming(scene, { durationSeconds: duration })
    : scene);
}

function validSceneTiming(scene: Scene, patch: Partial<Scene> = {}): Scene {
  const merged = { ...scene, ...patch };
  const maximum = merged.mediaType === "video" ? Math.max(.1, (merged.sourceEndSeconds ?? merged.sourceDurationSeconds ?? 1800) - (merged.sourceStartSeconds || 0)) : 3600;
  const durationSeconds = clamp(merged.durationSeconds, merged.mediaType === "video" ? .1 : .25, maximum);
  const requestedTransition = clamp(merged.transitionDurationSeconds, 0, 3600);
  const transitionDurationSeconds = requestedTransition >= durationSeconds ? durationSeconds / 2 : requestedTransition;
  return { ...merged, durationSeconds, transitionDurationSeconds, crop: normalizeImageCrop(merged.crop) };
}

export function duplicateScene(scenes: Scene[], sceneId: string): Scene[] {
  const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (index < 0) return scenes;
  const duplicate = {
    ...scenes[index],
    sceneId: globalThis.crypto?.randomUUID?.() ?? `scene-${Date.now()}`,
  };
  const copy = [...scenes];
  copy.splice(index + 1, 0, duplicate);
  return copy;
}

export function splitScene(scenes: Scene[], sceneId: string, playhead?: number): Scene[] {
  const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (index < 0 || scenes[index].durationSeconds < .5) return scenes;
  const start = scenes.slice(0, index).reduce((sum, scene) => sum + scene.durationSeconds, 0);
  const requested = playhead === undefined ? scenes[index].durationSeconds / 2 : playhead - start;
  const firstDuration = clamp(requested, .25, scenes[index].durationSeconds - .25);
  if (scenes[index].mediaType === "video") {
    const scene = scenes[index];
    return scenes.flatMap((s, i) => i === index ? [sliceVideoScene(scene, 0, firstDuration), sliceVideoScene(scene, firstDuration, scene.durationSeconds, crypto.randomUUID())] : [s]);
  }
  const first = validSceneTiming(scenes[index], { durationSeconds: firstDuration });
  const second = validSceneTiming({ ...scenes[index], sceneId: globalThis.crypto?.randomUUID?.() ?? `scene-${Date.now()}` }, { durationSeconds: scenes[index].durationSeconds - firstDuration });
  const copy = [...scenes];
  copy.splice(index, 1, first, second);
  return copy;
}

export function patchScene(scenes: Scene[], sceneId: string, patch: Partial<Scene>): Scene[] {
  return scenes.map((scene) => scene.sceneId === sceneId ? validSceneTiming(scene, patch) : scene);
}

export function normalizeProject(candidate: Partial<Project>, defaults: Project): Project {
  const voiceTrim = normalizeAudioTrim(candidate.voiceTrimStartSeconds ?? defaults.voiceTrimStartSeconds, candidate.voiceTrimEndSeconds === undefined ? defaults.voiceTrimEndSeconds : candidate.voiceTrimEndSeconds);
  const musicTrim = normalizeAudioTrim(candidate.musicTrimStartSeconds ?? defaults.musicTrimStartSeconds, candidate.musicTrimEndSeconds === undefined ? defaults.musicTrimEndSeconds : candidate.musicTrimEndSeconds);
  return {
    ...defaults,
    ...candidate,
    voiceTrimStartSeconds: voiceTrim.start,
    voiceTrimEndSeconds: voiceTrim.end,
    musicTrimStartSeconds: musicTrim.start,
    musicTrimEndSeconds: musicTrim.end,
    audioTiming: { ...defaults.audioTiming, ...(candidate.audioTiming || {}) },
    narrationMapping: {
      ...defaults.narrationMapping,
      ...(candidate.narrationMapping || {}),
      assignments: candidate.narrationMapping?.assignments || [],
    },
    audioTimelineCuts: normalizeAudioTimelineCuts(candidate.audioTimelineCuts),
    audioTimelineRemovedRanges: normalizeAudioRemovedRanges(candidate.audioTimelineRemovedRanges),
    audioTimelineGaps: normalizeAudioTimelineGaps(candidate.audioTimelineGaps),
    scenes: Array.isArray(candidate.scenes) ? candidate.scenes.map((scene) => validSceneTiming(scene)) : [],
  };
}

export function assignmentFor(project: Project, sceneId: string) {
  return project.narrationMapping.assignments.find((item) => item.sceneId === sceneId);
}

export function updateAssignment(project: Project, sceneId: string, patch: Record<string, unknown>): Project {
  const current = assignmentFor(project, sceneId) || {
    sceneId,
    audioPath: null,
    trimStartSeconds: 0,
    trimEndSeconds: null,
    leadingPaddingSeconds: 0,
    trailingPaddingSeconds: 0,
    enabled: true,
  };
  const merged = { ...current, ...patch };
  const trim = normalizeAudioTrim(merged.trimStartSeconds, merged.trimEndSeconds);
  const assignments = project.narrationMapping.assignments.filter((item) => item.sceneId !== sceneId);
  assignments.push({ ...merged, trimStartSeconds: trim.start, trimEndSeconds: trim.end });
  return { ...project, narrationMapping: { ...project.narrationMapping, assignments } };
}
