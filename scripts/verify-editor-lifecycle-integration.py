"""Verify retained local editor/Git integration evidence; not an OS release gate."""
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

if len(sys.argv) != 6:
    raise SystemExit('Provide packaged files, input, Git, retained baseline input directories and Folio.app.')
files_root, input_root, git_root, baseline_root, app = [Path(p).resolve() for p in sys.argv[1:]]
sha = lambda data: hashlib.sha256(data).hexdigest()
def evidence(file):
    file = Path(file)
    data = file.read_bytes()
    return {'path': str(file), 'bytes': len(data), 'sha256': sha(data)}
def read(file):
    return json.loads(Path(file).read_bytes())
source = 'd042c50356eb8644e3adf5db473eb515b0a18186'
script_names = ['files', 'editor-input', 'git', 'chat', 'diagnostics', 'watch']
scripts = {}
for name in script_names:
    p = Path(f'scripts/test-{name}.mjs')
    assert subprocess.check_output(['git', 'show', source + ':' + str(p)]) == p.read_bytes()
    scripts[name] = evidence(p)
files = read(files_root / 'result.json')
assert files['passed'] and not files['errors']
inputs = read(input_root / 'result.json')
baseline = read(baseline_root / 'result.json')
assert inputs['passed'] and not inputs['errors'] and not inputs['explicitGcRequested']
assert inputs['editorLifecycle'] == 'disposed' and inputs['sourceCommit'] == source
assert inputs['scriptSha256'] == sha((input_root / 'harness.mjs').read_bytes()) == scripts['editor-input']['sha256']
assert len(inputs['cases']) == len(baseline['cases']) == 5
for case, previous in zip(inputs['cases'], baseline['cases'], strict=True):
    for key in ['name', 'initial', 'final', 'sourceSha256', 'undos']:
        assert case[key] == previous[key]
    assert case['undos'] == 1 and sha(case['final'].encode()) == case['sourceSha256']
    events = case['events']
    if case['name'] == 'ordinary character keys':
        text = case['final'][len(case['initial']):]
        for kind in ['keydown', 'keyup']:
            keys = [e for e in events if e['type'] == kind][:len(text)]
            assert ''.join(e['key'] for e in keys) == text == 'alpha beta gamma'
            assert all(e['trusted'] for e in keys)
    else:
        for kind in ['compositionstart', 'compositionupdate']:
            assert any(e['type'] == kind and e['trusted'] for e in events)
        assert any(e['type'] == 'input' and e['isComposing'] and e['trusted'] for e in events)
        assert any(e['type'] == 'compositionend' for e in events)

def recovered_and_pdf(root, result):
    project = read(root / 'app-data/recovery.json')['project']
    assert len(project['files']) == 1
    final = result['cases'][-1]['final']
    assert project['files'][0]['content'] == result['recoveredFinalSource'] == final + ' after restart'
    workspace = root / 'app-data/workspaces' / project['id']
    version = workspace / 'versions' / read(workspace / 'state.json')['versions'][-1]['id']
    assert read(version / 'source.json')['files'][0]['content'] == final
    pdf = version / 'resume.pdf'
    reader = PdfReader(pdf)
    assert len(reader.pages) == 1
    page = reader.pages[0]
    text = page.extract_text()
    assert 'Editor input fixture.' in text
    return {'text': text, 'mediaBox': list(page.mediabox), 'cropBox': list(page.cropbox)}, evidence(pdf)
parsed, pdf = recovered_and_pdf(input_root, inputs)
previous_pdf, _ = recovered_and_pdf(baseline_root, baseline)
assert parsed == previous_pdf
identity = read('test-results/editor-lifecycle-integrated-package-identity.json')
assert Path(identity['app']) == app
assert sha((app / 'Contents/Resources/app.asar').read_bytes()) == identity['asarSha256'] == inputs['appAsarSha256']
assert sha((app / 'Contents/Resources/runtime/manifest.json').read_bytes()) == identity['runtimeManifestSha256'] == inputs['runtimeManifestSha256'] == baseline['runtimeManifestSha256']
for output in identity['outputs']:
    assert sha(Path(output['path']).read_bytes()) == output['sha256']
