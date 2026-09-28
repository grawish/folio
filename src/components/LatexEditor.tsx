import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createLatexEditorState, externalChange } from '../editor-state';

export type EditorHandle = {
  insert(text: string): void;
  goToLine(line: number): void;
  renameFile(from: string, to: string): void;
};
export const LatexEditor = forwardRef<
  EditorHandle,
  {
    visible: boolean;
    value: string;
    filename: string;
    sessionId: string;
    filenames: string[];
    onChange(value: string): void;
    onCursor(line: number, column: number): void;
    fontSize: number;
    dark: boolean;
  }
>(function LatexEditor(
  { visible, value, filename, sessionId, filenames, onChange, onCursor, fontSize, dark },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const appearance = useRef(new Compartment());
  const attributes = useRef(new Compartment());
  const cached = useRef(new Map<string, { state: EditorState; top: number; left: number }>());
  const shownKey = useRef(filename);
  const currentSession = useRef(sessionId);
  const callbacks = useRef({ onChange, onCursor });
  callbacks.current = { onChange, onCursor };
  useImperativeHandle(
    ref,
    () => ({
      renameFile(from, to) {
        const previous = cached.current.get(from);
        if (previous) {
          cached.current.set(to, previous);
          cached.current.delete(from);
        }
        if (shownKey.current === from) shownKey.current = to;
      },
      insert(text) {
        const view = editor.current;
        if (view) {
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        }
      },
      goToLine(line) {
        const view = editor.current;
        if (view) {
          const pos = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: 'center' }),
          });
          view.focus();
        }
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!host.current) return;
    if (currentSession.current !== sessionId) {
      cached.current.clear();
      currentSession.current = sessionId;
    }
    shownKey.current = filename;
    const previous = cached.current.get(filename);
    const state = previous
      ? previous.state.update({
          annotations: externalChange.of(true),
          changes:
            previous.state.doc.toString() === value
              ? undefined
              : { from: 0, to: previous.state.doc.length, insert: value },
          effects: [
            appearance.current.reconfigure(EditorView.theme({}, { dark })),
            attributes.current.reconfigure(
              EditorView.contentAttributes.of({
                'aria-label': `LaTeX source: ${filename}`,
                spellcheck: 'false',
              }),
            ),
          ],
        }).state
      : createLatexEditorState({
          value,
          filename,
          dark,
          appearance: appearance.current,
          attributes: attributes.current,
          callbacks,
        });
    if (!visible) {
      cached.current.delete(filename);
      cached.current.set(filename, {
        state,
        top: previous?.top ?? 0,
        left: previous?.left ?? 0,
      });
      if (cached.current.size > 100) cached.current.delete(cached.current.keys().next().value!);
      return;
    }
    const view = new EditorView({ parent: host.current, state });
    editor.current = view;
    if (previous)
      requestAnimationFrame(() => {
        if (editor.current === view) {
          view.scrollDOM.scrollTop = previous.top;
          view.scrollDOM.scrollLeft = previous.left;
        }
      });
    const position = view.state.selection.main.head;
    const line = view.state.doc.lineAt(position);
    callbacks.current.onCursor(line.number, position - line.from + 1);
    return () => {
      cached.current.delete(shownKey.current);
      cached.current.set(shownKey.current, {
        state: view.state,
        top: view.scrollDOM.scrollTop,
        left: view.scrollDOM.scrollLeft,
      });
      // Active project source has at most 100 files. Removed/restored files can
      // reuse recent states without keeping unbounded closed-project history.
      if (cached.current.size > 100) cached.current.delete(cached.current.keys().next().value!);
      view.destroy();
      editor.current = null;
    };
  }, [filename, sessionId, visible]);
  useEffect(() => {
    for (const name of cached.current.keys())
      if (!filenames.includes(name)) cached.current.delete(name);
  }, [filenames]);
  useEffect(() => {
    // Reconfigure the theme without replacing the document, selection, or undo history.
    editor.current?.dispatch({
      effects: appearance.current.reconfigure(EditorView.theme({}, { dark })),
    });
  }, [dark]);
  useLayoutEffect(() => {
    const view = editor.current;
    const previous = cached.current.get(filename);
    const state = view?.state ?? previous?.state;
    if (!state || state.doc.toString() === value) return;
    const transaction = state.update({
      annotations: externalChange.of(true),
      changes: { from: 0, to: state.doc.length, insert: value },
    });
    if (view) view.dispatch(transaction);
    else if (previous) cached.current.set(filename, { ...previous, state: transaction.state });
  }, [value, filename]);
  return <div className="editor-host" style={{ fontSize }} ref={host} />;
});
