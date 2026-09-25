# Finish an interrupted ZIP import

Use this guide when Folio closed before a ZIP import finished. Your original ZIP is kept.

## Open the review

1. Open Folio.
2. Click the interrupted-import notice near the top of the window. You can also choose **… → Interrupted imports…**, or **Settings → General → Review imports**.
3. Read the message next to the import's name. The path shows where Folio started making the new project.

Opening this list does not replace the resume you are working on.

## Finish the copy

1. Click **Finish import**.
2. If your current resume has unsaved changes, choose **Save & continue**, **Discard changes**, or **Keep editing**.
3. Wait for the recovered project to open. Its name appears at the top, Chat is selected, and the PDF builds on the right.

If all files were copied before Folio closed, the button says **Open recovered project**. It opens that existing folder; it does not make another copy.

If Folio stopped before preparation finished, there is no complete recovery copy. Click **Discard recovery copy**, then import the original ZIP again.

## Remove a copy you no longer need

Click **Move copy to Trash** to move the verified unfinished project folder to macOS Trash. Folio keeps the original ZIP. If that project is open, open another project first.

If the destination folder is already gone, **Discard recovery copy** removes only Folio's local recovery files.

## Keep changes made outside Folio

If you edited the copied files in another app, Folio blocks automatic resume and removal. Use **Show folder** to inspect them in Finder.

To keep those files and remove the recovery reminder:

1. Click **Keep files & dismiss…**.
2. Read the explanation.
3. Click **Keep files & stop recovery**.

The destination files stay where they are. Folio deletes its own staged recovery copy. You will need the original ZIP if you want to import it again later.

## What should happen

After successful recovery or cleanup, the item disappears from the review. When no items remain, the header notice disappears. Your other projects and original ZIP are unchanged.

If you close the window while Folio is finishing recovery, it waits and saves the recovered project for the next launch. You cannot dismiss the busy review with Escape.

## Reproduce the developer demonstration

After following the repository's local setup instructions:

```sh
npm run test:import-recovery
```

This automated walkthrough creates six synthetic imports, stops their helper processes at controlled copy boundaries, and opens the real Mac app. It demonstrates safe resume, completed-project reopening, outside-edit protection, cleanup, Settings access, failed-cleanup recovery, close during resume and restart. It also writes screenshots and a result file under the printed evidence directory in `test-results/`.

The demonstration uses its own app-data folder and a test-only substitute for macOS Trash. It does not use your normal Folio projects or your real Trash. It requires the local development toolchain; end users of the packaged app do not need that toolchain.

This is an executable developer walkthrough. A standalone public demo recording and downloadable example set are still pending in the [delivery checklist](../DELIVERY_SCOPE.md).

For technical limits and test evidence, see [ZIP import and recovery](../ZIP_IMPORT.md).
