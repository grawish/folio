import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import './pdf-text-layer.css';
import {
  ArrowDown,
  ArrowUp,
  FileText,
  LoaderCircle,
  Maximize,
  Minus,
  Plus,
  MousePointer2,
  Highlighter,
  Pencil,
  Square,
  MessageSquare,
  Send,
  X,
  Trash2,
} from 'lucide-react';
import type { AnnotationTool, PdfAnnotation } from '../shared/ai';
import { PdfAnnotations } from './PdfAnnotations';
import { usePdfDocument } from '../usePdfDocument';
import {
  PDF_LIMITS,
  pdfCanvasSize,
  pdfPageLayout,
  visiblePdfPages,
  pdfScrollAnchor,
  pdfScrollPosition,
} from '../pdf-policy';

function PdfPageContent({
  document,
  number,
  width,
  height,
  visibleCount,
  onError,
  onBusy,
  onReady,
  feedback,
}: {
  document: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  visibleCount: number;
  onError(message: string): void;
  onBusy(page: number): void;
  onReady(page: number): void;
  feedback?: {
    notes: PdfAnnotation[];
    tool: AnnotationTool;
    versionId: string;
    onAdd(note: PdfAnnotation): void;
    onSelect?(id: string): void;
  };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<{ url: string; rect: number[] }[]>([]);
  useEffect(() => {
    let stopped = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    let renderedPage: PDFPageProxy | undefined;
    const element = canvas.current;
    const textElement = text.current;
    const active = () => !stopped && !!element?.isConnected && !!textElement?.isConnected;
    onBusy(number);
    setLinks([]);
    const timer = window.setTimeout(() => {
      if (!active()) return;
      stopped = true;
      render?.cancel();
      layer?.cancel();
      if (element) {
        element.width = 0;
        element.height = 0;
      }
      onError(
        `PDF page ${number} took too long to render. Reduce its images or complexity and build again.`,
      );
    }, PDF_LIMITS.renderMs);
    const work = (async () => {
      const page = await document.getPage(number);
      if (!active()) {
        page.cleanup();
        return;
      }
      renderedPage = page;
      const scale = width / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      if (!element || !textElement) return;
      const pixels = pdfCanvasSize(
        viewport.width,
        viewport.height,
        window.devicePixelRatio,
        visibleCount * 2,
      );
      element.width = pixels.width;
      element.height = pixels.height;
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      textElement.replaceChildren();
      textElement.style.setProperty('--scale-factor', String(scale));
      textElement.style.setProperty('--total-scale-factor', String(scale));
      const content = await page.getTextContent();
      if (!active()) return;
      layer = new TextLayer({ textContentSource: content, container: textElement, viewport });
      // Attach rejection handlers immediately, including when Strict Mode or a
      // resize cancels rendering before text extraction has finished.
      render = page.render({
        canvas: element,
        viewport,
        transform: [pixels.width / viewport.width, 0, 0, pixels.height / viewport.height, 0, 0],
      });
      await Promise.all([render.promise, layer.render()]);
      if (!active()) return;
      const annotations = await page.getAnnotations();
      if (!active()) return;
      setLinks(
        annotations
          .filter((a) => a.url && a.rect)
          .map((a) => {
            const [m0, m1, m2, m3, m4, m5] = viewport.transform;
            const [x1, y1, x2, y2] = a.rect;
            return {
              url: a.url,
              rect: [
                m0 * x1 + m2 * y1 + m4,
                m1 * x1 + m3 * y1 + m5,
                m0 * x2 + m2 * y2 + m4,
                m1 * x2 + m3 * y2 + m5,
              ],
            };
          }),
      );
      onReady(number);
    })()
      .catch((error) => {
        if (
          active() &&
          error.name !== 'RenderingCancelledException' &&
          error.name !== 'AbortException'
        )
          onError(`PDF page ${number} could not be rendered. ${error.message}`);
      })
      .finally(() => clearTimeout(timer));
    void work;
    return () => {
      stopped = true;
      clearTimeout(timer);
      render?.cancel();
      layer?.cancel();
      // Release the backing surface immediately when this page leaves the
      // window. Page cleanup also releases its operators after cancellation.
      if (element) {
        element.width = 0;
        element.height = 0;
      }
      void work.then(() => renderedPage?.cleanup());
    };
  }, [document, number, width, visibleCount, onError, onBusy, onReady]);
  return (
    <>
      <canvas ref={canvas} aria-label={`Resume preview, page ${number}`} />
      <div className="textLayer" ref={text} />
      <div className="pdf-links">
        {links.map((link, i) => (
          <a
            key={i}
            href={link.url}
            title={link.url}
            aria-label={link.url}
            onClick={(e) => {
              e.preventDefault();
              void window.folio?.openExternal(link.url);
            }}
            style={{
              left: Math.min(link.rect[0], link.rect[2]),
              top: Math.min(link.rect[1], link.rect[3]),
              width: Math.abs(link.rect[2] - link.rect[0]),
              height: Math.abs(link.rect[3] - link.rect[1]),
            }}
          />
        ))}
      </div>
      {feedback && (
        <PdfAnnotations
          {...feedback}
          page={number}
          width={width}
          height={height}
          canvasCount={visibleCount * 2}
        />
      )}
    </>
  );
}

export type PdfPreviewHandle = { waitForPdf(data: Uint8Array): Promise<void> };

export const PdfPreview = forwardRef<
  PdfPreviewHandle,
  {
    data?: Uint8Array;
    building: boolean;
    stale: boolean;
    status: import('react').ReactNode;
    versionId?: string;
    annotations?: PdfAnnotation[];
    onAnnotations?(notes: PdfAnnotation[]): void;
    onAttach?(ids: string[]): void;
    focusNoteId?: string;
  }
>(function PdfPreview(
  {
    data,
    building,
    stale,
    status,
    versionId,
    annotations = [],
    onAnnotations,
    onAttach,
    focusNoteId,
  },
  ref,
) {
  const [tool, setTool] = useState<AnnotationTool>('select');
  const [editing, setEditing] = useState<string | null>(null),
    [noteText, setNoteText] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]),
    [notesOpen, setNotesOpen] = useState(false);
  const currentNotes = annotations.filter((note) => note.versionId === versionId);
  const editingNote = currentNotes.find((note) => note.id === editing);
  const selectNote = (id: string) => {
    const note = annotations.find((n) => n.id === id);
    if (note) {
      setEditing(id);
      setNoteText(note.text);
    }
  };
  const { document, sizes, acceptedData, loading, error, confirmRendered, rejectRender } =
    usePdfDocument(data);
  const [painted, setPainted] = useState<{ document: PDFDocumentProxy | null; pages: Set<number> }>(
    { document: null, pages: new Set() },
  );
  const pageBusy = useCallback(
    (number: number) => {
      setPainted((previous) => {
        if (previous.document !== document) return { document, pages: new Set() };
        if (!previous.pages.has(number)) return previous;
        const pages = new Set(previous.pages);
        pages.delete(number);
        return { document, pages };
      });
    },
    [document],
  );
  const pageReady = useCallback(
    (number: number) => {
      setPainted((previous) => ({
        document,
        pages: new Set([...(previous.document === document ? previous.pages : []), number]),
      }));
    },
    [document],
  );
  const readiness = useRef({ data, acceptedData, error, ready: false });
  const waiters = useRef(new Set<{ data: Uint8Array; finish(error?: string): void }>());
  useImperativeHandle(
    ref,
    () => ({
      waitForPdf(expected) {
        const current = readiness.current;
        if (current.data === expected && current.error)
          return Promise.reject(new Error(current.error));
        if (current.data === expected && current.acceptedData === expected && current.ready)
          return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const waiter = {
            data: expected,
            finish(error?: string) {
              clearTimeout(timer);
              waiters.current.delete(waiter);
              if (error) reject(new Error(error));
              else resolve();
            },
          };
          const timer = window.setTimeout(
            () => waiter.finish('Wait for the PDF preview to finish loading before exporting.'),
            PDF_LIMITS.loadMs + PDF_LIMITS.renderMs + 1000,
          );
          waiters.current.add(waiter);
        });
      },
    }),
    [],
  );
  useEffect(
    () => () => {
      for (const waiter of waiters.current) waiter.finish('The PDF preview was closed.');
    },
    [],
  );
  const [width, setWidth] = useState(500);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const pageWidth = Math.min(width, 850) * zoom;
  const layout = useMemo(() => pdfPageLayout(sizes, pageWidth), [sizes, pageWidth]);
  const previousLayout = useRef({ layout, document });
  const currentLayout = useRef({ layout, document });
  currentLayout.current = { layout, document };
  const positions = useRef(new WeakMap<PDFDocumentProxy, ReturnType<typeof pdfScrollAnchor>>());
  useLayoutEffect(() => {
    const element = scroll.current,
      before = previousLayout.current;
    previousLayout.current = { layout, document };
    if (!element || !before.layout.length || !layout.length) return;
    const remembered =
      before.document !== document
        ? (document && positions.current.get(document)) ||
          (before.document && positions.current.get(before.document))
        : undefined;
    const anchor = remembered || pdfScrollAnchor(before.layout, element.scrollTop);
    element.scrollTop = pdfScrollPosition(layout, anchor);
  }, [layout, document]);
  const visible = visiblePdfPages(layout, viewport.top, viewport.height);
  const visibleCount = visible.end - visible.start + 1;
  const visibleReady =
    !!document &&
    painted.document === document &&
    layout
      .slice(visible.start, visible.end + 1)
      .every((_, index) => painted.pages.has(visible.start + index + 1));
  useEffect(() => {
    if (visibleReady && !loading && !error) confirmRendered();
  }, [visibleReady, loading, error, confirmRendered]);
  readiness.current = { data, acceptedData, error, ready: visibleReady };
  useEffect(() => {
    for (const waiter of waiters.current) {
      if (waiter.data !== data) continue;
      if (error) waiter.finish(error);
      else if (acceptedData === data && visibleReady) waiter.finish();
    }
  }, [data, acceptedData, error, visibleReady]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (currentLayout.current.document !== document || currentLayout.current.layout !== layout)
          return;
        const next = { top: element.scrollTop, height: element.clientHeight };
        if (document) positions.current.set(document, pdfScrollAnchor(layout, next.top));
        setViewport(next);
        setPage(visiblePdfPages(layout, next.top, next.height).page);
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('scroll', update);
    };
  }, [layout, document]);
  useEffect(() => {
    setEditing(null);
    setSelectedIds([]);
    setNotesOpen(false);
    setTool('select');
  }, [versionId]);
  useEffect(() => {
    if (loading || error) return;
    const note = annotations.find((n) => n.id === focusNoteId && n.versionId === versionId);
    if (note) {
      setEditing(note.id);
      setNoteText(note.text);
      scroll.current
        ?.querySelector(`[data-page="${note.page}"]`)
        ?.scrollIntoView({ block: 'start' });
    }
  }, [focusNoteId, versionId, document, loading, error]);
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(160, entries[0].contentRect.width - 18)),
    );
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (document) setPage((p) => Math.min(p, document.numPages));
  }, [document]);
  const navigate = (next: number) => {
    setPage(next);
    scroll.current
      ?.querySelector(`[data-page="${next}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  return (
    <div className="preview-inner">
      <div className="preview-controls">
        <div className="preview-heading">
          <FileText size={16} />
          <strong>Preview</strong>
          {error ? (
            <span className="preview-state failed">Preview unavailable</span>
          ) : loading || (document && !visibleReady) ? (
            <span className="preview-state working">
              <LoaderCircle className="spin" size={12} />
              Rendering…
            </span>
          ) : (
            status
          )}
        </div>
        <div className="page-controls">
          <button
            className="icon-button"
            aria-label="Previous page"
            disabled={!document || page === 1}
            onClick={() => navigate(page - 1)}
          >
            <ArrowUp size={14} />
          </button>
          <span>{document ? `${page} / ${document.numPages}` : '— / —'}</span>
          <button
            className="icon-button"
            aria-label="Next page"
            disabled={!document || page === document.numPages}
            onClick={() => navigate(page + 1)}
          >
            <ArrowDown size={14} />
          </button>
        </div>
        <div className="zoom-controls">
          <button
            className="icon-button"
            aria-label="Zoom out"
            disabled={zoom <= 0.65}
            onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(1)))}
          >
            <Minus size={14} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            className="icon-button"
            aria-label="Zoom in"
            disabled={zoom >= 1.8}
            onClick={() => setZoom((z) => Math.min(1.8, +(z + 0.1).toFixed(1)))}
          >
            <Plus size={14} />
          </button>
          <div className="control-divider" />
          <button
            className="icon-button"
            title="Fit to width"
            aria-label="Fit to width"
            onClick={() => setZoom(1)}
          >
            <Maximize size={14} />
          </button>
        </div>
      </div>
      {error && (
        <div className="stale-note" role="alert">
          {error}
          {document && acceptedData !== data
            ? ' Showing the previous preview; export is paused.'
            : ' Export is paused until this PDF can be displayed.'}
        </div>
      )}
      {!error && (stale || loading) && data && (
        <div className="stale-note">
          {loading
            ? 'Loading the new PDF…'
            : `Showing the last successful build${building ? ' · Updating…' : ' · Recompile to update'}`}
        </div>
      )}
      <div className="preview-stage">
        <div
          className="preview-scroll"
          ref={scroll}
          aria-busy={loading || (!!document && !visibleReady && !error)}
        >
          {!document && error ? (
            <div className="preview-empty">
              <FileText size={30} />
              <h3>We couldn’t display this PDF</h3>
              <p>{error}</p>
            </div>
          ) : document ? (
            <div className="pdf-pages">
              {layout.map((size, i) => (
                <div
                  className="pdf-sheet"
                  data-page={i + 1}
                  key={i}
                  style={{ width: size.width, height: size.height }}
                >
                  {i >= visible.start && i <= visible.end && (
                    <PdfPageContent
                      document={document}
                      number={i + 1}
                      width={size.width}
                      height={size.height}
                      visibleCount={visibleCount}
                      onError={rejectRender}
                      onBusy={pageBusy}
                      onReady={pageReady}
                      feedback={
                        !loading && !error && versionId && (onAnnotations || currentNotes.length)
                          ? {
                              versionId,
                              tool,
                              notes: currentNotes.filter((note) => note.page === i + 1),
                              onAdd: (note) => {
                                onAnnotations?.([...annotations, note]);
                                setEditing(note.id);
                                setNoteText('');
                                setSelectedIds((ids) => [...ids, note.id]);
                                setTool('select');
                              },
                              onSelect: onAnnotations ? selectNote : undefined,
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              ))}
              <div className="paper-caption">
                {document.numPages} {document.numPages === 1 ? 'page' : 'pages'} · PDF preview
              </div>
            </div>
          ) : (
            <div className="preview-empty">
              <div className="empty-paper">
                <FileText size={34} strokeWidth={1.2} />
              </div>
              <h3>
                Your next chapter,
                <br />
                beautifully on paper.
              </h3>
              <p>
                {building
                  ? 'Typesetting your resume…'
                  : 'Compile your LaTeX to see your resume here.'}
              </p>
              {building && <LoaderCircle className="spin" size={18} />}
            </div>
          )}
        </div>
        {document && !loading && !error && versionId && onAnnotations && (
          <>
            <div className="annotation-tools" role="toolbar" aria-label="PDF annotation tools">
              {(
                [
                  ['select', 'Select text', MousePointer2],
                  ['highlight', 'Highlight an area', Highlighter],
                  ['pen', 'Draw on PDF', Pencil],
                  ['rectangle', 'Box an area', Square],
                  ['note', 'Add a PDF note', MessageSquare],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  className={tool === value ? 'active' : ''}
                  aria-label={label}
                  title={label}
                  aria-pressed={tool === value}
                  onClick={() => setTool(value)}
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
            {currentNotes.length > 0 && (
              <div className={`pdf-notes-tray ${notesOpen ? 'expanded' : ''}`}>
                <div className="pdf-notes-bar">
                  <button
                    className="text-button"
                    onClick={() => setNotesOpen((value) => !value)}
                    aria-expanded={notesOpen}
                  >
                    {currentNotes.length} PDF {currentNotes.length === 1 ? 'note' : 'notes'}
                  </button>
                  <button
                    className="button primary small"
                    disabled={!selectedIds.length}
                    onClick={() => {
                      onAttach?.(
                        selectedIds.filter((id) => currentNotes.some((note) => note.id === id)),
                      );
                      setNotesOpen(false);
                    }}
                  >
                    <Send size={14} />
                    Attach {selectedIds.length || ''} to chat
                  </button>
                </div>
                {notesOpen && (
                  <div className="pdf-notes-list">
                    {currentNotes.map((note) => (
                      <div key={note.id}>
                        <input
                          type="checkbox"
                          aria-label={`Attach note: ${note.text || note.kind}`}
                          checked={selectedIds.includes(note.id)}
                          onChange={(event) =>
                            setSelectedIds((ids) =>
                              event.target.checked
                                ? [...ids, note.id]
                                : ids.filter((id) => id !== note.id),
                            )
                          }
                        />
                        <button className="text-button" onClick={() => selectNote(note.id)}>
                          Page {note.page} · {note.text || note.kind}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {editingNote && (
              <div className="pdf-note-editor" role="dialog" aria-label="Edit PDF note">
                <div>
                  <strong>PDF note · Page {editingNote.page}</strong>
                  <button
                    className="icon-button"
                    aria-label="Close PDF note"
                    onClick={() => setEditing(null)}
                  >
                    <X size={15} />
                  </button>
                </div>
                {editingNote.selectedText && <blockquote>{editingNote.selectedText}</blockquote>}
                <textarea
                  aria-label="PDF note instructions"
                  autoFocus
                  value={noteText}
                  maxLength={4000}
                  placeholder="What should change here?"
                  onChange={(event) => setNoteText(event.target.value)}
                />
                <div className="note-actions">
                  <button
                    className="icon-button"
                    aria-label="Delete PDF note"
                    onClick={() => {
                      onAnnotations(annotations.filter((n) => n.id !== editing));
                      setSelectedIds((ids) => ids.filter((id) => id !== editing));
                      setEditing(null);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                  <button className="button secondary small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button
                    className="button primary small"
                    onClick={() => {
                      onAnnotations(
                        annotations.map((note) =>
                          note.id === editing ? { ...note, text: noteText } : note,
                        ),
                      );
                      setEditing(null);
                    }}
                  >
                    Save note
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
