"""Retain original TeX distribution sources and copy verified notices into Folio.

Python 3.11+. Uses the bounded archive/download helpers of the font collector.
Never extracts archive paths or executes upstream sources. See docs/LICENSING.md.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('tex_resource_shared', ROOT / 'scripts/collect-tex-font-materials.py')
c = importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


def source_identities(lock):
    ids, archives = set(), set()
    for source in [*lock['sources'], *lock['texts']]:
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,80}', source['id']) or source['id'] in ids:
            raise ValueError('Duplicate or invalid source identity')
        ids.add(source['id'])
        if source['archive'].casefold() in archives: raise ValueError('Duplicate source archive')
        archives.add(source['archive'].casefold())
        for key, field in [('materials','path'), ('matches','source')]:
            paths = [r[field].casefold() for r in source.get(key, [])]
            if len(paths) != len(set(paths)): raise ValueError('Duplicate locked archive member')


def coverage(bundle, matches, font, unmatched):
    own, fonts, missing = {}, {}, {}
    for rows, target in [(matches, own), ([m for s in font['sources'] for m in s['matches']], fonts)]:
        for row in rows:
            name = c.safe_path(row['bundle'])
            if name in target or name not in bundle: raise ValueError('Duplicate or unknown matched resource')
            c.verify(bundle[name], row);target[name] = row
    if set(own) & set(fonts): raise ValueError('Font and resource mappings overlap')
    for row in unmatched:
        name = c.safe_path(row['file'])
        if name in missing or name not in bundle: raise ValueError('Duplicate or unknown unresolved resource')
        if c.shared.digest(bundle[name]) != row['sha256']: raise ValueError('Unresolved resource differs')
        missing[name] = row
    if set(missing) != set(bundle) - set(own) - set(fonts): raise ValueError('Incomplete resource coverage')
    return {'bundledResources':len(bundle), 'matchedResources':len(own), 'fontFamilyResources':len(fonts),
            'combinedMatchedResources':len(own)+len(fonts), 'unmatchedResources':len(missing)}


def collect(offline, write_notices):
    lock_bytes = (ROOT / 'resources/tex-resource-sources.lock.json').read_bytes();lock = json.loads(lock_bytes)
    font_bytes = (ROOT / 'resources/tex-font-sources.lock.json').read_bytes();font = json.loads(font_bytes)
    if lock['schemaVersion'] != 1 or c.shared.digest(font_bytes) != lock['fontLockSha256']:
        raise ValueError('TeX resource or font source lock differs')
    source_identities(lock)
    bundle = c.bundle_files(lock);db = c.get_input(lock['database'], offline)
    records = c.database_records(db, lock['database']);retained = {'sources/' + lock['database']['archive']: db}
    all_materials, matches = {}, []
    for source in lock['sources']:
        data = c.get_input(source, offline);block = c.verify_package(data, source, records)
        selected, found = c.archive_materials(data, source, bundle);matches.extend(found)
        retained['sources/' + source['archive']] = data
        if block is not None:retained['metadata/' + source['package'] + '.tlpobj'] = block
        for name, content in selected.items():
            retained['materials/' + source['id'] + '/' + name] = content
            all_materials[(source['id'], name)] = content
    for entry in lock['texts']:
        data = c.get_input(entry, offline);retained['licenses/' + entry['archive']] = data
        all_materials[(entry['id'], '')] = data
    summary = coverage(bundle, matches, font, lock['unmatchedResources'])
    notices = c.publishable_notices(lock, all_materials)
    summary.update({'originalNoticeFiles':len(notices), 'sourceArchives':len(lock['sources']),
                    'sourceArchiveBytes':sum(s['bytes'] for s in lock['sources'])})
    source_map = {'schemaVersion':1, 'releaseAuditComplete':False, 'scope':lock['scope'],
                  'sourceLockSha256':c.shared.digest(lock_bytes), 'summary':summary,
                  'sources':[{k:s[k] for k in ['id','url','archive','bytes','sha256']} for s in lock['sources']],
                  'matches':sorted(matches, key=lambda r:r['bundle']), 'noticeFiles':lock['noticeFiles'],
                  'unmatchedResources':lock['unmatchedResources']}
    source_map_bytes = (json.dumps(source_map, indent=2)+'\n').encode()
    output = ROOT / 'artifacts/license-materials/tex-resources'
    for name, data in sorted(retained.items()):c.shared.atomic_write(output / name, data)
    for name, data in {**notices, 'SOURCES.json':source_map_bytes}.items():
        c.shared.atomic_write(output / 'app-notices' / name, data)
        if write_notices:c.shared.atomic_write(ROOT / 'resources/tex-resource-notices' / name, data)
    report = {**source_map, 'collectorSha256':c.shared.digest(Path(__file__).read_bytes()),
              'sharedCollectorSha256':c.shared.digest((ROOT / 'scripts/collect-tex-font-materials.py').read_bytes()),
              'commonCollectorSha256':c.shared.digest((ROOT / 'scripts/collect-rust-license-materials.py').read_bytes()),
              'fontSourceLockSha256':c.shared.digest(font_bytes),
              'evidence':[{'path':n,'bytes':len(d),'sha256':c.shared.digest(d)} for n,d in sorted(retained.items())],
              'limits':['Exact distribution matches do not prove a rebuild from editable sources.',
                        'Original per-file headers remain in the unchanged runtime bundle; catalogue labels are not per-file license determinations.',
                        'Full corresponding-source distribution, three generated configuration files and final signed-app redistribution review remain open.']}
    c.shared.atomic_write(output / 'inventory.json', (json.dumps(report, indent=2)+'\n').encode())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true');parser.add_argument('--write-notices', action='store_true')
    args = parser.parse_args();output = ROOT / 'artifacts/license-materials/tex-resources'
    try:report = collect(args.offline, args.write_notices)
    except Exception as error:
        c.shared.atomic_write(output / 'incomplete-inventory.json', (json.dumps({'releaseAuditComplete':False,'error':str(error)},indent=2)+'\n').encode())
        raise
    (output / 'incomplete-inventory.json').unlink(missing_ok=True)
    print(json.dumps(report['summary'],indent=2))
