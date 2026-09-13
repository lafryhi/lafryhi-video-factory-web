import { Crop, Focus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { DEFAULT_IMAGE_CROP, normalizeImageCrop } from "../domain";
import { useFileUrl } from "../hooks";
import type { ImageCrop } from "../types";
import { ProSlider } from "./ProSlider";

type Props = {
  imagePath: string;
  crop?: ImageCrop;
  portrait: boolean;
  onChange(crop: ImageCrop): void;
};

export function ImageCropEditor({ imagePath, crop: rawCrop, portrait, onChange }: Props) {
  const crop = normalizeImageCrop(rawCrop);
  const imageUrl = useFileUrl(imagePath);
  const [dragging, setDragging] = useState(false);
  const updateFocus = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    onChange(normalizeImageCrop({ ...crop, enabled: true, x: ((event.clientX - bounds.left) / bounds.width) * 100, y: ((event.clientY - bounds.top) / bounds.height) * 100 }));
  };
  const moveFocus = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) updateFocus(event);
  };
  const patch = (value: Partial<ImageCrop>) => onChange(normalizeImageCrop({ ...crop, ...value }));
  const reset = () => onChange({ ...DEFAULT_IMAGE_CROP });

  return <section className="settings-card crop-settings">
    <div className="card-heading"><h3>Image crop</h3><button data-testid="toggle-image-crop" className={`mini-action ${crop.enabled ? "active" : ""}`} onClick={() => patch({ enabled: !crop.enabled })}><Crop/> {crop.enabled ? "Crop on" : "Enable"}</button></div>
    <div
      data-testid="crop-canvas"
      className={`crop-canvas ${portrait ? "portrait" : "landscape"} ${crop.enabled ? "enabled" : ""}`}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); updateFocus(event); }}
      onPointerMove={moveFocus}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      title="Drag to choose the part of the image to keep"
    >
      {imageUrl && (/\.(mp4|mov|webm|mkv)/i.test(imagePath) || imagePath.includes(":video:") ? (
        <video src={imageUrl} muted preload="metadata" style={{ objectPosition: `${crop.x}% ${crop.y}%`, transform: `scale(${crop.zoom})`, transformOrigin: `${crop.x}% ${crop.y}%` }}/>
      ) : (
        <img src={imageUrl} alt="Crop preview" draggable={false} style={{ objectPosition: `${crop.x}% ${crop.y}%`, transform: `scale(${crop.zoom})`, transformOrigin: `${crop.x}% ${crop.y}%` }}/>
      ))}
      <span className="crop-grid"/><span className="crop-focus" style={{ left: `${crop.x}%`, top: `${crop.y}%` }}><Focus/></span>
    </div>
    <p className="crop-help">Drag the focus point, then zoom until only the part you want remains. The original image stays untouched.</p>
    <label className="field range"><span>Crop zoom <em>{crop.zoom.toFixed(2)}×</em></span><ProSlider ariaLabel="Image crop zoom" min={1} max={5} step={.01} value={crop.zoom} onChange={(zoom) => patch({ enabled: true, zoom })}/></label>
    <div className="field-pair"><label className="field range"><span>Horizontal <em>{Math.round(crop.x)}%</em></span><ProSlider ariaLabel="Image crop horizontal focus" min={0} max={100} value={crop.x} onChange={(x) => patch({ enabled: true, x })}/></label><label className="field range"><span>Vertical <em>{Math.round(crop.y)}%</em></span><ProSlider ariaLabel="Image crop vertical focus" min={0} max={100} value={crop.y} onChange={(y) => patch({ enabled: true, y })}/></label></div>
    <button className="crop-reset" onClick={reset}><RotateCcw/> Reset crop</button>
  </section>;
}
