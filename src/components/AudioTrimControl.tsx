import { Pause, Play, Scissors } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { normalizeAudioTrim } from "../domain";
import { useFileUrl } from "../hooks";
import { ProSlider } from "./ProSlider";

type Props = {
  label: string;
  source?: string | null;
  start: number;
  end: number | null;
  onChange(start: number, end: number | null): void;
};

export function AudioTrimControl({ label, source, start, end, onChange }: Props) {
  const url = useFileUrl(source);
  const audio = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const effectiveEnd = end ?? duration;
  useEffect(() => { setDuration(0); setPreviewing(false); }, [url]);
  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    const stopAtEnd = () => {
      if (effectiveEnd > 0 && player.currentTime >= effectiveEnd - .015) { player.pause(); setPreviewing(false); }
    };
    player.addEventListener("timeupdate", stopAtEnd);
    player.addEventListener("ended", stopAtEnd);
    return () => { player.removeEventListener("timeupdate", stopAtEnd); player.removeEventListener("ended", stopAtEnd); };
  }, [effectiveEnd]);
  const update = (nextStart: unknown, nextEnd: unknown) => {
    const normalized = normalizeAudioTrim(nextStart, nextEnd, duration || Number.POSITIVE_INFINITY);
    onChange(normalized.start, normalized.end);
  };
  const togglePreview = () => {
    const player = audio.current;
    if (!player || !duration) return;
    if (previewing) { player.pause(); setPreviewing(false); return; }
    player.currentTime = Math.min(start, Math.max(0, duration - .05));
    void player.play().then(() => setPreviewing(true)).catch(() => setPreviewing(false));
  };

  return <div className={`audio-trim ${source ? "ready" : "empty"}`} data-testid={`audio-trim-${label.toLowerCase().replace(/\s+/g, "-")}`}>
    <div className="audio-trim-heading"><span><Scissors/> {label}</span><button className="icon-button compact" aria-label={`Preview ${label} selection`} disabled={!duration} onClick={togglePreview}>{previewing ? <Pause/> : <Play/>}</button></div>
    {source ? <>
      <div className="trim-wave"><div className="trim-muted left" style={{ width: `${duration ? start / duration * 100 : 0}%` }}/><div className="trim-selection" style={{ left: `${duration ? start / duration * 100 : 0}%`, right: `${duration ? Math.max(0, 100 - effectiveEnd / duration * 100) : 0}%` }}/><div className="trim-muted right" style={{ width: `${duration ? Math.max(0, 100 - effectiveEnd / duration * 100) : 0}%` }}/>{Array.from({ length: 36 }, (_, index) => <i key={index} style={{ height: `${24 + (index * 43 % 70)}%` }}/>)}</div>
      {duration > 0 && <><label className="field range"><span>Start <em>{start.toFixed(2)}s</em></span><ProSlider ariaLabel={`${label} trim start`} min={0} max={Math.max(0, effectiveEnd - .05)} step={.01} value={Math.min(start, Math.max(0, effectiveEnd - .05))} onChange={(value) => update(value, end)}/></label><label className="field range"><span>End <em>{effectiveEnd.toFixed(2)}s</em></span><ProSlider ariaLabel={`${label} trim end`} min={Math.min(duration, start + .05)} max={duration} step={.01} value={effectiveEnd} onChange={(value) => update(start, value >= duration - .01 ? null : value)}/></label></>}
      <div className="field-pair trim-numbers"><label className="field"><span>Start seconds</span><input type="number" min={0} max={duration || undefined} step={.01} value={start} onChange={(event) => update(event.target.value, end)}/></label><label className="field"><span>End seconds</span><input type="number" min={0} max={duration || undefined} step={.01} value={end ?? ""} placeholder={duration ? `Full · ${duration.toFixed(2)}s` : "Full length"} onChange={(event) => update(start, event.target.value)}/></label></div>
      <audio ref={audio} src={url} preload="metadata" onLoadedMetadata={(event) => {
        const measured = event.currentTarget.duration;
        if (!Number.isFinite(measured) || measured <= 0) return;
        setDuration(measured);
        const normalized = normalizeAudioTrim(start, end, measured);
        if (normalized.start !== start || normalized.end !== end) onChange(normalized.start, normalized.end);
      }}/>
    </> : <p>Add an audio file to select the part you want to keep.</p>}
  </div>;
}
