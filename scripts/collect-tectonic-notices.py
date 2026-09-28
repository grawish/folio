#!/usr/bin/env python3
"""Assemble original Tectonic notices from previously collected, verified archives.

Reads source collections without changing them. No network or upstream code runs.
Outputs an immutable, content-addressed developer artifact; package inputs are
reviewed and copied into resources/tectonic-notices separately.
"""
from pathlib import Path, PurePosixPath
import argparse, json, hashlib, tarfile, base64, gzip
repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--materials', type=Path, default=repo / 'artifacts/license-materials')
args = parser.parse_args()
materials = args.materials.resolve()
inputs = {}
components = []
originals = {}
archives = []

def sha(b):
    return hashlib.sha256(b).hexdigest()

def filehash(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        while (b := f.read(128 * 1024)):
            h.update(b)
    return h.hexdigest()

def load(relative):
    p = materials / relative
    b = p.read_bytes()
    inputs[relative] = sha(b)
    return json.loads(b)

def locked(relative):
    p = repo / relative
    b = p.read_bytes()
    inputs[relative] = sha(b)
    return json.loads(b)

def checkfile(p, ref):
    assert p.is_file() and (not p.is_symlink()) and (p.stat().st_nlink == 1), p
    assert p.stat().st_size == ref['bytes'] and filehash(p) == ref['sha256'], p
    return p.read_bytes()

def archive(p, ref):
    assert p.stat().st_size == ref['bytes'] and filehash(p) == ref['sha256'], p
    archives.append({'file': str(p.relative_to(materials)), 'bytes': ref['bytes'], 'sha256': ref['sha256']})
    return tarfile.open(p, 'r:*')

def member(tar, name):
    matches = [m for m in tar.getmembers() if m.name == name]
    assert len(matches) == 1, name
    m = matches[0]
    assert m.isfile() and (not m.issym()) and (not m.islnk()) and (m.size <= 8 * 1024 * 1024), name
    return tar.extractfile(m).read()

def add(component, original, b, ref):
    assert len(b) == ref['bytes'] and sha(b) == ref['sha256'], original
    assert len(PurePosixPath(original).parts) > 0 and '..' not in PurePosixPath(original).parts and (not PurePosixPath(original).is_absolute())
    h = sha(b)
    originals[h] = base64.b64encode(b).decode()
    component['notices'].append({'originalPath': original, 'bytes': len(b), 'sha256': h, 'file': h + '.txt'})
core = load('compiler-sources/inventory.json')
corelock = locked('resources/runtime-license-sources.lock.json')
for entry in core['sources']:
    if entry['id'] == 'biber':
        continue
    ref = next((s for s in corelock['sources'] if s['id'] == entry['id']))
    assert entry['sha256'] == ref['sha256'] and entry['commit'] == ref['commit']
    c = {'id': entry['id'], 'kind': 'compiler-source', 'version': entry['version'], 'source': {k: entry[k] for k in ['repository', 'commit', 'url', 'bytes', 'sha256']}, 'notices': []}
    with archive(materials / 'compiler-sources' / entry['id'] / entry['archive'], ref) as tar:
        for m in entry['materials']:
            if PurePosixPath(m['path']).name in ['.gitmodules', 'Cargo.lock', 'Cargo.toml']:
                continue
            full = next((n for n in ref['materials'] if n.endswith('/' + m['path'])))
            b = member(tar, full)
            assert b == checkfile(materials / 'compiler-sources' / entry['id'] / 'materials' / m['path'], m)
            add(c, m['path'], b, m)
    components.append(c)
graph = load('compiler-rust-graph/inventory.json')
selected = load('compiler-rust-graph/selected-notices.json')
rust = load('compiler-rust/inventory.json')
public = json.loads((repo / 'docs/releases/compiler-rust-graph-verification.json').read_text())
for name in ['inventory.json', 'selected-notices.json']:
    ref = next((e for e in public['evidence'] if e['path'].endswith('/' + name)))
    checkfile(materials / 'compiler-rust-graph' / name, ref)
assert inputs['compiler-rust/inventory.json'] == selected['sourceInventorySha256']
supplement = locked('resources/rust-license-notices.lock.json')
for package in selected['packages']:
    if not package['inTectonicBuildClosure']:
        continue
    name = package['name'] + '-' + package['version']
    collected = next((p for p in rust['packages'] if (p['name'], p['version']) == (package['name'], package['version'])))
    assert collected['checksum'] == package['checksum']
    p = materials / 'compiler-rust/packages' / name / (name + '.crate')
    ref = {'bytes': collected['archiveBytes'], 'sha256': package['checksum']}
    c = {'id': name, 'kind': 'tectonic-rust-build-closure', 'version': package['version'], 'declaredLicense': package['declaredLicense'], 'source': {'url': 'https://static.crates.io/crates/' + package['name'] + '/' + name + '.crate', **ref}, 'notices': []}
    with archive(p, ref) as tar:
        for m in package['materials']:
            b = checkfile(materials / 'compiler-rust' / m['path'], m)
            parts = PurePosixPath(m['path']).parts
            original = '/'.join(parts[3:])
            if parts[2] == 'materials':
                assert b == member(tar, name + '/' + original)
            else:
                assert parts[2] == 'upstream-notices'
                s = next((s for s in supplement['sources'] if (s['name'], s['version']) == (package['name'], package['version'])))
                assert s['crateSha256'] == package['checksum']
                notice = next((n for n in s['materials'] if n['path'] == original))
                assert notice['sha256'] == m['sha256'] and notice['bytes'] == m['bytes']
                c.setdefault('supplementalSources', []).append(notice)
            add(c, original, b, m)
    components.append(c)
assert len([c for c in components if c['kind'] == 'tectonic-rust-build-closure']) == 303
std = load('rust-standard-library/inventory.json')
stdlock = locked('resources/rust-standard-library.lock.json')
for source in std['sources']:
    ref = next((s for s in stdlock['sources'] if s['id'] == source['id']))
    assert ref['sha256'] == source['sha256']
    c = {'id': source['id'] + '-' + stdlock['version'], 'kind': 'rust-toolchain-notice-superset', 'version': stdlock['version'], 'source': {k: source[k] for k in ['url', 'bytes', 'sha256']}, 'notices': []}
    with archive(materials / 'rust-standard-library' / source['archive'], ref) as tar:
        for m in source['materials']:
            if not m['notice']:
                continue
            b = checkfile(materials / 'rust-standard-library' / source['id'] / 'materials' / m['path'], m)
            assert b == member(tar, source['root'] + '/' + m['path'])
            add(c, m['path'], b, m)
    components.append(c)
native = load('compiler-native/inventory.json')
nativelock = locked('resources/native-license-sources.lock.json')
assert native['complete'] and native['errors'] == []
for port in native['ports']:
    ref = next((p for p in nativelock['sources'] if p['name'] == port['name']))
    assert ref['sha256'] == port['sha256'] and ref['version'] == port['version']
    folder = materials / 'compiler-native/ports' / port['name']
    c = {'id': port['name'] + '-' + port['version'], 'kind': 'native-build-port-notice-superset', 'version': port['version'], 'declaredLicense': port['declaredLicense'], 'source': {k: port[k] for k in ['url', 'bytes', 'sha256']}, 'notices': []}
    with archive(folder / port['archive'], ref) as tar:
        for m in port['materials']:
            b = checkfile(folder / 'notices' / m['path'], m)
            assert b == member(tar, port['archiveRoot'] + '/' + m['path'])
            add(c, m['path'], b, m)
    components.append(c)
assert len({c['id'] for c in components}) == len(components)
payload = json.dumps(originals, sort_keys=True, separators=(',', ':')).encode()
assert len(payload) < 16 * 1024 * 1024
compressed = gzip.compress(payload, mtime=0)
index = {'schemaVersion': 1, 'compiler': 'Tectonic', 'compilerVersion': corelock['compilerVersion'], 'compilerSourceCommit': graph['sourceCommit'], 'originalCompilerSha256': std['compilerBinarySha256'], 'completeBinarySbom': False, 'scope': 'Original notices from the Tectonic source families, resolved executable build closure, Rust toolchain distributions and native build ports. Build/toolchain supersets include tools and potentially unused code; this is not final linkage or redistribution approval. Biber/Perl, individual source grants and required corresponding-source distribution remain separate.', 'inputs': inputs, 'components': components, 'originalNoticeReferences': sum((len(c['notices']) for c in components)), 'uniqueOriginalTexts': len(originals), 'expandedTextBytes': sum((len(base64.b64decode(b)) for b in originals.values())), 'payload': {'file': 'ORIGINALS.json.gz', 'bytes': len(compressed), 'sha256': sha(compressed), 'expandedJsonBytes': len(payload), 'expandedJsonSha256': sha(payload)}, 'verifiedArchives': archives}
for (relative, h) in inputs.items():
    p = (repo if relative.startswith('resources/') else materials) / relative
    assert filehash(p) == h
index['collectorSha256'] = filehash(Path(__file__))
indexBytes = (json.dumps(index, indent=2) + '\n').encode()
out = repo / 'artifacts/license-materials/tectonic-notices' / sha(indexBytes)
out.mkdir(parents=True, exist_ok=True)
for (filename, data) in [('SOURCES.json', indexBytes), ('ORIGINALS.json.gz', compressed)]:
    target = out / filename
    if target.exists():
        assert target.is_file() and (not target.is_symlink()) and (target.read_bytes() == data), target
    else:
        with target.open('xb') as stream:
            stream.write(data)
print(json.dumps({'evidence': str(out), 'components': len(components), 'archives': len(archives), 'noticeReferences': index['originalNoticeReferences'], 'uniqueOriginalTexts': index['uniqueOriginalTexts'], 'expandedTextBytes': index['expandedTextBytes'], 'compressedBytes': len(compressed), 'passed': True}, indent=2))
