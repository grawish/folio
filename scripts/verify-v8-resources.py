"""Independently check a completed Folio V8 diagnostic using pypdf.

Run from the matching source checkout with RESULT_DIRECTORY and Folio.app.
Requires the analyzer output; it checks raw accounting, not source-map semantics.
"""
import collections
import datetime
import gzip
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
from pypdf import PdfReader

if len(sys.argv) not in [3, 4]:
    raise SystemExit('Provide RESULT_DIRECTORY, Folio.app and an optional evidence prefix.')
root, app = (Path(x).resolve() for x in sys.argv[1:3])
prefix = sys.argv[3] if len(sys.argv) == 4 else 'v8-resource'
assert re.fullmatch(r'[a-z][a-z0-9-]{1,60}', prefix), 'Invalid evidence prefix.'
sha = lambda data: hashlib.sha256(data).hexdigest()
def file_hash(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()
def artifact(file):
    file = Path(file)
    return {'path': str(file), 'bytes': file.stat().st_size, 'sha256': file_hash(file)}
def load_artifact(item):
    file = root / Path(item['file']).name
    assert file.stat().st_size == item['bytes'] and file_hash(file) == item['sha256']
    return json.loads(file.read_bytes())
def same(a, b):
    assert math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-8), (a, b)

raw = (root / 'measurements.json').read_bytes()
r = json.loads(raw)
a = json.loads((root / 'v8-analysis.json').read_bytes())
cycles = r['cycles']
assert r['passed'] and not r['errors'] and 1 <= cycles <= 20
assert a['reportSha256'] == sha(raw) and a['cycles'] == cycles
assert a['analysisScriptSha256'] == file_hash('scripts/analyze-v8-resources.mjs')
for name, expected in r['scripts'].items():
    assert file_hash(name) == expected == sha(subprocess.check_output(['git', 'show', r['sourceCommit'] + ':' + name]))
assert file_hash(root / 'sample-mac-processes') == r['instrumentation']['nativeObserverSha256']
assert file_hash(app / 'Contents/Resources/app.asar') == a['appAsarSha256'] == r['appAsarSha256']
assert file_hash(app / 'Contents/Resources/runtime/manifest.json') == r['runtimeManifestSha256']
for item in a['ownedSources']:
    assert file_hash(item['file']) == item['sha256']

# Re-inventory and stream-hash the historical seed, using its recorded order.
seed_report = Path(r['seed']['report'])
assert file_hash(seed_report) == r['seed']['reportSha256']
seed = json.loads(seed_report.read_bytes())
assert r['instrumentation']['nativeObserverSha256'] == seed['observer']['sha256']
seed_data = seed_report.parent / 'app-data'
entries = []
for base, folders, files in os.walk(seed_data, followlinks=False):
    for name in folders + files:
        f = Path(base, name)
        info = f.lstat()
        entry = {'path': str(f.relative_to(seed_data))}
        if stat.S_ISDIR(info.st_mode): entry['kind'] = 'directory'
        elif stat.S_ISREG(info.st_mode): entry.update(kind='file', bytes=info.st_size)
        else: raise AssertionError('Unexpected seed symlink or special file')
        entries.append(entry)
entries.sort(key=lambda e: e['path'])
assert entries == seed['storage'][-1]['entries']
assert len(entries) == r['seed']['entries']
assert sum(e.get('bytes', 0) for e in entries) == r['seed']['logicalFileBytes']
digest = hashlib.sha256()
for entry in entries:
    digest.update((json.dumps(entry, separators=(',', ':'), ensure_ascii=False) + '\n').encode())
    if entry['kind'] == 'file': digest.update(file_hash(seed_data / entry['path']).encode())
assert digest.hexdigest() == r['seed']['profileInventorySha256']
assert r['seed']['copiedExactly'] and r['seed']['preservedAfterRun']

expected_phases = ['ready']
expected_pdfs = []
expected_canvases = []
for c in range(1, cycles + 1):
    expected_phases += [f'cycle-{c}', f'Trace {c} small-build', f'Trace {c} small-export', f'cycle-{c}-small-idle', f'Trace {c} long-build', f'Trace {c} long-export', f'cycle-{c}-navigation', f'cycle-{c}-long-idle', f'Trace {c} return-build', f'Trace {c} return-export', f'cycle-{c}-return-idle', f'cycle-{c}-profile-read']
    expected_pdfs += [(f'Trace {c} {kind}', n) for kind, n in [('small', 1), ('long', 100), ('return', 1)]]
    expected_canvases += [f'Trace {c} small', f'Trace {c} long', f'cycle-{c}-page-100', f'cycle-{c}-page-50', f'cycle-{c}-page-1', f'Trace {c} return']
expected_phases.append('finished')
assert [p['name'] for p in r['phases']] == expected_phases
assert [(p['label'], p['pages']) for p in r['pdfs']] == expected_pdfs
assert [p['label'] for p in r['canvases']] == expected_canvases
assert all(1 <= x['renderedPages'] <= 5 and x['canvasPixels'] <= 16 * 1024**2 for x in r['canvases'])
pages = 0
for p in r['pdfs']:
    file = root / Path(p['path']).name
    assert file_hash(file) == p['sha256'] and file.stat().st_size == p['bytes'] and p['verified']
    pdf = PdfReader(file)
    assert len(pdf.pages) == p['pages']
    for i, page in enumerate(pdf.pages):
        assert f"{p['label']} page {i + 1}" in page.extract_text()
        pages += 1
