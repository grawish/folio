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
export const externalChange = Annotation.define<boolean>();

// Chromium records each natively applied contenteditable insertion in the frame's
// own undo stack, which keeps the replaced CodeMirror line DOM alive for as long as
// the view is mounted. CodeMirror owns undo here, so committed text that targets the
// current selection is applied as a transaction instead, as paste already is.
// Composition, autocorrect replacements, multiple selections and any input whose
// DOM selection differs from the editor selection keep the native path.
const managedTextInput = EditorView.domEventHandlers({
  beforeinput(event, view) {
    const text = event.data;
    if (
      event.inputType !== 'insertText' ||
      !text ||
      !event.cancelable ||
      event.isComposing ||
      view.composing ||
      view.compositionStarted ||
      view.state.readOnly
    )
      return false;
    // Chromium reports no target ranges for insertText, so require the live DOM
    // selection to be the single selection CodeMirror would replace.
    const selection = view.dom.ownerDocument.getSelection();
    const { main } = view.state.selection;
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !view.contentDOM.contains(selection.anchorNode) ||
      !view.contentDOM.contains(selection.focusNode) ||
      view.state.selection.ranges.length !== 1
    )
      return false;
    let anchor: number;
    let head: number;
    try {
      anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
      head = view.posAtDOM(selection.focusNode, selection.focusOffset);
    } catch {
      return false;
    }
    if (Math.min(anchor, head) !== main.from || Math.max(anchor, head) !== main.to) return false;
    const { from, to } = main;
    const insert = () =>
      view.state.update(view.state.replaceSelection(text), {
        userEvent: 'input.type',
        scrollIntoView: true,
      });
    event.preventDefault();
    if (
      !view.state
        .facet(EditorView.inputHandler)
        .some((handler) => handler(view, from, to, text, insert))
    )
      view.dispatch(insert());
    return true;
  },
});

// State extensions are created outside the view effect so their callbacks cannot
// retain its EditorView, DOM, or cleanup closure while the Code panel is hidden.
export function createLatexEditorState({
  value,
  filename,
  dark,
  appearance,
  attributes,
  callbacks,
}: {
  value: string;
  filename: string;
  dark: boolean;
  appearance: Compartment;
  attributes: Compartment;
  callbacks: {
    current: {
      onChange(value: string): void;
      onCursor(line: number, column: number): void;
    };
  };
}) {
  return EditorState.create({
    doc: value,
    extensions: [
      lineNumbers(),
      history(),
      managedTextInput,
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      StreamLanguage.define(stex),
      syntaxHighlighting(latexHighlighting),
      appearance.of(EditorView.theme({}, { dark })),
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
      attributes.of(
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
  });
}
