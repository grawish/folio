"""Compare a completed native-input baseline with the disposed-editor candidate.

Run with BASELINE_RESULT_DIRECTORY and CANDIDATE_RESULT_DIRECTORY after the V8
and retaining-path verifiers. These snapshots do not measure ordinary-session
memory or establish a timing improvement.
"""
from pathlib import Path
import datetime
import hashlib
import json
import sys
from pypdf import PdfReader

if len(sys.argv) != 3:
    raise SystemExit('Provide baseline and candidate result directories.')
roots = [Path(item).resolve() for item in sys.argv[1:]]
sha = lambda data: hashlib.sha256(data).hexdigest()
def artifact(file):
    file = Path(file)
    data = file.read_bytes()
    return {'path': str(file), 'bytes': len(data), 'sha256': sha(data)}
reports = [json.loads((root / 'measurements.json').read_bytes()) for root in roots]
analyses = [json.loads((root / 'retention-analysis.json').read_bytes()) for root in roots]
assert all(r['passed'] and not r['errors'] and r['cycles'] == 5 for r in reports)
assert all(r['inputMethod'] == 'native keyboard.insertText' for r in reports)
assert reports[0]['appAsarSha256'] != reports[1]['appAsarSha256']
assert reports[1]['applicationMode'] == 'changed app with disposed Chat editor'
assert reports[1]['retention']['editorLifecycle'] == 'disposed'
assert reports[1]['seed']['appAsarSha256'] == reports[0]['appAsarSha256']
for key in ['runtimeManifestSha256', 'applicationVersions']:
    assert reports[0][key] == reports[1][key], key
for key in ['reportSha256', 'profileInventorySha256', 'entries', 'logicalFileBytes', 'copiedExactly', 'preservedAfterRun']:
    assert reports[0]['seed'][key] == reports[1]['seed'][key], key
assert reports[0]['instrumentation']['nativeObserverSha256'] == reports[1]['instrumentation']['nativeObserverSha256']
changed_instruments = [name for name, value in reports[0]['scripts'].items() if value != reports[1]['scripts'][name]]
assert set(changed_instruments) == {'scripts/profile-v8-resources.mjs', 'scripts/capture-renderer-retention.mjs'}
for root, report, analysis in zip(roots, reports, analyses, strict=True):
    assert report['retention']['completed'] and analysis['workflowCompleted']
    assert json.loads((root / 'retention.json').read_bytes()) == report['retention']
    assert sha((root / 'retention.json').read_bytes()) == analysis['retentionReportSha256']
    assert sha(Path('scripts/analyze-renderer-retention.py').read_bytes()) == analysis['analysisScriptSha256']
    assert len(report['retention']['snapshots']) == len(analysis['snapshots']) == 3
    for snapshot, decoded in zip(report['retention']['snapshots'], analysis['snapshots'], strict=True):
        raw = (root / Path(snapshot['file']).name).read_bytes()
        assert len(raw) == snapshot['bytes']
        assert sha(raw) == snapshot['sha256'] == decoded['sha256']
        parsed = json.loads(raw)
        fields, nodes = parsed['snapshot']['meta']['node_fields'], parsed['nodes']
        width = len(fields)
        detached = [i for i in range(0, len(nodes), width) if nodes[i + fields.index('detachedness')] == 2]
        assert len(detached) == decoded['detachedNodes']
        assert sum(nodes[i + fields.index('self_size')] for i in detached) == decoded['detachedSelfBytes']
        assert sum(decoded['detachedShortestPathGroups'].values()) == len(detached)
    workspace = root / 'app-data/workspaces' / report['retention']['originalSyntheticProjectId']
    state = json.loads((workspace / 'state.json').read_bytes())
    seed_root = Path(report['seed']['report']).parent / 'app-data/workspaces' / state['projectId']
    before = json.loads((seed_root / 'state.json').read_bytes())
    assert state['versions'][:len(before['versions'])] == before['versions']
    assert len(state['versions']) == len(before['versions']) + 15 == 376
    for version in before['versions']:
        old_root = seed_root / 'versions' / version['id']
        kept_root = workspace / 'versions' / version['id']
        old_files = {file.relative_to(old_root) for file in old_root.rglob('*') if file.is_file()}
        kept_files = {file.relative_to(kept_root) for file in kept_root.rglob('*') if file.is_file()}
        assert old_files == kept_files
        for relative in old_files:
            assert not (old_root / relative).is_symlink() and not (kept_root / relative).is_symlink()
            assert sha((old_root / relative).read_bytes()) == sha((kept_root / relative).read_bytes())
    for pdf, version in zip(report['pdfs'], state['versions'][-15:], strict=True):
        version_root = workspace / 'versions' / version['id']
        source = json.loads((version_root / 'source.json').read_bytes())
        assert len(source['files']) == 1 and source['files'][0]['path'] == 'main.tex'
        assert sha(source['files'][0]['content'].encode()) == pdf['sourceSha256']
        assert sha((version_root / 'resume.pdf').read_bytes()) == pdf['sha256']
        assert sha((root / Path(pdf['path']).name).read_bytes()) == pdf['sha256']

