"""Reproduce selected Biber text files using unchanged, pinned upstream generators.

Developer-only macOS audit with cached sources, network denial and temporary
writes. Nonidentical outputs remain explicit gaps. No app/runtime changes.
"""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

cpan = load('generated_cpan', 'collect-biber-cpan-materials.py')
biber, shared = cpan.biber, cpan.shared
generation = load('generated_sandbox', 'collect-biber-unicode-evidence.py')


def inputs_for(recipe, sources):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,40}', recipe['id']):
        raise ValueError('Invalid generation case name')
    result = {}
    for item in recipe['inputs']:
        name = item['path']; shared.safe_member('source/' + name, 'source')
        data = sources.get(name)
        if not data or len(data) != item['bytes'] or shared.digest(data) != item['sha256']:
            raise ValueError('Generator input differs from reviewed source: ' + name)
        if name.casefold() in {n.casefold() for n in result}:
            raise ValueError('Generator input names collide')
        result[name] = data
    if not result or len(result) > 16 or sum(map(len, result.values())) > 4 * 1024 * 1024:
        raise ValueError('Generator input exceeds audit bounds')
    return result


def packer_methods(source):
    start = b'sub _main_pl_single {\n'; end = b'sub DESTROY {\n'
    manifest = b'sub _make_manifest {\n'
    if any(source.count(marker) != 1 for marker in [start, end, manifest]):
        raise ValueError('Packager method boundary differs from reviewed source')
    first = source.index(start); last = source.index(end, first)
    at = source.index(manifest); stop = source.index(b'\nsub ', at + 4)
    return source[first:last] + b'\n' + source[at:stop] + b'\n'


def packer_harness(source):
    # These four upstream methods are copied verbatim. The small harness supplies
    # reviewed package options and an in-memory ZIP sink; it does not build or run Biber.
    return b'''use strict;
use JSON::PP;
package AuditZip;
sub contents {
    my ($self, $name, $data) = @_;
    die "Unexpected output" unless $name eq 'MANIFEST' || $name eq 'META.yml';
    open my $f, '>', $name or die $!; binmode $f;
    print $f $data; close $f or die $!;
}
package PAR::Packer;
our $VERSION = '1.055';
my (%dep_zips, %dep_zip_files);
sub _vprint {}
''' + packer_methods(source) + b'''
$PAR::VERSION = '1.017';
open my $f, '<', 'members.json' or die $!;
my $input = JSON::PP::decode_json(do { local $/; <$f> });
my $self = bless { options => { B => 1 }, output => 'biber-darwin_arm',
    full_manifest => { map { $_ => 1 } @{$input->{members}} },
    add_manifest => { map { $_ => 1 } @{$input->{duplicates}} },
    zip => bless({}, 'AuditZip') }, 'PAR::Packer';
open my $main, '>', 'main.pl' or die $!;
binmode $main; print $main $self->_main_pl_single('script/biber-darwin'); close $main or die $!;
$self->_make_manifest();
'''


def member_input(payload, duplicates):
    for name in payload: biber.path_name(name)
    for name, record in duplicates.items():
        if name not in payload or record['extraOccurrences'] != 1:
            raise ValueError('Unsupported packager duplicate input')
        data = payload[name]
        if len(data) != record['bytes'] or shared.digest(data) != record['sha256']:
            raise ValueError('Packager duplicate differs from reviewed payload')
    # Filenames come from the parsed ZIP, never from its generated MANIFEST.
    return (json.dumps({'members': sorted(payload), 'duplicates': sorted(duplicates)}, indent=2) + '\n').encode()


def outputs_for(work, recipe):
    result = {}
    if len(recipe['outputs']) > 8: raise ValueError('Too many generator outputs')
    for name in recipe['outputs']:
        shared.safe_member('output/' + name, 'output')
        file = work / name
        if any(p.is_symlink() for p in [file, *file.parents]) or not file.is_file():
            raise ValueError('Missing or linked generator output')
        if file.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('Generator output exceeds audit bounds')
        result[name] = file.read_bytes()
    return result


