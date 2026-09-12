import { AlertTriangle, Maximize2, Pause, Play, RotateCcw, Volume2, Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import { audioSourceAtTimeline, formatTime, normalizeAudioRemovedRanges, normalizeAudioTimelineCuts, normalizeAudioTimelineGaps, normalizeImageCrop } from "../domain";
import { useFileUrl } from "../hooks";
import type { Project, Scene, Timeline } from "../types";
import { ProSlider } from "./ProSlider";

type Props = {
  project: Project;
  scene?: Scene;
  sceneProgress: number;
  timeline: Timeline | null;
  playhead: number;
  playing: boolean;
  onPlayhead(value: number): void;
  onToggle(): void;
};

function motionStyle(scene: Scene | undefined, progress: number, fillMode: string): React.CSSProperties {
  if (!scene) return {};
  const strength = scene.motionIntensity;
  const eased = progress * progress * (3 - 2 * progress);
  const zoom = scene.motion === "ZoomOut"
    ? scene.endZoom + (scene.startZoom - scene.endZoom) * (1 - eased)
    : scene.startZoom + (scene.endZoom - scene.startZoom) * eased;
  const travel = 8 * strength;
  let x = 0; let y = 0;
  if (scene.motion.includes("PanRight")) x = -travel + travel * 2 * eased;
  if (scene.motion.includes("PanLeft")) x = travel - travel * 2 * eased;
  if (scene.motion === "PanDown") y = -travel + travel * 2 * eased;
  if (scene.motion === "PanUp") y = travel - travel * 2 * eased;
  const fadeWindow = Math.min(.25, scene.transitionDurationSeconds / Math.max(scene.durationSeconds, .01));
  const opacity = scene.transition === "fade" && fadeWindow > 0 ? Math.min(1, progress / fadeWindow, (1 - progress) / fadeWindow) : 1;
  const crop = normalizeImageCrop(scene.crop);
  const cropZoom = crop.enabled ? crop.zoom : 1;
  return {
    objectFit: crop.enabled || fillMode.toLowerCase().startsWith("crop") ? "cover" : "contain",
    objectPosition: `${crop.x}% ${crop.y}%`,
    transformOrigin: `${crop.x}% ${crop.y}%`,
    transform: `translate3d(${x}%, ${y}%, 0) scale(${Math.max(1, zoom) * cropZoom})`,
    opacity: Math.max(.05, opacity),
  };
}

export function PreviewPanel(props: Props) {
  const imageUrl = useFileUrl(props.scene?.imagePath);
  const voiceUrl = useFileUrl(props.project.voiceFile);
  const musicUrl = useFileUrl(props.project.musicFile);
  const clipVideo = useRef<HTMLVideoElement>(null);
  const voice = useRef<HTMLAudioElement>(null);
  const music = useRef<HTMLAudioElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const duration = props.timeline?.durationSeconds || props.project.scenes.reduce((sum, item) => sum + item.durationSeconds, 0);
  const localTime = (props.scene?.durationSeconds || 0) * props.sceneProgress;
  const voiceStart = props.project.voiceTrimStartSeconds ?? 0;
  const voiceEnd = props.project.voiceTrimEndSeconds ?? null;
  const musicStart = props.project.musicTrimStartSeconds ?? 0;
  const musicEnd = props.project.musicTrimEndSeconds ?? null;
  const removedRanges = normalizeAudioRemovedRanges(props.project.audioTimelineRemovedRanges);
  const cuts = normalizeAudioTimelineCuts(props.project.audioTimelineCuts);
  const gaps = normalizeAudioTimelineGaps(props.project.audioTimelineGaps);

  const syncAudio = (value: number) => {
    const voiceTrack = voice.current;
    if (voiceTrack) {
      const source = audioSourceAtTimeline(duration, cuts.voice, removedRanges.voice, gaps.voice, value);
      voiceTrack.muted = source === null;
      if (source !== null) {
        const target = voiceStart + source;
        if (voiceEnd !== null && target >= voiceEnd) voiceTrack.pause();
        else if (Math.abs(voiceTrack.currentTime - target) > .12) voiceTrack.currentTime = Math.min(target, Math.max(0, (voiceTrack.duration || target + 1) - .01));
      }
    }
    const musicTrack = music.current;
    if (musicTrack) {
      const source = audioSourceAtTimeline(duration, cuts.music, removedRanges.music, gaps.music, value);
      musicTrack.muted = source === null;
      const fullEnd = musicEnd ?? musicTrack.duration;
      const selection = fullEnd - musicStart;
      if (source !== null) {
        const target = selection > .05 ? musicStart + (source % selection) : musicStart;
        if (Math.abs(musicTrack.currentTime - target) > .12) musicTrack.currentTime = target;
      }
    }
  };

  useEffect(() => {
    const tracks = [voice.current, music.current].filter(Boolean) as HTMLAudioElement[];
    music.current && (music.current.volume = props.project.musicVolume);
    voice.current && (voice.current.volume = 1);
    syncAudio(props.playhead);
    if (props.playing) {
      for (const track of tracks) {
        if (track === voice.current && voiceEnd !== null && voiceStart + props.playhead >= voiceEnd) continue;
        void track.play().catch(() => {});
      }
    } else tracks.forEach((track) => track.pause());
  }, [props.playing, voiceUrl, musicUrl, props.project.musicVolume, voiceStart, voiceEnd, musicStart, musicEnd]);
  useEffect(() => { syncAudio(props.playhead); }, [props.playhead, props.project.audioTimelineCuts, props.project.audioTimelineRemovedRanges, props.project.audioTimelineGaps]);

  useEffect(() => {
    const video = clipVideo.current;
    if (!video) return;
    const target = (props.scene?.sourceStartSeconds || 0) + localTime;
    if (Math.abs(video.currentTime - target) > .12) video.currentTime = target;
    video.muted = props.scene?.sourceAudio === false;
    if (props.playing) void video.play().catch(() => {}); else video.pause();
  }, [imageUrl, props.scene?.sceneId, localTime, props.playing]);

  const seek = (value: number) => {
    props.onPlayhead(value);
    syncAudio(value);
  };

  return <main className="preview-panel panel">
    <div className="preview-heading"><div><span className="eyebrow">Instant canvas</span><h2>Live preview</h2></div><div className="preview-meta"><span className="local-badge"><Zap/> Browser local</span><span>{props.project.resolution}</span><span>{props.project.fps} FPS</span></div></div>
    <div ref={stage} data-testid="preview-stage" className={`stage ${props.project.videoFormat === "vertical_9_16" ? "vertical" : "landscape"}`}>
      {imageUrl ? <div className="live-scene" key={props.scene?.sceneId}>{props.scene?.mediaType === "video" ? <video ref={clipVideo} src={imageUrl} playsInline preload="auto" style={motionStyle(props.scene, props.sceneProgress, props.project.fillMode)} onLoadedMetadata={e => { e.currentTarget.currentTime = (props.scene?.sourceStartSeconds || 0) + localTime; if (props.playing) void e.currentTarget.play().catch(() => {}); }}/> : <img data-testid="preview-image" src={imageUrl} alt="Current scene" style={motionStyle(props.scene, props.sceneProgress, props.project.fillMode)}/>}{props.scene?.texts?.filter((overlay) => localTime >= overlay.startSeconds && (overlay.endSeconds === null || localTime <= overlay.endSeconds)).map((overlay) => <div key={overlay.id} className="preview-text" dir="auto" style={{ left: `${overlay.x}%`, top: `${overlay.y}%`, color: overlay.color, fontFamily: overlay.fontFamily, fontSize: `${Math.max(10, overlay.fontSize / 2)}px` }}>{overlay.text}</div>)}</div> : <div className="stage-empty"><Play/><strong>Your preview appears here</strong><span>Drop images into the media library to begin.</span></div>}
      {props.scene && <div className="stage-badge">{props.scene.motion.replace(/([A-Z])/g, " $1").trim()}</div>}
    </div>
    <div className="transport">
      <button className="icon-button" title="Restart" onClick={() => seek(0)}><RotateCcw/></button>
      <button data-testid="preview-play" className="play-button" aria-label={props.playing ? "Pause preview" : "Play preview"} title={props.playing ? "Pause preview" : "Play preview"} onClick={props.onToggle}>{props.playing ? <Pause/> : <Play/>}</button>
      <span className="timecode">{formatTime(props.playhead)} <i>/</i> {formatTime(duration)}</span>
      <ProSlider ariaLabel="Preview position" min={0} max={Math.max(duration, .01)} step={.01} value={Math.min(props.playhead, duration)} onChange={seek}/>
      <Volume2 className="transport-icon"/>
      <button className="icon-button" title="Fullscreen" onClick={() => stage.current?.requestFullscreen()}><Maximize2/></button>
    </div>
    {voiceUrl && <audio ref={voice} src={voiceUrl} preload="metadata" onTimeUpdate={(event) => {
      if (voiceEnd !== null && event.currentTarget.currentTime >= voiceEnd) event.currentTarget.pause();
    }}/>}
    {musicUrl && <audio ref={music} src={musicUrl} preload="metadata" onTimeUpdate={(event) => {
      const end = musicEnd ?? event.currentTarget.duration;
      if (end > musicStart && event.currentTarget.currentTime >= end - .015) {
        event.currentTarget.currentTime = musicStart;
        if (props.playing) void event.currentTarget.play().catch(() => {});
      }
    }} onEnded={(event) => {
      event.currentTarget.currentTime = musicStart;
      if (props.playing) void event.currentTarget.play().catch(() => {});
    }}/>}
    {props.timeline?.warnings.length ? <div className="warning-strip"><AlertTriangle/>{props.timeline.warnings.join(" · ")}</div> : null}
  </main>;
}
