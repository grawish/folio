"""Verify the paired synthetic editor-input runs, including their preserved failures."""
from pathlib import Path
import datetime
import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from pypdf import PdfReader

if len(sys.argv) != 5:
    raise SystemExit('Provide final candidate, final baseline, initial candidate and initial baseline result directories.')
roots = [Path(item).resolve() for item in sys.argv[1:]]
sha = lambda data: hashlib.sha256(data).hexdigest()
def evidence(file):
    file = Path(file)
    data = file.read_bytes()
    return {'path': str(file), 'bytes': len(data), 'sha256': sha(data)}
reports = [json.loads((root / 'result.json').read_bytes()) for root in roots]
script_file = 'scripts/test-editor-input.mjs'
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
script = Path(script_file).read_bytes()
assert subprocess.check_output(['git', 'show', commit + ':' + script_file]) == script
expected_names = ['ordinary character keys', 'committed composition', 'composition interrupted by Chat', 'cancelled composition', 'composition replaces selection']
pdf_signatures = []
final_results = []
for root, report, mode in zip(roots[:2], reports[:2], ['disposed', 'mounted'], strict=True):
    assert report['passed'] and not report['errors'] and not report['explicitGcRequested']
    assert report['editorLifecycle'] == mode
    assert sha((root / 'harness.mjs').read_bytes()) == report['scriptSha256'] == sha(script)
    assert report['sourceCommit'] == 'aed7933f0c7bb5d174165dd71ebb1c7b1e5119e1'
    assert [case['name'] for case in report['cases']] == expected_names
    assert [row['label'] for row in report['observations']] == ['ready'] + expected_names
    for case in report['cases']:
        assert sha(case['final'].encode()) == case['sourceSha256'] and case['undos'] == 1
        events = case['events']
        if case['name'] == 'ordinary character keys':
            typed = case['final'][len(case['initial']):]
            downs = [event for event in events if event['type'] == 'keydown'][:len(typed)]
            ups = [event for event in events if event['type'] == 'keyup'][:len(typed)]
            assert ''.join(event['key'] for event in downs) == typed == 'alpha beta gamma'
            assert ''.join(event['key'] for event in ups) == typed
            assert all(event['trusted'] for event in downs + ups)
        else:
            assert any(event['type'] == 'compositionstart' and event['trusted'] for event in events)
            assert any(event['type'] == 'compositionupdate' and event['trusted'] for event in events)
            assert any(event['type'] == 'input' and event['isComposing'] and event['trusted'] for event in events)
            assert any(event['type'] == 'compositionend' for event in events)
    final = report['cases'][-1]['final']
    assert report['recoveredFinalSource'] == final + ' after restart'
    assert sha(report['recoveredFinalSource'].encode()) == report['recoveredFinalSourceSha256']
    recovered = json.loads((root / 'app-data/recovery.json').read_bytes())['project']
    assert len(recovered['files']) == 1 and recovered['files'][0]['path'] == 'main.tex'
    assert recovered['files'][0]['content'] == report['recoveredFinalSource']
    workspace = root / 'app-data/workspaces' / recovered['id']
    state = json.loads((workspace / 'state.json').read_bytes())
    version = workspace / 'versions' / state['versions'][-1]['id']
    saved_source = json.loads((version / 'source.json').read_bytes())
    assert len(saved_source['files']) == 1 and saved_source['files'][0]['content'] == final
    pdf_file = version / 'resume.pdf'
    reader = PdfReader(pdf_file)
    assert len(reader.pages) == 1
    page = reader.pages[0]
    text = page.extract_text()
    assert 'Editor input fixture.' in text and '日本語' not in text
    signature = {'text': text, 'mediaBox': list(page.mediabox), 'cropBox': list(page.cropbox)}
    pdf_signatures.append(signature)
    final_results.append({
        'editorLifecycle': mode, 'result': evidence(root / 'result.json'),
        'harnessSnapshot': evidence(root / 'harness.mjs'),
        'appAsarSha256': report['appAsarSha256'], 'runtimeManifestSha256': report['runtimeManifestSha256'],
        'host': report['host'], 'applicationVersions': report['applicationVersions'],
        'cases': [{key: value for key, value in case.items() if key != 'events'} | {'eventCounts': {kind: sum(event['type'] == kind for event in case['events']) for kind in ['keydown', 'keyup', 'input', 'compositionstart', 'compositionupdate', 'compositionend']}, 'compositionEndTrustFlags': [event['trusted'] for event in case['events'] if event['type'] == 'compositionend']} for case in report['cases']],
        'recoveredSourceSha256': report['recoveredFinalSourceSha256'],
        'pdf': evidence(pdf_file), 'parsedPdf': signature,
        'screenshot': evidence(root / 'composition-restored.png'),
    })
