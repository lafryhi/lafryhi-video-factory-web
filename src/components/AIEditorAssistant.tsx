import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { aiEditorApi, type AIEditPlan, type AIJob, type AIPreset, type AISource } from "../aiEditor";
import { mediaUrl } from "../api";
import type { Project } from "../types";

const presets: [AIPreset, string][] = [["silence", "Remove Silence"], ["fillers", "Remove Filler Words"], ["subtitles", "Auto Subtitles"], ["reel", "Social Media Reel"], ["talking", "Clean Talking Head"], ["bright", "Bright Color Grade"], ["audio", "Smooth Audio Cuts"]];

export function AIEditorAssistant({ sessionId, disabled, onApply }: { sessionId: string; disabled?: boolean; onApply(project: Project): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const [sources, setSources] = useState<AISource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("Remove long pauses, add subtitles and prepare a vertical 9:16 Reel around 45 seconds.");
  const [language, setLanguage] = useState("en");
  const [chosen, setChosen] = useState<AIPreset[]>(["silence", "subtitles", "reel"]);
  const [analysisId, setAnalysisId] = useState("");
  const [plan, setPlan] = useState<AIEditPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [output, setOutput] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const invalidate = () => { setPlan(null); setOutput(""); };
  async function open() {
    dialog.current?.showModal();
    try { const cap = await aiEditorApi.capabilities(); setAvailable(true); if (!cap.transcription) setWarnings(["Whisper is not configured on this server. Silence editing works; automatic subtitles and filler removal need transcription."]); }
    catch { setAvailable(false); setError("The AI editing backend is not available yet. Your existing editor and Google Flow assistant remain available."); }
  }
  async function work(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStatus("Failed — correct the issue and retry."); }
    finally { if (alive.current) setBusy(false); }
  }
  async function wait(jobId: string): Promise<AIJob> {
    const deadline = Date.now() + 30 * 60_000;
    while (alive.current && Date.now() < deadline) {
      const job = await aiEditorApi.job(sessionId, jobId);
      setStatus(`${job.stage} · ${Math.round(job.progress * 100)}%`);
      if (job.status === "error") throw new Error(job.error || "AI job failed");
      if (job.status === "complete") return job;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error("Stopped waiting for the job. Reopen the panel and analyze again if needed.");
  }
  return <>
    <button className="button ghost" disabled={disabled} onClick={() => void open()}><Sparkles size={16}/> Edit with AI</button>
    <dialog ref={dialog} className="ai-editor-dialog" aria-labelledby="ai-editor-title" onCancel={e => { if (busy) e.preventDefault(); }}>
      <div className="ai-editor-header"><div><span className="eyebrow">Assisted editing · MVP</span><h2 id="ai-editor-title">AI Video Editor</h2></div><button className="button ghost" disabled={busy} onClick={() => dialog.current?.close()}>Close</button></div>
      <p>Upload raw footage or downloaded Flow clips. Review the plan, then add editable scenes to your timeline.</p>
      <p className="muted">Conservative automatic editing. Semantic mistake detection and AI highlight selection are not available yet.</p>
      <fieldset disabled={busy || available !== true}>
        <label>Video clips (up to 10, 200 MB each)<input aria-label="AI video clips" type="file" accept=".mp4,.mov,.webm,.mkv" multiple onChange={event => {
          const files = [...event.target.files || []]; event.target.value = "";
          void work(async () => {
            if (sources.length + files.length > 10) throw new Error("Use at most 10 clips per edit.");
            invalidate(); setAnalysisId("");
            for (const file of files) { setStatus(`Uploading ${file.name}`); const source = await aiEditorApi.upload(sessionId, file); setSources(previous => [...previous, source]); setSelected(previous => [...previous, source.id]); }
            setStatus("Clips uploaded. Ready to analyze.");
          });
        }}/></label>
        {sources.map(source => <label key={source.id} className="ai-source"><input type="checkbox" checked={selected.includes(source.id)} onChange={e => { setSelected(e.target.checked ? [...selected, source.id] : selected.filter(id => id !== source.id)); setAnalysisId(""); invalidate(); }}/>{source.name} · {source.duration.toFixed(1)}s</label>)}
        <label>Editing instruction<textarea rows={4} maxLength={4000} value={instruction} onChange={e => { setInstruction(e.target.value); invalidate(); }}/></label>
        <label>Spoken language<select value={language} onChange={e => { setLanguage(e.target.value); setAnalysisId(""); invalidate(); }}><option value="en">English</option><option value="fr">French</option><option value="ar">Arabic</option></select></label>
        <div className="ai-presets">{presets.map(([value, label]) => <button type="button" className={`button ghost ${chosen.includes(value) ? "active" : ""}`} aria-pressed={chosen.includes(value)} key={value} onClick={() => { setChosen(chosen.includes(value) ? chosen.filter(p => p !== value) : [...chosen, value]); invalidate(); }}>{label}</button>)}</div>
        <button className="button primary" disabled={!selected.length || !instruction.trim()} onClick={() => void work(async () => {
          invalidate(); let id = analysisId;
          if (!id) { const started = await aiEditorApi.analyze(sessionId, selected, language); const analyzed = await wait(started.jobId); id = started.jobId; setAnalysisId(id); setWarnings(analyzed.warnings); }
          setStatus("Building Edit Plan"); const result = await aiEditorApi.plan(sessionId, id, instruction, chosen); setPlan(result.plan); setStatus("Plan ready — review before applying.");
        })}>{analysisId ? "Regenerate Edit Plan" : "Analyze Video"}</button>
      </fieldset>
      <div role="status" aria-live="polite">{status}</div>
      {error && <p role="alert" className="ai-error">{error}</p>}
      {[...new Set([...warnings, ...plan?.warnings || []])].map(warning => <p className="ai-warning" key={warning}>{warning}</p>)}
      {plan && <>
        <p>{plan.operations.filter(o => o.type !== "subtitle").length} suggested cuts · up to {plan.targetDuration.toFixed(1)}s · {plan.aspectRatio}</p>
        <label>Color preset<select disabled={busy} value={plan.video.colorPreset} onChange={e => setPlan({ ...plan, video: { ...plan.video, colorPreset: e.target.value as AIEditPlan["video"]["colorPreset"] } })}>{["original", "bright", "warm", "cool", "contrast", "soft"].map(p => <option key={p}>{p}</option>)}</select></label>
        <details><summary>Structured edit plan</summary><pre>{JSON.stringify(plan, null, 2)}</pre></details>
        <p>Apply appends scenes, sets the project to {plan.aspectRatio}, and keeps your existing scenes. Use Undo to restore the previous project.</p>
        <button className="button primary" disabled={busy || Boolean(output)} onClick={() => void work(async () => {
          const started = await aiEditorApi.render(sessionId, analysisId, plan); const result = await wait(started.jobId);
          if (!result.project || !result.outputPath || !result.review || !Object.values(result.review.checks).every(Boolean)) throw new Error("The render did not pass quality review.");
          onApply(result.project); setOutput(result.outputPath); setStatus("Ready — editable scenes added to your timeline.");
        })}>Apply AI Edit</button>
      </>}
      {output && <video className="ai-result" controls src={mediaUrl(output)}/>}
    </dialog>
  </>;
}
