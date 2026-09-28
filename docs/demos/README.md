# Screenshot demos

These walkthroughs use the real Folio interface and synthetic resumes. Most AI demos use a deterministic local provider fixture; connection forms are empty examples. The separately labeled Claude PDF-note demo uses a real subscription with a synthetic document. Compiler/recovery error states are deliberately created in isolated test data. The gallery is a set of screenshot demos, not video recordings.

The [website gallery](https://grawish.github.io/folio/demos.html) shows each demo with steps and a tutorial link. The same screenshots are kept in `docs/images/` with capture manifests. [Feature coverage](../FEATURE_GUIDE_INDEX.md) maps the supported features.

## Reproduce the screenshots

After developer setup, run `npm run build` and `npm run demo:capture` for the main workspace and Settings forms. This creates a fresh synthetic profile and never connects an AI account. You can pass a packaged app executable to `node scripts/capture-tutorials.mjs /absolute/path/to/Folio.app/Contents/MacOS/Folio`.

The more involved screenshots come from the existing native suites: `test:chat`, `test:templates`, `test:import`, `test:files`, `test:watch`, `test:runtime`, `test:migration`, `test:diagnostics`, and `test:pdf-viewer`. Run these sequentially. Each prints the location of its evidence and screenshots.

For an import-recovery demo without a personal home-folder path in the screenshot:

```sh
FOLIO_TEST_OUTPUT=/private/tmp/folio-demos npm run test:import-recovery
```

Inspect screenshots before publishing. Use no personal resume, API key, account identity or private folder in published images. Routine captures use no account; only the opt-in live Claude workflow below uses an existing subscription. `capture-manifest.json` and `qualified-captures.json` identify synthetic captures and their hashes. Screenshot evidence is distinct from live provider acceptance and wider macOS certification.

The early-workspace demo uses `npm run test:runtime` with a fresh isolated profile and synthetic recovery. It edits source, writes a chat draft and saves the exact compiler choice before the real compiler copy is activated, then closes and verifies recovery on restart. `startup-chat.png` shows this flow in current development source; preview-4 predates it. The same suite covers compiler repair, unavailable recorded versions, startup errors and closing before recovery has loaded.

The history-storage demo uses `npm run test:history-storage` with a synthetic resume, real PDFs and real annotation controls. It checks usage, protected versions, cancel/confirm, retained source and drafts, portable Save, and close/restart during a held journal write. `history-removal-dark.png` and `history-removal-light.png` show the confirmation at the minimum window size. This development-source feature is newer than preview-4; no AI account is used.

The local-font demo uses `npm run test:fonts`. It selects bundled Roboto files through scripted native dialog results, builds the real PDF, and verifies cancellation, outside edits, reload, close during Apply, persistence and portable font bytes. It does not use an AI account or install fonts system-wide. The dark preview and compact light capture are `docs/images/local-fonts.png` and `local-fonts-light.png`.

The support-bundle demo uses `npm run test:support` with synthetic private markers and a real compiler error. It verifies field exclusion, exact preview/export text, selected sections, compact dark/light layouts, cancellation, write failures and close during export. No provider is contacted and the ZIP is not uploaded.

The interrupted-save demo uses `npm run test:save-recovery`. It creates real disposable save journals, kills a fixture process, adds outside edits and opens the actual review. It checks file choices, stale reviews, damaged copies, exact binary/history/source recovery, ZIP export, retained drafts, compact themes, close/reload during Apply and a stopped-write retry. Demo projects live under `/private/tmp/folio-recovery-demo-*`; screenshots contain synthetic content. The curated dark and light images are `save-recovery.png` and `save-recovery-light.png`. No AI account is used.

The resource-pack screenshots use `npm run test:pack-catalog`: the ordinary compiled publisher key, real public HTTPS catalog/archive, real Tectonic/Biber checks and a synthetic table document. It verifies installation without changing the project, import notices, compact light Settings, PDF comparison, explicit Apply, backups and save/restart. No AI account is used. The independent `scripts/verify-public-pack.ts` check confirms actual cancellation and HTTP 206 resume against GitHub. The original `npm run test:packs` still uses a temporary test publisher and simulated transport for deterministic interruption/offline cases; it restores the normal native build afterward.

The app-update screenshots use `npm run test:updates` with the ordinary source build and an isolated, synthetic project. They show actual Stable/Beta settings and the unconfigured-publisher message. The test checks preferences and normal close/reopen recovery; no native app update or live update feed is claimed.

`app-updates-recovery.png` comes from that suite's `updates-staging-recovery.png`. It injects one controlled restart IPC failure to show the real timeout message and return-to-work controls. The test then changes the project name and chat draft and checks both after normal close/reopen. The two-minute deadline and late-event guards are tested separately; this screen is not evidence of a real macOS staging failure or signed replacement.

`app-updates-disk-space.png` comes from the same suite’s `updates-disk-space.png`. The low-space state is simulated in the real Settings screen; the test checks that retry and dismissal controls remain available. Separate adapter controls simulate free-space readings before both transfer and staging without filling a real disk.

`keyboard-navigation.png` and `keyboard-settings.png` come from `npm run test:workspace` (`keyboard-tabs.png` and `keyboard-settings.png`). Real keyboard events move focus through the source-built app with a synthetic resume; no UI error state or AI response is injected. These captures do not establish physical VoiceOver or complete accessibility acceptance.

`compiler-storage.png` comes from `npm run test:runtime`. Settings measures the real current compiler and a tiny inert old-compiler fixture in an isolated profile. Confirmation choices are intercepted for repeatability; cancellation, file-change rejection, removal and a subsequent real PDF build are checked. No personal compiler data is used.

## Real Claude subscription demo

Build Folio, then explicitly opt into account usage:

```sh
npm run build
node scripts/test-live-claude.mjs --live
```

Claude Code must already be installed and signed in. This command consumes account usage and sends only its built-in synthetic document, note and PDF images. It creates an isolated Folio profile and save folder; it does not read your existing resumes. It runs the ordinary app/provider/compiler and intercepts only native file-picker choices. It is not part of CI, and without `--live` it exits before opening the app.

`claude-live-settings.png`, `claude-live-annotation.png` and `claude-live-completed.png` are the unchanged Settings, page-two note and completed-response captures from the successful run. The [verification record](../releases/claude-live-verification.json) binds them to source/script hashes, the exact saved source and exported PDF, and includes the limitations of two earlier harness attempts. No account identity or credentials are published. One successful account/model workflow does not qualify every model, a signed installer or other macOS versions.

The compiler-cache demo uses `node scripts/test-engine-cache.mjs /path/to/Folio.app/Contents/MacOS/Folio`. It builds real PDFs, checks unchanged warm format bytes, adds inert old caches, and tests normal restart in an isolated profile. The cache-limit UI uses a scoped file-size override; no real disk is filled. `cache-limit.png` shows source 4 beside the retained PDF from source 3, and `cache-rebuilt.png` shows the successful retry. The separate native-writer integration uses real files and confirms process-group termination. No AI account is used.

The recovery-write demo uses `node scripts/test-recovery-writes.mjs /path/to/Folio.app/Contents/MacOS/Folio`. It delays or fails recovery and settings renames only inside its isolated synthetic profile. `recovery-retry.png` shows both real retry controls; `recovery-retried.png` shows the resolved state. Auto-compile is off and the PDF placeholder is intentional. The same script checks coalescing, native admission and normal restart. This development-source demo uses no AI account and does not test physical power loss.

The Git demo uses `npm run test:git` and an isolated synthetic Git configuration. It initializes, stages and commits through the visible panel, then independently reads `HEAD:main.tex` and reopens Code. `git-history.png` is the unchanged `committed.png` capture, identified by [its capture record](git-capture.json). No remote is contacted; the PDF placeholder is intentional.
