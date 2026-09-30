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

GENERATED_XS_MODULES = {
    'Encode::Byte', 'Encode::CN', 'Encode::EBCDIC', 'Encode::EUCJPASCII', 'Encode::HanExtra',
    'Encode::JIS2K', 'Encode::JP', 'Encode::KR', 'Encode::Symbol', 'Encode::TW',
}


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
    _, info = native.macho(data, file_type=8, name_suffix='_encoding')
    required = '_boot_' + row['module'].replace('::', '__')
    if info['bootSymbols'] != row['bootSymbols'] or required not in info['bootSymbols']:
        raise ValueError('Compiled module entry points differ')
    if 'expectedEncodingSymbols' in row and info['suffixNames'] != row['expectedEncodingSymbols']:
        raise ValueError('Compiled module encoding-table symbols differ from reviewed enc2xs reproduction')
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

def bundling_chain_evidence(sources):
    # Module::ScanDeps (the dependency scanner PAR::Packer uses) has two
    # hardcoded heuristic rules that explain the unbundled X11/mysql
    # references without Biber itself ever using Tk or MySQL:
    #   'DBI.pm' => sub { grep !/\bProxy\b/, _glob_in_inc('DBD', 1); }
    #     -- scanning DBI.pm bundles every installed DBD::* driver.
    #   'Tk.pm' => sub { $SeenTk = 1; qw( Tk/FileSelect.pm Encode/Unicode.pm ) }
    #     -- scanning any file named Tk.pm (including AnyEvent::Impl::Tk)
    #        triggers recursive Tk bundling.
    # Biber depends on Log::Log4perl, whose bundled Appender::DBI uses DBI
    # directly; DBI's own bundled DBD::Gofer::Transport::corostream uses
    # AnyEvent, and AnyEvent ships AnyEvent/Impl/Tk.pm as one of its
    # interchangeable event-loop backends. Every step below is a byte
    # presence/pattern check against the exact retained source archives.
    checks = [
        ('Log-Log4perl-1.54', 'lib/Log/Log4perl/Appender/DBI.pm', rb'\buse\s+DBI\b'),
        ('DBI-1.643', 'lib/DBD/Gofer/Transport/corostream.pm', rb'\buse\s+AnyEvent\b'),
    ]
    steps = []
    for source_id, path, pattern in checks:
        data = sources[source_id].get(path)
        steps.append({'source': source_id, 'path': path, 'present': data is not None,
                      'patternFound': bool(data and re.search(pattern, data))})
    tk_impl_present = 'lib/AnyEvent/Impl/Tk.pm' in sources['AnyEvent-7.17']
    steps.append({'source': 'AnyEvent-7.17', 'path': 'lib/AnyEvent/Impl/Tk.pm', 'present': tk_impl_present,
                  'patternFound': tk_impl_present})
    return {'scanDepsRule': 'DBI.pm bundles every installed DBD::* driver; any Tk.pm reference triggers recursive Tk bundling',
            'chainVerified': all(s['present'] and s['patternFound'] for s in steps), 'steps': steps}

def ambiguous_build_input_paths(candidate, all_sources):
    # For a module built by enc2xs from .ucm tables (Encode's generated-XS
    # modules), the module's own .pm does not name its build inputs. Derive
    # them the same way each candidate's own Makefile.PL does: a sibling
    # Makefile.PL plus every *.ucm file under a shared ucm/ directory next to
    # the Encode source root (see e.g. Encode-3.16/Byte/Makefile.PL, which
    # opendir()s '../ucm').
    [anchor] = candidate['anchors']
    source_root = all_sources[candidate['id']]
    module_dir = str(PurePosixPath(anchor['source']).parent)
    module_dir = '' if module_dir == '.' else module_dir
    encode_root = str(PurePosixPath(module_dir).parent) if module_dir else ''
    encode_root = '' if encode_root == '.' else encode_root
    ucm_dir = (encode_root + '/ucm/') if encode_root else 'ucm/'
    makefile = (module_dir + '/Makefile.PL') if module_dir else 'Makefile.PL'
    ucm_files = sorted(p for p in source_root if p.startswith(ucm_dir) and p.endswith('.ucm'))
    return [makefile] + ucm_files


def ambiguous_build_inputs_identical(row, all_sources):
    # True only if every candidate's derived build-input set (paths and
    # bytes) is identical, meaning the version ambiguity cannot change the
    # compiled output regardless of which candidate was actually linked.
    digests = []
    for candidate in row['sources']:
        paths = ambiguous_build_input_paths(candidate, all_sources)
        source_root = all_sources[candidate['id']]
        if any(p not in source_root for p in paths):
            return False
        digests.append({p.split('/')[-1]: shared.digest(source_root[p]) for p in paths})
    return len(digests) > 1 and all(d == digests[0] for d in digests[1:])