assert pages == cycles * 102

# Recompute every native memory sum and Mach CPU accumulation from raw ticks.
seen = {}
first_time = int(r['samples'][0]['atAbstime'])
cpu_ns = 0
starts = {}
for i, row in enumerate(r['samples']):
    assert not i or row['atMs'] >= r['samples'][i-1]['atMs']
    starts.setdefault(row['phase'], row)
    assert row['summedRssBytes'] == sum(p['rssBytes'] for p in row['processes'])
    assert row['summedFootprintBytes'] == sum(p['footprintBytes'] for p in row['processes'])
    ids = {p['pid'] for p in row['processes']}
    assert len(ids) == len(row['processes'])
    for j, p in enumerate(row['processes']):
        assert not j or p['parent'] in ids
        key = p['pid'], p['birthAbstime']
        total = (int(p['userTicks']) + int(p['systemTicks'])) * row['timebase']['numer'] // row['timebase']['denom']
        previous = seen.get(key, total if int(p['birthAbstime']) < first_time else 0)
        assert total >= previous
        cpu_ns += total - previous
        seen[key] = total
    same(row['observedCpuSeconds'], cpu_ns / 1e9)
for phase in r['phases']:
    start = starts[phase['name']]
    same(phase['atMs'], start['atMs'])
    same(phase['observedCpuSeconds'], start['observedCpuSeconds'])
root_process = r['samples'][0]['processes'][0]
closed = json.loads(subprocess.check_output([str(root / 'sample-mac-processes'), str(root_process['pid'])]))
assert not any(p['pid'] == root_process['pid'] and p['birthAbstime'] == root_process['birthAbstime'] for p in closed['processes'])

# Check every CPU sample and exact leaf-weight aggregation independently.
assert [p['cycle'] for p in r['cpuProfiles']] == list(range(1, cycles + 1))
aggregates = {}
for role in ['main', 'renderer']:
    assert len(a['cpu'][role]) == cycles
    contexts = collections.Counter()
    for record, analysis in zip(r['cpuProfiles'], a['cpu'][role], strict=True):
        p = load_artifact(record[role])
        nodes = {node['id']: node for node in p['nodes']}
        assert len(nodes) == len(p['nodes']) == analysis['nodes']
        assert len(p['samples']) == len(p['timeDeltas']) == analysis['samples']
        assert analysis['cycle'] == record['cycle']
        parent = {}
        for node in nodes.values():
            for child in node.get('children', []):
                assert child in nodes and child not in parent
                parent[child] = node['id']
        for node_id in nodes:
            visited = set()
            while node_id in parent:
                assert node_id not in visited
                visited.add(node_id)
                node_id = parent[node_id]
        leaf_weights = collections.Counter()
        idle = gc = 0
        for node_id, delta in zip(p['samples'], p['timeDeltas'], strict=True):
            assert node_id in nodes and isinstance(delta, (float, int)) and math.isfinite(delta) and delta >= 0
            f = nodes[node_id]['callFrame']
            leaf_weights[(f['functionName'], f['url'], f['lineNumber'] + 1, f['columnNumber'] + 1)] += delta
            if f['functionName'] == '(idle)': idle += delta
            if f['functionName'] == '(garbage collector)': gc += delta
        reported = collections.Counter()
        for item in analysis['selfWeights']:
            f = item['frame']
            reported[(f['function'], f['url'], f['line'], f['column'])] += item['microseconds']
        assert leaf_weights == reported
        assert sum(p['timeDeltas']) == analysis['totalSampleWeightMicroseconds'] == sum(x['value'] for x in analysis['contextWeights'])
        assert idle == analysis['idleSampleWeightMicroseconds'] and gc == analysis['gcSampleWeightMicroseconds']
        assert p['endTime'] - p['startTime'] == analysis['profileDurationMicroseconds']
        for item in analysis['contextWeights']: contexts[item['label']] += item['value']
    aggregates[role] = [{'sourceOrLabel': k, 'sampleWeightMicroseconds': v} for k, v in contexts.most_common()]

labels = ['ready'] + [f'cycle-{c}' for c in range(1, cycles + 1) if c == 1 or c % 5 == 0 or c == cycles]
assert [o['label'] for o in r['heapObservations']] == labels == [o['label'] for o in a['heaps']]
for obs, calculated in zip(r['heapObservations'], a['heaps'], strict=True):
    p = load_artifact(obs['profile'])
    nodes = {}
    queue = [p['head']]
    while queue:
        node = queue.pop()
        assert node['id'] not in nodes and math.isfinite(node['selfSize']) and node['selfSize'] >= 0
        nodes[node['id']] = node
        queue.extend(node['children'])
    assert sum(n['selfSize'] for n in nodes.values()) == calculated['treeReportedEstimatedBytes']
    assert sum(n['selfSize'] for n in nodes.values()) == sum(x['value'] for x in calculated['contextEstimatedBytes'])
    assert sum(s['size'] for s in p['samples']) == calculated['samplesReportedEstimatedBytes']
    assert all(s['nodeId'] in nodes and math.isfinite(s['size']) and s['size'] >= 0 for s in p['samples'])
    assert len(nodes) == calculated['nodes']
    for key in ['memory', 'dom', 'mainMemory']: assert obs[key] == calculated[key]