assert pdf_signatures[0] == pdf_signatures[1]
for left, right in zip(reports[0]['cases'], reports[1]['cases'], strict=True):
    assert (left['initial'], left['final'], left['sourceSha256']) == (right['initial'], right['final'], right['sourceSha256'])
assert reports[0]['appAsarSha256'] == '2cd68ead966a0701c11b74727504220ee039534cf50d9226991627a3a6d66687'
assert reports[1]['appAsarSha256'] == 'fbc69b9abcd714b69a35f139f7ac155a05458e5cefdc0bef3e29e861b932e91e'
assert reports[0]['runtimeManifestSha256'] == reports[1]['runtimeManifestSha256']
assert reports[0]['applicationVersions'] == reports[1]['applicationVersions']
assert reports[0]['recoveredFinalSourceSha256'] == reports[1]['recoveredFinalSourceSha256']
for root, report in zip(roots[2:], reports[2:], strict=True):
    assert not report['passed'] and not report['errors'] and len(report['cases']) == 1
    assert sha((root / 'harness.mjs').read_bytes()) == report['scriptSha256']
    assert report['currentSource'] == reports[0]['cases'][1]['final']
    ends = [event for event in report['currentEvents'] if event['type'] == 'compositionend']
    assert len(ends) == 1 and ends[0]['trusted'] is False and ends[0]['data'] == '日本語'
assert reports[2]['scriptSha256'] == reports[3]['scriptSha256'] != reports[0]['scriptSha256']

files = [(f'{label}/{name}', root / name) for label, root in zip(['candidate', 'baseline', 'initial-candidate', 'initial-baseline'], roots, strict=True) for name in ['result.json', 'harness.mjs']]
stream = io.BytesIO()
with tarfile.open(fileobj=stream, mode='w') as archive:
    for name, file in files:
        data = file.read_bytes()
        info = tarfile.TarInfo(name)
        info.size, info.mode = len(data), 0o644
        archive.addfile(info, io.BytesIO(data))
output = Path('docs/performance/editor-input-traces.tar.gz')
output.write_bytes(gzip.compress(stream.getvalue(), mtime=0))
with tarfile.open(output, 'r:gz') as archive:
    assert sorted(archive.getnames()) == sorted(name for name, _ in files)
    for name, file in files:
        assert archive.extractfile(name).read() == file.read_bytes()
record = {
    'schemaVersion': 1, 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'harnessCommitContainingExactRunBytes': commit, 'harness': evidence(script_file),
    'checkoutHeadAtRun': reports[0]['sourceCommit'],
    'provenanceNote': 'The harness was committed after these runs. Each run copied its own source before launching and checked its hash again at completion. Both final snapshots match the committed file byte for byte.',
    'sameInputsAndExpectedSources': True, 'allTenCasesPass': True,
    'allCasesUndoAndRedoInOneStep': True, 'actualRecoveryFilesMatchExpectedFinalSource': True,
    'bothFinalVersionSourceFilesMatch': True, 'bothFinalPdfsIndependentlyParsedAndMatch': True,
    'explicitGcRequested': False, 'runs': final_results,
    'initialFailures': [evidence(root / 'result.json') for root in roots[2:]],
    'initialFailureReason': 'Both apps preserved the text and undo/redo but the first observer incorrectly required compositionend to be trusted. Both record trusted composition start/update/input events and an untrusted end event through this CDP path. The corrected observer retains all trust flags, requires native input, and checks exact source, selection replacement, cancellation, undo/redo and restart recovery.',
    'rawTraces': evidence(output), 'verifier': evidence(__file__),
    'scope': 'One sequential candidate/baseline correctness pair on the development Mac, five input cases each and a restart. Keyboard and browser-composition paths are automated. This does not exercise a physical Mac input source/candidate window, every language or VoiceOver. Unicode is in comments; the PDF check is source/build continuity, not glyph/font coverage. No timing, ordinary-GC retention or memory-budget claim is made.',
}
Path('docs/releases/editor-input-verification.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'passed': True, 'cases': 10, 'pdfs': 2, 'finalSourcesMatch': True, 'harnessCommit': commit, 'archiveBytes': output.stat().st_size}))
