"""Build a bounded, mechanically verified TeX/font grant-review queue.

Converts the already-locked `resources/tex-font-sources.lock.json` and
`resources/tex-resource-sources.lock.json` plus their packaged original
notice files into a per-source/package review queue. This tool makes no
license, redistribution-permission or corresponding-source determination:
every declared license label is copied verbatim from the existing lock and
every row is stamped `grantReviewed: false` / `correspondingSourceReviewed:
false`. A human reviewer clears those flags individually, outside this tool.

Fails closed: an unknown notice source reference, a missing/renamed/resized/
tampered notice file, an unaccounted bundle file, or a cross-lock hash
mismatch raises instead of producing a partial or silently-skipped row.

Python 3.11+. Reads only files already committed to the repository; performs
no network access, archive extraction or upstream execution.

    python3 scripts/collect-tex-grant-review.py
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ID_PATTERN = re.compile(r'[a-z0-9][a-z0-9.-]{0,80}')
TEXT_ID_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,120}')
NOTICE_NAME_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,150}')
LOCKS = ('font', 'resource')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(filename, data):
    for parent in [filename, *filename.parents]:
        if parent.is_symlink():
            raise ValueError(f'Generated output cannot use a symbolic link: {parent}')
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.write_bytes(data)


def load_json(relative_path):
    path = ROOT / relative_path
    raw = path.read_bytes()
    return raw, json.loads(raw)


def check_ids(lock, label):
    seen = set()
    for source in lock['sources']:
        source_id = source['id']
        if not SOURCE_ID_PATTERN.fullmatch(source_id) or source_id in seen:
            raise ValueError(f'Invalid or duplicate {label} source id: {source_id!r}')
        seen.add(source_id)
    for text in lock.get('texts', []):
        text_id = text['id']
        if not TEXT_ID_PATTERN.fullmatch(text_id) or text_id in seen:
            raise ValueError(f'Invalid or duplicate {label} text id: {text_id!r}')
        seen.add(text_id)
    return seen


def check_notice_files(lock, ids, label):
    directory = ROOT / f'resources/tex-{label}-notices'
    expected = {}
    for entry in lock['noticeFiles']:
        name = entry['file']
        if not NOTICE_NAME_PATTERN.fullmatch(name) or '/' in name:
            raise ValueError(f'Unsafe {label} notice filename: {name!r}')
        if entry['source'] not in ids:
            raise ValueError(f'Unknown {label} notice source reference: {entry["source"]!r}')
        if name.casefold() in {n.casefold() for n in expected}:
            raise ValueError(f'Colliding {label} notice filename: {name!r}')
        expected[name] = entry
    guide_names = ['README.md'] if label == 'font' else ['README.md', 'SOURCES.json']
    for name in guide_names:
        data = (directory / name).read_bytes()
        expected[name] = {'file': name, 'bytes': len(data), 'sha256': digest(data)}
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError(f'{label} notice directory is missing or a symbolic link')
    on_disk = sorted(p.name for p in directory.iterdir())
    if set(on_disk) != set(expected):
        raise ValueError(f'{label} notice directory does not exactly match its lock: {directory}')
    for name in on_disk:
        target = directory / name
        if not target.is_file() or target.is_symlink():
            raise ValueError(f'{label} notice entry is missing or a symbolic link: {name}')
        data = target.read_bytes()
        reference = expected[name]
        if len(data) != reference['bytes'] or digest(data) != reference['sha256']:
            raise ValueError(f'{label} notice file differs from its lock: {name}')
    return expected


def notice_references(lock, source_id):
    return [
        {'file': entry['file'], 'sha256': entry['sha256'], **({'member': entry['member']} if 'member' in entry else {})}
        for entry in lock['noticeFiles']
        if entry['source'] == source_id
    ]


def source_rows(lock, label):
    rows = []
    for source in lock['sources']:
        match_count = len(source.get('matches', []))
        status = 'matched' if match_count > 0 else 'notices-only'
        rows.append({
            'lock': label,
            'kind': 'source',
            'id': source['id'],
            'package': source.get('package'),
            'declaredLicense': source.get('declaredLicense'),
            'archive': source['archive'],
            'archiveBytes': source['bytes'],
            'archiveSha256': source['sha256'],
            'matchCount': match_count,
            'status': status,
            'noticeReferences': notice_references(lock, source['id']),
            'grantReviewed': False,
            'correspondingSourceReviewed': False,
        })
    return rows


def unmatched_rows(resource_lock):
    rows = []
    for entry in resource_lock['unmatchedResources']:
        rows.append({
            'lock': 'resource',
            'kind': 'unmatched-generated',
            'file': entry['file'],
            'sha256': entry['sha256'],
            'reason': entry['reason'],
            'matchCount': 0,
            'status': 'unmatched-generated',
            'noticeReferences': [],
            'grantReviewed': False,
            'correspondingSourceReviewed': False,
            'correspondingSourceApplicable': False,
        })
    return rows


def bundle_accounting(bundle, font_lock, resource_lock):
    files = bundle['files']
    matched = {}
    for lock, label in [(font_lock, 'font'), (resource_lock, 'resource')]:
        for source in lock['sources']:
            for match in source.get('matches', []):
                name = match['bundle']
                if name in matched:
                    raise ValueError(f'Bundle file matched by more than one source: {name!r}')
                if files.get(name) != match['sha256']:
                    raise ValueError(f'Matched bundle file differs from resources/bundle.lock.json: {name!r}')
                matched[name] = (label, source['id'])
    unmatched = {}
    for entry in resource_lock['unmatchedResources']:
        name = entry['file']
        if files.get(name) != entry['sha256']:
            raise ValueError(f'Unmatched bundle file differs from resources/bundle.lock.json: {name!r}')
        unmatched[name] = entry['reason']
    accounted = set(matched) | set(unmatched)
    if accounted != set(files):
        missing = set(files) - accounted
        extra = accounted - set(files)
        raise ValueError(f'Incomplete bundle accounting; missing={sorted(missing)[:5]} extra={sorted(extra)[:5]}')
    return {'bundledResources': len(files), 'matchedResources': len(matched), 'unmatchedResources': len(unmatched)}


def collect():
    bundle_raw, bundle = load_json('resources/bundle.lock.json')
    font_raw, font_lock = load_json('resources/tex-font-sources.lock.json')
    resource_raw, resource_lock = load_json('resources/tex-resource-sources.lock.json')
    for lock in (font_lock, resource_lock):
        if lock.get('schemaVersion') != 1:
            raise ValueError('Unsupported TeX source lock schema version')
    if digest(bundle_raw) != font_lock['bundleLockSha256']:
        raise ValueError('Font lock bundle reference differs from resources/bundle.lock.json')
    if digest(bundle_raw) != resource_lock['bundleLockSha256']:
        raise ValueError('Resource lock bundle reference differs from resources/bundle.lock.json')
    if digest(font_raw) != resource_lock['fontLockSha256']:
        raise ValueError('Resource lock font reference differs from resources/tex-font-sources.lock.json')

    font_ids = check_ids(font_lock, 'font')
    resource_ids = check_ids(resource_lock, 'resource')
    if font_ids & resource_ids:
        raise ValueError(f'Font and resource source/text ids collide: {sorted(font_ids & resource_ids)}')
    check_notice_files(font_lock, font_ids, 'font')
    check_notice_files(resource_lock, resource_ids, 'resource')

    accounting = bundle_accounting(bundle, font_lock, resource_lock)

    rows = [*source_rows(font_lock, 'font'), *source_rows(resource_lock, 'resource'), *unmatched_rows(resource_lock)]
    source_kind_rows = [row for row in rows if row['kind'] == 'source']
    unresolved = [
        {'file': row['file'], 'sha256': row['sha256'], 'reason': row['reason']}
        for row in rows if row['kind'] == 'unmatched-generated'
    ]
    license_labels = {}
    for row in source_kind_rows:
        label = row['declaredLicense'] or '(undeclared)'
        license_labels[label] = license_labels.get(label, 0) + 1

    summary = {
        'bundledResources': accounting['bundledResources'],
        'totalReviewRows': len(rows),
        'sourcePackageRows': len(source_kind_rows),
        'matchedSourceRows': sum(1 for row in source_kind_rows if row['status'] == 'matched'),
        'noticesOnlySourceRows': sum(1 for row in source_kind_rows if row['status'] == 'notices-only'),
        'unmatchedGeneratedRows': len(unresolved),
        'totalMatchCount': sum(row['matchCount'] for row in source_kind_rows),
        'missingDeclaredLicenseRows': sum(1 for row in source_kind_rows if row['declaredLicense'] is None),
        'supplementalLicenseTexts': len(font_lock.get('texts', [])) + len(resource_lock.get('texts', [])),
        'grantReviewedRows': sum(1 for row in rows if row['grantReviewed']),
        'correspondingSourceReviewedRows': sum(1 for row in rows if row.get('correspondingSourceReviewed')),
    }
    if summary['totalMatchCount'] + summary['unmatchedGeneratedRows'] != summary['bundledResources']:
        raise ValueError('Review-row match accounting does not add up to the bundled resource count')

    report = {
        'schemaVersion': 1,
        'releaseAuditComplete': False,
        'scope': (
            'Mechanically verified TeX/font grant-review queue derived from existing local '
            'source locks and packaged notices. Not a completed legal review, not a signed-release '
            'artifact, and not a determination of redistribution permission, corresponding-source '
            'compliance, build reproduction or absence of linkage. Every row is an unreviewed '
            'grant/corresponding-source placeholder.'
        ),
        'collectorSha256': digest(Path(__file__).read_bytes()),
        'bundleLockSha256': digest(bundle_raw),
        'fontLockSha256': digest(font_raw),
        'resourceLockSha256': digest(resource_raw),
        'summary': summary,
        'rows': rows,
        'unresolvedItems': unresolved,
        'declaredLicenseLabelCounts': dict(sorted(license_labels.items(), key=lambda item: (-item[1], item[0]))),
        'limits': [
            'Declared license labels are copied verbatim from the existing locks; this tool does not '
            'interpret, normalize or validate license terms.',
            'grantReviewed and correspondingSourceReviewed are always false here; clearing them requires '
            'a separate, individual human review per row, not performed by this tool.',
            'The three unmatched-generated rows have no identified source archive; correspondingSourceApplicable '
            'is explicitly false for them because no source is known yet, not because none is required.',
            'Full corresponding-source distribution, redistribution-permission conclusions, build reproduction, '
            'linkage analysis and the final signed-app release audit remain entirely out of scope.',
        ],
    }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--write-index', action='store_true', help='Also refresh docs/releases/tex-grant-review-index.json')
    args = parser.parse_args()
    artifact_dir = ROOT / 'artifacts/license-materials/tex-grant-review'
    try:
        report = collect()
    except Exception as error:
        atomic_write(
            artifact_dir / 'incomplete-inventory.json',
            (json.dumps({'releaseAuditComplete': False, 'error': str(error)}, indent=2) + '\n').encode(),
        )
        raise
    (artifact_dir / 'incomplete-inventory.json').unlink(missing_ok=True)
    atomic_write(artifact_dir / 'inventory.json', (json.dumps(report, indent=2) + '\n').encode())
    if args.write_index:
        atomic_write(ROOT / 'docs/releases/tex-grant-review-index.json', (json.dumps(report, indent=2) + '\n').encode())
    print(json.dumps(report['summary'], indent=2))


if __name__ == '__main__':
    main()