# Publish only raw diagnostic observations, profiles and analysis; no user-data
# copy, app binary, PDFs or reproducible multi-megabyte source maps.
files = [root / 'measurements.json', root / 'v8-analysis.json']
files += [root / Path(c[role]['file']).name for c in r['cpuProfiles'] for role in ['main', 'renderer']]
files += [root / Path(o['profile']['file']).name for o in r['heapObservations']]
if 'retention' in r:
    assert r['retention'].get('completed')
    assert json.loads((root / 'retention.json').read_bytes()) == r['retention']
    for snapshot in r['retention']['snapshots']:
        file = root / Path(snapshot['file']).name
        assert file.stat().st_size == snapshot['bytes'] and file_hash(file) == snapshot['sha256']
    files.append(root / 'retention.json')
archive = Path(f'docs/performance/{prefix}-traces.tar.gz')
with archive.open('wb') as target, gzip.GzipFile(fileobj=target, mode='wb', filename='', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as tar:
    for file in sorted(files):
        data = file.read_bytes()
        info = tarfile.TarInfo(file.name)
        info.size = len(data)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(data))
with tarfile.open(archive, 'r:gz') as tar:
    assert sorted(tar.getnames()) == sorted(f.name for f in files)
    for file in files: assert tar.extractfile(file.name).read() == file.read_bytes()
summary = {
    'schemaVersion': 1,
    'sourceCommit': r['sourceCommit'], 'appAsarSha256': r['appAsarSha256'], 'runtimeManifestSha256': r['runtimeManifestSha256'],
    'host': r['host'], 'applicationVersions': r['applicationVersions'], 'instrumentation': r['instrumentation'],
    'inputMethod': r.get('inputMethod', 'native keyboard.insertText'),
    'postWorkloadRetentionDiagnostic': r.get('retention'),
    'seed': r['seed'], 'cycles': cycles, 'pdfs': len(r['pdfs']), 'independentlyParsedPages': pages,
    'nativeSnapshots': len(r['samples']), 'phaseMarkers': len(r['phases']), 'canvasObservations': len(r['canvases']),
    'cpuProfiles': cycles * 2, 'heapObservations': len(a['heaps']),
    'cpuContextSampleWeights': aggregates,
    'heap': [{k: v for k, v in h.items() if k != 'selfEstimatedBytes'} for h in a['heaps']],
    'sourceMaps': a['sourceMaps'], 'scope': r['scope'] + ' ' + a['scope'],
}
summary_file = Path(f'docs/performance/{prefix}-summary.json')
summary_file.write_text(json.dumps(summary, indent=2) + '\n')
record = {
    'schemaVersion': 1, 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceCommit': r['sourceCommit'], 'appAsarSha256': r['appAsarSha256'], 'runtimeManifestSha256': r['runtimeManifestSha256'],
    'profiledAppExited': True, 'originalSeedMetadataAndAllFileHashesUnchanged': True,
    'allExportedPdfsAndEveryPageIndependentlyParsed': True,
    'allNativeMemorySumsMachCpuCountersAndPhaseMarkersRecomputed': True,
    'allCpuTraceHashesSamplesLeafWeightsAndTotalsIndependentlyRecomputed': True,
    'allHeapTraceHashesTreeAndSampleTotalsIndependentlyRecomputed': True,
    'sourceMapMethod': 'Analyzer verifies a packaged main map and exact-JavaScript-byte renderer replay, plus owned sources. This Python verifier checks their recorded source hashes and independent raw accounting; it does not independently implement source-map decoding.',
    'sourceMapAnalyzer': artifact('scripts/analyze-v8-resources.mjs'),
    'independentVerifier': artifact('scripts/verify-v8-resources.py'),
    'rawArchive': artifact(archive), 'summary': artifact(summary_file),
    'retained': [artifact(root / 'measurements.json'), artifact(root / 'v8-analysis.json')] + ([artifact('test-results/v8-profile-20.log'), artifact('test-results/v8-profile-analysis-final.log')] if prefix == 'v8-resource' else []),
    'scope': 'Diagnostic validation, not an app speedup, root-cause proof, threshold pass or production resource acceptance. Original 120-cycle failures remain open.',
}
Path(f'docs/releases/{prefix}-verification.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'passed': True, 'pdfs': len(r['pdfs']), 'independentlyParsedPages': pages, 'nativeSnapshots': len(r['samples']), 'cpuProfiles': cycles * 2, 'heapObservations': len(a['heaps']), 'archiveBytes': archive.stat().st_size, 'originalSeedPreserved': True}, indent=2))
