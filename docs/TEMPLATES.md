# Templates and paper sizes

Folio includes six original resume layouts. Open **Templates**, choose **A4** or **US Letter**, then select a layout. Each thumbnail comes from the compiled sample PDF at that size. Creating a resume opens Chat with the real PDF alongside it. Unsaved work still requires the usual save/discard choice.

| Layout | Intended use | Bundled body font | Sample size |
| --- | --- | --- | --- |
| Classic | General professional resume with section rules | Latin Modern Roman | 11 pt |
| Modern | Spacious product/creative resume with a warm accent | Latin Modern Sans | 10 pt |
| Academic | Education, research, selected work and teaching | Latin Modern Roman | 11 pt |
| Minimal | Simple black-and-white single column | Latin Modern Roman | 11 pt |
| Compact Technical | Technical skills, experience and projects | Latin Modern Sans | 10 pt |
| Two Column | Experience and education beside a skills sidebar | Latin Modern Sans | 10 pt |

All twelve samples are one page. Single-column sources can continue onto later pages as content grows. Two Column uses two nonbreaking columns and is intended for a concise one-page resume; shorten content or switch layouts if a column becomes too long. Its PDF content stream puts the full left column before the right column. Other readers and hiring systems may interpret columns differently. No template has a guaranteed ATS score or universal compatibility claim.

Names, contact details, employers and achievements are examples. Replace them with your own facts. The template fonts are included in the runtime; no operating-system font installation is needed. Arbitrary custom fonts and a guided font-import workflow remain outside the currently implemented picker.

## Change an existing resume's paper

For an existing bundled template, open **Code** and replace `a4paper` with `letterpaper` (or the reverse) in the first `\documentclass` line. Build and inspect every page: changing size can change line breaks and page count. A4 is 210 × 297 mm; US Letter is 8.5 × 11 inches.

Imported sources keep their own paper and font declarations. Folio does not rewrite them from template metadata. The actual TeX source determines the output size.

## Origin and persistence

New projects record a template ID and origin version (`1`) in `resume.project.json`. Source, origin and version survive Save, Save As, recovery, version snapshots, source ZIP export and ZIP import. Existing projects without this metadata continue to work; their origin version remains unknown. This records where a project began, not a promise that edited source still matches the original layout. It is separate from planned per-project compiler/resource pinning.

## Reproducible corpus

`resources/templates/` holds six TeX sources and `catalog.json`. The catalog supplies picker descriptions, fonts, origin versions and expected content. `src/shared/template-catalog.ts` shares the exact A4/Letter conversion across project creation, runtime preparation, runtime verification and tests.

To rebuild on a supported development Mac:

```sh
# Python needs pypdf and pdfplumber; Poppler's pdftoppm must be on PATH.
FOLIO_PYTHON=/path/to/python npm run templates:build
npm test
npm run test:integration
npm run test:templates
npm run runtime:verify
```

These are developer tools, not end-user prerequisites. The build uses the production compiler with networking denied and a separate empty cache for each variant. It rejects overfull boxes, missing characters and substituted/undefined font shapes. No new resources were needed: the runtime lock still contains 516 resources.

Generated PDFs, matching sources, extracted text and a report are under `output/pdf/templates/`. Shipped images and source/image hashes are under `public/templates/`. Checks require one page, correct paper dimensions, sample names/contact details/content, ordered section headings, an email link, embedded fonts and text bounds inside the page margins. Minimal additionally checks accented-character and ligature extraction. All pages were rendered and visually inspected. Automated bounds checks do not substitute for visual review.

The unit gate rejects stale source/image hashes. Native desktop tests create every variant using keyboard selection, check actual PDF text and native export dimensions, exercise unsaved-change protection, save/export origin metadata and reopen the Letter project. They check the picker at 1040 × 680 in dark/light themes. Integration tests repeat fresh-cache builds and retain isolation, failure, cancellation and imported-package checks.

## Evidence and limits

The 82 unit/protocol tests, 10 compiler integration tests and runtime integrity/offline verification passed on this Apple silicon Mac. The first native twelve-variant run passed in `test-results/templates-CmgiI8/`; visual review then found nested scrolling and compressed cards. Both were corrected, with checks for card-content bounds and fixed footer placement. The final development test passed in `test-results/templates-fpYGsY/`. The compact workflow suite passed in `test-results/compact-hCHOK8/` after updating two obsolete editor-label expectations. Final package evidence is recorded in the release README and `design-qa.md`.

This milestone implements the requested styles, paper sizes, real thumbnails, font descriptions and sample corpus. Native cross-platform acceptance, controlled cross-platform rendered-image comparisons, broader custom-font support and production distribution requirements remain open in `RELEASE_GAP_AUDIT.md`.
