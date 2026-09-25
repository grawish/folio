import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  drawSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  StreamLanguage,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { stex } from '@codemirror/legacy-modes/mode/stex';

const latexHighlighting = HighlightStyle.define([
  { tag: [tags.tagName, tags.keyword], color: 'var(--syntax-command)' },
  { tag: [tags.atom, tags.number, tags.bool], color: 'var(--syntax-atom)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.variableName, tags.standard(tags.variableName)], color: 'var(--syntax-variable)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.bracket, tags.punctuation], color: 'var(--syntax-punctuation)' },
  { tag: tags.invalid, color: 'var(--error)', textDecoration: 'underline wavy' },
]);
const externalChange = Annotation.define<boolean>();

export type EditorHandle = {
  insert(text: string): void;
  goToLine(line: number): void;
  renameFile(from: string, to: string): void;
};
export const LatexEditor = forwardRef<
  EditorHandle,
  {
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
  { value, filename, sessionId, filenames, onChange, onCursor, fontSize, dark },
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
  useEffect(() => {
    if (!host.current) return;
    if (currentSession.current !== sessionId) {
      cached.current.clear();
      currentSession.current = sessionId;
    }
    shownKey.current = filename;
    const previous = cached.current.get(filename);
    const view = new EditorView({
      parent: host.current,
      state: previous
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
        : EditorState.create({
            doc: value,
            extensions: [
              lineNumbers(),
              history(),
              drawSelection(),
              highlightActiveLine(),
              highlightActiveLineGutter(),
              StreamLanguage.define(stex),
              syntaxHighlighting(latexHighlighting),
              appearance.current.of(EditorView.theme({}, { dark })),
              bracketMatching(),
              highlightSelectionMatches(),
              keymap.of([
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                ...completionKeymap,
                indentWithTab,
              ]),
              autocompletion({
                override: [
                  (context) => {
                    const word = context.matchBefore(/\\[a-zA-Z]*/);
                    if (!word) return null;
                    return {
                      from: word.from,
                      options: [
                        { label: '\\section', type: 'keyword', apply: '\\section{Section title}' },
                        { label: '\\textbf', type: 'keyword', apply: '\\textbf{Bold text}' },
                        { label: '\\textit', type: 'keyword', apply: '\\textit{Italic text}' },
                        {
                          label: '\\href',
                          type: 'keyword',
                          apply: '\\href{https://example.com}{Link text}',
                        },
                        {
                          label: '\\begin',
                          type: 'keyword',
                          apply: '\\begin{itemize}\n  \\item Your achievement\n\\end{itemize}',
                        },
                        { label: '\\item', type: 'keyword' },
                        { label: '\\hfill', type: 'keyword' },
                      ],
                    };
                  },
                ],
              }),
              attributes.current.of(
                EditorView.contentAttributes.of({
                  'aria-label': `LaTeX source: ${filename}`,
                  spellcheck: 'false',
                }),
              ),
              EditorView.updateListener.of((update) => {
                if (
                  update.docChanged &&
                  !update.transactions.some((transaction) => transaction.annotation(externalChange))
                )
                  callbacks.current.onChange(update.state.doc.toString());
                if (update.selectionSet || update.docChanged) {
                  const pos = update.state.selection.main.head;
                  const line = update.state.doc.lineAt(pos);
                  callbacks.current.onCursor(line.number, pos - line.from + 1);
                }
              }),
              EditorView.theme({
                '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--surface)' },
                '.cm-scroller': {
                  fontFamily: 'var(--font-mono)',
                  lineHeight: '1.55',
                  overflow: 'auto',
                },
                '.cm-content': { padding: '6px 0 24px', caretColor: 'var(--accent)' },
                '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
                '.cm-line': { padding: '0 10px 0 8px' },
                '.cm-gutters': {
                  background: 'var(--surface)',
                  color: 'var(--faint)',
                  border: 'none',
                  paddingRight: '6px',
                },
                '.cm-lineNumbers .cm-gutterElement': { minWidth: '38px' },
                '.cm-activeLine, .cm-activeLineGutter': { background: 'var(--editor-active-line)' },
                '&.cm-focused': { outline: 'none' },
                '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
                  background: 'var(--editor-selection)',
                },
                '.cm-searchMatch': { background: 'var(--editor-search)' },
                '.cm-searchMatch.cm-searchMatch-selected': {
                  background: 'var(--editor-search-selected)',
                  outline: '1px solid var(--warning)',
                },
                '.cm-selectionMatch': { background: 'var(--editor-selection)' },
                '&.cm-focused .cm-matchingBracket': {
                  background: 'var(--editor-selection)',
                  outline: '1px solid var(--accent)',
                },
                '.cm-panels': {
                  background: 'var(--surface-soft)',
                  color: 'var(--ink)',
                  borderColor: 'var(--line)',
                },
                '.cm-textfield': {
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  borderRadius: '3px',
                },
                '.cm-button': {
                  background: 'var(--surface-raised)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  backgroundImage: 'none',
                },
                '.cm-tooltip': {
                  border: '1px solid var(--line)',
                  background: 'var(--surface-raised)',
                  color: 'var(--ink)',
                  borderRadius: '6px',
                },
                '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
                  background: 'var(--surface-selected)',
                  color: 'var(--accent)',
                },
              }),
            ],
          }),
    });
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
  }, [filename, sessionId]);
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
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        annotations: externalChange.of(true),
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value,
        },
      });
  }, [value]);
  return <div className="editor-host" style={{ fontSize }} ref={host} />;
});
