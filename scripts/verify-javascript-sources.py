#!/usr/bin/env python3
"""Bind byte-reproduced JavaScript inputs to the pinned original npm archives."""
import argparse
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import tarfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('npm_materials', ROOT / 'scripts/collect-npm-license-materials.py')
npm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(npm)


def member_path(file, location):
    parts = PurePosixPath(file).parts
    owner = PurePosixPath(location).parts
    if ('\\' in file or '\0' in file or file.startswith('/') or '..' in parts
            or parts[:len(owner)] != owner or len(parts) <= len(owner)):
        raise ValueError('Source escapes its declared npm package')
    return 'package/' + '/'.join(parts[len(owner):])


def verify(inventory_path, cache, root=ROOT):
    inventory_bytes = inventory_path.read_bytes()
    inventory = json.loads(inventory_bytes)
    index_bytes = (root / 'resources/npm-notices/SOURCES.json').read_bytes()
    index = json.loads(index_bytes)
    lock_bytes = (root / 'package-lock.json').read_bytes()
    lock = json.loads(lock_bytes)
    if (inventory['schemaVersion'] != 1 or index['schemaVersion'] != 1
            or inventory['packageLockSha256'] != npm.sha256(lock_bytes)
            or index['packageLockSha256'] != npm.sha256(lock_bytes)):
        raise ValueError('JavaScript inventory and notices require the same npm lock')
    indexed = {p['location']: p for p in index['packages']}
    if len(indexed) != len(index['packages']):
        raise ValueError('Duplicate notice-index package')
    checked, seen_modules = [], set()
    file_count = map_count = 0
    known_locations = {p['location'] for p in inventory['packages']}
    if len(known_locations) != len(inventory['packages']):
        raise ValueError('Duplicate replay package')
    for item in inventory['modules']:
        if item['id'] in seen_modules:
            raise ValueError('Duplicate replay module')
        seen_modules.add(item['id'])
        if item['kind'].startswith('npm-') and item.get('package') not in known_locations:
            raise ValueError('Source lacks a replay package')
    for package in inventory['packages']:
        location = package['location']
        original = indexed.get(location)
        locked = lock['packages'].get(location)
        if (not original or not locked
                or any(original[k] != package[k] for k in ('name', 'version', 'declaredLicense'))
                or locked['version'] != package['version']
                or original['archive']['url'] != package['url'] or package['url'] != locked['resolved']
                or original['archive']['integrity'] != package['integrity'] or package['integrity'] != locked['integrity']):
            raise ValueError('Replay package is not bound to its notice index and dependency lock')
        filename = original['archive']['file']
        if PurePosixPath(filename).name != filename or '\\' in filename:
            raise ValueError('Invalid archive cache name')
        data, notices = npm.archive_notices(cache / filename, original)
        for filename, content in notices.items():
            if (root / 'resources/npm-notices' / filename).read_bytes() != content:
                raise ValueError('Bundled original notice differs from publisher bytes')
        # archive_notices has already bounded and checked all member paths and duplicates.
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
            entries = {m.name: m for m in tar}
            def read(file):
                entry = entries.get(member_path(file, location))
                if not entry or not entry.isfile() or not 0 <= entry.size <= 16 * 1024 * 1024:
                    raise ValueError('Missing, linked or oversized original source')
                return tar.extractfile(entry).read()
            if npm.sha256(read(location + '/package.json')) != package['packageJsonSha256']:
                raise ValueError('Installed package metadata differs from publisher archive')
            for item in inventory['modules']:
                if item.get('package') != location:
                    continue
                if item['kind'] == 'npm-source':
                    content = read(item['file'])
                    file_count += 1
                elif item['kind'] == 'npm-source-map-content':
                    maps = item.get('publishedSourceMaps', [])
                    if not maps:
                        raise ValueError('Embedded original source lacks a publisher map')
                    content = None
                    for ref in maps:
                        map_bytes = read(ref['file'])
                        if npm.sha256(map_bytes) != ref['sha256']:
                            raise ValueError('Publisher source map differs')
                        source_map = json.loads(map_bytes)
                        i = ref['sourceIndex']
                        if type(i) is not int or not 0 <= i < len(source_map['sources']):
                            raise ValueError('Invalid publisher source-map index')
                        source = source_map['sources'][i]
                        full = posixpath.normpath(posixpath.join(posixpath.dirname(ref['file']), source_map.get('sourceRoot', ''), source))
                        if full != item['file']:
                            raise ValueError('Publisher source-map location differs')
                        member_path(full, location)
                        text = source_map['sourcesContent'][i]
                        if not isinstance(text, str):
                            raise ValueError('Missing publisher source-map text')
                        candidate = text.encode()
                        if content is not None and content != candidate:
                            raise ValueError('Ambiguous publisher source-map text')
                        content = candidate
                    map_count += 1
                else:
                    raise ValueError('Unknown npm source contribution')
                if len(content) != item['sourceBytes'] or npm.sha256(content) != item['sourceSha256']:
                    raise ValueError('Replayed source differs from publisher archive')
        checked.append({'location': location, 'name': package['name'], 'version': package['version'],
                        'archiveSha256': original['archive']['sha256'], 'noticeFiles': len(notices)})
    return {'schemaVersion': 1, 'passed': True, 'inventorySha256': npm.sha256(inventory_bytes),
            'sourceIndexSha256': npm.sha256(index_bytes), 'npmInputFilesMatched': file_count,
            'embeddedOriginalSourcesMatched': map_count, 'packageJsonFilesMatched': len(checked),
            'originalArchivesChecked': len(checked), 'packages': checked, 'completeBinarySbom': False,
            'scope': 'Exact npm source bytes and published source-map contents from checksum-verified locked archives. Generated helpers are associated with their build tools, not assigned byte-level authorship. Nested vendored terms, native components and complete redistribution remain separate.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path)
    parser.add_argument('--cache', type=Path, default=ROOT / 'artifacts/license-materials/npm-archives')
    args = parser.parse_args()
    inventory_path = args.inventory or Path(json.loads((ROOT / 'test-results/javascript-inventory-location.json').read_text())['root']) / 'inventory.json'
    report = verify(inventory_path, args.cache)
    destination = inventory_path.parent / 'publisher-sources.json'
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'packages'}, indent=2))
