"""Check actual template PDF geometry, text, links and embedded fonts, then render."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import unicodedata
import re
import os
import html
from importlib.metadata import version

import pdfplumber
from pypdf import PdfReader
from PIL import Image
from template_image_diff import compare_images, diff_preview

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--previews', type=Path)
mode.add_argument('--compare', type=Path)
args = parser.parse_args()
corpus = json.loads((args.directory / 'corpus.json').read_text())
results = []
renderer = os.environ.get('FOLIO_PDFTOPPM', 'pdftoppm')
baseline = None
if args.compare:
    baseline = json.loads((args.compare / 'manifest.json').read_text())
    names = [r['name'] for r in corpus['records']]
    assert baseline['schemaVersion'] == 1
    assert len(set(names)) == len(names) == len(baseline['variants'])
    assert set(names) == {r['name'] for r in baseline['variants']}
    (args.directory / 'rendered').mkdir()
    (args.directory / 'reference').mkdir()
    (args.directory / 'diff').mkdir()
renderer_version = subprocess.run([renderer, '-v'], capture_output=True, text=True, check=True)
render_version = (renderer_version.stdout + renderer_version.stderr).splitlines()[0]

def normalize(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).strip()

for record in corpus['records']:
    name, template, paper = record['name'], record['template'], record['paper']
    filename = args.directory / (name + '.pdf')
    reader = PdfReader(filename)
    assert len(reader.pages) == 1, (name, 'sample must fit on one page', len(reader.pages))
    page = reader.pages[0]
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    assert abs(width - paper['width']) < .2 and abs(height - paper['height']) < .2, (name, width, height)
    text = normalize(page.extract_text())
    for expected in [template['sampleName'], template['email'], *template['checks']]:
        assert normalize(expected) in text, (name, 'missing text', expected)
    assert '\ufffd' not in text and '\x00' not in text, (name, 'missing glyph')
    # The content stream should contain complete sections in intended order,
    # including the full left column before the right in the two-column layout.
    lower = text.lower()
    cursor = 0
    for section in template['sections']:
        position = lower.find(section.lower(), cursor)
        assert position >= cursor, (name, 'section order', section)
        cursor = position + len(section)
    fonts = []
    for ref in page['/Resources']['/Font'].values():
        font = ref.get_object()
        descendants = font.get('/DescendantFonts')
        actual = descendants[0].get_object() if descendants else font
        descriptor = actual.get('/FontDescriptor')
        assert descriptor, (name, 'font descriptor missing')
        descriptor = descriptor.get_object()
        assert any(key in descriptor for key in ['/FontFile', '/FontFile2', '/FontFile3']), (name, 'font not embedded')
        fonts.append(str(actual['/BaseFont']))
    uris = []
    for ref in page.get('/Annots', []):
        annotation = ref.get_object()
        action = annotation.get('/A')
        if action and action.get('/URI'):
            uris.append(str(action['/URI']))
    assert 'mailto:' + template['email'] in uris, (name, 'email link missing')
    with pdfplumber.open(filename) as pdf:
        chars = pdf.pages[0].chars
        assert len(chars) > 400, (name, 'text layer unexpectedly sparse')
        for char in chars:
            assert 30 <= char['x0'] <= char['x1'] <= width - 30, (name, 'horizontal clipping', char['text'])
            assert 30 <= char['top'] <= char['bottom'] <= height - 30, (name, 'vertical clipping', char['text'])
        bounds = [min(c['x0'] for c in chars), min(c['top'] for c in chars), max(c['x1'] for c in chars), max(c['bottom'] for c in chars)]
    (args.directory / (name + '.txt')).write_text(text + '\n')
    result = {'name': name, 'sourceHash': record['sourceHash'], 'pdfHash': record['pdfHash'], 'pageCount': 1, 'width': width, 'height': height, 'textBounds': bounds, 'fonts': fonts, 'textChecks': True, 'linksChecked': len(uris)}
    if args.previews or args.compare:
        preview_dir = args.previews or args.directory / 'rendered'
        preview_dir.mkdir(parents=True, exist_ok=True)
        prefix = preview_dir / name
        subprocess.run([renderer, '-png', '-singlefile', '-scale-to', '1200', str(filename), str(prefix)], check=True, timeout=60)
        result['previewHash'] = hashlib.sha256(prefix.with_suffix('.png').read_bytes()).hexdigest()
        if baseline:
            expected = next(r for r in baseline['variants'] if r['name'] == name)
            assert expected['sourceHash'] == record['sourceHash'], (name, 'source changed; review and regenerate previews deliberately')
            original = (args.compare / (name + '.png')).read_bytes()
            assert hashlib.sha256(original).hexdigest() == expected['previewHash'], (name, 'reviewed preview changed')
            (args.directory / 'reference' / (name + '.png')).write_bytes(original)
            with Image.open(args.compare / (name + '.png')) as reference, Image.open(prefix.with_suffix('.png')) as actual:
                comparison, mask = compare_images(reference, actual)
                result['visualComparison'] = comparison
                result['referenceHash'] = expected['previewHash']
                if mask is not None:
                    diff_preview(reference, mask).save(args.directory / 'diff' / (name + '.png'))
    results.append(result)
    print(f'Checked PDF and rendered: {name} ({width:.1f} × {height:.1f} pt)')

report = {'schemaVersion': 1, 'variants': results}
if args.compare:
    report['provenance'] = corpus['provenance']
    report['renderer'] = {'version': render_version, 'scaleTo': 1200,
                          'pillow': version('Pillow'), 'pypdf': version('pypdf'),
                          'pdfplumber': version('pdfplumber')}
    report['passed'] = all(r['visualComparison']['passed'] for r in results)
    cards = []
    for result in results:
        name = html.escape(result['name'])
        status = 'PASS' if result['visualComparison']['passed'] else 'FAIL'
        cards.append(f'<section><h2>{name}: {status}</h2><div>' + ''.join(
            f'<figure><figcaption>{label}</figcaption><img src="{folder}/{name}.png"></figure>'
            for label, folder in [('Reviewed reference', 'reference'), ('Current render', 'rendered'), ('Changed pixels in red', 'diff')]) + '</div></section>')
    (args.directory / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Folio template PDF comparison</title>'
        '<style>body{font:16px system-ui;margin:32px;background:#f0f3f5;color:#172b40}section{margin-bottom:40px}section>div{display:flex;gap:16px}figure{flex:1;min-width:0;margin:0}img{width:100%;background:white;border:1px solid #ccc}figcaption{margin:8px 0}</style>'
        '<h1>Template PDF comparison</h1><p>Original coordinates, fixed tolerances, no alignment or resizing to hide changes. Red shows any changed pixel; pass/fail uses the numeric tolerances in verification.json.</p>' + ''.join(cards))
(args.directory / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
if args.previews:
    (args.previews / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
if args.compare and not report['passed']:
    failed = [r['name'] for r in results if not r['visualComparison']['passed']]
    raise SystemExit('Template appearance changed: ' + ', '.join(failed) + '. Inspect index.html and diff images; reviewed previews were not overwritten.')
