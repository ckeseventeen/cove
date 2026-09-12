import { useEffect, useRef, useState } from "react";

type Props = {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  className?: string;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
};

export function Slider({ value, min, max, ariaLabel, className, onChange, onCommit }: Props) {
  const [localValue, setLocalValue] = useState(value);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setLocalValue(value);
  }, [value]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    dragging.current = true;
    const next = Number(event.target.value);
    setLocalValue(next);
    onChange(next);
  };

  const handleRelease = () => {
    dragging.current = false;
    onCommit(localValue);
  };

  return (
    <input
      aria-label={ariaLabel}
      type="range"
      className={className}
      min={min}
      max={max}
      value={Math.min(localValue, max)}
      onChange={handleChange}
      onPointerUp={handleRelease}
      onMouseUp={handleRelease}
    />
  );
}
