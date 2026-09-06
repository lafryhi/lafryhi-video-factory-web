type Props = {
  value: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  onChange(value: number): void;
};

export function ProSlider({ value, min, max, step = 1, ariaLabel, onChange }: Props) {
  const percentage = max === min ? 0 : Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return <span className="pro-slider-shell">
    <input
      aria-label={ariaLabel}
      className="pro-slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ "--slider-progress": `${percentage}%` } as React.CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  </span>;
}
