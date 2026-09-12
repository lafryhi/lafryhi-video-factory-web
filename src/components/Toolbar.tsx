import { Clapperboard, FilePlus2, FolderOpen, Moon, Pause, Play, Redo2, Save, Sun, Undo2 } from "lucide-react";
import { FlowProductionAssistant } from "./FlowProductionAssistant";
import { AIEditorAssistant } from "./AIEditorAssistant";
import type { Project } from "../types";

type Props = {
  sessionId?: string;
  onAIApply?(project: Project): void;
  projectName: string;
  dirty: boolean;
  busy: boolean;
  playing: boolean;
  theme: "dark" | "light";
  canUndo: boolean;
  canRedo: boolean;
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  onAnalyze(): void;
  onPreview(): void;
  onExport(): void;
  onTheme(): void;
};

const Action = ({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
  <button className="tool-button" title={label} aria-label={label} {...props}>{children}<span>{label}</span></button>
);

export function Toolbar(props: Props) {
  return <header className="toolbar">
    <div className="brand"><span className="brand-mark"><Clapperboard size={24}/></span><div><strong>LAFRYHI VIDEO FACTORY</strong><small lang="ar">مصنع الفيديو</small></div></div>
    <div className="tool-group">
      <Action label="New" onClick={props.onNew}><FilePlus2/></Action>
      <Action label="Open" onClick={props.onOpen}><FolderOpen/></Action>
      <Action label="Save" onClick={props.onSave}><Save/></Action>
      <span className="divider" />
      <Action label="Undo" onClick={props.onUndo} disabled={!props.canUndo}><Undo2/></Action>
      <Action label="Redo" onClick={props.onRedo} disabled={!props.canRedo}><Redo2/></Action>
    </div>
    <div className="project-title"><span>{props.projectName}{props.dirty && <i className="dirty-dot" title="Unsaved changes"/>}</span><small>{props.busy ? "Working…" : props.dirty ? "Unsaved changes" : "Saved"}</small></div>
    <div className="toolbar-actions">
      <FlowProductionAssistant/>
      {props.sessionId && props.onAIApply && <AIEditorAssistant key={props.sessionId} sessionId={props.sessionId} onApply={props.onAIApply} disabled={props.busy}/>}
      <button data-testid="analyze" className="button ghost" onClick={props.onAnalyze} disabled={props.busy}>Analyze</button>
      <button data-testid="preview" className={`button ghost ${props.playing ? "active" : ""}`} onClick={props.onPreview} disabled={props.busy}>{props.playing ? <Pause size={16}/> : <Play size={16}/>} {props.playing ? "Pause" : "Play now"}</button>
      <button data-testid="export" className="button primary" onClick={props.onExport} disabled={props.busy}><Clapperboard size={16}/> Export video</button>
      <button data-testid="theme-toggle" className="icon-button" onClick={props.onTheme} title="Toggle color theme" aria-label="Toggle color theme">{props.theme === "dark" ? <Sun/> : <Moon/>}</button>
    </div>
  </header>;
}