pairs = []
for left, right in zip(reports[0]['pdfs'], reports[1]['pdfs'], strict=True):
    assert left['label'] == right['label'] and left['pages'] == right['pages'] and left['sourceSha256'] == right['sourceSha256']
    signatures = []
    for root, item in zip(roots, [left, right], strict=True):
        values = []
        for page in PdfReader(root / Path(item['path']).name).pages:
            links = []
            for ref in page.get('/Annots', []):
                note = ref.get_object()
                if note.get('/Subtype') == '/Link':
                    links.append({'rect': list(note['/Rect']), 'uri': note.get('/A', {}).get('/URI')})
            values.append({'text': page.extract_text(), 'mediaBox': list(page.mediabox), 'cropBox': list(page.cropbox), 'links': links})
        signatures.append(values)
    assert signatures[0] == signatures[1]
    assert len(signatures[0]) == left['pages']
    pairs.append({'label': left['label'], 'pages': left['pages'], 'sourceSha256': left['sourceSha256'], 'pageTextGeometryAndLinkComparisonSha256': sha(json.dumps(signatures[0], sort_keys=True).encode())})
assert len(pairs) == 15 and sum(item['pages'] for item in pairs) == 510
result = {
    'schemaVersion': 1,
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sameSeedAndEmbeddedRuntime': True,
    'sameNativeInputAndWorkload': True,
    'changedInstrumentFiles': changed_instruments,
    'allActualSavedSourcesMatchIntendedInput': True,
    'allExportHashesMatchRetainedHistory': True,
    'allOriginal361VersionsPreserved': True,
    'comparedPdfPairs': 15, 'comparedPagePairs': 510, 'independentlyParsedPages': 1020,
    'pairs': pairs,
    'runs': [{
        'role': role, 'sourceCommit': report['sourceCommit'], 'appAsarSha256': report['appAsarSha256'],
        'runtimeManifestSha256': report['runtimeManifestSha256'], 'inputMethod': report['inputMethod'],
        'scripts': report['scripts'], 'measurements': artifact(root / 'measurements.json'),
        'observations': report['retention']['observations'], 'snapshots': analysis['snapshots'],
        'retentionAnalysis': artifact(root / 'retention-analysis.json'),
    } for role, root, report, analysis in zip(['historical baseline', 'editor lifecycle candidate'], roots, reports, analyses, strict=True)],
    'analyzer': artifact('scripts/analyze-renderer-retention.py'),
    'comparisonVerifier': artifact(__file__),
    'scope': 'One development-Mac candidate compared with the earlier five-cycle native-input baseline. The embedded runtime, copied on-disk seed and document workload match; the app changes and the explicit candidate instrument permits a changed ASAR and requires zero editor views in Chat. Post-workload explicit-GC snapshots are separate from ordinary sampling. Paths are shortest non-weak paths, not dominators, complete retained sizes or exclusive owners. Snapshot IDs may be reused and do not prove individual object survival/release. This is not randomized performance evidence, a whole-session memory bound or closure of the earlier CPU failures. Full heap snapshots remain local.',
}
output = Path('docs/performance/editor-lifecycle-comparison.json')
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'passed': True, 'pdfPairs': 15, 'pagePairs': 510, 'oldHistoryPreserved': True, 'sourceAndPdfHashesMatchHistory': True, 'output': str(output)}))
