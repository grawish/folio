"""Check actual template PDF geometry, text, links and embedded fonts, then render."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import unicodedata
import re

import pdfplumber
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--previews', type=Path)
args = parser.parse_args()
corpus = json.loads((args.directory / 'corpus.json').read_text())
results = []

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
    if args.previews:
        args.previews.mkdir(parents=True, exist_ok=True)
        prefix = args.previews / name
        subprocess.run(['pdftoppm', '-png', '-singlefile', '-scale-to', '1200', str(filename), str(prefix)], check=True)
        result['previewHash'] = hashlib.sha256(prefix.with_suffix('.png').read_bytes()).hexdigest()
    results.append(result)
    print(f'Checked PDF and rendered: {name} ({width:.1f} × {height:.1f} pt)')

report = {'schemaVersion': 1, 'variants': results}
(args.directory / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
if args.previews:
    (args.previews / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n')
