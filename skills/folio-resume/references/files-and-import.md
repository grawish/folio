<!-- Generated from docs/tutorials/files-and-import.md; run npm run skill:build after editing the guide. -->

# Work with files and import a project

A TeX project can have a main file, smaller section files, images, and other assets. Keep the folder together when moving it.

## Open and copy a project

Use the **…** menu beside the project name. **Open project…** selects a TeX file. **Open project folder…** opens a folder and may ask which TeX file is the main document. **Recent projects** reopens a saved location.

Use **Save project as…** for an independent copy. The copy keeps its conversation and history but gets its own project identity. Use **Export LaTeX source…** for a ZIP you can move or share. That ZIP includes source, assets, and conversation/history, so review its contents before sharing. AI credentials are excluded.

## Import a ZIP

1. Choose **… → Import ZIP project…** and select the archive.
2. Read the source/asset count and any skipped-file list.
3. Choose the **Main document**, the TeX file that builds the whole PDF.
4. Choose **Choose location & import**, then select a parent folder.
5. Folio creates a new folder. Wait for its PDF and check the result.

[Screenshot: ZIP import and main-document choice](https://github.com/grawish/folio/blob/main/docs/images/import.png)

The original archive is kept. Unsafe paths or unsupported archives are rejected. Folio does not run scripts from an import. A missing package or unsupported TeX engine can still prevent a valid archive from building. If copying is interrupted, use [import recovery](recover-an-import.md).

## Create, rename, remove and restore files

1. Use **Add source file** at the top of the sidebar. Give it a relative filename such as `sections/projects.tex`.
2. In the main file, add `\input{sections/projects}` where that section belongs.
3. Use a file's **…** menu to rename or remove it. Update any TeX references to a renamed file.
4. Save to write the changes to disk.
5. Open **… → Removed files & saved copies…** to inspect retained text and restore it under an available name.

[Screenshot: Restoring a saved source copy](https://github.com/grawish/folio/blob/main/docs/images/restore-file.png)

Restoring does not replace another file. When a removal is saved, an earlier disk copy is retained. A removed main document needs a replacement main file before compiling. The sidebar's **Main** selector and project menu let you choose it.

**Demos:** `npm run test:import` covers file/folder opening, ZIP selection and round-trips. `npm run test:files` covers create, rename, remove, restore, per-file undo, Save As, and restart. Their resumes and destinations are synthetic.
