<!-- Generated from docs/tutorials/resource-packs.md; run npm run skill:build after editing the guide. -->

# Add extra LaTeX resources

A resource pack adds files that the compiler needs to build certain documents. Installing a pack keeps your resume and its compiler choice the same. You choose when a project starts using it.

**Available in the current source build:** the first public pack adds **Multirow 2.9**, **bigstrut** and **bigdelim** for table cells, row spacing and braces. The app already knows which publisher to trust. These screenshots use the normal app and real public pack, with a made-up sample document. A signed Mac installer is still being prepared.

AI connections stay in their own Settings page. You do not need to choose an AI provider or enter an API key to install a resource pack.

## Get a pack

1. Open **Settings → LaTeX resources**.
2. Choose **Check for packs** to read the signed catalog.
3. Choose **Download and install** on the pack you need.
4. Watch the download, copying and offline-check steps. Keep Folio open until it finishes.

You can use **Cancel operation**. A stopped download keeps its received part. Choose **Reload saved packs**, then **Resume and install** to continue. **Clear download** removes that download's cached files; it keeps installed compilers and retained signed archives.

Each pack needs its exact base compiler. If that compiler is missing, install or repair the matching version first. A similar version name is not enough. A failed signature or file check is a reason to get a fresh copy from the configured publisher.

## Import a file from another computer

1. Download the `.foliopack` from the [Folio table-pack release](https://github.com/grawish/folio/releases/tag/resource-packs-v1). Choose **Import pack file** and pick it.
2. Read its name, description and required compiler. Open **Package notices** to read the included notices.
3. Choose **Install reviewed pack**, or **Discard import** to leave it unused.
4. Wait for the offline checks to finish.

[Screenshot: Reviewing the published table pack and its notices in the real dark-theme interface](https://github.com/grawish/folio/blob/main/docs/images/pack-import-review.png)

Folio uses the bytes you reviewed. If that file changes afterward, it does not secretly replace your reviewed copy. A valid signature is still followed by file checks and a real compiler test.

## Use an installed pack for this project

1. Find the installed pack and choose **Preview for this project**.
2. Choose **Build comparison**. Folio builds the document and saves a backup.
3. Read the new PDF carefully. If the old compiler could not build this source, the left side explains why there is no before PDF. **Show original build error** reveals the details.
4. Choose **Use this pack** only when you want the change. **Keep recorded compiler** leaves the old choice in place.
5. Save the project folder when you are ready.

[Screenshot: An installed pack in the compact light-theme Settings window](https://github.com/grawish/folio/blob/main/docs/images/pack-installed-light.png)

[Screenshot: Previewing the table PDF after the published pack adds its missing resources](https://github.com/grawish/folio/blob/main/docs/images/pack-preview-light.png)

The backup keeps your source, assets, saved history and the new PDF. It keeps either the before PDF or the old build error. Find it under **Settings → About → Compiler backups**. If the previewed compiler becomes damaged before you apply it, Folio asks you to repair it and compare again.

## If work stops

Closing the window or reloading it cancels active pack work and waits for it to settle. A download can resume. A complete signed archive can be installed again with **Install saved pack**, even offline. Use **Reload saved packs** to check what is actually ready.

An installation that already finished stays installed. It still does not change the project by itself. Your chosen compiler stays recorded when you save, close, restart or export the source.

Maintainers can reproduce these screens with `npm run test:pack-catalog`. It uses the normal app key, public HTTPS catalog, real compiler sandbox and an isolated sample project. The separate `npm run test:packs` checks interruptions with a temporary test publisher and simulated network responses. See [the protocol, evidence and remaining release work](https://github.com/grawish/folio/blob/main/docs/MANAGED_PACKS.md).
