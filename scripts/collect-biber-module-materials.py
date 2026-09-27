"""Associate Biber's compiled Perl modules with reviewed source materials.

Offline developer audit. Parses Mach-O symbols and original source as data;
never loads native modules, evaluates Perl, or rebuilds the original binaries.
"""
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re

ROOT = Path(__file__).resolve().parent.parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


native = load('module_native', 'collect-biber-native-materials.py')
cpan = load('module_cpan', 'collect-biber-cpan-materials.py')
biber, shared = native.biber, native.shared


def validate_inventory(payload, records):
    actual = {n for n in payload if n.endswith('.bundle')}
    covered, digests, names = set(), set(), set()
    for row in records:
        module = row['module']
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*', module):
            raise ValueError('Invalid Perl module name')
        if module in names or row['sha256'] in digests or not row['payloadPaths'] or not row['sources']:
            raise ValueError('Duplicate or incomplete module association')
        names.add(module); digests.add(row['sha256'])
        if len({s['id'] for s in row['sources']}) != len(row['sources']):
            raise ValueError('Duplicate source candidate')
        for name in row['payloadPaths']:
            biber.path_name(name)
            if name not in actual or name in covered or name.split('/auto/', 1)[-1] != module.replace('::', '/') + '/' + module.split('::')[-1] + '.bundle':
                raise ValueError('Unexpected or overlapping module path')
            data = payload[name]
            if len(data) != row['bytes'] or shared.digest(data) != row['sha256']:
                raise ValueError('Native module bytes differ')
            covered.add(name)
    if covered != actual: raise ValueError('Compiled module coverage is incomplete')


def check_native(data, row):
    if len(data) != row['bytes'] or shared.digest(data) != row['sha256']:
        raise ValueError('Native module bytes differ')
    _, info = native.macho(data, file_type=8)
    required = '_boot_' + row['module'].replace('::', '__')
    if info['bootSymbols'] != row['bootSymbols'] or required not in info['bootSymbols']:
        raise ValueError('Compiled module entry points differ')
    return info


def paired_module_path(path, module):
    relative = module.replace('::', '/') + '.pm'
    return path == 'par/lib/' + relative or bool(re.fullmatch(r'loader/[a-f0-9]{8}/' + re.escape(relative), path))


def check_source(candidate, module, boot_symbols, sources, payload, patch):
    retained = {}
    if not candidate['anchors']: raise ValueError('Missing paired Perl source')
    seen = set()
    for anchor in candidate['anchors']:
        name = anchor['source']; shared.safe_member('source/' + name, 'source')
        if name in seen or name not in sources: raise ValueError('Missing or duplicate source anchor')
        seen.add(name); data = sources[name]
        if shared.digest(data) != anchor['sourceSha256']: raise ValueError('Paired Perl source changed')
        transform = anchor['transformation']
        if transform == 'none': compared = data
        elif transform.startswith('PAR::Filter::PatchContent:'):
            compared = cpan.transformed(data, transform.removeprefix('PAR::Filter::PatchContent:'), patch)
        else: raise ValueError('Unknown source transformation')
        if shared.digest(compared) != anchor['payloadSha256'] or not anchor['payload']:
            raise ValueError('Paired Perl source comparison differs')
        if not any(paired_module_path(p, module) for p in anchor['payload']):
            raise ValueError('Source anchor does not name the native module')
        for target in anchor['payload']:
            if payload.get(target) != compared: raise ValueError('Packaged Perl source differs')
        retained[name] = data
    seen = set()
    for row in candidate['xsDeclarations']:
        name = row['path']; shared.safe_member('source/' + name, 'source')
        if name in seen or name not in sources or not name.endswith(('.xs', '.c')):
            raise ValueError('Missing or duplicate XS source')
        seen.add(name); data = sources[name]
        if len(data) != row['bytes'] or shared.digest(data) != row['sha256']:
            raise ValueError('XS source changed')
        declared = {m.decode() for m in re.findall(rb'(?m)^\s*MODULE\s*=\s*([A-Za-z_][A-Za-z0-9_:]*)\b', data)}
        if not row['modules'] or any(m not in declared or '_boot_' + m.replace('::', '__') not in boot_symbols for m in row['modules']):
            raise ValueError('XS declaration differs from the exported module')
        retained[name] = data
    return retained


def dependency_references(info, payload):
    rows = []
    libraries = [p for p in payload if p.startswith('par/shlib/') and p.endswith('.dylib')]
    for entry in info['dependencies']:
        name = entry['name']; system = name.startswith('/usr/lib/') or name.startswith('/System/Library/')
        matches = sorted(p for p in libraries if PurePosixPath(p).name == PurePosixPath(name).name)
        rows.append({**entry, 'macosSystemPath': system, 'bundledBasenameCandidates': matches,
                     'unbundledNonSystemReference': not system and not matches})
    return rows


