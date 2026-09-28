# Keyboard navigation and accessibility

The current development source keeps the chat-first layout and adds keyboard navigation for its view tabs, named content panels, selected-section information in Settings and focus return after a modal closes. These changes are not part of the preview-4 installer.

## Behavior

- Chat, Code and Git are the members of the workspace tab list. Sidebar and History actions keep their button roles outside that list.
- Only the selected view tab is a normal Tab stop. Left/Right select and focus the adjacent view, wrapping at either end; Home selects Chat and End selects Git. Modified Command/Control/Option keys are left alone. Up/Down keep their usual behavior.
- Each tab names and controls its associated panel. The hidden panel is excluded from keyboard navigation and the accessible view; an active panel can receive focus. Switching away from Code disposes its CodeMirror view instance while retaining each file's source, undo/redo, selection and scroll position; returning to Code restores that state. The parent-owned chat draft persists across all views.
- Settings sections remain ordinary navigation buttons. The current section has `aria-current="true"`; changing it works with Tab and Enter.
- Shared dialogs use unique title/description identifiers and native modal behavior. Opening one makes the surrounding workspace inert. Closing restores the connected opener when focus would otherwise be left on the page body. It does not take focus away from another control already selected by the workflow.

The tab behavior follows the [W3C tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). Dialog naming, containment and focus return follow the [W3C modal-dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Native dialog behavior remains responsible for focus containment; Folio does not add a second custom focus trap.

## Verification

`npm run test:workspace` uses real Electron windows, an isolated profile and synthetic local resume content. Its keyboard checks cover arrow wrapping, Home/End, forward/reverse Tab order, matching panel names, retained unsent text, modal boundary wrapping, rejected outside focus, the current Settings section and Escape returning focus to its opener. The existing suite continues through pane resizing, autosave failures, close/reopen recovery and changed preferences. It can also run against the packaged application through the standard Mac qualification runner.

The original native control reproduced three gaps: ArrowRight left focus and selection on Chat, both tabs lacked associated named panels, and closing Settings left focus away from its opener. The corrected source control confirms those behaviors are repaired. The full workspace and chat/PDF regressions pass. [Exact sources, test results and capture hashes](releases/keyboard-navigation-verification.json) preserve the verification scope.

These are keyboard and browser-accessibility semantics checks, not a full accessibility-conformance claim. Physical VoiceOver output, other dialogs and controls, supported macOS versions, high-DPI displays and complete keyboard-only task acceptance remain in the release audit. No live AI account is used by the workspace test.
