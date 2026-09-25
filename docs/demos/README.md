# Screenshot demos

These walkthroughs use the real Folio interface and synthetic resumes. AI demos use a deterministic local provider fixture; connection forms are empty examples, not live account tests. Compiler/recovery error states are deliberately created in isolated test data. The gallery is a set of screenshot demos, not video recordings.

The [website gallery](https://grawish.github.io/folio/demos.html) shows each demo with steps and a tutorial link. The same screenshots are kept in `docs/images/` with capture manifests. [Feature coverage](../FEATURE_GUIDE_INDEX.md) maps the supported features.

## Reproduce the screenshots

After developer setup, run `npm run build` and `npm run demo:capture` for the main workspace and Settings forms. This creates a fresh synthetic profile and never connects an AI account. You can pass a packaged app executable to `node scripts/capture-tutorials.mjs /absolute/path/to/Folio.app/Contents/MacOS/Folio`.

The more involved screenshots come from the existing native suites: `test:chat`, `test:templates`, `test:import`, `test:files`, `test:watch`, `test:runtime`, `test:migration`, and `test:pdf-viewer`. Run these sequentially. Each prints the location of its evidence and screenshots.

For an import-recovery demo without a personal home-folder path in the screenshot:

```sh
FOLIO_TEST_OUTPUT=/private/tmp/folio-demos npm run test:import-recovery
```

Inspect screenshots before publishing. Use no real resume, API key, signed-in account or private folder. `capture-manifest.json` and `qualified-captures.json` identify synthetic captures and their hashes. Screenshot evidence is distinct from live provider acceptance and wider macOS certification.
