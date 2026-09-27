#!/usr/bin/env python3
"""Retain pinned npm publisher archives and their unchanged original notices."""
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
MAX_ARCHIVE = 80 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def archive_notices(archive, package):
    """Inspect only; never extract archive paths or execute package code."""
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE:
        raise ValueError('Invalid npm source archive')
    data = archive.read_bytes()
    ref = package['archive']
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if len(data) != ref['bytes'] or sha256(data) != ref['sha256'] or integrity != ref['integrity']:
        raise ValueError('Changed npm publisher archive')
    with tarfile.open(archive, 'r:gz') as tar:
        entries = {}
        total = 0
        for member in tar:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or member.name in entries:
                raise ValueError('Unsafe or duplicate npm archive entry')
            entries[member.name] = member
            total += member.size
            if len(entries) > 50_000 or total > 512 * 1024 * 1024:
                raise ValueError('Npm archive exceeds inspection limits')

        def read(name):
            entry = entries.get(name)
            if not entry or not entry.isfile() or not 0 < entry.size <= 1024 * 1024:
                raise ValueError('Missing, linked or oversized npm material')
            return tar.extractfile(entry).read()

        metadata = json.loads(read('package/package.json'))
        if metadata['name'] != package['name'] or metadata['version'] != package['version']:
            raise ValueError('Npm archive package identity differs')
        if metadata.get('license') != package['declaredLicense']:
            raise ValueError('Npm license declaration differs')
        available = {
            name for name, member in entries.items()
            if len(PurePosixPath(name).parts) == 2 and member.isfile()
            and re.fullmatch(r'(?:third[-_]party[-_])?(?:licen[cs]es?|copying|copyright|notice)(?:[._-].*)?', PurePosixPath(name).name, re.I)
        }
        if available != {n['packagePath'] for n in package['notices']}:
            raise ValueError('Npm original notice inventory differs')
        result = {}
        for notice in package['notices']:
            content = read(notice['packagePath'])
            if len(content) != notice['bytes'] or sha256(content) != notice['sha256']:
                raise ValueError('Changed npm original notice')
            filename = notice['file']
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,150}', filename) or filename in result:
                raise ValueError('Invalid npm notice destination')
            result[filename] = content
        return data, result


def collect(output, cache, offline=False):
    sources = ROOT / 'resources/npm-notices/SOURCES.json'
    source_bytes = sources.read_bytes()
    lock = json.loads(source_bytes)
    package_lock_bytes = (ROOT / 'package-lock.json').read_bytes()
    package_lock = json.loads(package_lock_bytes)
    if lock['schemaVersion'] != 1 or lock['packageLockSha256'] != sha256(package_lock_bytes):
        raise ValueError('Npm notice sources do not match package-lock.json')
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    files = []
    locations, names = set(), set()
    for package in lock['packages']:
        location = package['location']
        ref = package_lock['packages'].get(location)
        source = package['archive']
        if location in locations or not ref or (ref.get('dev') and package.get('inclusionReason') not in ('bundled-source', 'generated-runtime-support')) or ref['version'] != package['version']:
            raise ValueError('Invalid locked production package')
        locations.add(location)
        if source['url'] != ref['resolved'] or source['integrity'] != ref['integrity']:
            raise ValueError('Npm archive does not match locked publisher')
        url = urlsplit(source['url'])
        if url.scheme != 'https' or url.netloc != 'registry.npmjs.org' or url.query or url.fragment:
            raise ValueError('Unexpected npm publisher URL')
        filename = source['file']
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.tgz', filename):
            raise ValueError('Invalid npm archive destination')
        archive = cache / filename
        if not archive.exists():
            if offline:
                raise ValueError('Missing cached npm source archive: ' + filename)
            temporary = archive.with_suffix('.tgz.download')
            try:
                subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location',
                                '--proto', '=https', '--max-time', '120', '--max-filesize', str(MAX_ARCHIVE),
                                '--output', str(temporary), source['url']], check=True)
                archive_notices(temporary, package)
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
        data, notices = archive_notices(archive, package)
        entries = {'archives/' + filename: data}
        for name, content in notices.items():
            if name in names:
                raise ValueError('Duplicate npm notice destination')
            names.add(name)
            entries['notices/' + name] = content
            if content != (sources.parent / name).read_bytes():
                raise ValueError('Bundled npm notice differs from original publisher archive')
        for name, content in entries.items():
            destination = output / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            files.append({'path': name, 'bytes': len(content), 'sha256': sha256(content)})
    missing = [p['name'] for p in lock['packages'] if not p['notices']]
    if missing != lock['missingOriginalText'] or lock['releaseAuditComplete'] is not False:
        raise ValueError('Npm notice gap record differs')
    (output / 'SOURCES.json').write_bytes(source_bytes)
    result = {'schemaVersion': 1, 'sourceIndexSha256': sha256(source_bytes),
              'packages': len(locations), 'originalNoticeFiles': len(names),
              'missingOriginalText': missing, 'releaseAuditComplete': False, 'files': files}
    (output / 'inventory.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/license-materials/npm')
    parser.add_argument('--cache', type=Path, default=ROOT / 'artifacts/license-materials/npm-archives')
    args = parser.parse_args()
    result = collect(args.output, args.cache, args.offline)
    print(json.dumps({k: v for k, v in result.items() if k != 'files'}, indent=2))