git = read(git_root / 'result.json')
assert git['passed'] and not git['errors'] and git['uiInitializeStageCommit'] and git['codeViewRestored']
project = Path(git['fixtureRoot']) / 'project'
assert subprocess.check_output(['git', '-C', str(project), 'rev-parse', 'HEAD'], text=True).strip() == git['commit']['hash']
committed = subprocess.check_output(['git', '-C', str(project), 'show', 'HEAD:main.tex'])
assert committed == (project / 'main.tex').read_bytes()
assert b'Git Smoke Test' in committed and committed.endswith(b'\n% tracked change\n')
assert git['commit']['subject'] == 'Initial commit from smoke test' and git['commit']['author'] == 'Folio Test'
website = read('test-results/website/result.json')
assert not website['errors'] and len(website['checks']) == 4
assert {r['width'] for r in website['checks']} == {1440, 390}
assert all(not r['overflow'] and r['themePersistence'] for r in website['checks'])
assert all(r['images'] == 40 for r in website['checks'] if r['route'] == '/demos.html')
source_tests = Path('test-results/editor-lifecycle-merged-source-tests.log').read_text()
assert 'tests 486' in source_tests and 'pass 486' in source_tests and 'fail 0' in source_tests
archive_files = [('files/result.json', files_root / 'result.json'), ('input/result.json', input_root / 'result.json'), ('input/harness.mjs', input_root / 'harness.mjs'), ('git/result.json', git_root / 'result.json'), ('website/result.json', Path('test-results/website/result.json')), ('package/identity.json', Path('test-results/editor-lifecycle-integrated-package-identity.json'))]
stream = io.BytesIO()
with tarfile.open(fileobj=stream, mode='w') as tar:
    for name, file in archive_files:
        data = file.read_bytes()
        info = tarfile.TarInfo(name)
        info.mode, info.size = 0o644, len(data)
        tar.addfile(info, io.BytesIO(data))
archive = Path('docs/performance/editor-lifecycle-integration-traces.tar.gz')
archive.write_bytes(gzip.compress(stream.getvalue(), mtime=0))
with tarfile.open(archive, 'r:gz') as tar:
    for name, file in archive_files:
        assert tar.extractfile(name).read() == file.read_bytes()
record = {
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'applicationAndHarnessSource': source, 'scripts': scripts,
    'package': identity, 'packagedFilesPassed': True, 'fivePackagedInputCasesPassed': True,
    'inputMatchesRetainedBaseline': True, 'actualRecoveryAndSavedVersionChecked': True,
    'inputPdf': pdf, 'parsedPdf': parsed, 'gitUiPassed': True,
    'gitCommit': git['commit']['hash'], 'actualCommittedSourceSha256': sha(committed),
    'sourceTests': {'passed': 486, 'failed': 0, 'log': evidence('test-results/editor-lifecycle-merged-source-tests.log')},
    'website': website, 'archive': evidence(archive), 'verifier': evidence(__file__),
    'scope': 'Local source-built and ad-hoc packaged Apple silicon checks on the development Mac. Browser composition is not a physical Mac input method; Unicode is in TeX comments, so the PDF proves build continuity rather than glyph coverage. The baseline input run is retained from earlier collection, not a new timing pair. Git checks local initialization/staging/commit only. Hosted qualification, production signing, ordinary-session resource budgets, long-session CPU failures and physical accessibility remain open.',
}
Path('docs/releases/editor-lifecycle-integration-verification.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'passed': True, 'sourceTests': 486, 'inputCases': 5, 'packageOutputs': len(identity['outputs']), 'gitCommit': git['commit']['hash'], 'websiteDemos': 40}))
