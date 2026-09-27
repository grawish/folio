#!/usr/bin/env python3
"""Retain exact PDF.js component sources, notices and publisher-map associations."""
import argparse
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('npm_materials', ROOT / 'scripts/collect-npm-license-materials.py')
npm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(npm)


def relative(name):
    if (not isinstance(name, str) or not name or '\\' in name or '\0' in name
            or name.startswith('/') or '..' in PurePosixPath(name).parts
            or str(PurePosixPath(name)) != name):
        raise ValueError('Invalid PDF.js material path')
    return name


def checked(data, ref):
    if len(data) != ref['bytes'] or npm.sha256(data) != ref['sha256']:
        raise ValueError('Changed PDF.js material')
    return data


def cached(ref, destination, offline, maximum=1024 * 1024):
    if ref['bytes'] < 1 or ref['bytes'] > maximum:
        raise ValueError('PDF.js material exceeds collection limit')
    if destination.is_symlink():
        raise ValueError('Linked PDF.js material')
    if not destination.exists():
        if offline:
            raise ValueError('Missing cached PDF.js material: ' + destination.name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.download')
        if temporary.is_symlink():
            raise ValueError('Linked PDF.js download destination')
        try:
            subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
                            '--max-time', '120', '--max-filesize', str(maximum), '--output', str(temporary), ref['url']], check=True)
            checked(temporary.read_bytes(), ref)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    if not destination.is_file() or destination.stat().st_size > maximum:
        raise ValueError('Invalid cached PDF.js material')
    return checked(destination.read_bytes(), ref)


def original_notice(ref, source):
    if ref['copy'] == 'complete-original':
        data = source
    elif ref['copy'] == 'original-comment-prefix' and ref.get('offset') == 0:
        match = re.match(rb'(?:/\*.*?\*/\s*)+', source, re.S)
        if not match or b'Copyright' not in match.group():
            raise ValueError('Original PDF.js copyright header missing')
        data = match.group()
    else:
        raise ValueError('Unknown PDF.js notice copy rule')
    return checked(data, ref)


def verify_map_bindings(bindings, sources, publisher):
    maps, seen, count = {}, set(), 0
    for item in bindings:
        source = relative(item['source'])
        if source in seen or source not in sources or not item['bindings']:
            raise ValueError('Invalid PDF.js source association')
        seen.add(source)
        per_source = set()
        for binding in item['bindings']:
            name, index = relative(binding['map']), binding['index']
            if name not in maps:
                maps[name] = json.loads(publisher[name])
            mapping = maps[name]
            if (type(index) is not int or not 0 <= index < len(mapping['sources'])
                    or (name, index) in per_source
                    or mapping['sources'][index] != 'webpack://pdf.js/./' + source
                    or not isinstance(mapping['sourcesContent'][index], str)
                    or mapping['sourcesContent'][index].encode() != sources[source]):
                raise ValueError('PDF.js publisher source-map association differs')
            per_source.add((name, index)); count += 1
    return count


