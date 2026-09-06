import { AlertTriangle, Archive, Check, CheckCircle2, CircleStop, Download, EyeOff, FolderOpen, Info, LoaderCircle, Play, Save, Sparkles, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mediaUrl } from "../api";

export type PopupTone = "info" | "success" | "warning" | "error";
export type PopupAction = { id: string; label: string; variant?: "primary" | "secondary" | "danger"; icon?: "save" | "download" };
export type PopupOptions = {
  tone?: PopupTone;
  eyebrow?: string;
  title: string;
  message: string;
  detail?: string;
  actions?: PopupAction[];
  cancelId?: string | null;
  input?: { label: string; value?: string; placeholder?: string; required?: boolean };
};
export type ToastOptions = { tone?: PopupTone; title: string; message?: string; duration?: number };

type DialogRequest = PopupOptions & { resolve(value: string | null): void };
type ToastItem = ToastOptions & { id: string };
type PopupApi = {
  choose(options: PopupOptions): Promise<string | null>;
  confirm(options: Omit<PopupOptions, "actions"> & { confirmLabel?: string; cancelLabel?: string }): Promise<boolean>;
  alert(options: Omit<PopupOptions, "actions"> & { buttonLabel?: string }): Promise<void>;
  prompt(options: Omit<PopupOptions, "actions" | "input"> & { label: string; value?: string; placeholder?: string }): Promise<string | null>;
  toast(options: ToastOptions): void;
};