def collect():
    lock_bytes = (ROOT / 'resources/biber-module-sources.lock.json').read_bytes(); lock = json.loads(lock_bytes)
    foundation_bytes = (ROOT / 'resources/biber-build-provenance.lock.json').read_bytes()
    cpan_bytes = (ROOT / 'resources/biber-cpan-sources.lock.json').read_bytes()
    if lock['schemaVersion'] != 1 or shared.digest(foundation_bytes) != lock['foundationLockSha256'] or shared.digest(cpan_bytes) != lock['cpanLockSha256']:
        raise ValueError('Original source identities changed')
    foundation, cpan_lock = json.loads(foundation_bytes), json.loads(cpan_bytes)
    binary = biber.verified(ROOT / 'resources/runtime/mac-arm64/biber', foundation['arm64Binary'])
    loader, par, _ = biber.parse_payload(binary, foundation['reviewedZipDuplicates'])
    manifest = json.loads(biber.verified(ROOT / 'resources/runtime/mac-arm64/manifest.json', foundation['runtimeManifest']))
    expected = {n.removeprefix('biber-cache/'): h for n, h in manifest['files'].items() if n.startswith('biber-cache/')}
    cache = biber.map_cache(ROOT / 'resources/runtime/mac-arm64/biber-cache', expected, binary, loader, par, foundation)
    payload = {'par/' + n: d for n, d in par.items()} | {'loader/' + n: d for n, d in loader.items()}
    validate_inventory(payload, lock['modules'])
    wanted = {s['id'] for row in lock['modules'] for s in row['sources']} | {'PAR-Packer-1.055'}
    entries = [e for e in foundation['foundationSources'] + cpan_lock['sources'] if e['id'] in wanted]
    if len(entries) != len(wanted): raise ValueError('Missing or duplicate source archive')
    sources, retained, source_records = {}, {}, []
    for entry in entries:
        archive = biber.foundation_input(entry, True) if entry in foundation['foundationSources'] else cpan.get_input(entry, True)
        sources[entry['id']] = biber.archive_sources(archive, entry['root'])
        retained['sources/' + entry['archive']] = archive
        names = {n for n in sources[entry['id']] if shared.NOTICE.fullmatch(PurePosixPath(n).name)}
        names.update(n for n in ['README', 'README.md', 'INSTALL', 'MANIFEST', 'Makefile.PL', 'Build.PL', 'Artistic'] if n in sources[entry['id']])
        if len(names) > 512: raise ValueError('Source notice inventory exceeds bounds')
        for name in names: retained['materials/' + entry['id'] + '/' + name] = sources[entry['id']][name]
        source_records.append({**entry, 'selectedNoticeAndBuildFiles': sorted(names)})
    patch = sources['PAR-Packer-1.055']['lib/PAR/Filter/PatchContent.pm']
    if shared.digest(patch) != cpan_lock['packagerFilterSha256']: raise ValueError('Packager source changed')
    retained['materials/PAR-Packer-1.055/lib/PAR/Filter/PatchContent.pm'] = patch
    records = []
    for row in lock['modules']:
        info = check_native(payload[row['payloadPaths'][0]], row)
        for candidate in row['sources']:
            files = check_source(candidate, row['module'], info['bootSymbols'], sources[candidate['id']], payload, patch)
            retained.update({'materials/' + candidate['id'] + '/' + name: data for name, data in files.items()})
        records.append({**row, 'native': info, 'dependencyReferences': dependency_references(info, payload),
                        'sourceVersionAmbiguous': len(row['sources']) > 1,
                        'requiresGeneratedXsReview': not any(s['xsDeclarations'] for s in row['sources'])})
    missing = sorted({d['name'] for r in records for d in r['dependencyReferences'] if d['unbundledNonSystemReference']})
    output = ROOT / 'artifacts/license-materials/biber-modules'
    for name, data in sorted(retained.items()):
        shared.safe_member('output/' + name, 'output'); path = output / name
        if any(p.is_symlink() for p in [path, *path.parents]): raise ValueError('Linked material output')
        shared.atomic_write(path, data)
    report = {'schemaVersion': 1, 'releaseAuditComplete': False, 'scope': lock['scope'],
              'collectorSha256': shared.digest(Path(__file__).read_bytes()), 'lockSha256': shared.digest(lock_bytes),
              'helpers': {p: shared.digest((ROOT / 'scripts' / p).read_bytes()) for p in ['collect-biber-native-materials.py', 'collect-biber-cpan-materials.py', 'collect-biber-build-evidence.py', 'collect-rust-license-materials.py']},
              'arm64Binary': foundation['arm64Binary'], 'preparedCacheFilesVerified': len(cache), 'sources': source_records,
              'summary': {'compiledModulePayloadFiles': sum(len(r['payloadPaths']) for r in records), 'distinctCompiledModules': len(records),
                          'sourceArchives': len(entries), 'sourceArchiveBytes': sum(e['bytes'] for e in entries),
                          'ambiguousSourceAssociations': sum(r['sourceVersionAmbiguous'] for r in records),
                          'generatedXsReviewRequired': sum(r['requiresGeneratedXsReview'] for r in records),
                          'sourceMaterialFiles': sum(p.startswith('materials/') for p in retained),
                          'newExactNativeRebuilds': 0},
              'modules': records, 'unbundledNonSystemReferences': missing,
              'evidence': [biber.file_record(n, d) for n, d in sorted(retained.items())],
              'limits': ['Exported entry points and exact paired Perl files establish source associations, not native build versions, vendor patches or byte-identical compiled binaries.',
                         'All matching candidate archives are retained where paired source bytes are shared by multiple releases; no ambiguous version is silently selected.',
                         'Some Encode XS sources are generated. Their paired modules and full original archives are retained; their generated XS inputs still require review.',
                         'Dependency paths and basename candidates are static references, not proof of runtime resolution. X11 and MySQL client references have no bundled library candidate.',
                         'Static/vendored native dependencies, complete license obligations, corresponding-source publication, production signing and the final app SBOM remain open.']}
    shared.atomic_write(output / 'inventory.json', (json.dumps(report, indent=2) + '\n').encode())
    return report


if __name__ == '__main__':
    output = ROOT / 'artifacts/license-materials/biber-modules'
    try: report = collect()
    except Exception as error:
        shared.atomic_write(output / 'incomplete-inventory.json', (json.dumps({'releaseAuditComplete': False, 'error': str(error)}, indent=2) + '\n').encode()); raise
    (output / 'incomplete-inventory.json').unlink(missing_ok=True)
    print(json.dumps(report['summary'], indent=2))
