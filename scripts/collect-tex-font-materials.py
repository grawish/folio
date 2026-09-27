"""Retain exact bundled-font distribution sources and publish original notices.

Python 3.11+. No archive extraction, font installation or upstream execution.
Use --offline for cached inputs and --write-notices to refresh packaged notices.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import lzma
from pathlib import Path
import re
import tarfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('font_materials_shared', ROOT / 'scripts/collect-rust-license-materials.py')
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
MAX_EXPANDED = 256 * 1024 * 1024
MAX_MEMBER = 16 * 1024 * 1024


def safe_path(name):
    shared.safe_member('root/' + name, 'root')
    if any(ord(c) < 32 for c in name) or ':' in name: raise ValueError('Unsafe material path')
    return name


def verify(data, entry):
    if len(data) != entry['bytes'] or shared.digest(data) != entry['sha256']:
        raise ValueError('Source or material differs from its lock')
    return data


def source_url(url):
    patterns = [r'https://ftp\.math\.utah\.edu/pub/tex/historic/systems/texlive/2021/tlnet-final/(archive/[a-z0-9.-]+\.tar\.xz|tlpkg/texlive\.tlpdb\.xz)',
                r'https://codeload\.github\.com/FortAwesome/Font-Awesome/tar\.gz/[a-f0-9]{40}',
                r'https://raw\.githubusercontent\.com/spdx/license-list-data/[a-f0-9]{40}/text/OFL-1\.1\.txt',
                r'https://www\.latex-project\.org/lppl/lppl-1-3c\.txt']
    if not any(re.fullmatch(p, url) for p in patterns): raise ValueError('Unreviewed source URL')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Source redirects are not allowed')


def get_input(entry, offline):
    name = safe_path(entry['archive'])
    if '/' in name or not 0 < entry['bytes'] <= 64 * 1024 * 1024: raise ValueError('Invalid source archive bounds')
    source_url(entry['url'])
    p = ROOT / '.cache/license-sources/tex-fonts' / name
    if any(n.is_symlink() for n in [p, *p.parents]): raise ValueError('Linked source cache')
    try:
        if not p.is_file() or p.stat().st_size != entry['bytes']:
            if p.exists(): raise ValueError('Source cache size or type differs')
            raise FileNotFoundError(p)
        return verify(p.read_bytes(), entry)
    except FileNotFoundError:
        if offline: raise ValueError('Missing offline source: ' + name)
    request = urllib.request.Request(entry['url'], headers={'User-Agent': 'Folio-source-audit/1.0'})
    deadline = time.monotonic() + 120
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        chunks, total = [], 0
        while chunk := response.read(64 * 1024):
            total += len(chunk)
            if total > entry['bytes'] or time.monotonic() > deadline: raise ValueError('Source download exceeds bounds')
            chunks.append(chunk)
    data = verify(b''.join(chunks), entry); shared.atomic_write(p, data)
    return data


def database_records(data, entry):
    verify(data, entry)
    decoder = lzma.LZMADecompressor()
    raw = decoder.decompress(data, max_length=32 * 1024 * 1024 + 1)
    if not decoder.eof or decoder.unused_data or len(raw) > 32 * 1024 * 1024:
        raise ValueError('Database exceeds decompression bounds')
    if len(raw) != entry['uncompressedBytes'] or shared.digest(raw) != entry['uncompressedSha256']:
        raise ValueError('Package database differs')
    result = {}
    for block in raw.split(b'\n\n'):
        if not block.startswith(b'name '): continue
        name = block.split(b'\n', 1)[0][5:].decode()
        if name in result: raise ValueError('Duplicate package database record')
        result[name] = block
    return result


def verify_package(data, source, records):
    verify(data, source)
    if 'package' not in source: return None
    block = records[source['package']]
    if len(block) != source['metadataBytes'] or shared.digest(block) != source['metadataSha256']:
        raise ValueError('Reviewed package metadata differs')
    fields = {}
    for line in block.decode().splitlines():
        key, _, value = line.partition(' ')
        if key in ['name','revision','catalogue-license','containersize','containerchecksum','doccontainersize','doccontainerchecksum']:
            if key in fields: raise ValueError('Duplicate publisher checksum field')
            fields[key] = value
    prefix = source['containerPrefix']
    if (prefix not in ['', 'doc'] or fields['name'] != source['package'] or
        int(fields['revision']) != source['revision'] or fields['catalogue-license'] != source['declaredLicense'] or
        int(fields[prefix + 'containersize']) != len(data) or
        fields[prefix + 'containerchecksum'] != source['publisherSha512'] or
        hashlib.sha512(data).hexdigest() != source['publisherSha512']):
        raise ValueError('Source differs from publisher package/checksum metadata')
    return block


def archive_materials(data, source, bundle):
    verify(data, source)
    mode = {'tar.xz':'r:xz', 'tar.gz':'r:gz'}[source['format']]
    needed = {e['path']: e for e in source['materials']}
    matched = {e['source']: e for e in source['matches']}
    selected, matches, seen, expanded = {}, [], set(), 0
    with tarfile.open(fileobj=io.BytesIO(data), mode=mode) as archive:
        for count, member in enumerate(archive, 1):
            name = safe_path(member.name.rstrip('/') if member.isdir() else member.name)
            expanded += member.size
            if count > 30000 or member.size < 0 or expanded > MAX_EXPANDED: raise ValueError('Archive exceeds audit bounds')
            if name.casefold() in seen: raise ValueError('Duplicate or case-colliding archive member')
            seen.add(name.casefold())
            if member.isdir(): continue
            if not member.isfile(): raise ValueError('Archive contains a link or special file')
            if name not in needed and name not in matched: continue
            if member.size > MAX_MEMBER: raise ValueError('Selected member exceeds audit bounds')
            content = archive.extractfile(member).read(MAX_MEMBER + 1)
            if len(content) != member.size: raise ValueError('Truncated archive material')
            if name in needed: selected[name] = verify(content, needed[name])
            if name in matched:
                row = matched[name];verify(content, row)
                if bundle.get(row['bundle']) != content: raise ValueError('Bundled file does not exactly match its source')
                matches.append({**row, 'distribution': source['id']})
    if set(selected) != set(needed) or len(matches) != len(matched): raise ValueError('Missing locked archive material')
    return selected, matches


def bundle_files(lock):
    raw = (ROOT / 'resources/bundle.lock.json').read_bytes()
    if shared.digest(raw) != lock['bundleLockSha256']: raise ValueError('Bundle lock changed')
    expected = json.loads(raw)['files']; runtime = ROOT / 'resources/runtime/mac-arm64'
    if (runtime / 'bundle.lock.json').read_bytes() != raw: raise ValueError('Prepared bundle lock differs')
    manifest = json.loads((runtime / 'manifest.json').read_text())
    data = (runtime / 'bundle.zip').read_bytes()
    if shared.digest(data) != manifest['files']['bundle.zip']: raise ValueError('Runtime bundle differs from manifest')
    files, seen = {}, set()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        expanded = 0
        for member in archive.infolist():
            name = safe_path(member.filename); expanded += member.file_size
            if name in seen or member.is_dir() or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Duplicate or linked bundle entry')
            if member.file_size > MAX_MEMBER or expanded > 128 * 1024 * 1024 or len(files) >= 1024:
                raise ValueError('Runtime bundle exceeds audit bounds')
            seen.add(name)
            content = archive.read(member)
            if name == 'SHA256SUM':
                digest = shared.digest(json.dumps(expected, separators=(',', ':'), ensure_ascii=False).encode()).encode()
                if content != digest: raise ValueError('Runtime bundle identity marker differs')
                continue
            if shared.digest(content) != expected.get(name): raise ValueError('Runtime resource differs from lock')
            files[name] = content
    if set(files) != set(expected) or 'SHA256SUM' not in seen: raise ValueError('Incomplete runtime resource inventory')
    return files


def publishable_notices(lock, materials):
    result = {}
    for entry in lock['noticeFiles']:
        name = safe_path(entry['file'])
        if '/' in name or name.casefold() in {n.casefold() for n in result}: raise ValueError('Colliding notice output')
        data = materials[(entry['source'], entry.get('member', ''))]
        result[name] = verify(data, entry)
    return result


def collect(offline, write_notices):
    lock_bytes = (ROOT / 'resources/tex-font-sources.lock.json').read_bytes();lock = json.loads(lock_bytes)
    if lock['schemaVersion'] != 1: raise ValueError('Unsupported font-source lock')
    bundle = bundle_files(lock); db = get_input(lock['database'], offline)
    records = database_records(db, lock['database']);retained = {'sources/' + lock['database']['archive']: db}
    all_materials, matches = {}, []
    for source in lock['sources']:
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,80}', source['id']): raise ValueError('Invalid source identity')
        data = get_input(source, offline);block = verify_package(data, source, records)
        selected, found = archive_materials(data, source, bundle);matches.extend(found)
        retained['sources/' + source['archive']] = data
        if block is not None: retained['metadata/' + source['package'] + '.tlpobj'] = block
        for name, content in selected.items():
            retained['materials/' + source['id'] + '/' + name] = content
            all_materials[(source['id'], name)] = content
    for entry in lock['texts']:
        data = get_input(entry, offline);retained['licenses/' + entry['archive']] = data
        all_materials[(entry['id'], '')] = data
    names = {m['bundle'] for m in matches};fonts = {n for n in bundle if n.endswith(('.otf', '.ttf', '.pfb'))}
    if len(names) != len(matches) or not fonts <= names: raise ValueError('Duplicate mapping or unmapped font binary')
    notices = publishable_notices(lock, all_materials)
    output = ROOT / 'artifacts/license-materials/tex-fonts'
    for name, data in sorted(retained.items()): shared.atomic_write(output / name, data)
    for name, data in notices.items():
        shared.atomic_write(output / 'app-notices' / name, data)
        if write_notices: shared.atomic_write(ROOT / 'resources/tex-font-notices' / name, data)
    report = {'schemaVersion':1, 'releaseAuditComplete':False, 'scope':lock['scope'],
              'collectorSha256':shared.digest(Path(__file__).read_bytes()), 'lockSha256':shared.digest(lock_bytes),
              'sharedCollectorSha256':shared.digest((ROOT / 'scripts/collect-rust-license-materials.py').read_bytes()),
              'summary':{'bundledResources':len(bundle),'matchedResources':len(matches),'fontBinaries':len(fonts),'unmatchedResources':len(bundle)-len(matches),'originalNoticeFiles':len(notices),'sourceArchives':len(lock['sources'])},
              'matches': sorted(matches, key=lambda r:r['bundle']),
              'unmatchedResources': sorted(set(bundle)-names),
              'sources':[{k:s[k] for k in ['id','url','archive','bytes','sha256']} for s in lock['sources']],
              'evidence':[{'path':n,'bytes':len(d),'sha256':shared.digest(d)} for n,d in sorted(retained.items())],
              'noticeFiles':lock['noticeFiles'],
              'limits':['Exact distribution-file mapping, not reproduction from editable font design sources.',
                        'Font Awesome publisher archive supplies supplemental notice context; its font bytes differ from the matched TeX Live copies.',
                        'Other TeX resources, complete redistribution review and the final signed-app SBOM remain open.']}
    shared.atomic_write(output / 'inventory.json', (json.dumps(report, indent=2)+'\n').encode())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true');parser.add_argument('--write-notices', action='store_true')
    args = parser.parse_args();output = ROOT / 'artifacts/license-materials/tex-fonts'
    try: report = collect(args.offline, args.write_notices)
    except Exception as error:
        shared.atomic_write(output / 'incomplete-inventory.json', (json.dumps({'releaseAuditComplete':False,'error':str(error)},indent=2)+'\n').encode())
        raise
    (output / 'incomplete-inventory.json').unlink(missing_ok=True)
    print(json.dumps(report['summary'], indent=2))
