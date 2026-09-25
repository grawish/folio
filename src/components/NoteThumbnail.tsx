import { useEffect, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import type { PdfAnnotation } from '../shared/ai';
import { renderNoteThumbnail } from '../pdf-feedback';

const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
function thumbnail(projectId: string, note: PdfAnnotation): Promise<string> {
  const key = JSON.stringify([projectId, note]);
  const existing = cache.get(key);
  if (existing) return existing;
  // Render visible attachments one at a time and keep a bounded image cache.
  const task = queue
    .catch(() => {})
    .then(async () => {
      const snapshot = await window.folio?.readVersion(projectId, note.versionId);
      if (!snapshot) throw new Error('PDF version unavailable');
      return renderNoteThumbnail(snapshot.pdf, note);
    });
  queue = task;
  cache.set(key, task);
  if (cache.size > 60) cache.delete(cache.keys().next().value!);
  void task.catch(() => cache.delete(key));
  return task;
}

export function NoteThumbnail({ projectId, note }: { projectId: string; note: PdfAnnotation }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [image, setImage] = useState('');
  const identity = JSON.stringify(note);
  useEffect(() => {
    let cancelled = false;
    setImage('');
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void thumbnail(projectId, JSON.parse(identity))
        .then((value) => {
          if (!cancelled) setImage(value);
        })
        .catch(() => {});
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [projectId, identity]);
  return (
    <span className="chat-note-preview" ref={ref}>
      {image ? (
        <img src={image} alt={`Marked area on PDF page ${note.page}`} />
      ) : (
        <Paperclip size={16} />
      )}
    </span>
  );
}