const PopupContext = createContext<PopupApi | null>(null);
const toneIcon = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };
const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function keepFocusInside(event: KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((item) => !item.hidden && item.getAttribute("aria-hidden") !== "true");
  if (!items.length) { event.preventDefault(); container.focus(); return; }
  const first = items[0]; const last = items.at(-1)!;
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function ActionIcon({ icon }: { icon?: PopupAction["icon"] }) {
  if (icon === "save") return <Save/>;
  if (icon === "download") return <Download/>;
  return null;
}

export function PopupProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const primary = useRef<HTMLButtonElement>(null);
  const promptInput = useRef<HTMLInputElement>(null);
  const dialogCard = useRef<HTMLElement>(null);
  const inputValueRef = useRef("");

  const closeDialog = useCallback((value: string | null) => {
    setDialog((current) => {
      if (current) current.resolve(current.input ? (value === "submit" ? inputValueRef.current.trim() : null) : value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!dialog) return;
    inputValueRef.current = dialog.input?.value || "";
    setInputValue(inputValueRef.current);
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => (dialog.input ? promptInput.current : primary.current)?.focus(), 20);
    const keyHandler = (event: KeyboardEvent) => {
      keepFocusInside(event, dialogCard.current);
      if (event.key === "Escape" && dialog.cancelId !== null) { event.preventDefault(); closeDialog(dialog.cancelId || null); }
    };
    window.addEventListener("keydown", keyHandler);
    return () => { window.clearTimeout(focusTimer); window.removeEventListener("keydown", keyHandler); document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [dialog, closeDialog]);

  const choose = useCallback((options: PopupOptions) => new Promise<string | null>((resolve) => setDialog({ tone: "info", cancelId: null, ...options, resolve })), []);
  const confirm = useCallback(async (options: Omit<PopupOptions, "actions"> & { confirmLabel?: string; cancelLabel?: string }) => {
    const result = await choose({ ...options, cancelId: "cancel", actions: [{ id: "cancel", label: options.cancelLabel || "Cancel", variant: "secondary" }, { id: "confirm", label: options.confirmLabel || "Continue", variant: options.tone === "error" || options.tone === "warning" ? "danger" : "primary" }] });
    return result === "confirm";
  }, [choose]);
  const alert = useCallback(async (options: Omit<PopupOptions, "actions"> & { buttonLabel?: string }) => {
    await choose({ ...options, cancelId: "ok", actions: [{ id: "ok", label: options.buttonLabel || "Got it", variant: "primary" }] });
  }, [choose]);
  const prompt = useCallback((options: Omit<PopupOptions, "actions" | "input"> & { label: string; value?: string; placeholder?: string }) => choose({ ...options, cancelId: "cancel", input: { label: options.label, value: options.value, placeholder: options.placeholder, required: true }, actions: [{ id: "cancel", label: "Cancel", variant: "secondary" }, { id: "submit", label: "Save project", variant: "primary", icon: "save" }] }), [choose]);
  const toast = useCallback((options: ToastOptions) => {
    const id = crypto.randomUUID();
    setToasts((items) => [...items, { tone: "info", duration: 4200, ...options, id }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), options.duration ?? 4200);
  }, []);
  const api = useMemo(() => ({ choose, confirm, alert, prompt, toast }), [choose, confirm, alert, prompt, toast]);
  const ToneIcon = dialog ? toneIcon[dialog.tone || "info"] : Info;

  return <PopupContext.Provider value={api}>
    {children}
    <div className="toast-region" aria-live="polite" aria-label="Notifications">
      {toasts.map((item) => { const Icon = toneIcon[item.tone || "info"]; return <div key={item.id} className={`toast-card ${item.tone || "info"}`} data-testid="toast">
        <span className="toast-icon"><Icon/></span><div><strong>{item.title}</strong>{item.message && <p>{item.message}</p>}</div>
        <button aria-label="Dismiss notification" onClick={() => setToasts((items) => items.filter((entry) => entry.id !== item.id))}><X/></button>
        <i className="toast-life" style={{ animationDuration: `${item.duration ?? 4200}ms` }}/>
      </div>; })}
    </div>
    {dialog && <div className="popup-backdrop" data-testid="popup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && dialog.cancelId !== null) closeDialog(dialog.cancelId || null); }}>
      <section ref={dialogCard} className={`popup-card ${dialog.tone || "info"}`} role={dialog.tone === "error" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="popup-title" aria-describedby="popup-message" tabIndex={-1}>
        <div className="popup-glow"/><div className="popup-topline"><span><Sparkles/> {dialog.eyebrow || "LAFRYHI VIDEO FACTORY"}</span>{dialog.cancelId !== null && <button aria-label="Close dialog" onClick={() => closeDialog(dialog.cancelId || null)}><X/></button>}</div>
        <div className="popup-hero"><span className="popup-icon"><ToneIcon/></span><div><h2 id="popup-title">{dialog.title}</h2><p id="popup-message">{dialog.message}</p></div></div>
        {dialog.detail && <div className="popup-detail">{dialog.detail}</div>}
        {dialog.input && <label className="popup-input"><span>{dialog.input.label}</span><input ref={promptInput} value={inputValue} placeholder={dialog.input.placeholder} onChange={(event) => { inputValueRef.current = event.target.value; setInputValue(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && inputValue.trim()) closeDialog("submit"); }}/></label>}
        <div className="popup-actions">{(dialog.actions || []).map((action, index) => <button key={action.id} ref={index === (dialog.actions?.length || 1) - 1 ? primary : undefined} className={`popup-button ${action.variant || "secondary"}`} disabled={dialog.input?.required && action.id === "submit" && !inputValue.trim()} onClick={() => closeDialog(action.id)}><ActionIcon icon={action.icon}/>{action.label}</button>)}</div>
      </section>
    </div>}
  </PopupContext.Provider>;
}

export function usePopups(): PopupApi {
  const value = useContext(PopupContext);
  if (!value) throw new Error("usePopups must be used inside PopupProvider");
  return value;
}

export type ExportPopupState = {
  open: boolean;
  status: "running" | "success" | "error" | "cancelled";
  progress: number;
  stage: string;
  logs: string[];
  error?: string;
  output?: string;
  showVideo?: boolean;
};

export function ExportProgressPopup({ state, desktop = false, onCancel, onClose, onShowVideo, onOpenVideo, onRetry }: { state: ExportPopupState; desktop?: boolean; onCancel(): void; onClose(): void; onShowVideo(): void; onOpenVideo?(): void; onRetry(): void }) {
  const card = useRef<HTMLElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!state.open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => firstAction.current?.focus(), 20);
    const keyHandler = (event: KeyboardEvent) => {
      keepFocusInside(event, card.current);
      if (event.key === "Escape" && state.status !== "running") { event.preventDefault(); onCloseRef.current(); }
    };
    window.addEventListener("keydown", keyHandler);
    return () => { window.clearTimeout(focusTimer); window.removeEventListener("keydown", keyHandler); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [state.open, state.status]);
  if (!state.open) return null;
  const percent = Math.round(Math.max(0, Math.min(1, state.progress)) * 100);
  const running = state.status === "running";
  const content = state.status === "success"
    ? { tone: "success", title: "Your video is ready", message: desktop ? "The final MP4 was rendered successfully and is ready to open." : "The final MP4 was rendered successfully and is ready to download.", icon: <Check/> }
    : state.status === "error"
      ? { tone: "error", title: "Export could not finish", message: state.error || "The video engine reported an unexpected error.", icon: <XCircle/> }
      : state.status === "cancelled"
        ? { tone: "warning", title: "Export cancelled", message: "Your project and local media are safe. You can export again whenever you are ready.", icon: <CircleStop/> }
        : { tone: "info", title: "Creating your video", message: "Media is uploaded only for this export. You can cancel safely at any time.", icon: <LoaderCircle className="spin"/> };
  return <div className="popup-backdrop export-backdrop" data-testid="export-popup">
    <section ref={card} className={`popup-card export-popup ${content.tone}`} role="dialog" aria-modal="true" aria-labelledby="export-title" aria-describedby="export-message" tabIndex={-1}>
      <div className="popup-glow"/><div className="popup-topline"><span><Sparkles/> EXPORT STUDIO</span>{!running && <button aria-label="Close export dialog" onClick={onClose}><X/></button>}</div>
      <div className="popup-hero"><span className="popup-icon">{content.icon}</span><div><h2 id="export-title">{content.title}</h2><p id="export-message">{content.message}</p></div></div>
      <div className="export-status"><div><span>{running ? state.stage || "Preparing export" : state.status === "success" ? "Completed" : state.status === "error" ? "Stopped with an error" : "Stopped"}</span><strong>{running ? `${percent}%` : state.status === "success" ? "100%" : "Stopped"}</strong></div><div className="popup-progress" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${state.status === "success" ? 100 : percent}%` }}/></div></div>
      {state.status === "success" && state.showVideo && state.output && <div className="export-video-shell"><video data-testid="export-video" src={mediaUrl(state.output)} controls autoPlay playsInline preload="metadata">Your browser cannot play this MP4.</video></div>}
      {state.logs.length > 0 && <details className="export-logs"><summary>Technical details <span>{state.logs.length} events</span></summary><pre>{state.logs.join("\n")}</pre></details>}
      <div className="popup-actions">
        {running && <button ref={firstAction} data-testid="cancel-export" className="popup-button danger" onClick={onCancel}><CircleStop/> Cancel export</button>}
        {state.status === "success" && <><button ref={firstAction} className="popup-button secondary" onClick={onClose}>Close</button>{desktop ? state.output && <button data-testid="open-export" className="popup-button primary" onClick={onOpenVideo}><Play/> Open video</button> : <><button data-testid="show-export" className="popup-button secondary" onClick={onShowVideo}>{state.showVideo ? <EyeOff/> : <Play/>} {state.showVideo ? "Hide video" : "Play video"}</button>{state.output && <a data-testid="download-export" className="popup-button primary" href={mediaUrl(state.output, true)}><Download/> Download MP4</a>}</>}</>}
        {(state.status === "error" || state.status === "cancelled") && <><button ref={firstAction} className="popup-button secondary" onClick={onClose}>Close</button><button data-testid="retry-export" className="popup-button primary" onClick={onRetry}>Try again</button></>}
      </div>
    </section>
  </div>;
}

export type PackagePopupState = {
  open: boolean;
  mode: "save" | "open";
  status: "running" | "success" | "error" | "cancelled";
  progress: number;
  stage: string;
  fileName?: string;
  error?: string;
};

export function PackageProgressPopup({ state, onCancel, onClose, onRetry }: { state: PackagePopupState; onCancel(): void; onClose(): void; onRetry(): void }) {
  const card = useRef<HTMLElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!state.open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => firstAction.current?.focus(), 20);
    const keyHandler = (event: KeyboardEvent) => {
      keepFocusInside(event, card.current);
      if (event.key === "Escape" && state.status !== "running") { event.preventDefault(); onCloseRef.current(); }
    };
    window.addEventListener("keydown", keyHandler);
    return () => { window.clearTimeout(focusTimer); window.removeEventListener("keydown", keyHandler); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [state.open, state.status]);
  if (!state.open) return null;
  const running = state.status === "running";
  const saving = state.mode === "save";
  const percent = Math.round(Math.max(0, Math.min(1, state.progress)) * 100);
  const content = state.status === "success"
    ? { tone: "success", title: saving ? "Full project saved" : "Project opened", message: saving ? `${state.fileName || "Your LVF project"} contains the timeline and all source media.` : `${state.fileName || "The LVF project"} is restored and ready to edit.`, icon: <Check/> }
    : state.status === "error"
      ? { tone: "error", title: saving ? "Project could not be saved" : "Project could not be opened", message: state.error || "The project package could not be processed.", icon: <XCircle/> }
      : state.status === "cancelled"
        ? { tone: "warning", title: saving ? "Save cancelled" : "Open cancelled", message: "The project currently in the editor was left unchanged.", icon: <CircleStop/> }
        : { tone: "info", title: saving ? "Saving complete project" : "Opening complete project", message: saving ? "Images, audio, text, and timeline settings are being packed into one portable LVF file." : "The package structure and every media checksum are being verified before the editor changes.", icon: <LoaderCircle className="spin"/> };
  const progressLabel = saving ? "Project save progress" : "Project open progress";
  return <div className="popup-backdrop export-backdrop" data-testid="package-popup">
    <section ref={card} className={`popup-card export-popup ${content.tone}`} role="dialog" aria-modal="true" aria-labelledby="package-title" aria-describedby="package-message" tabIndex={-1}>
      <div className="popup-glow"/><div className="popup-topline"><span>{saving ? <Archive/> : <FolderOpen/>} PORTABLE LVF PROJECT</span>{!running && <button aria-label="Close project dialog" onClick={onClose}><X/></button>}</div>
      <div className="popup-hero"><span className="popup-icon">{content.icon}</span><div><h2 id="package-title">{content.title}</h2><p id="package-message">{content.message}</p></div></div>
      <div className="export-status"><div><span>{running ? state.stage : state.status === "success" ? "Completed and verified" : state.status === "error" ? "Stopped with an error" : "Stopped"}</span><strong>{running ? `${percent}%` : state.status === "success" ? "100%" : "Stopped"}</strong></div><div className="popup-progress" role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${state.status === "success" ? 100 : percent}%` }}/></div></div>
      <div className="popup-actions">
        {running && <button ref={firstAction} data-testid="cancel-package" className="popup-button danger" onClick={onCancel}><CircleStop/> Cancel</button>}
        {state.status === "success" && <button ref={firstAction} className="popup-button primary" onClick={onClose}>Continue editing</button>}
        {(state.status === "error" || state.status === "cancelled") && <><button ref={firstAction} className="popup-button secondary" onClick={onClose}>Close</button><button data-testid="retry-package" className="popup-button primary" onClick={onRetry}>Try again</button></>}
      </div>
    </section>
  </div>;
}
