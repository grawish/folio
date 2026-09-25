import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { defaultPanes, paneLayout, readPanes } from './shared/workspace-layout';

export function usePaneLayout(open: boolean) {
  const element = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
  const [preferences, setPreferences] = useState(() => {
    try {
      return readPanes(localStorage.getItem('folio:panes'));
    } catch {
      return defaultPanes;
    }
  });
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    setWidth(node.clientWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('folio:panes', JSON.stringify(preferences));
    } catch {
      /* Session still works. */
    }
  }, [preferences]);
  const layout = paneLayout(width, open, preferences);
  return {
    element,
    layout,
    resizeSidebar: (sidebar: number) => setPreferences((p) => ({ ...p, sidebar })),
    resizeEditor: (editor: number) =>
      setPreferences((p) => ({ ...p, editorRatio: editor / layout.available })),
    resetSidebar: () => setPreferences((p) => ({ ...p, sidebar: null })),
    resetEditor: () => setPreferences((p) => ({ ...p, editorRatio: 0.5 })),
    reset: () => setPreferences(defaultPanes),
    style: {
      gridTemplateColumns: `${open ? `${layout.sidebar}px 6px ` : ''}${layout.editor}px 6px minmax(420px, 1fr)`,
    },
  };
}
