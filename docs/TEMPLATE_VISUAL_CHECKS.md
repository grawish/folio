# Check template appearance

Folio's twelve sample PDFs must keep their reviewed appearance: six layouts, each on A4 and US Letter. Text extraction alone would miss a moved heading, clipped line or changed color. The visual gate builds every variant with the real sandboxed compiler and a separate empty cache, then compares its rendered page with the reviewed image in `public/templates/`.

## Run the check

On an Apple silicon development Mac, after `npm run setup`:

```sh
brew install poppler
python3 -m venv .cache/pdf-tests
.cache/pdf-tests/bin/python -m pip install -r scripts/template-test-requirements.txt
FOLIO_PYTHON=.cache/pdf-tests/bin/python npm run test:template-images
```

`FOLIO_PDFTOPPM` can name an existing Poppler executable. These tools are for development and CI; people using the packaged app do not need Python, Poppler or Homebrew.

The command first runs seven comparison controls, then builds all twelve PDFs. Existing checks still require the correct page size, one page, sample text, section order, email links, embedded fonts and text inside the page bounds. Compiler errors, missing glyphs, substituted fonts and overfull boxes fail the run.

The result is a new `test-results/template-regression-…/` folder. Open its `index.html` to see the reviewed image, current render and difference image side by side. Red marks show any changed pixels; `verification.json` records which changes exceed the tolerances. PDFs, matching TeX, compiler logs and numeric results remain available after a failure. The command does not overwrite a reviewed image or change the app.

## Fixed comparison rules

Poppler renders each page with its longest side at 1,200 pixels. Comparison uses the original pixel positions, with no alignment, cropping, blur or resizing to conceal a changed layout. Dimensions must match exactly. The [Pillow channel operations](https://pillow.readthedocs.io/en/stable/reference/ImageChops.html) compute absolute RGB differences.

The following two checks must both pass on each page:

- Pixels with any RGB channel change greater than 12 may total at most **0.1% of the visible-content pixels**.
- The summed absolute RGB error, averaged over three channels and visible-content pixels, must be at most **2 levels out of 255**.

Visible content means pixels with a channel below 250 in either image. Normalizing against content prevents a page's large white margins from hiding a missing line. Completely blank references, transparency, and images over two million pixels are rejected. Small color-rounding noise can pass; the controls require failures for a one-pixel layout shift, a removed line, a clipped heading, a blank/resized output and a widespread color change below the per-pixel threshold.

## Review an intended change

A source or reviewed-image hash change stops the check. Inspect the new PDF and the difference report before deciding that a layout change is intended. `npm run templates:build` is the separate command that regenerates the picker images and their manifest; run it only as part of a deliberate template review. Inspect all affected pages, review the source/image changes together and run the read-only check again. Never regenerate the reference merely to turn an unexplained failure green.

The report records the runtime manifest, compiler/checker hashes, Node/kernel information and PDF-tool versions. A rasterizer upgrade can change antialiasing; investigate that separately from a compiler or layout change. Tolerances are committed constants, not automatic adjustments to the current result.

## Current evidence

All twelve fresh-cache renders on the development Apple silicon Mac match the existing reviewed PNGs byte for byte, with zero changed pixels and zero mean error. All seven comparison controls pass. The portable [verification record](releases/template-image-verification.json) includes source/PDF/image hashes and numeric results. The initial control run exposed a tolerance that admitted a one-pixel shift in a simple line layout; the threshold was tightened before running the real corpus.

The Mac qualification workflow runs this gate and retains its reports/images. Hosted [run 36240831283](https://github.com/grawish/folio/actions/runs/36240831283) at `433a5c8` also passed all twelve comparisons with zero changed pixels using Poppler 26.09.0. That job later failed in the native chat test, so the image-gate result does not qualify the whole package. Neither result establishes every macOS version, physical high-DPI display or accessibility behavior, or qualifies a signed installer. Those remain separate release checks.
