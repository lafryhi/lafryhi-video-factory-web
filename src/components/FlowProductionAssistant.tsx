import { useRef, useState } from "react";
import { ClipboardList } from "lucide-react";
import { allPrompts, exportPackage, generalStyle, masterPrompt, preparePackage, preschoolStyle, sceneLabels, scenePrompt, styleLabels, suggestCharacter, workflowText, type Audience, type FlowPackage, type FlowScene, type FlowStyle } from "../flowProduction";

export function FlowProductionAssistant() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [idea, setIdea] = useState("");
  const [audience, setAudience] = useState<Audience>("Preschool / kids");
  const [format, setFormat] = useState<"9:16" | "16:9">("9:16");
  const [duration, setDuration] = useState("30");
  const [custom, setCustom] = useState("30");
  const [character, setCharacter] = useState<string | null>(null);
  const [style, setStyle] = useState<FlowStyle>({ ...preschoolStyle });
  const [pkg, setPackage] = useState<FlowPackage | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const targetDuration = Number(duration === "custom" ? custom : duration);
  const masterCharacter = character ?? suggestCharacter(idea);
  const current = pkg ? { ...pkg, masterCharacter, style } : null;
  const changed = pkg && (pkg.idea !== idea.trim() || pkg.audience !== audience || pkg.format !== format || pkg.targetDuration !== targetDuration);

  function prepare() {
    setError(""); setNotice("");
    try {
      setPackage(preparePackage({ idea, audience, format, targetDuration, masterCharacter, style }));
      setNotice("Production package prepared. Review and edit each scene before using it in Flow.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not prepare the package."); }
  }
  async function copy(text: string, label: string) {
    setError(""); setNotice("");
    try { await navigator.clipboard.writeText(text); setNotice(`${label} copied.`); }
    catch { setError("Clipboard access is unavailable. Select and copy the prompt text manually, or export the package."); }
  }
  function download(extension: "txt" | "md" | "json") {
    if (!current) return;
    const mime = { txt: "text/plain", md: "text/markdown", json: "application/json" };
    const url = URL.createObjectURL(new Blob([exportPackage(current, extension)], { type: `${mime[extension]};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url; link.download = `google-flow-production.${extension}`;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`${extension.toUpperCase()} export prepared.`);
  }
  function patchScene(index: number, key: Exclude<keyof FlowScene, "duration">, value: string) {
    setPackage(previous => previous ? { ...previous, scenes: previous.scenes.map((scene, i) => i === index ? { ...scene, [key]: value } : scene) } : null);
  }
  return <>
    <button className="button flow-launch" onClick={() => dialog.current?.showModal()}><ClipboardList size={16}/> Prepare for Google Flow</button>
    <dialog ref={dialog} role="dialog" className="flow-dialog" aria-labelledby="flow-title">
      <div className="flow-header"><div><small>PREPARE FOR GOOGLE FLOW</small><h1 id="flow-title">Google Flow Production Assistant</h1></div><button className="button" onClick={() => dialog.current?.close()}>Back to editor</button></div>
      <p>Create a copy-paste-ready production package locally. This tool uses editable story templates; it does not generate video or send your idea to a service. Write in English for English prompts.</p>
      <p>Your draft stays available when this panel is closed. Export it before reloading or leaving the page.</p>
      <form onSubmit={event => { event.preventDefault(); prepare(); }}>
        <section className="flow-card">
          <h2>Production brief</h2>
          <label>Idea (English)<textarea required maxLength={5000} value={idea} onChange={e => setIdea(e.target.value)} placeholder="A cheerful red fox cub learns to identify three colors in a preschool garden."/></label>
          <div className="flow-grid">
            <label>Audience<select value={audience} onChange={e => { const next = e.target.value as Audience; setAudience(next); setStyle({ ...(next === "Preschool / kids" ? preschoolStyle : generalStyle), ...(next === "Educational" ? { ageAppropriateness: "Clear explanations, patient pacing, one learning objective at a time" } : next === "Entertainment" ? { ageAppropriateness: "General audience; engaging pacing and readable reactions" } : {}) }); }}>{["Preschool / kids", "General", "Educational", "Entertainment"].map(value => <option key={value}>{value}</option>)}</select></label>
            <label>Video format<select value={format} onChange={e => setFormat(e.target.value as "9:16" | "16:9")}><option value="9:16">9:16 vertical</option><option value="16:9">16:9 landscape</option></select></label>
            <label>Target duration<select value={duration} onChange={e => setDuration(e.target.value)}><option value="30">30s</option><option value="45">45s</option><option value="60">60s</option><option value="custom">Custom</option></select></label>
            {duration === "custom" && <label>Custom duration (seconds)<input type="number" min="4" max="600" step="1" required value={custom} onChange={e => setCustom(e.target.value)}/></label>}
          </div>
          <button className="button" type="button" onClick={() => { setAudience("Preschool / kids"); setStyle({ ...preschoolStyle }); }}>Apply Preschool Educational Video preset</button>
        </section>
        <section className="flow-card"><h2>Character Consistency</h2><label>Master Character Description<textarea required value={masterCharacter} onChange={e => setCharacter(e.target.value)}/></label><p>Review the suggested identity and specify exact clothing, colors, and distinguishing features. This text is reused verbatim in every scene prompt.</p><button type="button" className="button" onClick={() => void copy(masterCharacter, "Master character")}>Copy Master Character</button></section>
        <section className="flow-card"><h2>Global Style</h2><div className="flow-grid">{(Object.keys(styleLabels) as (keyof FlowStyle)[]).map(key => <label key={key}>{styleLabels[key]}<textarea required value={style[key]} onChange={e => setStyle(previous => ({ ...previous, [key]: e.target.value }))}/></label>)}</div><p>Character and global style edits update the prepared prompts immediately.</p></section>
        <button className="button primary" type="submit">{pkg ? "Prepare for Google Flow again (replace scenes)" : "Prepare for Google Flow"}</button>
      </form>
      <p role="status">{notice}</p>{error && <p role="alert">{error}</p>}
      {current && <section aria-label="Prepared production package">
        <h2>Production package · {current.targetDuration}s · {current.format}</h2>
        {changed && <p role="alert">The brief has changed. Prepare again to update the package. This replaces scene edits.</p>}
        <div className="flow-actions"><button className="button" disabled={!!changed} onClick={() => void copy(allPrompts(current), "All prompts")}>Copy All Prompts</button><button className="button" disabled={!!changed} onClick={() => void copy(masterPrompt(current), "Master prompt")}>Copy Master Prompt</button>{(["txt", "md", "json"] as const).map(extension => <button className="button" disabled={!!changed} key={extension} onClick={() => download(extension)}>Export {extension === "md" ? "Markdown" : extension.toUpperCase()}</button>)}</div>
        <details className="flow-card"><summary>Master Prompt — complete video brief</summary><pre>{masterPrompt(current)}</pre></details>
        <details className="flow-card" open><summary>Recommended Flow workflow</summary><pre>{workflowText(current)}</pre></details>
        {current.scenes.map((scene, index) => <details className="flow-card" key={index} open={index === 0}>
          <summary>{scene.title} · {scene.duration}s · {current.scenes.slice(0, index).reduce((sum, item) => sum + item.duration, 0)}–{current.scenes.slice(0, index + 1).reduce((sum, item) => sum + item.duration, 0)}s</summary>
          <p>Exact planned edited duration: {scene.duration} seconds. Match or trim the clip to this target during assembly.</p>
          <div className="flow-grid">{(Object.keys(sceneLabels) as (Exclude<keyof FlowScene, "duration">)[]).map(key => <label key={key}>{sceneLabels[key]}<textarea value={scene[key]} onChange={e => patchScene(index, key, e.target.value)}/></label>)}</div>
          <h3>Character continuity</h3><p>{current.masterCharacter}</p>
          <h3>Google Flow / Veo prompt (English)</h3><pre>{scenePrompt(current, scene, index)}</pre>
          <button className="button" disabled={!!changed} onClick={() => void copy(scenePrompt(current, scene, index), `Scene ${index + 1} prompt`)}>Copy Scene Prompt</button>
        </details>)}
      </section>}
    </dialog>
  </>;
}
