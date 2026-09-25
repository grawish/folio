<!-- Generated from docs/tutorials/chat-and-feedback.md; run npm run skill:build after editing the guide. -->

# Chat, mark the PDF, and review changes

Start with a sample resume and an AI connection selected in Settings. Use true information about yourself. The AI can improve wording and layout, but you must check names, dates, claims, and contact details.

## Ask for one clear change

1. Open **Chat**.
2. Type a request such as: “Rename the Projects heading to Selected Projects. Keep the rest the same.”
3. Press Enter or **Send**. Shift + Enter adds a new line.
4. Watch the progress as the agent reads, edits, builds, and checks PDF images.
5. Read its reply and inspect the finished PDF. **Stop** cancels a running request. If a request fails, read the error before using **Retry**.

[Screenshot: A finished request with PDF attachments](https://github.com/grawish/folio/blob/main/docs/images/chat-workspace.png)

This is a real app capture using a deterministic local AI fixture and a synthetic Taylor Example resume. The reply is scripted for testing; it is not a live model result. The actual compiler, PDF renderer and history are running.

If the agent asks a question, answer with the missing facts. Do not ask it to invent experience. You can keep editing Code during a request; if the source changes, a finished AI draft must be reviewed from History instead of replacing your newer text.

## Point at the PDF

1. Choose a tool above the PDF: **Highlight an area**, **Box an area**, **Draw on PDF**, or **Add a PDF note**.
2. Drag over the area, draw your mark, or click for a note.
3. Enter an instruction, such as “Shorten this paragraph to two lines,” and choose **Save note**.
4. Select the notes you want to send and choose **Attach to chat**.
5. Check the page number and cropped image in the message. Remove an unwanted attachment with its × button.
6. Add your request and send it.

[Screenshot: Highlight, box, drawing and note on a PDF](https://github.com/grawish/folio/blob/main/docs/images/annotations.png)

Marks keep their position when you zoom. Notes belong to the PDF version you marked; an old note is not silently moved onto a changed layout. Read the current page before reusing feedback. PDF exports do not include these marks.

## Compare and restore

1. After an AI edit, choose **Compare changes** below the reply, or open **History**.
2. Pick an earlier version. Compare its PDF with the current PDF; navigate both if they have several pages.
3. Choose **Restore selected version** if you want to return to it. Earlier versions remain available.
4. For a recent agent change, **Undo** offers a quicker return. Check the resulting PDF and save.

[Screenshot: Side-by-side version history](https://github.com/grawish/folio/blob/main/docs/images/history.png)

History keeps source and the matching PDF together. It is different from the Code editor's Command + Z history, which applies to edits in an individual file during the editing session.

**Demo:** `npm run test:chat` runs requests, questions, stop/retry, all four mark tools, attachments, compare, undo, restore, stale-draft protection, clean export, and restart using a synthetic local provider. Follow the same steps manually with your account when you want to verify live provider behavior.
