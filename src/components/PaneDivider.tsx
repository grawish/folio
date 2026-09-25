import { useRef, useState } from 'react';

export function PaneDivider({
  label,
  controls,
  value,
  min,
  max,
  onChange,
  onReset,
}: {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
  onReset(): void;
}) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const change = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  return (
    <div
      className={`pane-divider ${dragging ? 'dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} pixels`}
      title={`${label}. Drag or use Left/Right arrows. Double-click to reset.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current) change(drag.current.value + event.clientX - drag.current.x);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') change(value - step);
        else if (event.key === 'ArrowRight') change(value + step);
        else if (event.key === 'Home') change(min);
        else if (event.key === 'End') change(max);
        else if (event.key === 'Enter') onReset();
        else return;
        event.preventDefault();
      }}
    />
  );
}