def compare_outputs(recipe, generated, payload, patch):
    matches, unmatched = [], []
    for name, targets in recipe['outputs'].items():
        raw = generated[name]
        data = cpan.transformed(raw, recipe['packagerPatch'], patch) if recipe.get('packagerPatch') else raw
        for target in targets:
            if target not in payload: raise ValueError('Missing reviewed payload target')
            row = {**biber.file_record(target, payload[target]),
                   'case': recipe['id'], 'generatedPath': recipe['id'] + '/' + name,
                   'rawGeneratedSha256': shared.digest(raw),
                   'comparedGeneratedSha256': shared.digest(data),
                   'transformation': 'packager-patch:' + recipe['packagerPatch'] if recipe.get('packagerPatch') else 'none'}
            (matches if data == payload[target] else unmatched).append(row)
    return matches, unmatched


def build_miniperl(work, source, sandbox, env, deadline):
    # sense.pm.PL records compile-time Perl hints. Rebuilding miniperl from the
    # checksum-verified 5.32.1 source gives those exact core semantics without
    # treating the host Perl as a substitute or retaining a host-built runtime.
    if len(source) > 10_000 or sum(map(len, source.values())) > 128 * 1024 * 1024:
        raise ValueError('Perl miniperl source exceeds audit bounds')
    required = {'Configure', 'miniperlmain.c', 'lib/strict.pm', 'lib/warnings.pm'}
    if not required.issubset(source) or any(not source[name] for name in required):
        raise ValueError('Perl miniperl source is incomplete')
    root = work / 'perl-5.32.1'
    for name, data in source.items():
        shared.safe_member('source/' + name, 'source')
        shared.atomic_write(root / name, data)
    configure = work.parent / 'miniperl-configure.log'
    make = work.parent / 'miniperl-make.log'
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Text generation exceeded its deadline')
    generation.bounded_run(sandbox + ['/bin/sh', 'Configure', '-des'], root, env, configure, remaining)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Text generation exceeded its deadline')
    generation.bounded_run(sandbox + ['/usr/bin/make', 'miniperl'], root, env, make, remaining)
    configpm = work.parent / 'miniperl-configpm.log'
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Text generation exceeded its deadline')
    generation.bounded_run(sandbox + [str(root / 'miniperl'), '-Ilib', 'configpm'], root, env, configpm, remaining)
    executable = root / 'miniperl'
    if executable.is_symlink() or not executable.is_file() or executable.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Perl miniperl output is invalid')
    version = subprocess.run(sandbox + [str(executable), '-Ilib', '-e', 'print "$^V"'], cwd=root, env=env,
                             capture_output=True, timeout=20, check=True).stdout.decode()
    if version != 'v5.32.1':
        raise ValueError('Built miniperl version differs from reviewed source')
    return root, {'version': version}



def verify_miniperl_recipe(recipe, cpan_entries, foundation, payload):
    inputs = {row['path']: row['sha256'] for row in recipe['inputs']}
    targets = {target for rows in recipe['outputs'].values() for target in rows}
    if len(inputs) != len(recipe['inputs']) or not inputs or not targets:
        raise ValueError('Miniperl recipe inputs or outputs are invalid')
    if recipe['source'] == 'perl-5.32.1':
        if not any(entry['id'] == recipe['source'] for entry in foundation['foundationSources']):
            raise ValueError('Miniperl recipe source is not a reviewed foundation archive')
        return
    entry = cpan_entries.get(recipe['source'])
    if entry is None:
        raise ValueError('Miniperl recipe source is not a reviewed CPAN archive')
    authorized = [anchor for anchor in entry.get('generatedAnchors', []) if anchor.get('generator') == 'perl-5.32.1-miniperl'
                  and anchor.get('source') in inputs and anchor.get('sourceSha256') == inputs[anchor.get('source')]
                  and anchor.get('payload') in targets]
    if len(authorized) != len(targets):
        raise ValueError('Miniperl recipe is not authorized by a generated CPAN anchor')
    for anchor in authorized:
        if anchor['payload'] not in payload or shared.digest(payload[anchor['payload']]) != anchor['sha256']:
            raise ValueError('Miniperl recipe anchor payload differs from reviewed identity')
