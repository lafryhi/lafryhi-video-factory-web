import { GripVertical, Minus, MousePointer2, Plus, Scissors, Trash2, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { assetName } from "../assets";
import { audioTrackLayout, formatTime, MIN_AUDIO_SEGMENT_SECONDS, normalizeAudioRemovedRanges, normalizeAudioTimelineCuts, normalizeAudioTimelineGaps, sceneDuration, timelineSelectionRange, totalDuration } from "../domain";
import { useFileUrl } from "../hooks";
import type { Project, Scene, Timeline, TimelineRangeSelection, TimelineSelection } from "../types";
import { ProSlider } from "./ProSlider";

function ClipImage({ scene }: { scene: Scene }) {
  const url = useFileUrl(scene.imagePath);
  return url ? <img src={url} alt="" draggable={false}/> : null;
}

function trimLabel(start = 0, end: number | null = null): string {
  if (start <= 0 && end === null) return "";
  return ` · ${start.toFixed(1)}–${end === null ? "end" : end.toFixed(1)}s`;
}

function Waveform({ duration }: { duration: number }) {
  return <div className="waveform">{Array.from({ length: Math.max(3, Math.round(duration * 4)) }, (_, index) => <i key={index} style={{ height: `${20 + ((index * 29) % 70)}%` }}/>)}</div>;
}

const clampTime = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

function rangeTrackPosition(kind: TimelineRangeSelection["kind"]): React.CSSProperties {
  if (kind === "scene") return { top: 27, height: 74 };
  if (kind === "voice") return { top: 101, height: 55 };
  if (kind === "narration") return { top: 156, height: 61 };
  return { top: 217, height: 55 };
}

function isSelected(current: TimelineSelection | null, candidate: TimelineSelection): boolean {
  if (!current || current.kind !== candidate.kind) return false;
  if (current.kind === "scene" && candidate.kind === "scene") return current.sceneId === candidate.sceneId;
  if (current.kind === "narration" && candidate.kind === "narration") return current.sceneId === candidate.sceneId && Math.abs(current.startSeconds - candidate.startSeconds) < .001;
  return current.kind !== "scene" && current.kind !== "narration" && candidate.kind !== "scene" && candidate.kind !== "narration" && Math.abs(current.startSeconds - candidate.startSeconds) < .001;
}

type Props = {
  project: Project;
  timeline: Timeline | null;
  selectedId: string | null;
  selectedClip?: TimelineSelection | null;
  selectedClips?: TimelineSelection[];
  selectedRange?: TimelineRangeSelection | null;
  playhead: number;
  onSelect(id: string): void;
  onSelectClip?(selection: TimelineSelection, additive?: boolean): void;
  onSelectRange?(selection: TimelineRangeSelection | null): void;
  onPlayhead(seconds: number): void;
  onReorder(fromId: string, toId: string): void;
  onResize(sceneId: string, seconds: number): void;
  onSplit(sceneId: string, playhead: number): void;
  onCut?(selection: TimelineSelection, playhead: number): void;
  onMoveAudio?(selection: TimelineSelection, deltaSeconds: number): void;
  onRemoveRange?(selection: TimelineRangeSelection): void;
  onRemoveSelected?(): void;
  onRemove(sceneId: string): void;
};

type RangeDraft = TimelineRangeSelection & { anchorSeconds: number; minimumSeconds: number; maximumSeconds: number };

export function TimelineEditor(props: Props) {
  const [zoom, setZoom] = useState(62);
  const [dragId, setDragId] = useState<string | null>(null);
  const [audioMove, setAudioMove] = useState<{ selection: TimelineSelection; startX: number; deltaX: number } | null>(null);
  const pointerSelectedKey = useRef<string | null>(null);
  const [resize, setResize] = useState<{ sceneId: string; startX: number; startDuration: number; value: number } | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeDraft, setRangeDraft] = useState<RangeDraft | null>(null);
  const rangeDraftRef = useRef<RangeDraft | null>(null);
  const rangePointerCleanup = useRef<() => void>(() => {});
  const canvas = useRef<HTMLDivElement>(null);
  const duration = totalDuration(props.project, props.timeline);
  const canvasDuration = Math.max(duration, 1);
  const width = Math.max(canvasDuration * zoom, 800);
  const cuts = normalizeAudioTimelineCuts(props.project.audioTimelineCuts);
  const removedRanges = normalizeAudioRemovedRanges(props.project.audioTimelineRemovedRanges);
  const gaps = normalizeAudioTimelineGaps(props.project.audioTimelineGaps);
  const selectedClips = props.selectedClips || (props.selectedClip === undefined
    ? (props.selectedId ? [{ kind: "scene", sceneId: props.selectedId } satisfies TimelineSelection] : [])
    : props.selectedClip ? [props.selectedClip] : []);
  const selectedClip = selectedClips.at(-1) || null;
  const starts = useMemo(() => {
    let cursor = 0;
    return props.project.scenes.map((scene) => {
      const current = cursor;
      cursor += sceneDuration(scene, props.timeline);
      return [scene.sceneId, current] as const;
    });
  }, [props.project.scenes, props.timeline]);
  const startByScene = new Map(starts);
  const select = (selection: TimelineSelection, additive = false) => {
    if (selection.kind === "scene" || selection.kind === "narration") props.onSelect(selection.sceneId);
    props.onSelectClip?.(selection, additive);
  };
  const selectionIsActive = (selection: TimelineSelection) => selectedClips.some((item) => isSelected(item, selection));
  const selectionKey = (selection: TimelineSelection) => selection.kind === "scene" ? `scene:${selection.sceneId}` : selection.kind === "narration" ? `narration:${selection.sceneId}:${selection.startSeconds}` : `${selection.kind}:${selection.startSeconds}`;
  const beginAudioMove = (selection: TimelineSelection, event: React.PointerEvent<HTMLElement>) => {
    if (rangeMode) { beginRange(selection, event); return; }
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerSelectedKey.current = selectionKey(selection);
    select(selection, event.metaKey || event.ctrlKey);
    setAudioMove({ selection, startX: event.clientX, deltaX: 0 });
  };
  const timeAtPointer = (clientX: number) => {
    const rect = canvas.current?.getBoundingClientRect();
    return rect ? clampTime((clientX - rect.left) / zoom, 0, duration) : 0;
  };
  useEffect(() => () => rangePointerCleanup.current(), []);
  const beginRange = (selection: TimelineSelection, event: React.PointerEvent<HTMLElement>) => {
    if (!rangeMode) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    let minimumSeconds = 0; let maximumSeconds = duration;
    if (selection.kind === "scene" || selection.kind === "narration") {
      minimumSeconds = startByScene.get(selection.sceneId) ?? 0;
      const scene = props.project.scenes.find((item) => item.sceneId === selection.sceneId);
      maximumSeconds = minimumSeconds + (scene ? sceneDuration(scene, props.timeline) : 0);
    }
    const anchorSeconds = clampTime(timeAtPointer(event.clientX), minimumSeconds, maximumSeconds);
    const base = selection.kind === "scene" || selection.kind === "narration"
      ? { kind: selection.kind, sceneId: selection.sceneId, startSeconds: anchorSeconds, endSeconds: anchorSeconds }
      : { kind: selection.kind, startSeconds: anchorSeconds, endSeconds: anchorSeconds };
    const draft = { ...base, anchorSeconds, minimumSeconds, maximumSeconds } as RangeDraft;
    rangeDraftRef.current = draft;
    setRangeDraft(draft);
    props.onSelectRange?.(null);
    rangePointerCleanup.current();
    const target = event.currentTarget;
    const updateDraft = (pointerEvent: PointerEvent) => {
      const value = clampTime(timeAtPointer(pointerEvent.clientX), draft.minimumSeconds, draft.maximumSeconds);
      const next = { ...draft, startSeconds: Math.min(draft.anchorSeconds, value), endSeconds: Math.max(draft.anchorSeconds, value) };
      rangeDraftRef.current = next;
      setRangeDraft(next);
    };
    const cleanup = () => {
      target.removeEventListener("pointermove", updateDraft);
      target.removeEventListener("pointerup", finishDraft);
      target.removeEventListener("pointercancel", cancelDraft);
      rangePointerCleanup.current = () => {};
    };
    const finishDraft = (pointerEvent: PointerEvent) => {
      updateDraft(pointerEvent);
      const finalDraft = rangeDraftRef.current;
      if (finalDraft) {
        const { anchorSeconds: _anchor, minimumSeconds: _minimum, maximumSeconds: _maximum, ...finalSelection } = finalDraft;
        props.onSelectRange?.(finalSelection.endSeconds - finalSelection.startSeconds >= MIN_AUDIO_SEGMENT_SECONDS ? finalSelection : null);
      }
      rangeDraftRef.current = null;
      setRangeDraft(null);
      cleanup();
    };
    const cancelDraft = () => {
      rangeDraftRef.current = null;
      setRangeDraft(null);
      cleanup();
    };
    target.addEventListener("pointermove", updateDraft);
    target.addEventListener("pointerup", finishDraft);
    target.addEventListener("pointercancel", cancelDraft);
    rangePointerCleanup.current = cleanup;
  };
  const resizeMove = (event: React.PointerEvent) => {
    const currentDraft = rangeDraftRef.current;
    if (currentDraft) {
      const value = clampTime(timeAtPointer(event.clientX), currentDraft.minimumSeconds, currentDraft.maximumSeconds);
      const nextDraft = { ...currentDraft, startSeconds: Math.min(currentDraft.anchorSeconds, value), endSeconds: Math.max(currentDraft.anchorSeconds, value) };
      rangeDraftRef.current = nextDraft;
      setRangeDraft(nextDraft);
      return;
    }
    if (audioMove) {
      setAudioMove({ ...audioMove, deltaX: event.clientX - audioMove.startX });
      return;
    }
    if (!resize) return;
    setResize({ ...resize, value: Math.max(.25, resize.startDuration + (event.clientX - resize.startX) / zoom) });
  };
  const resizeEnd = (event: React.PointerEvent) => {
    const currentDraft = rangeDraftRef.current;
    if (currentDraft) {
      const value = clampTime(timeAtPointer(event.clientX), currentDraft.minimumSeconds, currentDraft.maximumSeconds);
      const finalDraft = { ...currentDraft, startSeconds: Math.min(currentDraft.anchorSeconds, value), endSeconds: Math.max(currentDraft.anchorSeconds, value) };
      const { anchorSeconds: _anchor, minimumSeconds: _minimum, maximumSeconds: _maximum, ...selection } = finalDraft;
      props.onSelectRange?.(selection.endSeconds - selection.startSeconds >= MIN_AUDIO_SEGMENT_SECONDS ? selection : null);
      rangeDraftRef.current = null;
      setRangeDraft(null);
      return;
    }
    if (audioMove) {
      const deltaX = event.clientX - audioMove.startX;
      if (Math.abs(deltaX) >= 4) props.onMoveAudio?.(audioMove.selection, deltaX / zoom);
      setAudioMove(null);
      return;
    }
    if (resize) props.onResize(resize.sceneId, resize.value);
    setResize(null);
    setAudioMove(null);
  };
  const cancelPointer = () => {
    rangePointerCleanup.current();
    rangeDraftRef.current = null;
    setRangeDraft(null);
    setResize(null);
  };
  const seek = (event: React.MouseEvent) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (rect) props.onPlayhead(Math.max(0, Math.min(duration, (event.clientX - rect.left) / zoom)));
  };
  const selectedTrackRange = selectedClip ? timelineSelectionRange(props.project, selectedClip, props.timeline) : null;
  const selectedBounds = selectedTrackRange ? { start: selectedTrackRange.startSeconds, end: selectedTrackRange.endSeconds, margin: selectedTrackRange.kind === "scene" ? .25 : MIN_AUDIO_SEGMENT_SECONDS } : null;
  const canCut = Boolean(selectedClips.length === 1 && selectedBounds && props.playhead >= selectedBounds.start + selectedBounds.margin && props.playhead <= selectedBounds.end - selectedBounds.margin);
  const cutTitle = !selectedClip ? "Select a timeline clip to cut" : canCut ? `Cut selected ${selectedClip.kind} clip at the playhead` : "Move the playhead inside the selected clip to cut";
  const removeLabel = props.selectedRange
    ? "Remove selected timeline range"
    : selectedClips.length > 1
      ? `Remove ${selectedClips.length} selected clips`
    : selectedClip?.kind === "scene"
      ? "Delete selected scene"
      : selectedClip
        ? `Remove selected ${selectedClip.kind} segment`
        : "Select a timeline clip to remove";
  const visibleRange = rangeDraft || props.selectedRange;
  const ticks = Array.from({ length: Math.ceil(canvasDuration) + 1 }, (_, index) => index);

  const globalAudioTrack = (kind: "voice" | "music", source: string, label: string, trimStart = 0, trimEnd: number | null = null) => {
    const segments = audioTrackLayout(duration, cuts[kind], removedRanges[kind], gaps[kind]);
    const className = kind === "music" ? "music-clip" : "audio-clip voice-clip";
    if (!source) return <div className={`${className} empty`} style={{ width: Math.max(88, duration * zoom) }}><span>{kind === "music" ? "No background music" : "No main voice"}</span></div>;
    if (!segments.length) return <div className={`${className} empty`} style={{ width: Math.max(88, duration * zoom) }}><span>{kind === "music" ? "No background music clips" : "No main voice clips"}</span></div>;
    return segments.map((segment, index) => {
      const selection: TimelineSelection = { kind, startSeconds: segment.start };
      const previousEnd = segments[index - 1]?.timelineEnd || 0;
      const moving = audioMove && selectionKey(audioMove.selection) === selectionKey(selection);
      return <button key={`${kind}-${segment.start}`} type="button" data-timeline-start={segment.timelineStart} data-source-start={segment.start} data-testid={`timeline-${kind}-${index}`} aria-label={`Select ${kind} segment ${index + 1}`} className={`${className} selectable ${moving ? "dragging" : ""} ${selectionIsActive(selection) ? "selected" : ""}`} style={{ width: Math.max(28, (segment.end - segment.start) * zoom), marginLeft: Math.max(index ? 2 : 0, (segment.timelineStart - previousEnd) * zoom), transform: moving ? `translateX(${audioMove.deltaX}px)` : undefined }} onPointerDown={(event) => beginAudioMove(selection, event)} onClick={(event) => { event.stopPropagation(); if (pointerSelectedKey.current === selectionKey(selection)) { pointerSelectedKey.current = null; return; } if (!rangeMode) select(selection, event.metaKey || event.ctrlKey); }}><Waveform duration={segment.end - segment.start}/><span>{index === 0 ? `${label}${trimLabel(trimStart, trimEnd)}` : `${formatTime(segment.start)} continuation`}</span></button>;
    });
  };

  return <section className={`timeline-panel panel ${rangeMode ? "range-mode" : ""}`} aria-label="Video timeline" onPointerMove={resizeMove} onPointerUp={resizeEnd} onPointerCancel={cancelPointer}>
    <div className="timeline-toolbar"><div><strong>Timeline</strong><span>{visibleRange ? `${(visibleRange.endSeconds - visibleRange.startSeconds).toFixed(2)}s selected` : selectedClips.length > 1 ? `${selectedClips.length} clips selected` : `${props.project.scenes.length} scenes · ${formatTime(duration)}`}</span></div><div className="timeline-tools"><button data-testid="timeline-range-tool" className={`icon-button ${rangeMode ? "active" : ""}`} title="Select an exact range to remove" aria-label="Select timeline range" aria-pressed={rangeMode} onClick={() => { setRangeMode((value) => !value); rangePointerCleanup.current(); rangeDraftRef.current = null; setRangeDraft(null); props.onSelectRange?.(null); }}><MousePointer2/></button><button data-testid="split-scene" className="icon-button" title={cutTitle} aria-label="Cut selected timeline clip" disabled={!canCut || Boolean(props.selectedRange)} onClick={() => { if (!selectedClip || !canCut) return; selectedClip.kind === "scene" ? props.onSplit(selectedClip.sceneId, props.playhead) : props.onCut?.(selectedClip, props.playhead); }}><Scissors/></button><button data-testid="delete-selected-scene" className="icon-button danger" title={`${removeLabel} (Delete or Backspace)`} aria-label={removeLabel} disabled={!props.selectedRange && !selectedTrackRange} onClick={() => { if (props.selectedRange) props.onRemoveRange?.(props.selectedRange); else if (props.onRemoveSelected) props.onRemoveSelected(); else if (selectedClip?.kind === "scene") props.onRemove(selectedClip.sceneId); else if (selectedTrackRange) props.onRemoveRange?.(selectedTrackRange); }}><Trash2/></button><Minus/><ProSlider ariaLabel="Timeline zoom" min={28} max={160} value={zoom} onChange={setZoom}/><Plus/><ZoomIn/></div></div>
    <div className="timeline-layout">
      <div className="track-labels"><div className="ruler-spacer"/><div><strong>Scenes</strong><small>Visuals & motion</small></div><div><strong>Main voice</strong><small>Primary audio</small></div><div><strong>Narration</strong><small>Per scene clips</small></div><div><strong>Music</strong><small>Background track</small></div></div>
      <div className="timeline-scroll">
        <div ref={canvas} className="timeline-canvas" style={{ width }} onClick={seek}>
          <div className="ruler">{ticks.map((tick) => <span key={tick} style={{ left: tick * zoom }}><i/>{tick % 5 === 0 ? formatTime(tick) : ""}</span>)}</div>
          <div className="track scene-track">
            {props.project.scenes.map((scene, index) => {
              const resolved = resize?.sceneId === scene.sceneId ? resize.value : sceneDuration(scene, props.timeline);
              const selection: TimelineSelection = { kind: "scene", sceneId: scene.sceneId };
              return <div key={scene.sceneId} data-testid={`timeline-scene-${index}`} data-scene-id={scene.sceneId} className={`timeline-clip ${selectionIsActive(selection) ? "selected" : ""} ${scene.sceneId === dragId ? "dragging" : ""}`} style={{ width: Math.max(36, resolved * zoom) }} draggable={!resize && !rangeMode} onPointerDown={(event) => beginRange(selection, event)} onDragStart={() => { setDragId(scene.sceneId); select(selection); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); if (dragId) props.onReorder(dragId, scene.sceneId); setDragId(null); }} onDragEnd={() => setDragId(null)} onClick={(event) => { event.stopPropagation(); if (!rangeMode) select(selection, event.metaKey || event.ctrlKey); }}>
                <ClipImage scene={scene}/><span className="clip-overlay"><GripVertical/><strong>{index + 1}</strong><small>{resolved.toFixed(1)}s</small></span><button data-testid={`delete-timeline-scene-${index}`} className="clip-delete" aria-label={`Delete scene ${index + 1}`} title={`Delete scene ${index + 1}`} draggable={false} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); select(selection); props.onRemove(scene.sceneId); }}><Trash2/></button><button className="trim-handle" aria-label={`Resize scene ${index + 1}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setResize({ sceneId: scene.sceneId, startX: event.clientX, startDuration: resolved, value: resolved }); }}/>
              </div>;
            })}
          </div>
          <div className="track voice-track" onDragOver={(event) => event.preventDefault()}>{globalAudioTrack("voice", props.project.voiceFile, assetName(props.project.voiceFile), props.project.voiceTrimStartSeconds, props.project.voiceTrimEndSeconds ?? null)}</div>
          <div className="track narration-track">
            {props.project.scenes.map((scene, sceneIndex) => {
              const item = props.project.narrationMapping.assignments.find((assignment) => assignment.sceneId === scene.sceneId);
              const length = sceneDuration(scene, props.timeline);
              if (!item?.audioPath || !item.enabled) return <div key={scene.sceneId} className="narration-scene-lane" style={{ width: Math.max(36, length * zoom) }}><div className="audio-clip empty"><span>No clip</span></div></div>;
              const segments = audioTrackLayout(length, cuts.narration[scene.sceneId], removedRanges.narration[scene.sceneId], gaps.narration[scene.sceneId]);
              return <div key={scene.sceneId} className="narration-scene-lane" style={{ width: Math.max(36, length * zoom) }} onDragOver={(event) => event.preventDefault()}>{segments.length ? segments.map((segment, segmentIndex) => {
                const selection: TimelineSelection = { kind: "narration", sceneId: scene.sceneId, startSeconds: segment.start };
                const moving = audioMove && selectionKey(audioMove.selection) === selectionKey(selection);
                return <button key={`${scene.sceneId}-${segment.start}`} type="button" data-timeline-start={segment.timelineStart} data-source-start={segment.start} data-testid={`timeline-narration-${sceneIndex}-${segmentIndex}`} aria-label={`Select narration segment ${sceneIndex + 1}.${segmentIndex + 1}`} className={`audio-clip selectable ${moving ? "dragging" : ""} ${selectionIsActive(selection) ? "selected" : ""}`} style={{ left: segment.timelineStart * zoom, width: Math.max(28, (segment.end - segment.start) * zoom), transform: moving ? `translateX(${audioMove.deltaX}px)` : undefined }} title={assetName(item.audioPath)} onPointerDown={(event) => beginAudioMove(selection, event)} onClick={(event) => { event.stopPropagation(); if (pointerSelectedKey.current === selectionKey(selection)) { pointerSelectedKey.current = null; return; } if (!rangeMode) select(selection, event.metaKey || event.ctrlKey); }}><Waveform duration={segment.end - segment.start}/><span>{segmentIndex === 0 ? `${assetName(item.audioPath)}${trimLabel(item.trimStartSeconds, item.trimEndSeconds)}` : `${formatTime(segment.start)} continuation`}</span></button>;
              }) : <div className="audio-clip empty"><span>No narration clips</span></div>}</div>;
            })}
          </div>
          <div className="track music-track" onDragOver={(event) => event.preventDefault()}>{globalAudioTrack("music", props.project.musicFile, assetName(props.project.musicFile), props.project.musicTrimStartSeconds, props.project.musicTrimEndSeconds ?? null)}</div>
          {visibleRange && <div data-testid="timeline-range-selection" className={`timeline-range-selection ${visibleRange.kind}`} style={{ left: visibleRange.startSeconds * zoom, width: Math.max(3, (visibleRange.endSeconds - visibleRange.startSeconds) * zoom), ...rangeTrackPosition(visibleRange.kind) }}><span>{(visibleRange.endSeconds - visibleRange.startSeconds).toFixed(2)}s</span></div>}
          <div className="playhead" style={{ left: props.playhead * zoom }}><i/></div>
          {props.timeline?.silenceBoundaries.map((value) => <div key={value} className="silence-marker" style={{ left: value * zoom }} title={`Silence at ${formatTime(value)}`}/>) }
        </div>
      </div>
    </div>
  </section>;
}
