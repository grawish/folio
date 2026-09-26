<!-- Generated from docs/tutorials/settings-and-compiler.md; run npm run skill:build after editing the guide. -->

# Make the workspace comfortable and repair the compiler

## Appearance and space

Open **Settings → General** to choose Dark, Light or System appearance. The header sun/moon button switches between dark and light. The PDF keeps its paper colors.

Drag the dividers between files, writing and PDF to resize them. You can also focus a divider with Tab and press Left or Right. Enter resets that divider. **Reset pane sizes** in General resets both. The sidebar's hide/show control makes more writing room.

[Screenshot: General settings](https://github.com/grawish/folio/blob/main/docs/images/general.png)

## Editor and PDF settings

Open **Settings → Editor & PDF**. Change **Editor text size** or **Automatic preview**. These preferences change how you work, not the typography of your exported resume; edit the TeX to change the document itself.

[Screenshot: Editor and PDF settings](https://github.com/grawish/folio/blob/main/docs/images/editor-settings.png)

## Understand privacy and help

**Settings → Privacy** explains what is local and what is sent when you chat. Source ZIP exports include chat/history. PDF exports contain the resume without chat or marks. Review a source ZIP before sharing it.

[Screenshot: Privacy settings](https://github.com/grawish/folio/blob/main/docs/images/privacy.png)

The header **Help and keyboard shortcuts** button lists shortcuts. Include the version from **Settings → About** in a bug report.

## Make a support bundle

A support bundle is a small ZIP of facts that can help someone understand a problem. It leaves out your resume, PDF, chats, notes, keys, raw logs, usernames and file paths.

1. Open **Settings → Privacy → Review support bundle**.
2. Click each section on the left to read its file on the right.
3. Untick **Include** for any section you want to leave out. The AI connection summary starts unticked. You can include it if the provider type and image-check state would help.
4. Keep at least one section selected, then click **Save support ZIP** and choose a place on your Mac.
5. Share the ZIP yourself when you are ready. Folio does not upload or send it.

[Screenshot: The exact compiler summary before saving a support ZIP](https://github.com/grawish/folio/blob/main/docs/images/support-bundle.png)

The preview is a snapshot. To collect newer information after a build or change, close this screen and open it again. If you cancel the save dialog, you can still review and save the same snapshot. If saving fails, choose another location and try again.

This ZIP contains counts and status information, not the full compiler log or the resume that failed. For a harder problem, make a small example with fake details. Do not confuse a support ZIP with **Export LaTeX source…**, which includes your source, chats and history. See [the complete file list and privacy checks](https://github.com/grawish/folio/blob/main/docs/SUPPORT_BUNDLES.md).

[Screenshot: Reviewing a support summary in a small window with the light theme](https://github.com/grawish/folio/blob/main/docs/images/support-bundle-light.png)

`npm run test:support` reproduces this workflow with synthetic private markers and a real compiler failure.

## Repair a compiler

The compiler is the local tool that turns TeX into PDF. Projects record which compiler they use so an update does not silently change their output.

1. If Folio reports damaged compiler files, save your source.
2. Open **Settings → About** and read the compiler message.
3. Choose **Repair compiler**. Folio checks a separate replacement from matching local resources before using it.
4. Wait for the ready state, then rebuild and read the PDF.

[Screenshot: Compiler integrity failure and repair button](https://github.com/grawish/folio/blob/main/docs/images/compiler-repair.png)

This screenshot comes from deliberate corruption in an isolated test. Do not damage your own compiler to reproduce it. If a matching local copy is unavailable, you can still edit and save; online repair and additional managed packs are not implemented yet.

## Compare a different included compiler

If a project records a different compiler from the included one, Settings offers a comparison. Folio builds both versions and keeps a backup of the source, assets and history. Review both PDFs before choosing **Use included compiler**. **Keep recorded compiler** leaves the project's choice alone. **Show backup** opens the retained backup.

[Screenshot: Compiler comparison](https://github.com/grawish/folio/blob/main/docs/images/compiler-comparison.png)

The screenshot uses a synthetic previous compiler identity to exercise the flow; it is not evidence that two real production releases produce identical output. See [compiler migration](https://github.com/grawish/folio/blob/main/docs/COMPILER_MIGRATION.md) for exact interruption and backup behavior.

**Demos:** `npm run test:workspace`, `npm run test:runtime`, and `npm run test:migration`. Runtime failure tests alter only their isolated managed copies.
