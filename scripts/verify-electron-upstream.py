"""Verify retained publisher archives and the original Electron notice copies offline.

Pass a directory containing the release ZIP, SHASUMS256.txt and electron-VERSION.tgz.
Nothing is extracted or executed. JSON evidence is written to stdout only on success.
"""
from pathlib import Path
import base64
import gzip
import hashlib
import json
import stat
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def digest_file(file, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.digest()


def checked_file(file, expected):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != expected['bytes']:
        raise ValueError(f'Changed or linked input: {file.name}')
    if digest_file(file).hex() != expected['sha256']:
        raise ValueError(f'Changed input digest: {file.name}')
    return {'file': file.name, **expected}


def tar_member(archive, name, limit):
    matches = [item for item in archive.getmembers() if item.name == name]
    if len(matches) != 1 or not matches[0].isfile() or not 0 < matches[0].size <= limit:
        raise ValueError('Missing, linked, duplicate or oversized npm material.')
    return archive.extractfile(matches[0]).read(limit + 1)


def verify(folder):
    source = ROOT / 'resources/electron-notices'
    index_bytes = (source / 'SOURCES.json').read_bytes()
    index = json.loads(index_bytes)
    locked = json.loads((ROOT / 'package-lock.json').read_text())['packages']['node_modules/electron']
    version = index['electronVersion']
    if (index['platform'] != 'darwin-arm64' or version != locked['version'] or
            index['package']['integrity'] != locked['integrity'] or
            index['package']['url'] != locked['resolved']):
        raise ValueError('Upstream evidence differs from the dependency lock.')
    archive = index['upstream']['archive']
    filename = f'electron-v{version}-darwin-arm64.zip'
    if archive['name'] != filename:
        raise ValueError('Unexpected release archive name.')
    zip_path = folder / filename
    records = [checked_file(zip_path, {k: archive[k] for k in ['bytes', 'sha256']})]
    checks_path = folder / 'SHASUMS256.txt'
    records.append(checked_file(checks_path, {k: index['upstream']['checksums'][k] for k in ['bytes', 'sha256']}))
    lines = [line.split() for line in checks_path.read_text().splitlines() if line.split() and line.split()[-1].lstrip('*') == filename]
    if len(lines) != 1 or len(lines[0]) != 2 or lines[0][0] != archive['sha256']:
        raise ValueError('Publisher checksum file disagrees with the release archive.')
    npm_path = folder / f'electron-{version}.tgz'
    records.append(checked_file(npm_path, {'bytes': index['package']['archiveBytes'], 'sha256': index['package']['archiveSha256']}))
    if 'sha512-' + base64.b64encode(digest_file(npm_path, 'sha512')).decode() != locked['integrity']:
        raise ValueError('Npm archive does not match its locked SHA-512.')
    with tarfile.open(npm_path, 'r:gz') as tar:
        npm_checks = tar_member(tar, 'package/checksums.json', 32 * 1024)
        package = json.loads(tar_member(tar, 'package/package.json', 32 * 1024))
    if (package['version'] != version or hashlib.sha256(npm_checks).hexdigest() != index['package']['checksumsSha256'] or
            json.loads(npm_checks)[filename] != archive['sha256']):
        raise ValueError('Npm publisher checksum entry disagrees with the release archive.')
    notices = []
    with zipfile.ZipFile(zip_path) as zipped:
        for original in [*index['noticeFiles'], index['framework']]:
            matches = [info for info in zipped.infolist() if info.filename == original['file']]
            if len(matches) != 1 or matches[0].is_dir() or matches[0].file_size != original['bytes']:
                raise ValueError('Missing, duplicate or changed release member.')
            if stat.S_ISLNK(matches[0].external_attr >> 16):
                raise ValueError('Linked release member.')
            h = hashlib.sha256()
            with zipped.open(matches[0]) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
            if h.hexdigest() != original['sha256']:
                raise ValueError('Release member hash differs.')
            if 'compressedFile' in original:
                if original['file'] not in ['LICENSE', 'LICENSES.chromium.html'] or original['compressedFile'] != original['file'] + '.gz':
                    raise ValueError('Unexpected notice filename.')
                compressed = source / original['compressedFile']
                checked_file(compressed, {'bytes': original['compressedBytes'], 'sha256': original['compressedSha256']})
                expanded = gzip.decompress(compressed.read_bytes())
                if len(expanded) != original['bytes'] or hashlib.sha256(expanded).hexdigest() != original['sha256']:
                    raise ValueError('Compressed notice differs from the original release.')
                notices.append({k: original[k] for k in ['file', 'bytes', 'sha256']})
    if len(notices) != 2:
        raise ValueError('Both original notices are required.')
    return {'schemaVersion': 1, 'electronVersion': version, 'sourceIndexSha256': hashlib.sha256(index_bytes).hexdigest(),
            'archivesAndChecksums': records, 'noticeFiles': notices, 'framework': index['framework'],
            'publisherAndNpmChecksumEntriesAgree': True, 'compressedCopiesMatchCompleteOriginals': True,
            'completeBinarySbom': False,
            'scope': 'Retained publisher archive identities and original notice copies verified offline. No archive is extracted or executed. This is not an independent native-source rebuild or complete redistribution/SBOM review.'}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/verify-electron-upstream.py /path/to/retained-archives')
    print(json.dumps(verify(Path(sys.argv[1])), indent=2))
