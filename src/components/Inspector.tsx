import { Copy, Music, Plus, Settings2, SlidersHorizontal, Trash2, Type as TypeIcon, X } from "lucide-react";
import { useState } from "react";
import { assetName } from "../assets";
import { assignmentFor } from "../domain";
import type { Capabilities, Project, Scene, TextOverlay } from "../types";
import { AudioTrimControl } from "./AudioTrimControl";
import { ImageCropEditor } from "./ImageCropEditor";
import { ProSlider } from "./ProSlider";

type Props = {
  project: Project;
  scene?: Scene;
  capabilities: Capabilities;
  onScene(patch: Partial<Scene>): void;
  onProject(patch: Partial<Project>): void;
  onTiming(patch: Partial<Project["audioTiming"]>): void;
  onNarration(patch: Record<string, unknown>): void;
  onChooseNarration(): void;
  onChooseOutput(): void;
  onDuplicate(): void;
  onRemove(): void;
  onAddText(): void;
  onText(id: string, patch: Partial<TextOverlay>): void;
  onRemoveText(id: string): void;
};

const NumberField = ({ label, value, min = 0, max, step = .1, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange(value: number): void }) =>
  <label className="field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))}/></label>;

export function Inspector(props: Props) {
  const [tab, setTab] = useState<"scene" | "project" | "audio">("scene");
  const assignment = props.scene ? assignmentFor(props.project, props.scene.sceneId) : undefined;
  return <aside className="inspector panel">
    <div className="inspector-tabs">
      <button data-testid="tab-scene" className={tab === "scene" ? "active" : ""} onClick={() => setTab("scene")}><SlidersHorizontal/> Scene</button>
      <button data-testid="tab-project" className={tab === "project" ? "active" : ""} onClick={() => setTab("project")}><Settings2/> Project</button>
      <button data-testid="tab-audio" className={tab === "audio" ? "active" : ""} onClick={() => setTab("audio")}><Music/> Audio</button>
    </div>
    <div className="inspector-scroll">
      {tab === "scene" && (props.scene ? <>
        <div className="inspector-title"><div><span className="eyebrow">Selected scene</span><h2>{assetName(props.scene.imagePath)}</h2></div><div><button data-testid="duplicate-scene" className="icon-button" onClick={props.onDuplicate} title="Duplicate"><Copy/></button><button data-testid="remove-scene" className="icon-button danger" onClick={props.onRemove} title="Remove"><Trash2/></button></div></div>
        <section className="settings-card"><h3>Timing & motion</h3>
          <NumberField label="Duration (seconds)" value={props.scene.durationSeconds} min={.25} onChange={(durationSeconds) => props.onScene({ durationSeconds })}/>
          <label className="field"><span>Motion preset</span><select value={props.scene.motion} onChange={(event) => props.onScene({ motion: event.target.value })}>{props.capabilities.motions.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select></label>
          <label className="field range"><span>Motion intensity <em>{Math.round(props.scene.motionIntensity * 100)}%</em></span><ProSlider ariaLabel="Motion intensity" min={0} max={1} step={.01} value={props.scene.motionIntensity} onChange={(motionIntensity) => props.onScene({ motionIntensity })}/></label>
          <div className="field-pair"><NumberField label="Start zoom" value={props.scene.startZoom} min={1} step={.01} onChange={(startZoom) => props.onScene({ startZoom })}/><NumberField label="End zoom" value={props.scene.endZoom} min={1} step={.01} onChange={(endZoom) => props.onScene({ endZoom })}/></div>
          <label className="field"><span>Transition</span><select value={props.scene.transition} onChange={(event) => props.onScene({ transition: event.target.value })}><option value="fade">Fade</option><option value="none">None</option></select></label>
          <NumberField label="Transition length" value={props.scene.transitionDurationSeconds} max={props.scene.durationSeconds} onChange={(transitionDurationSeconds) => props.onScene({ transitionDurationSeconds })}/>
          <NumberField label="Timing weight" value={props.scene.timingWeight} min={.01} step={.1} onChange={(timingWeight) => props.onScene({ timingWeight })}/>
          {props.scene.mediaType === "video" && (
            <label className="check" style={{ marginTop: "6px" }}>
              <input type="checkbox" checked={props.scene.sourceAudio !== false} onChange={(event) => props.onScene({ sourceAudio: event.target.checked })}/> Keep original video audio
            </label>
          )}
        </section>
        <ImageCropEditor imagePath={props.scene.imagePath} crop={props.scene.crop} portrait={props.project.videoFormat === "vertical_9_16"} onChange={(crop) => props.onScene({ crop })}/>
        <section className="settings-card text-settings"><div className="card-heading"><h3>Text overlays</h3><button data-testid="add-text" className="mini-action" onClick={props.onAddText}><Plus/> Add text</button></div>
          {props.scene.texts?.length ? props.scene.texts.map((overlay, index) => <div className="text-overlay-editor" key={overlay.id}>
            <div className="text-editor-heading"><span><TypeIcon/> Text {index + 1}</span><button className="icon-button danger compact" title="Remove text" onClick={() => props.onRemoveText(overlay.id)}><X/></button></div>
            <label className="field"><span>Content</span><input data-testid={`text-overlay-${index}`} value={overlay.text} placeholder="Type your title" dir="auto" onChange={(event) => props.onText(overlay.id, { text: event.target.value })}/></label>
            <div className="field-pair"><label className="field"><span>Font</span><select value={overlay.fontFamily} onChange={(event) => props.onText(overlay.id, { fontFamily: event.target.value as TextOverlay["fontFamily"] })}><option value="Outfit">Outfit</option><option value="Rubik">Rubik · العربية</option></select></label><label className="field color-field"><span>Color</span><input type="color" value={overlay.color} onChange={(event) => props.onText(overlay.id, { color: event.target.value })}/></label></div>
            <label className="field range"><span>Font size <em>{overlay.fontSize}px</em></span><ProSlider ariaLabel={`Text ${index + 1} font size`} min={16} max={160} value={overlay.fontSize} onChange={(fontSize) => props.onText(overlay.id, { fontSize })}/></label>
            <div className="field-pair"><label className="field range"><span>Horizontal <em>{overlay.x}%</em></span><ProSlider ariaLabel={`Text ${index + 1} horizontal position`} min={5} max={95} value={overlay.x} onChange={(x) => props.onText(overlay.id, { x })}/></label><label className="field range"><span>Vertical <em>{overlay.y}%</em></span><ProSlider ariaLabel={`Text ${index + 1} vertical position`} min={5} max={95} value={overlay.y} onChange={(y) => props.onText(overlay.id, { y })}/></label></div>
          </div>) : <button className="text-empty" onClick={props.onAddText}><TypeIcon/><span><strong>Add a title or caption</strong><small>Outfit and Arabic-ready Rubik included</small></span></button>}
        </section>
        <section className="settings-card"><h3>Scene narration</h3>
          <button className="file-picker" onClick={props.onChooseNarration}><span>{assignment?.audioPath ? assetName(assignment.audioPath) : "Choose audio clip"}</span><strong>Browse</strong></button>
          <label className="check"><input type="checkbox" checked={assignment?.enabled ?? true} onChange={(event) => props.onNarration({ enabled: event.target.checked })}/> Enable this clip</label>
          <AudioTrimControl label="Scene narration" source={assignment?.audioPath} start={assignment?.trimStartSeconds ?? 0} end={assignment?.trimEndSeconds ?? null} onChange={(trimStartSeconds, trimEndSeconds) => props.onNarration({ trimStartSeconds, trimEndSeconds })}/>
          <div className="field-pair"><NumberField label="Lead padding" value={assignment?.leadingPaddingSeconds ?? 0} onChange={(leadingPaddingSeconds) => props.onNarration({ leadingPaddingSeconds })}/><NumberField label="Tail padding" value={assignment?.trailingPaddingSeconds ?? 0} onChange={(trailingPaddingSeconds) => props.onNarration({ trailingPaddingSeconds })}/></div>
        </section>
      </> : <div className="empty-inspector">Select a scene to edit its timing, motion, transition, and narration.</div>)}
      {tab === "project" && <>
        <div className="inspector-title"><div><span className="eyebrow">Output</span><h2>Project settings</h2></div></div>
        <section className="settings-card"><h3>Canvas</h3>
          <label className="field"><span>Video format</span><select value={props.project.videoFormat} onChange={(event) => props.onProject({ videoFormat: event.target.value, resolution: props.capabilities.formats.find((item) => item.key === event.target.value)?.width + "x" + props.capabilities.formats.find((item) => item.key === event.target.value)?.height })}>{props.capabilities.formats.map((item) => <option key={item.key} value={item.key}>{item.name} · {item.width}×{item.height}</option>)}</select></label>
          <label className="field"><span>Fill mode</span><select value={props.project.fillMode} onChange={(event) => props.onProject({ fillMode: event.target.value })}><option>Fit with blurred background</option><option>Crop to fill</option></select></label>
          <NumberField label="Frames per second" value={props.project.fps} min={1} max={120} step={1} onChange={(fps) => props.onProject({ fps })}/>
          <NumberField label="Minimum scene length" value={props.project.minimumSceneDuration} min={.25} onChange={(minimumSceneDuration) => props.onProject({ minimumSceneDuration })}/>
        </section>
        <section className="settings-card"><h3>Export</h3>
          <label className="field"><span>File name</span><input value={props.project.outputName} onChange={(event) => props.onProject({ outputName: event.target.value })}/></label>
          <label className="field"><span>Output workspace</span><button className="file-picker" onClick={props.onChooseOutput}><span>{props.project.outputFolder ? "Secure server workspace" : "Preparing workspace"}</span><strong>Info</strong></button></label>
        </section>
      </>}
      {tab === "audio" && <>
        <div className="inspector-title"><div><span className="eyebrow">Sound & sync</span><h2>Audio settings</h2></div></div>
        <section className="settings-card"><h3>Track trimming</h3><AudioTrimControl label="Main voice" source={props.project.voiceFile} start={props.project.voiceTrimStartSeconds ?? 0} end={props.project.voiceTrimEndSeconds ?? null} onChange={(voiceTrimStartSeconds, voiceTrimEndSeconds) => props.onProject({ voiceTrimStartSeconds, voiceTrimEndSeconds })}/><AudioTrimControl label="Background music" source={props.project.musicFile} start={props.project.musicTrimStartSeconds ?? 0} end={props.project.musicTrimEndSeconds ?? null} onChange={(musicTrimStartSeconds, musicTrimEndSeconds) => props.onProject({ musicTrimStartSeconds, musicTrimEndSeconds })}/></section>
        <section className="settings-card"><h3>Timeline timing</h3>
          <label className="field"><span>Timing mode</span><select value={props.project.audioTiming.mode} onChange={(event) => props.onTiming({ mode: event.target.value })}>{props.capabilities.timingModes.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select></label>
          {props.project.audioTiming.mode === "silence_aware" && <><NumberField label="Silence threshold (dB)" value={props.project.audioTiming.silenceThresholdDb} min={-100} max={0} step={1} onChange={(silenceThresholdDb) => props.onTiming({ silenceThresholdDb })}/><NumberField label="Minimum silence" value={props.project.audioTiming.minimumSilenceSeconds} min={.01} onChange={(minimumSilenceSeconds) => props.onTiming({ minimumSilenceSeconds })}/></>}
          <NumberField label="Minimum scene duration" value={props.project.audioTiming.minimumSceneSeconds} min={.01} onChange={(minimumSceneSeconds) => props.onTiming({ minimumSceneSeconds })}/>
        </section>
        <section className="settings-card"><h3>Music mix</h3><label className="field range"><span>Background volume <em>{Math.round(props.project.musicVolume * 100)}%</em></span><ProSlider ariaLabel="Background volume" min={0} max={1} step={.01} value={props.project.musicVolume} onChange={(musicVolume) => props.onProject({ musicVolume })}/></label></section>
        <section className="settings-card"><h3>Narration overflow</h3><label className="field"><span>Mismatch strategy</span><select value={props.project.narrationMapping.mismatchStrategy} onChange={(event) => props.onProject({ narrationMapping: { ...props.project.narrationMapping, mismatchStrategy: event.target.value } })}>{props.capabilities.mismatchStrategies.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select></label><NumberField label="Default outro length" value={props.project.narrationMapping.defaultOutroSeconds} onChange={(defaultOutroSeconds) => props.onProject({ narrationMapping: { ...props.project.narrationMapping, defaultOutroSeconds } })}/></section>
      </>}
    </div>
  </aside>;
}
