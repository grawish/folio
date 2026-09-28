import { useCallback, useEffect, useRef, useState } from 'react';
import { comparePdfs, type PageComparison } from './pdf-compare';

// Change-highlight timing: 1.2s fully visible, then a 0.3s fade (spec).
const HOLD_MS = 1200;
const FADE_MS = 300;

export type ChangeHighlightRequest = {
  /** Identifies the AI run this before/after pair belongs to, for cancellation. */
  runId: string;
  before: Uint8Array;
  after: Uint8Array;
};

export type ChangeHighlightState = {
  /** Per-page comparison results, keyed by 0-indexed page number. */
  pages: Map<number, PageComparison>;
  /** 'hidden' | 'visible' | 'fading' drives the overlay's opacity/animation. */
  phase: 'hidden' | 'visible' | 'fading';
  failed: boolean;
  totalRegions: number;
};

const idle: ChangeHighlightState = {
  pages: new Map(),
  phase: 'hidden',
  failed: false,
  totalRegions: 0,
};

function countRegions(pages: Map<number, PageComparison>) {
  let total = 0;
  for (const page of pages.values())
    if (page.status === 'changed') total += page.regions.length;
    else if (page.status === 'inserted' || page.status === 'removed') total += 1;
  return total;
}

export type ChangeHighlightStop = { page: number; index: number };

// A flat, page-then-position ordered list of navigable stops: one per
// changed region, plus one for each inserted/removed page marker.
function stopsOf(pages: Map<number, PageComparison>): ChangeHighlightStop[] {
  const stops: ChangeHighlightStop[] = [];
  for (const page of [...pages.keys()].sort((a, b) => a - b)) {
    const comparison = pages.get(page)!;
    if (comparison.status === 'changed')
      for (let index = 0; index < comparison.regions.length; index++) stops.push({ page, index });
    else if (comparison.status === 'inserted' || comparison.status === 'removed')
      stops.push({ page, index: -1 });
  }
  return stops;
}

/**
 * Runs one raster comparison per `request` identity (by runId), then flashes
 * translucent regions for HOLD_MS followed by a FADE_MS fade-out once the
 * caller reports the replacement PDF and overlay are actually visible.
 * Cancels outstanding work whenever `request` changes identity or clears.
 */
export function usePdfChangeHighlight(
  request: ChangeHighlightRequest | undefined,
  visible: boolean,
  priorityStart: number,
  priorityEnd: number,
) {
  const [state, setState] = useState(idle);
  const requestRef = useRef(request);
  const startedRef = useRef<string | null>(null);
  const timers = useRef<number[]>([]);
  requestRef.current = request;

  const flash = useCallback((total: number) => {
    for (const timer of timers.current) clearTimeout(timer);
    setState((previous) => ({ ...previous, phase: 'visible', totalRegions: total }));
    // Reduced motion is handled entirely by the global CSS rule that collapses
    // transition-duration to ~0, so the opacity transition below just becomes
    // an instant hide instead of needing a separate JS timing branch.
    timers.current = [
      window.setTimeout(
        () => setState((previous) => ({ ...previous, phase: 'fading' })),
        HOLD_MS,
      ),
      window.setTimeout(
        () => setState((previous) => ({ ...previous, phase: 'hidden' })),
        HOLD_MS + FADE_MS,
      ),
    ];
  }, []);

  useEffect(() => {
    if (!request) {
      setState(idle);
      startedRef.current = null;
      return;
    }
    setState({ ...idle, pages: new Map() });
    startedRef.current = null;
    const controller = new AbortController();
    const pages = new Map<number, PageComparison>();
    comparePdfs(request.before, request.after, {
      signal: controller.signal,
      priorityStart,
      priorityEnd,
      onPage(index, page) {
        if (requestRef.current?.runId !== request.runId) return;
        pages.set(index, page);
        setState((previous) =>
          previous.failed ? previous : { ...previous, pages: new Map(pages) },
        );
      },
    }).catch((error) => {
      if (controller.signal.aborted || requestRef.current?.runId !== request.runId) return;
      console.error('PDF change comparison failed:', error);
      setState((previous) => ({ ...previous, failed: true }));
    });
    return () => {
      controller.abort();
      for (const timer of timers.current) clearTimeout(timer);
      timers.current = [];
    };
  }, [request, priorityStart, priorityEnd]);

  useEffect(() => {
    if (!request || !visible || state.failed || startedRef.current === request.runId) return;
    if (!state.pages.size) return;
    const total = countRegions(state.pages);
    if (!total) return;
    startedRef.current = request.runId;
    flash(total);
  }, [request, visible, state.failed, state.pages, flash]);

  const [cursor, setCursor] = useState(0);
  const stops = stopsOf(state.pages);

  const replay = () => {
    if (!request || state.failed) return;
    const total = countRegions(state.pages);
    if (!total) return;
    setCursor(0);
    flash(total);
  };

  const step = (delta: number) => {
    if (!stops.length) return undefined;
    const next = (((cursor + delta) % stops.length) + stops.length) % stops.length;
    setCursor(next);
    if (state.phase === 'hidden') flash(countRegions(state.pages));
    return stops[next];
  };

  return { state, stops, cursor: stops[cursor], replay, next: () => step(1), previous: () => step(-1) };
}
