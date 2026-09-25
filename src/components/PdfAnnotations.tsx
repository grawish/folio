import { useEffect, useRef, useState } from 'react';
import type { AnnotationTool, PdfAnnotation, Point } from '../shared/ai';
import { drawAnnotation } from '../pdf-feedback';
import { pdfCanvasSize } from '../pdf-policy';

export function PdfAnnotations({
  notes,
  tool,
  page,
  versionId,
  width,
  height,
  canvasCount,
  onAdd,
  onSelect,
}: {
  notes: PdfAnnotation[];
  tool: AnnotationTool;
  page: number;
  versionId: string;
  width: number;
  height: number;
  canvasCount: number;
  onAdd(note: PdfAnnotation): void;
  onSelect?(id: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<PdfAnnotation | null>(null);
  const start = useRef<Point | null>(null),
    points = useRef<Point[]>([]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const pixels = pdfCanvasSize(width, height, window.devicePixelRatio, canvasCount);
    element.width = pixels.width;
    element.height = pixels.height;
    const context = element.getContext('2d')!;
    for (const note of [...notes, ...(draft ? [draft] : [])])
      drawAnnotation(context, note, element.width, element.height);
    return () => {
      element.width = 0;
      element.height = 0;
    };
  }, [notes, draft, width, height, canvasCount]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const make = (end: Point): PdfAnnotation => {
    const from = start.current ?? end;
    const all = tool === 'pen' ? [...points.current, end] : [from, end];
    const x = Math.min(...all.map((p) => p.x)),
      y = Math.min(...all.map((p) => p.y));
    const right = Math.max(...all.map((p) => p.x)),
      bottom = Math.max(...all.map((p) => p.y));
    return {
      id: crypto.randomUUID(),
      versionId,
      page,
      kind: tool === 'select' ? 'note' : tool,
      rect: {
        x,
        y,
        width: Math.min(1 - x, Math.max(0.003, right - x)),
        height: Math.min(1 - y, Math.max(0.003, bottom - y)),
      },
      points: tool === 'pen' ? [...points.current] : undefined,
      text: '',
      createdAt: new Date().toISOString(),
    };
  };
  return (
    <div className="pdf-annotation-layer">
      <canvas
        ref={canvas}
        className={tool === 'select' ? 'select-mode' : 'draw-mode'}
        style={{ width, height }}
        tabIndex={tool === 'select' ? -1 : 0}
        aria-label={`Draw ${tool} on PDF page ${page}. Press Enter to add a note at the center.`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && tool !== 'select') {
            event.preventDefault();
            start.current = { x: 0.4, y: 0.4 };
            const note = make({ x: 0.6, y: 0.5 });
            note.kind = 'note';
            onAdd(note);
            start.current = null;
          }
        }}
        onPointerDown={(event) => {
          if (tool === 'select' || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const p = point(event);
          start.current = p;
          points.current = [p];
          setDraft(make(p));
        }}
        onPointerMove={(event) => {
          if (!start.current) return;
          const p = point(event);
          if (points.current.length < 2000) points.current.push(p);
          setDraft(make(p));
        }}
        onPointerCancel={() => {
          start.current = null;
          setDraft(null);
        }}
        onPointerUp={(event) => {
          if (!start.current) return;
          const note = make(point(event));
          if (tool === 'highlight') {
            const sheet = event.currentTarget.closest('.pdf-sheet')!,
              bounds = sheet.getBoundingClientRect();
            const left = bounds.left + note.rect.x * width,
              top = bounds.top + note.rect.y * height;
            note.selectedText = [...sheet.querySelectorAll('.textLayer span')]
              .filter((span) => {
                const r = span.getBoundingClientRect();
                return (
                  r.right > left &&
                  r.left < left + note.rect.width * width &&
                  r.bottom > top &&
                  r.top < top + note.rect.height * height
                );
              })
              .map((span) => span.textContent)
              .join(' ')
              .slice(0, 8000);
          }
          start.current = null;
          setDraft(null);
          onAdd(note);
        }}
      />
      {notes.map((note, index) => (
        <button
          className="pdf-note-marker"
          key={note.id}
          style={{
            left: `${Math.min(0.95, note.rect.x) * 100}%`,
            top: `${Math.min(0.97, note.rect.y) * 100}%`,
          }}
          onClick={() => onSelect?.(note.id)}
          disabled={!onSelect}
          aria-label={`${onSelect ? 'Edit note' : 'Note'} ${index + 1} on page ${page}: ${note.text || note.kind}`}
          title={note.text || 'Edit PDF note'}
        >
          {index + 1}
        </button>
      ))}
    </div>
  );
}
