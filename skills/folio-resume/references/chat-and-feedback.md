<!-- Generated from docs/tutorials/chat-and-feedback.md; run npm run skill:build after editing the guide. -->

# Chat, mark the PDF, and review changes

Start with a sample resume and an AI connection selected in Settings. Use true information about yourself. The AI can improve wording and layout, but you must check names, dates, claims, and contact details.

## Ask for one clear change

1. Open **Chat**.
2. Type a request such as: “Rename the Projects heading to Selected Projects. Keep the rest the same.”
3. Press Enter or **Send**. Shift + Enter adds a new line.
4. Watch the progress as the agent edits and builds. Layout work and PDF notes also receive a visual review.
5. Read its reply and inspect the finished PDF. **Stop** cancels a running request. If a request fails, read the error before using **Retry**.

[Screenshot: A finished request with PDF attachments](https://github.com/grawish/folio/blob/main/docs/images/chat-workspace.png)

This is a real app capture using a deterministic local AI fixture and a synthetic Taylor Example resume. The reply is scripted for testing; it is not a live model result. The actual compiler, PDF renderer and history are running.

If the agent asks a question, answer with the missing facts. Do not ask it to invent experience. You can keep editing Code during a request; if the source changes, a finished AI draft must be reviewed from History instead of replacing your newer text.

## Fast edits and validation

Choose **Auto** or a particular model beside Send. Small text changes use exact replacements instead of regenerating whole files. With a current matching PDF, narrow edits can finish with one model call and one compile, without rendering images for the AI.

**Built successfully** means the source compiled. **Visually checked** means a model also reviewed every finished page. The fast path requires a small change in one existing TeX file with unchanged TeX structure, no attached notes, unchanged pagination, and no overflow warnings. Larger changes and uncertain cases receive visual review. Inspect your finished PDF and factual content in either case.

Questions and requests for missing facts return without changing the source. A failed or cancelled edit leaves the current source intact; newer manual or outside edits are never silently replaced. Auto can switch to the Capable model to repair a failed edit, and the reply identifies the models used.

## Point at the PDF

1. Choose a tool above the PDF: **Highlight an area**, **Box an area**, **Draw on PDF**, or **Add a PDF note**.
2. Drag over the area, draw your mark, or click for a note.
3. Enter an instruction, such as “Shorten this paragraph to two lines,” and choose **Save note**.
4. Select the notes you want to send and choose **Attach to chat**.
5. Check the page number and cropped image in the message. Remove an unwanted attachment with its × button.
6. Add your request and send it.

[Screenshot: Highlight, box, drawing and note on a PDF](https://github.com/grawish/folio/blob/main/docs/images/annotations.png)

Marks keep their position when you zoom. Notes belong to the PDF version you marked; an old note is not silently moved onto a changed layout. Read the current page before reusing feedback. PDF exports do not include these marks.

## See what the AI changed

This feature is in current development source; the preview-4 download does not include it yet.

After a successful AI edit, the app compares the new PDF with the one you had before and marks the changed regions.

1. Send an edit request and wait for the reply and the finished PDF.
2. Changed regions flash briefly as a translucent overlay, then fade so you can read the page.
3. Choose **Show changes** above the PDF to replay the marks. The button shows how many changes were found.
4. Use **Previous change** and **Next change** to jump between marked pages.
5. Zoom or resize freely; marks keep their position on the page.

[Screenshot: Change highlights marking an AI edit on the PDF](https://github.com/grawish/folio/blob/main/docs/images/pdf-change-highlights.png)

This real app capture uses a synthetic resume, a deterministic local AI fixture and a real compiled PDF; no live model produced the edit. Marks belong to the displayed PDF only: manual edits, project switches and History restores do not trigger them, and a comparison that finishes after you switch projects or rebuild is discarded instead of marking the wrong PDF. If a comparison cannot finish, the PDF simply appears without highlights.

**Demo:** `npm run test:pdf-highlight` builds the app and runs `scripts/test-pdf-highlight-smoke.mjs`, checking an ordinary edit and a deliberately delayed comparison end-to-end.

## Compare and restore

1. After an AI edit, choose **Compare changes** below the reply, or open **History**.
2. Pick an earlier version. Compare its PDF with the current PDF; navigate both if they have several pages.
3. Choose **Restore selected version** if you want to return to it. Earlier versions remain available.
4. For a recent agent change, **Undo** offers a quicker return. Check the resulting PDF and save.

[Screenshot: Side-by-side version history](https://github.com/grawish/folio/blob/main/docs/images/history.png)

History keeps source and the matching PDF together. It is different from the Code editor's Command + Z history, which applies to edits in an individual file during the editing session.

## Make room in History

This feature is in current development source; the preview-4 download does not include it yet.

History shows how many versions you have and how much space their source and PDFs use. New versions must fit within 1,000 versions and 64 MiB of these files for each project. Older projects already above that limit are kept. If History is full, your source and earlier PDFs stay safe while you choose what to remove.

1. Finish the current build or AI request, then open **History**.
2. Select an older version and compare its PDF. The current PDF and newest saved version cannot be removed.
3. Choose **Remove selected version…** and read the confirmation.
4. Choose **Keep version** to cancel, or **Remove this version** to remove it and its visual notes. Sent note text stays in chat. Removal cannot be undone here.
5. **Save** your project to update the history inside its folder. Your current source, current PDF and unfinished chat request are kept. Build again if History had been full.

[Screenshot: History removal confirmation in a small dark window](https://github.com/grawish/folio/blob/main/docs/images/history-removal-dark.png)

This real app capture uses a synthetic Alex Morgan resume and a real compiled PDF. No AI account is connected. Earlier project copies and backups are kept; removing local history does not erase those copies.

**Demo:** `npm run test:history-storage` checks cancel, removal, notes, saved-project updates, dark/light layouts and restart. It also pauses a real storage write to check that closing the window waits safely. [Developer details and limits](https://github.com/grawish/folio/blob/main/docs/HISTORY_STORAGE.md) explain how interrupted removal is recovered.

**Demo:** `npm run test:chat` runs requests, questions, stop/retry, all four mark tools, attachments, compare, undo, restore, stale-draft protection, clean export, and restart using a synthetic local provider. Follow the same steps manually with your account when you want to verify live provider behavior.
