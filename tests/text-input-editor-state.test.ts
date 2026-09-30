import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Compartment, Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { createLatexEditorState, externalChange } from '../src/editor-state';

// createLatexEditorState wires CodeMirror's real history/undo extensions and the
// exact onChange/onCursor listener LatexEditor.tsx uses. A minimal {state, dispatch}
// target (no DOM, no React) is enough to drive @codemirror/commands' undo/redo and the
// updateListener facet, so this exercises the same state machine the editor host runs,
// not source text. Physical IME candidate windows, VoiceOver and real keyboard hardware
// remain untestable here; scripts/test-editor-input.mjs covers browser-injected
// composition (commit/cancel/interrupt/selection-replace) against the packaged app,
// which this file does not duplicate.
function harness(initialValue: string) {
  const changeLog: string[] = [];
  const cursorLog: Array<[number, number]> = [];
  const callbacks = {
    current: {
      onChange: (value: string) => changeLog.push(value),
      onCursor: (line: number, column: number) => cursorLog.push([line, column]),
    },
  };
  let state = createLatexEditorState({
    value: initialValue,
    filename: 'main.tex',
    dark: false,
    appearance: new Compartment(),
    attributes: new Compartment(),
    callbacks,
  });
  const listeners = state.facet(EditorView.updateListener);
  const target = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      const tr = state.update(spec);
      const update = {
        docChanged: !tr.state.doc.eq(state.doc),
        selectionSet: !tr.state.selection.eq(state.selection),
        transactions: [tr],
        state: tr.state,
      };
      state = tr.state;
      for (const listener of listeners) listener(update as never);
    },
  };
  return {
    target,
    changeLog,
    cursorLog,
    get doc() {
      return state.doc.toString();
    },
  };
}

test('accented and CJK text, and a composition-style selection replacement, are saved and fully undo/redo-able', () => {
  const h = harness('\\section{Name}\n');
  h.target.dispatch({ changes: { from: h.target.state.doc.length, insert: 'Café résumé naïve' } });
  assert.equal(h.doc, '\\section{Name}\nCafé résumé naïve');
  assert.deepEqual(h.changeLog, ['\\section{Name}\nCafé résumé naïve']);

  // Select the just-typed text and replace it, mirroring how a committed IME
  // composition (Japanese candidate accepted) replaces an existing selection.
  h.target.dispatch({
    selection: { anchor: '\\section{Name}\n'.length, head: h.target.state.doc.length },
  });
  h.target.dispatch(h.target.state.replaceSelection('東京 日本語'));
  assert.equal(h.doc, '\\section{Name}\n東京 日本語');
  assert.equal(h.changeLog.at(-1), '\\section{Name}\n東京 日本語');

  undo(h.target);
  assert.equal(h.doc, '\\section{Name}\nCafé résumé naïve');
  undo(h.target);
  assert.equal(h.doc, '\\section{Name}\n');
  redo(h.target);
  redo(h.target);
  assert.equal(h.doc, '\\section{Name}\n東京 日本語');
});

test('an externally applied replacement (AI edit or outside-file reload) does not re-trigger a save, and undo still recovers the prior typed Unicode text for saving', () => {
  const h = harness('base\n');
  h.target.dispatch({
    changes: { from: h.target.state.doc.length, insert: 'unicode: café 日本語' },
  });
  const afterUserEdit = h.doc;
  assert.deepEqual(h.changeLog, [afterUserEdit]);

  // LatexEditor's [value, filename] effect dispatches exactly this shape whenever
  // `value` diverges from the live doc (an AI-applied patch, an outside-file reload,
  // or a cached-file resync): a full-document replace tagged with externalChange.
  // Transaction.time is pushed past history's newGroupDelay so this lands in its own
  // undo step deterministically, the same separation real elapsed time would give a
  // later AI/reload sync without an actual wall-clock wait in the test.
  h.target.dispatch({
    annotations: [externalChange.of(true), Transaction.time.of(Date.now() + 10_000)],
    changes: {
      from: 0,
      to: h.target.state.doc.length,
      insert: 'base\nAI rewrote this paragraph entirely.',
    },
  });
  assert.equal(h.doc, 'base\nAI rewrote this paragraph entirely.');
  // The listener's guard (no transaction carries externalChange) must suppress onChange,
  // otherwise every external sync would re-issue a redundant/looping save.
  assert.deepEqual(h.changeLog, [afterUserEdit], 'external replacement must not call onChange');

  undo(h.target);
  assert.equal(
    h.doc,
    afterUserEdit,
    'undo must restore the exact prior Unicode text, not drop or mangle it',
  );
  assert.equal(
    h.changeLog.at(-1),
    afterUserEdit,
    'undoing past an external change must resurface the recovered text through onChange so it gets saved back to disk',
  );

  redo(h.target);
  assert.equal(h.doc, 'base\nAI rewrote this paragraph entirely.');
});

test('cursor column tracks UTF-16 code units, so a trailing surrogate pair or an unnormalized combining accent shifts later column numbers', () => {
  const h = harness('');
  h.target.dispatch({ changes: { from: 0, insert: '👍' }, selection: { anchor: 2 } });
  assert.deepEqual(
    h.cursorLog.at(-1),
    [1, 3],
    'astral emoji occupies two UTF-16 units before the cursor',
  );
  h.target.dispatch({ changes: { from: 2, insert: 'x' }, selection: { anchor: 3 } });
  assert.deepEqual(h.cursorLog.at(-1), [1, 4]);

  const h2 = harness('');
  const decomposed = 'e\u0301'; // "e" + combining acute accent, renders as one glyph, visually like "é"
  h2.target.dispatch({
    changes: { from: 0, insert: decomposed },
    selection: { anchor: decomposed.length },
  });
  assert.equal(
    h2.doc,
    decomposed,
    'CodeMirror stores the two code units as typed; it does not normalize to precomposed NFC',
  );
  assert.deepEqual(
    h2.cursorLog.at(-1),
    [1, 3],
    'reported column counts the base letter and combining mark as two units even though one glyph is drawn',
  );
});