def collect(output, cache, archive_cache, offline=False, root=ROOT):
    lock_bytes = (root / 'resources/pdfjs-notices/SOURCES.json').read_bytes()
    lock = json.loads(lock_bytes)
    if lock['schemaVersion'] != 1 or lock['completeBinarySbom'] is not False:
        raise ValueError('Invalid PDF.js component scope')
    pkg = lock['package']; upstream = lock['upstream']; commit = upstream['commit']
    if (pkg['name'] != 'pdfjs-dist' or upstream['repository'] != 'mozilla/pdf.js'
            or not re.fullmatch('[0-9a-f]{40}', commit)):
        raise ValueError('Unexpected PDF.js source identity')
    source_index = json.loads((root / 'resources/npm-notices/SOURCES.json').read_text())
    original = next(p for p in source_index['packages'] if p['location'] == pkg['location'])
    package_lock = json.loads((root / 'package-lock.json').read_text())['packages'][pkg['location']]
    if (original['name'] != pkg['name'] or original['version'] != pkg['version'] or original['archive'] != pkg['archive']
            or package_lock['version'] != pkg['version'] or package_lock['integrity'] != pkg['archive']['integrity']
            or package_lock['resolved'] != pkg['archive']['url']):
        raise ValueError('PDF.js archive differs from the npm dependency lock')
    metadata_ref = upstream['npmMetadata']
    if metadata_ref['url'] != 'https://registry.npmjs.org/pdfjs-dist/' + pkg['version']:
        raise ValueError('Unexpected PDF.js registry metadata URL')
    metadata_bytes = cached(metadata_ref, cache / relative(metadata_ref['file']), offline)
    metadata = json.loads(metadata_bytes)
    if (metadata['name'] != pkg['name'] or metadata['version'] != pkg['version'] or metadata['gitHead'] != commit
            or metadata['dist']['integrity'] != pkg['archive']['integrity'] or metadata['dist']['tarball'] != pkg['archive']['url']):
        raise ValueError('PDF.js publisher commit/archive binding differs')
    archive = archive_cache / relative(pkg['archive']['file'])
    data = cached(pkg['archive'], archive, offline, npm.MAX_ARCHIVE)
    npm.archive_notices(archive, original)
    publisher = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for ref in lock['publisherFiles']:
            name = relative(ref['path'])
            if name in publisher:
                raise ValueError('Duplicate PDF.js publisher input')
            member = tar.getmember('package/' + name)
            if not member.isfile() or not 0 < member.size <= 16 * 1024 * 1024:
                raise ValueError('Invalid PDF.js publisher input')
            publisher[name] = checked(tar.extractfile(member).read(), ref)
    sources = {}
    for ref in lock['upstreamFiles']:
        name = relative(ref['path'])
        if name in sources or ref['url'] != 'https://raw.githubusercontent.com/mozilla/pdf.js/' + commit + '/' + name:
            raise ValueError('Unexpected PDF.js upstream input')
        sources[name] = cached(ref, cache / 'upstream' / name, offline)
    count = verify_map_bindings(lock['sourceMapBindings'], sources, publisher)
    if {i['source'] for i in lock['sourceMapBindings']} != {i['path'] for i in lock['upstreamFiles'] if i['role'] == 'source'}:
        raise ValueError('Unassociated PDF.js original source')
    notices = {}
    for ref in lock['noticeFiles']:
        name = relative(ref['file'])
        if '/' in name or name in notices:
            raise ValueError('Invalid PDF.js notice destination')
        content = original_notice(ref, sources[ref['source']])
        if content != (root / 'resources/pdfjs-notices' / name).read_bytes():
            raise ValueError('Bundled PDF.js notice differs from original')
        notices[name] = content
    records = []
    retained = {'npm-metadata.json': metadata_bytes, 'archives/' + pkg['archive']['file']: data,
                **{'upstream/' + k: v for k, v in sources.items()},
                **{'publisher/' + k: v for k, v in publisher.items()},
                **{'notices/' + k: v for k, v in notices.items()}}
    output.mkdir(parents=True, exist_ok=True)
    for name, content in sorted(retained.items()):
        destination = output / name; destination.parent.mkdir(parents=True, exist_ok=True); destination.write_bytes(content)
        records.append({'file': name, 'bytes': len(content), 'sha256': npm.sha256(content)})
    result = {'schemaVersion': 1, 'passed': True, 'sourceIndexSha256': npm.sha256(lock_bytes), 'packageVersion': pkg['version'],
              'upstreamCommit': commit, 'originalSources': len(lock['sourceMapBindings']), 'sourceMapBindings': count,
              'noticeFiles': len(notices), 'completeBinarySbom': False, 'scope': lock['scope'], 'files': records}
    (output / 'SOURCES.json').write_bytes(lock_bytes)
    (output / 'inventory.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/license-materials/pdfjs')
    parser.add_argument('--cache', type=Path, default=ROOT / 'artifacts/license-materials/pdfjs-cache')
    parser.add_argument('--archive-cache', type=Path, default=ROOT / 'artifacts/license-materials/npm-archives')
    args = parser.parse_args()
    report = collect(args.output, args.cache, args.archive_cache, args.offline)
    print(json.dumps({k: v for k, v in report.items() if k != 'files'}, indent=2))
