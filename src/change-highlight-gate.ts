// Pure gates for the AI "Show changes" PDF highlight. They are kept out of
// App/PdfPreview so the late-read and displayed-document rules have fast
// source tests; the native smoke (`npm run test:pdf-highlight`) covers the UI.

export type AppliedIdentity = { id: string; revision: number };

/**
 * Whether a before-PDF read that resolves after an AI apply still belongs to
 * the displayed project/build. Deliberately ignores the agent run: completion
 * clears it, and a valid late reply must still show its highlight (PR #45).
 * A project switch or any newer edit/build changes id/revision and discards it.
 */
export function lateBeforeReadIsCurrent(applied: AppliedIdentity, current: AppliedIdentity) {
  return current.id === applied.id && current.revision === applied.revision;
}

/**
 * The comparison to draw over `displayed`, or undefined when a different PDF
 * (manual rebuild, History restore, project switch) is on screen, so old marks
 * and their controls never appear over a document they do not describe.
 */
export function highlightForDisplayed<T extends { after: Uint8Array }>(
  request: T | undefined,
  displayed: Uint8Array | undefined,
): T | undefined {
  return request && displayed === request.after ? request : undefined;
}

/** Clamps a change-stop page to the displayed document's page range. */
export function clampChangePage(page: number, pageCount: number | undefined) {
  return pageCount ? Math.max(1, Math.min(page, pageCount)) : page;
}