def collect(output):
    if sys.platform != 'darwin': raise ValueError('This generator audit requires macOS sandbox-exec')
    lock_bytes = (ROOT / 'resources/biber-generated-sources.lock.json').read_bytes(); lock = json.loads(lock_bytes)
    foundation_bytes = (ROOT / 'resources/biber-build-provenance.lock.json').read_bytes()
    cpan_bytes = (ROOT / 'resources/biber-cpan-sources.lock.json').read_bytes()
    if lock['schemaVersion'] != 1 or lock['foundationLockSha256'] != shared.digest(foundation_bytes) or lock['cpanLockSha256'] != shared.digest(cpan_bytes):
        raise ValueError('Generated-source lock differs from reviewed foundation')
    foundation, cpan_lock = json.loads(foundation_bytes), json.loads(cpan_bytes)
    if foundation['packerVersion'] != '1.055' or foundation['parVersion'] != '1.017':
        raise ValueError('Packager harness version needs review')
    binary = biber.verified(ROOT / 'resources/runtime/mac-arm64/biber', foundation['arm64Binary'])
    loader, files, _ = biber.parse_payload(binary, foundation['reviewedZipDuplicates'])
    manifest = json.loads(biber.verified(ROOT / 'resources/runtime/mac-arm64/manifest.json', foundation['runtimeManifest']))
    expected = {n.removeprefix('biber-cache/'): h for n, h in manifest['files'].items() if n.startswith('biber-cache/')}
    cache = biber.map_cache(ROOT / 'resources/runtime/mac-arm64/biber-cache', expected, binary, loader, files, foundation)
    payload = {**{'par/' + n: d for n, d in files.items()}, **{'loader/' + n: d for n, d in loader.items()}}
    source_ids = {r['source'] for r in lock['recipes']} | {'PAR-Packer-1.055'}
    miniperl_recipes = [r for r in lock['recipes'] if r.get('interpreter') == 'perl-5.32.1-miniperl']
    if any(r.get('interpreter') not in (None, 'perl-5.32.1-miniperl') for r in lock['recipes']):
        raise ValueError('Unknown generated-source interpreter')
    if miniperl_recipes:
        source_ids.add('perl-5.32.1')
    cpan_entries = {entry['id']: entry for entry in cpan_lock['sources']}
    for recipe in miniperl_recipes:
        verify_miniperl_recipe(recipe, cpan_entries, foundation, payload)
    entries = [e for e in foundation['foundationSources'] + cpan_lock['sources'] if e['id'] in source_ids]
    if len(entries) != len(source_ids): raise ValueError('Missing or duplicate source archive')
    archives, sources = {}, {}
    for entry in entries:
        data = biber.foundation_input(entry, True) if entry in foundation['foundationSources'] else cpan.get_input(entry, True)
        archives['sources/' + entry['archive']] = data
        sources[entry['id']] = biber.archive_sources(data, entry['root'])
    patch = sources['PAR-Packer-1.055']['lib/PAR/Filter/PatchContent.pm']
    if shared.digest(patch) != cpan_lock['packagerFilterSha256']: raise ValueError('Packager patch changed')
    case_ids = [r['id'] for r in lock['recipes']]
    if len(case_ids) != len(set(case_ids)) or len(case_ids) > 16: raise ValueError('Invalid generation cases')
    (ROOT / 'test-results').mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='biber-generated-', dir=ROOT / 'test-results')).resolve()
    for name in ['tmp', 'home', 'controls']: (run / name).mkdir()
    (run / 'sandbox.sb').write_text(generation.sandbox_profile(run))
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(run / 'home'), 'TMPDIR': str(run / 'tmp'),
           'LC_ALL': 'C', 'LANG': 'C', 'PERL_HASH_SEED': '0', 'PERL_PERTURB_KEYS': '0',
           'PERL_BUILD_EXPAND_CONFIG_VARS': '0', 'PERL_BUILD_EXPAND_ENV_VARS': '0', 'PAR_VERBATIM': '1'}
    prefix = ['/usr/bin/sandbox-exec', '-f', str(run / 'sandbox.sb'), '/usr/bin/perl']
    controls = generation.check_sandbox(prefix, run / 'controls', env, run.parent / (run.name + '-outside'))
    retained = {**archives, 'packager/PatchContent.pm': patch}
    matches, unmatched, commands = [], [], []
    deadline = time.monotonic() + 300
    miniperl_root, miniperl = None, None
    if miniperl_recipes:
        miniperl_root, _ = build_miniperl(run / 'miniperl-build', sources['perl-5.32.1'], prefix[:-1], env, deadline)
        miniperl = miniperl_root / 'miniperl'
    for recipe in lock['recipes']:
        work = run / recipe['id']; work.mkdir(); (work / 'lib').mkdir()
        inputs = inputs_for(recipe, sources[recipe['source']])
        if recipe['id'] == 'packer':
            inputs['harness.pl'] = packer_harness(inputs['lib/PAR/Packer.pm'])
            inputs['members.json'] = member_input(files, foundation['reviewedZipDuplicates'])
        for name, data in inputs.items():
            target = work / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
            retained['inputs/' + recipe['id'] + '/' + name] = data
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Text generation exceeded its deadline')
        log = run / (recipe['id'] + '.log')
        interpreter = [str(miniperl), '-I' + str(miniperl_root / 'lib')] if recipe.get('interpreter') == 'perl-5.32.1-miniperl' else prefix
        generation.bounded_run((prefix[:-1] + interpreter if miniperl is not None and interpreter[0] == str(miniperl) else interpreter) + recipe['arguments'], work, env, log, remaining)
        generated = outputs_for(work, recipe)
        good, different = compare_outputs(recipe, generated, payload, patch)
        matches.extend(good); unmatched.extend(different)
        retained.update({'generated/' + recipe['id'] + '/' + name: data for name, data in generated.items()})
        retained['logs/' + recipe['id'] + '.log'] = log.read_bytes()
        commands.append({'cwd': recipe['id'], 'perlArguments': recipe['arguments'], 'interpreter': recipe.get('interpreter', 'system-perl')})
    details = (json.dumps({'matches': matches, 'unmatched': unmatched}, indent=2) + '\n').encode()
    retained['source-matches.json'] = details
    for name, data in sorted(retained.items()): shared.atomic_write(output / name, data)
    report = {'schemaVersion': 1, 'releaseAuditComplete': False, 'scope': lock['scope'],
              'collectorSha256': shared.digest(Path(__file__).read_bytes()),
              'lockSha256': shared.digest(lock_bytes), 'foundationLockSha256': shared.digest(foundation_bytes),
              'cpanLockSha256': shared.digest(cpan_bytes), 'sourceArchives': entries,
              'helpers': {name: shared.digest((ROOT / 'scripts' / name).read_bytes()) for name in
                          ['collect-biber-cpan-materials.py', 'collect-biber-build-evidence.py',
                           'collect-biber-unicode-evidence.py', 'collect-rust-license-materials.py']},
              'arm64Binary': foundation['arm64Binary'], 'preparedCacheFilesVerified': len(cache),
              'hostPerl': {'path': '/usr/bin/perl', 'sha256': shared.digest(Path('/usr/bin/perl').read_bytes()),
                           'version': subprocess.check_output(prefix + ['-e', 'print "$^V"'], cwd=run, env=env, timeout=20).decode()},
              'sandbox': {'controls': controls, 'networkDenied': True, 'readIsolation': False,
                          'writeScope': 'unique temporary run directory and /dev/null', 'deadlineSeconds': 180},
              'commands': commands,
              'summary': {'cases': len(commands), 'generatedFiles': sum(len(r['outputs']) for r in lock['recipes']),
                          'matchingPayloadFiles': len(matches), 'unmatchedTargets': len(unmatched)},
              'evidence': [biber.file_record(n, d) for n, d in sorted(retained.items())],
              'remaining': ['System-Perl recipes use host 5.34.1 support modules; miniperl recipes use the exact retained Perl 5.32.1 source.',
                            'Other generated files, native build/source provenance, redistribution terms and the exact signed-app SBOM remain open.']}
    shared.atomic_write(output / 'inventory.json', (json.dumps(report, indent=2) + '\n').encode())
    print('Retained generation run:', run)
    return report


if __name__ == '__main__':
    output = ROOT / 'artifacts/license-materials/biber-generated'
    try:
        report = collect(output)
    except Exception as error:
        shared.atomic_write(output / 'incomplete-inventory.json', (json.dumps({'releaseAuditComplete': False, 'error': str(error)}, indent=2) + '\n').encode())
        raise
    (output / 'incomplete-inventory.json').unlink(missing_ok=True)
    print(json.dumps(report['summary'], indent=2))
