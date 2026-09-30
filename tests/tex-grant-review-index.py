"""Offline checks for the bounded TeX/font grant-review index collector."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('tex_grant_review', ROOT / 'scripts/collect-tex-grant-review.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class TexGrantReviewIndex(unittest.TestCase):
    def test_collect_produces_a_fully_accounted_unreviewed_queue(self):
        report = c.collect()
        self.assertFalse(report['releaseAuditComplete'])
        self.assertIn('unreviewed grant/corresponding-source placeholder', report['scope'])
        summary = report['summary']
        self.assertEqual(summary['bundledResources'], 516)
        self.assertEqual(summary['totalMatchCount'] + summary['unmatchedGeneratedRows'], summary['bundledResources'])
        self.assertEqual(summary['sourcePackageRows'], summary['matchedSourceRows'] + summary['noticesOnlySourceRows'])
        self.assertEqual(summary['totalReviewRows'], len(report['rows']))
        self.assertEqual(summary['unmatchedGeneratedRows'], len(report['unresolvedItems']))
        self.assertEqual(summary['unmatchedGeneratedRows'], 3)
        self.assertEqual(summary['grantReviewedRows'], 0)
        self.assertEqual(summary['correspondingSourceReviewedRows'], 0)
        for row in report['rows']:
            self.assertFalse(row['grantReviewed'])
            self.assertFalse(row.get('correspondingSourceReviewed'))
        unresolved_files = {item['file'] for item in report['unresolvedItems']}
        self.assertEqual(unresolved_files, {'kanjix.map', 'language.dat', 'pdftex.map'})
        for row in report['rows']:
            if row['kind'] == 'unmatched-generated':
                self.assertFalse(row['correspondingSourceApplicable'])

    def test_declared_license_labels_are_copied_verbatim_not_interpreted(self):
        report = c.collect()
        source_rows = [row for row in report['rows'] if row['kind'] == 'source']
        _, font_lock = c.load_json('resources/tex-font-sources.lock.json')
        _, resource_lock = c.load_json('resources/tex-resource-sources.lock.json')
        expected = {}
        for lock in (font_lock, resource_lock):
            for source in lock['sources']:
                expected[source['id']] = source.get('declaredLicense')
        for row in source_rows:
            self.assertEqual(row['declaredLicense'], expected[row['id']])
        total_labeled = sum(v for k, v in report['declaredLicenseLabelCounts'].items() if k != '(undeclared)')
        undeclared = report['declaredLicenseLabelCounts'].get('(undeclared)', 0)
        self.assertEqual(total_labeled + undeclared, len(source_rows))
        self.assertEqual(undeclared, report['summary']['missingDeclaredLicenseRows'])

    def test_source_and_text_ids_are_validated_and_checked_for_collisions(self):
        good = {'sources': [{'id': 'example'}], 'texts': [{'id': 'OFL-1.1.txt'}]}
        ids = c.check_ids(good, 'font')
        self.assertEqual(ids, {'example', 'OFL-1.1.txt'})
        for bad in [
            {'sources': [{'id': 'Bad_ID'}], 'texts': []},
            {'sources': [{'id': 'dup'}, {'id': 'dup'}], 'texts': []},
        ]:
            with self.assertRaises(ValueError):
                c.check_ids(bad, 'font')

    def test_bundle_accounting_rejects_double_matches_and_hash_drift(self):
        bundle = {'files': {'a.sty': 'h1', 'b.map': 'h2'}}
        font = {'sources': [{'id': 'f', 'matches': [{'bundle': 'a.sty', 'sha256': 'h1'}]}]}
        resource = {
            'sources': [{'id': 'r', 'matches': []}],
            'unmatchedResources': [{'file': 'b.map', 'sha256': 'h2', 'reason': 'generated'}],
        }
        accounting = c.bundle_accounting(bundle, font, resource)
        self.assertEqual(accounting, {'bundledResources': 2, 'matchedResources': 1, 'unmatchedResources': 1})
        with self.assertRaisesRegex(ValueError, 'more than one source'):
            c.bundle_accounting(bundle, {'sources': [
                {'id': 'f1', 'matches': [{'bundle': 'a.sty', 'sha256': 'h1'}]},
                {'id': 'f2', 'matches': [{'bundle': 'a.sty', 'sha256': 'h1'}]},
            ]}, resource)
        drifted_font = {'sources': [{'id': 'f', 'matches': [{'bundle': 'a.sty', 'sha256': 'WRONG'}]}]}
        with self.assertRaisesRegex(ValueError, 'differs from resources/bundle.lock.json'):
            c.bundle_accounting(bundle, drifted_font, resource)
        incomplete_bundle = {'files': {**bundle['files'], 'c.otf': 'h3'}}
        with self.assertRaisesRegex(ValueError, 'Incomplete bundle accounting'):
            c.bundle_accounting(incomplete_bundle, font, resource)

    def test_fails_closed_on_unknown_notice_source_reference(self):
        lock = {'noticeFiles': [{'file': 'x.txt', 'source': 'missing-id', 'bytes': 1, 'sha256': '0' * 64}]}
        with self.assertRaisesRegex(ValueError, 'Unknown font notice source reference'):
            c.check_notice_files(lock, {'known-id'}, 'font')

    def test_fails_closed_on_tampered_or_missing_notice_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / 'resources/tex-font-notices'
            directory.mkdir(parents=True)
            data = b'original notice text\n'
            (directory / 'NOTICE.txt').write_bytes(data)
            (directory / 'README.md').write_bytes(b'guide\n')
            lock = {'noticeFiles': [{'file': 'NOTICE.txt', 'source': 'src', 'bytes': len(data), 'sha256': c.digest(data)}]}
            with patch.object(c, 'ROOT', root):
                # Clean baseline succeeds.
                c.check_notice_files(lock, {'src'}, 'font')
                # Tampering with the file's bytes fails closed.
                (directory / 'NOTICE.txt').write_bytes(b'tampered\n')
                with self.assertRaisesRegex(ValueError, 'differs from its lock'):
                    c.check_notice_files(lock, {'src'}, 'font')
                # Removing the file fails closed.
                (directory / 'NOTICE.txt').unlink()
                with self.assertRaisesRegex(ValueError, 'does not exactly match its lock'):
                    c.check_notice_files(lock, {'src'}, 'font')
                # An unexpected extra file fails closed too.
                (directory / 'NOTICE.txt').write_bytes(data)
                (directory / 'extra.txt').write_bytes(b'unexpected\n')
                with self.assertRaisesRegex(ValueError, 'does not exactly match its lock'):
                    c.check_notice_files(lock, {'src'}, 'font')

    def test_fails_closed_on_lock_cross_reference_drift(self):
        bundle_raw, _ = c.load_json('resources/bundle.lock.json')
        font_raw, font_lock = c.load_json('resources/tex-font-sources.lock.json')
        _, resource_lock = c.load_json('resources/tex-resource-sources.lock.json')
        self.assertEqual(c.digest(bundle_raw), font_lock['bundleLockSha256'])
        self.assertEqual(c.digest(bundle_raw), resource_lock['bundleLockSha256'])
        self.assertEqual(c.digest(font_raw), resource_lock['fontLockSha256'])
        drifted = copy.deepcopy(resource_lock)
        drifted['fontLockSha256'] = '0' * 64
        self.assertNotEqual(c.digest(font_raw), drifted['fontLockSha256'])


if __name__ == '__main__':
    unittest.main()
