<!-- Generated from docs/tutorials/save-and-recover.md; run npm run skill:build after editing the guide. -->

# Save your work and handle outside changes

## Save and autosave

Click **Save** or press Command + S. The first save asks for a folder. Wait for **Saved locally**. Local recovery and a saved project folder serve different purposes: recovery helps reopen your draft, while Save updates the folder you chose.

To turn on autosave, open **Settings → General → Autosave project**. Save once to choose a folder. After that, Folio saves source, chat and notes after a two-second pause. Autosave waits during AI work and other saves, and pauses for outside changes or errors.

[Screenshot: General settings with autosave](https://github.com/grawish/folio/blob/main/docs/images/general-light.png)

Close Folio normally and reopen it to check recovery. If a dialog asks about unsaved changes, choose the action that fits: save, keep the current project open, or discard only when you intend to lose those changes. Do not test forced crashes with your only copy of a real resume.

## When another app edits the folder

1. Choose **Review changes** when Folio reports outside-file changes.
2. Read the list of modified, added or removed files.
3. Choose **Keep editing** to leave the disk files alone for now, **Save a copy…** to preserve your editor state elsewhere, or **Reload source from disk** to use the outside changes.
4. If reloading, confirm the main document. Differing editor text is preserved in **Removed files & saved copies**.
5. Rebuild and inspect the PDF before exporting.

[Screenshot: Reviewing outside-file changes](https://github.com/grawish/folio/blob/main/docs/images/external-changes.png)

Builds, exports and AI application wait while source or assets need review. Saving can ask before replacing outside edits. Read that choice carefully; don't keep retrying a save to dismiss a conflict.

## Recover an interrupted save

Folio usually fixes a stopped save by putting the earlier files back. If another app changed a file after the save stopped, Folio asks you to choose which version to keep.

1. If Folio cannot open your workspace, click **Review interrupted saves**. If the app is already open, choose **More project actions → Interrupted saves…**.
2. Click **Review files** beside the project.
3. Choose a file from the list. You can look at **Current disk copy**, **Before the save**, and **Attempted save**. The attempted save is the version Folio was trying to write.
4. Select **Keep this version** under the copy you want. Folio starts by keeping outside edits. For other files, it suggests the version from before the save. Check every file.
5. Click **Review choices**, read the list, then click **Apply and keep backups**.
6. Click **Show recovery copies** to find the backups, or **Done** to reopen the project. Build the PDF and check the result.

[Screenshot: Choosing files after an interrupted save](https://github.com/grawish/folio/blob/main/docs/images/save-recovery.png)

A version marked **File is absent** means that file will not be in the recovered project. A missing or damaged backup cannot be selected. Fonts, images and history files are kept exactly as they are, even when they cannot be shown as text.

If a file changes while you are reviewing, Folio stops. Click **Refresh**, check the new copies and choose again. Refresh resets the suggested choices.

Before changing files, Folio keeps the available versions, your editor source, and conversation copies in a local backup folder. This includes an unfinished draft from another project that was open when you began. It does not send the copies to AI. **More project actions → Interrupted saves… → Show all recovery copies** lets you find the backups later. Draft folders contain source and conversation copies; they may need assets from the original project to compile.

[Screenshot: Recovery in a small light-theme window](https://github.com/grawish/folio/blob/main/docs/images/save-recovery-light.png)

You can close a review before pressing Apply. Once Apply starts, closing or reloading waits for it or resumes it later; it does not undo your file choices. If a write stops halfway, Folio keeps the choices and backups. Closing that failed review checks recovery again instead of replacing the files with an older editor draft.

A combination of files can still contain broken TeX, an invalid project file, or damaged history. If the files were saved but the project cannot open, Folio says so and keeps its backups. Use **Show copies**, repair the affected files, and try opening again. Unreadable save records may need manual repair. Do not delete recovery records just to hide an error. See [save recovery details](https://github.com/grawish/folio/blob/main/docs/SAVE_RECOVERY_IMPLEMENTATION.md) for limits.

ZIP imports have their own [review and recovery tutorial](recover-an-import.md). Process-interruption tests do not prove power-loss or network-filesystem durability.

**Demos:** `npm run test:save-recovery` creates disposable interrupted saves and checks this review flow, newer edits, binary files, history, backups, reload and close during Apply. `npm run test:workspace` covers autosave and normal restart. `npm run test:watch` covers outside-file review. `npm test` includes real process-kill recovery checks. These tests use synthetic files; do not force a crash on your only copy of a real resume.
