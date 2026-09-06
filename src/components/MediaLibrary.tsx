import { FileAudio, FolderPlus, ImagePlus, Mic2, Music2, Search } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import { assetName } from "../assets";
import { useFileUrl } from "../hooks";
import type { Project, Scene } from "../types";

function Thumbnail({ scene, index, selected, onSelect, onReorder }: { scene: Scene; index: number; selected: boolean; onSelect(): void; onReorder(from: string, to: string): void }) {
  const url = useFileUrl(scene.imagePath);
  return <button draggable data-testid={`media-scene-${index}`} data-scene-id={scene.sceneId} className={`media-item ${selected ? "selected" : ""}`} onClick={onSelect} title={assetName(scene.imagePath)}
    onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-lafryhi-scene", scene.sceneId); }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-lafryhi-scene")) event.preventDefault(); }}
    onDrop={(event) => { const from = event.dataTransfer.getData("application/x-lafryhi-scene"); if (from) { event.preventDefault(); event.stopPropagation(); onReorder(from, scene.sceneId); } }}>
    <span className="thumb">{url && <img src={url} alt=""/>}</span>
    <span><strong>{assetName(scene.imagePath)}</strong><small>{scene.durationSeconds.toFixed(1)}s · {scene.motion.replace(/([A-Z])/g, " $1").trim()}</small></span>
  </button>;
}

type Props = {
  project: Project;
  selectedId: string | null;
  onSelect(id: string): void;
  onImportImages(): void;
  onVoice(): void;
  onMusic(): void;
  onNarrationFolder(): void;
  onDemo(orientation: "landscape" | "portrait"): void;
  onReorder(from: string, to: string): void;
  onDropImages(files: File[]): void;
  onDropAudio(field: "voiceFile" | "musicFile", file: File): void;
};

export function MediaLibrary(props: Props) {
  const [query, setQuery] = useState("");
  const [dropActive, setDropActive] = useState(false);
  const scenes = useMemo(() => props.project.scenes.filter((scene) => assetName(scene.imagePath).toLowerCase().includes(query.toLowerCase())), [props.project.scenes, query]);
  const externalImages = (event: DragEvent) => [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
  const dropAudio = (field: "voiceFile" | "musicFile", event: DragEvent<HTMLButtonElement>) => {
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(item.name));
    if (file) { event.preventDefault(); event.stopPropagation(); props.onDropAudio(field, file); }
  };
  return <aside className={`media-panel panel ${dropActive ? "drop-active" : ""}`}
    onDragEnter={(event) => { if (externalImages(event).length) setDropActive(true); }}
    onDragOver={(event) => { if (externalImages(event).length) event.preventDefault(); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
    onDrop={(event) => { const files = externalImages(event); setDropActive(false); if (files.length) { event.preventDefault(); props.onDropImages(files); } }}>
    <div className="panel-heading"><div><span className="eyebrow">Assets</span><h2>Media library</h2></div><button data-testid="import-images" className="icon-button" onClick={props.onImportImages} title="Import image folder"><ImagePlus/></button></div>
    <label className="search"><Search/><input data-testid="scene-search" aria-label="Search scenes" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search scenes"/></label>
    <div className="media-scroll">
      <div className="section-label"><span>SCENES</span><span>{props.project.scenes.length}</span></div>
      {scenes.length ? scenes.map((scene, index) => <Thumbnail key={scene.sceneId} scene={scene} index={index} selected={scene.sceneId === props.selectedId} onSelect={() => props.onSelect(scene.sceneId)} onReorder={props.onReorder}/>) :
        <button data-testid="import-images-empty" className="empty-media" onClick={props.onImportImages}><FolderPlus/><strong>Import an image folder</strong><span>PNG, JPG, WebP and more</span></button>}
      <div className="section-label"><span>AUDIO</span></div>
      <button data-testid="voice-file" className="audio-item audio-drop" onClick={props.onVoice} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropAudio("voiceFile", event)}><Mic2/><span><strong>Main voice track</strong><small>{assetName(props.project.voiceFile)}</small><em>Drop MP3 here</em></span></button>
      <button data-testid="music-file" className="audio-item audio-drop" onClick={props.onMusic} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropAudio("musicFile", event)}><Music2/><span><strong>Background music</strong><small>{assetName(props.project.musicFile)}</small><em>Drop MP3 here</em></span></button>
      <button data-testid="narration-folder" className="audio-item" onClick={props.onNarrationFolder}><FileAudio/><span><strong>Map scene narration</strong><small>Match clips to scenes</small></span></button>
    </div>
    <div className="demo-actions" aria-label="Bundled demo projects">
      <button data-testid="load-demo" className="demo-link" onClick={() => props.onDemo("landscape")}><span>16:9</span> Load landscape demo</button>
      <button data-testid="load-demo-portrait" className="demo-link portrait" onClick={() => props.onDemo("portrait")}><span>9:16</span> Load portrait demo</button>
    </div>
  </aside>;
}
