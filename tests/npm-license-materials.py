"""Offline controls for original npm source and notice verification."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('npm_materials', Path(__file__).resolve().parents[1] / 'scripts/collect-npm-license-materials.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class NpmMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'example-1.0.0.tgz'
        self.notice = b'Original publisher notice.\n'
        self.package = {'name': 'example', 'version': '1.0.0', 'declaredLicense': 'MIT', 'notices': [
            {'file': 'example--LICENSE', 'packagePath': 'package/LICENSE', 'bytes': len(self.notice), 'sha256': mod.sha256(self.notice)}]}

    def make_archive(self, *, name='example', version='1.0.0', license='MIT', text=None, extra=None, linked=False):
        with tarfile.open(self.archive, 'w:gz') as tar:
            records = [('package/package.json', json.dumps({'name': name, 'version': version, 'license': license}).encode()),
                       ('package/LICENSE', self.notice if text is None else text)]
            if extra:
                records.append(extra)
            for key, data in records:
                info = tarfile.TarInfo(key)
                if key == 'package/LICENSE' and linked:
                    info.type = tarfile.SYMTYPE
                    info.linkname = '/outside/license'
                    tar.addfile(info)
                else:
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))
        data = self.archive.read_bytes()
        self.package['archive'] = {'bytes': len(data), 'sha256': mod.sha256(data),
                                   'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()}

    def test_original_notice_and_complete_archive_preserved(self):
        self.make_archive()
        data, notices = mod.archive_notices(self.archive, self.package)
        self.assertEqual(data, self.archive.read_bytes())
        self.assertEqual(notices, {'example--LICENSE': self.notice})

    def test_changed_archive_rejected_even_before_tar_processing(self):
        self.make_archive()
        self.archive.write_bytes(self.archive.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'Changed npm publisher'):
            mod.archive_notices(self.archive, self.package)

    def test_changed_notice_rejected(self):
        self.make_archive(text=b'X' * len(self.notice))
        with self.assertRaisesRegex(ValueError, 'Changed npm original notice'):
            mod.archive_notices(self.archive, self.package)

    def test_package_identity_and_license_declaration_bound(self):
        for changes in [{'name': 'another'}, {'version': '2.0.0'}, {'license': 'ISC'}]:
            with self.subTest(changes=changes):
                self.make_archive(**changes)
                with self.assertRaises(ValueError):
                    mod.archive_notices(self.archive, self.package)

    def test_duplicate_or_escaping_archive_members_rejected(self):
        for name in ['package/LICENSE', 'package/../outside', '/absolute']:
            with self.subTest(name=name):
                self.make_archive(extra=(name, b'bad'))
                with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
                    mod.archive_notices(self.archive, self.package)

    def test_linked_notice_or_archive_rejected(self):
        self.make_archive(linked=True)
        with self.assertRaises(ValueError):
            mod.archive_notices(self.archive, self.package)
        original = self.root / 'original.tgz'
        self.archive.rename(original)
        self.archive.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'Invalid npm source archive'):
            mod.archive_notices(self.archive, self.package)

    def test_omitted_original_notice_rejected(self):
        self.make_archive(extra=('package/NOTICE', b'Additional required notice\n'))
        with self.assertRaisesRegex(ValueError, 'notice inventory differs'):
            mod.archive_notices(self.archive, self.package)

    def test_invalid_destination_and_wrong_sha512_rejected(self):
        self.make_archive()
        self.package['notices'][0]['file'] = '../outside'
        with self.assertRaisesRegex(ValueError, 'destination'):
            mod.archive_notices(self.archive, self.package)
        self.package['notices'][0]['file'] = 'example--LICENSE'
        self.package['archive']['integrity'] = 'sha512-' + base64.b64encode(bytes(64)).decode()
        with self.assertRaisesRegex(ValueError, 'Changed npm publisher'):
            mod.archive_notices(self.archive, self.package)


    def test_interrupted_download_does_not_poison_cache_then_verified_retry_succeeds(self):
        self.make_archive()
        data = self.archive.read_bytes()
        self.package['location'] = 'node_modules/example'
        self.package['archive'].update(file='example-1.0.0.tgz', url='https://registry.npmjs.org/example/-/example-1.0.0.tgz')
        package_lock = json.dumps({'packages': {'node_modules/example': {
            'version': '1.0.0', 'resolved': self.package['archive']['url'], 'integrity': self.package['archive']['integrity']}}}).encode()
        (self.root / 'package-lock.json').write_bytes(package_lock)
        sources = self.root / 'resources/npm-notices'
        sources.mkdir(parents=True)
        (sources / 'example--LICENSE').write_bytes(self.notice)
        (sources / 'SOURCES.json').write_text(json.dumps({'schemaVersion': 1,
            'packageLockSha256': mod.sha256(package_lock), 'packages': [self.package],
            'missingOriginalText': [], 'releaseAuditComplete': False}))
        output, cache = self.root / 'output', self.root / 'cache'
        def interrupted(command, **kwargs):
            Path(command[command.index('--output') + 1]).write_bytes(b'incomplete')
            raise subprocess.CalledProcessError(18, command)
        def download(command, **kwargs):
            Path(command[command.index('--output') + 1]).write_bytes(data)
        with patch.object(mod, 'ROOT', self.root):
            with patch.object(mod.subprocess, 'run', side_effect=interrupted):
                with self.assertRaises(subprocess.CalledProcessError):
                    mod.collect(output, cache)
            self.assertEqual(list(cache.iterdir()), [])
            self.assertFalse((output / 'inventory.json').exists())
            with patch.object(mod.subprocess, 'run', side_effect=download):
                report = mod.collect(output, cache)
            self.assertEqual(report['originalNoticeFiles'], 1)
            self.assertEqual((output / 'archives/example-1.0.0.tgz').read_bytes(), data)
            self.assertEqual((output / 'notices/example--LICENSE').read_bytes(), self.notice)
            self.assertEqual(list(cache.iterdir()), [cache / 'example-1.0.0.tgz'])


if __name__ == '__main__':
    unittest.main()