def collect():
    lock_bytes = (ROOT / 'resources/biber-module-sources.lock.json').read_bytes(); lock = json.loads(lock_bytes)
    foundation_bytes = (ROOT / 'resources/biber-build-provenance.lock.json').read_bytes()
    cpan_bytes = (ROOT / 'resources/biber-cpan-sources.lock.json').read_bytes()
    encode_lock_bytes = (ROOT / 'resources/biber-encode-xs-sources.lock.json').read_bytes()
    if lock['schemaVersion'] != 1 or shared.digest(foundation_bytes) != lock['foundationLockSha256'] or shared.digest(cpan_bytes) != lock['cpanLockSha256']:
        raise ValueError('Original source identities changed')
    encode_lock = json.loads(encode_lock_bytes)
    if (encode_lock.get('schemaVersion') != 1 or encode_lock.get('biberModuleLockSha256') != shared.digest(lock_bytes)
            or encode_lock.get('cpanLockSha256') != shared.digest(cpan_bytes)
            or {row.get('module') for row in encode_lock.get('modules', [])} != GENERATED_XS_MODULES):
        raise ValueError('Encode XS review lock differs from reviewed module/CPAN identity')
    encode_inventory_path = ROOT / 'artifacts/license-materials/biber-encode-xs/inventory.json'
    encode_inventory_bytes = encode_inventory_path.read_bytes()
    encode_inventory = json.loads(encode_inventory_bytes)
    if (encode_inventory.get('lockSha256') != shared.digest(encode_lock_bytes)
            or encode_inventory.get('summary', {}).get('modules') != len(GENERATED_XS_MODULES)
            or {row['module'] for row in encode_inventory.get('modules', [])} != GENERATED_XS_MODULES):
        raise ValueError('Encode XS evidence inventory differs from reviewed lock')
    foundation, cpan_lock = json.loads(foundation_bytes), json.loads(cpan_bytes)
    binary = biber.verified(ROOT / 'resources/runtime/mac-arm64/biber', foundation['arm64Binary'])
    loader, par, _ = biber.parse_payload(binary, foundation['reviewedZipDuplicates'])
    manifest = json.loads(biber.verified(ROOT / 'resources/runtime/mac-arm64/manifest.json', foundation['runtimeManifest']))
    expected = {n.removeprefix('biber-cache/'): h for n, h in manifest['files'].items() if n.startswith('biber-cache/')}
    cache = biber.map_cache(ROOT / 'resources/runtime/mac-arm64/biber-cache', expected, binary, loader, par, foundation)
    payload = {'par/' + n: d for n, d in par.items()} | {'loader/' + n: d for n, d in loader.items()}
    validate_inventory(payload, lock['modules'])
    wanted = ({s['id'] for row in lock['modules'] for s in row['sources']} |
              {'PAR-Packer-1.055', 'Log-Log4perl-1.54', 'AnyEvent-7.17'})
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
        ambiguous = len(row['sources']) > 1
        generated_xs_reviewed = row['module'] in GENERATED_XS_MODULES
        records.append({**row, 'native': info, 'dependencyReferences': dependency_references(info, payload),
                        'sourceVersionAmbiguous': ambiguous,
                        'ambiguousBuildInputsIdentical': ambiguous_build_inputs_identical(row, sources) if ambiguous else None,
                        'generatedXsReviewed': generated_xs_reviewed,
                        'requiresGeneratedXsReview': not generated_xs_reviewed and not any(s['xsDeclarations'] for s in row['sources'])})
    missing = sorted({d['name'] for r in records for d in r['dependencyReferences'] if d['unbundledNonSystemReference']})
    bundling_chain = bundling_chain_evidence(sources)
    for source_id, path in [('Log-Log4perl-1.54', 'lib/Log/Log4perl/Appender/DBI.pm'),
                             ('DBI-1.643', 'lib/DBD/Gofer/Transport/corostream.pm'),
                             ('AnyEvent-7.17', 'lib/AnyEvent/Impl/Tk.pm')]:
        retained['materials/' + source_id + '/' + path] = sources[source_id][path]
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
                          'ambiguousBuildInputsResolved': sum(r.get('ambiguousBuildInputsIdentical') is True for r in records),
                          'generatedXsReviewed': sum(r['generatedXsReviewed'] for r in records),
                          'generatedXsReviewRequired': sum(r['requiresGeneratedXsReview'] for r in records),
                          'sourceMaterialFiles': sum(p.startswith('materials/') for p in retained),
                          'newExactNativeRebuilds': 0},
              'modules': records, 'unbundledNonSystemReferences': missing,
              'bundlingChainEvidence': bundling_chain,
              'encodeXsEvidence': biber.file_record('artifacts/license-materials/biber-encode-xs/inventory.json', encode_inventory_bytes),
              'evidence': [biber.file_record(n, d) for n, d in sorted(retained.items())],
              'limits': ['Exported entry points and exact paired Perl files establish source associations, not native build versions, vendor patches or byte-identical compiled binaries.',
                         'All matching candidate archives are retained where paired source bytes are shared by multiple releases; no ambiguous version is silently selected.',
                         'Some Encode XS sources are generated. Their paired modules and full original archives are retained; their generated XS inputs still require review.',
                         'Dependency paths and basename candidates are static references, not proof of runtime resolution. bundlingChainEvidence explains why X11/MySQL got bundled (Module::ScanDeps heuristics via Log::Log4perl::Appender::DBI -> DBI -> DBD::Gofer::Transport::corostream -> AnyEvent -> AnyEvent::Impl::Tk), but does not establish whether an ordinary Biber operation loads them.',
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
