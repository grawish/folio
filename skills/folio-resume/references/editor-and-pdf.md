<!-- Generated from docs/tutorials/editor-and-pdf.md; run npm run skill:build after editing the guide. -->

# Edit TeX and check the PDF

## Code, search and sections

1. Open **Code** and select a file in the sidebar or its tab.
2. Press Command + F to search. Use Command + Z to undo and Command + Shift + Z to redo. Each file keeps its own editing history during the session.
3. Edit plain text while keeping TeX commands and matching braces intact. Command suggestions appear as you type.
4. Use **Insert a section** for a starting block, then replace its sample content. Put content before `\end{document}`.
5. With **Auto-compile** on, pause typing to build. With it off, click **Compile** or press Command + Enter.

[Screenshot: The Code tab beside the real PDF](https://github.com/grawish/folio/blob/main/docs/images/code.png)

For a small exercise, rename `Alex Morgan` in the Classic template, build, then undo the edit and build again. Do not change a command such as `\bfseries` when you only intend to change the name.

## Find a build error

Try removing a closing brace in a disposable sample. The new build should fail and keep the last successful PDF visible. Open the error count at the bottom, select a source-linked diagnostic, and inspect the indicated line. **Raw log** gives more compiler detail. Fix the brace and build again.

The previous PDF may look fine while the current source is broken. Check **Up to date** before using it. Export recompiles changed source and waits for a current rendered preview; it does not silently export a stale success.

## Fix a missing file, font or package

When Folio recognizes the problem, **Build output → Diagnostics** shows a short explanation above the original errors. Select an error with a filename and line number to jump there. Switch to **Raw log** for the full compiler output. At a small window size, scroll inside Build output to read the rest.

| Message | What to try |
| --- | --- |
| Missing project file | Put the missing file inside your saved project folder, or fix the filename and relative path in Code. Review Folio's outside-file changes if prompted, then compile. |
| Missing LaTeX package or class | Check whether the original template came with the named `.sty` or `.cls` file. Keep it in the project folder at the path used by the source. If you do not have it, adapt the template to the bundled packages. Builds cannot download packages. |
| Font not found | For a document that already uses `fontspec`, try `\setmainfont{lmroman10-regular.otf}`. This bundled font can change the layout. You can also keep your own `.otf` or `.ttf` files in the project and refer to their relative paths. Fonts installed elsewhere on your Mac may be unavailable to the isolated compiler. |
| This document requires LuaTeX or pdfTeX | Use a XeLaTeX-compatible template, or adapt the commands that need the other engine. Folio cannot switch to LuaTeX or pdfTeX. Deleting the engine check alone may leave other incompatible commands. |

[Screenshot: A synthetic missing-font error with the suggested bundled font](https://github.com/grawish/folio/blob/main/docs/images/build-help-font.png)

To try the font fix safely, create a disposable resume, turn **Auto-compile** off, and replace its main source with:

```tex
\documentclass{article}
\usepackage{fontspec}
\setmainfont{Folio Missing Font}
\begin{document}Sample\end{document}
```

Click **Compile**. Read the font advice, then replace `Folio Missing Font` with `lmroman10-regular.otf` and compile again. The PDF should show “Sample,” the advice should disappear, and the status should say **Up to date**.

[Screenshot: The real compiler reporting that a synthetic document requires LuaTeX](https://github.com/grawish/folio/blob/main/docs/images/build-help-engine.png)

The advice covers recognized messages, not every possible LaTeX error. An unfamiliar failure keeps its original diagnostics and raw log. Compiler-file damage has a separate Settings repair flow. This help does not install fonts or packages automatically; a guided font importer remains planned.

## Read and export the PDF

Scroll, use page arrows, or enter a page number. Use − and + to zoom and **Fit to width** to reset the view. In selection mode, text can be selected and document links can be followed. Switch to a mark tool when you want to annotate.

[Screenshot: Navigating and marking a long synthetic PDF](https://github.com/grawish/folio/blob/main/docs/images/pdf-navigation.png)

Choose **Export PDF**, pick a filename, and open the result to check it. Marks and notes stay out of the exported PDF. The viewer supports up to 100 pages and 25 MiB with geometry and rendering limits. AI image review has a separate 20-page limit. Simplify an oversized document; do not assume increasing zoom changes these limits.

If a replacement PDF fails to load, Folio keeps the previous view. Fix the source and rebuild before exporting. See [viewer limits](https://github.com/grawish/folio/blob/main/docs/PDF_VIEWER_LIMITS.md).

**Demos:** `npm run test:diagnostics` exercises real missing-package, file, font and engine failures, source links, compact dark/light layouts and the bundled-font repair. `npm run test:desktop`, `npm run test:compact`, and `npm run test:pdf-viewer` cover the broader editing and PDF workflows with synthetic inputs.
