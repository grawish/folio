"""Controls for archive-bound source and embedded-source-map attribution."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('js_sources', Path(__file__).resolve().parents[1] / 'scripts/verify-javascript-sources.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class JavaScriptPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'example.tgz'
        self.location = 'node_modules/example'
        self.code = b'exports.value = 42;\n'
        self.source = 'export const value: number = 42;\n'
        metadata = json.dumps({'name': 'example', 'version': '1.0.0', 'license': 'MIT'}).encode()
        source_map = json.dumps({'sources': ['../src/a.ts'], 'sourcesContent': [self.source]}).encode()
        notice = b'Original notice\n'
        with tarfile.open(self.archive, 'w:gz') as tar:
            for file, content in [('package.json', metadata), ('LICENSE', notice), ('out/a.js', self.code), ('out/a.js.map', source_map)]:
                entry = tarfile.TarInfo('package/' + file); entry.size = len(content)
                tar.addfile(entry, io.BytesIO(content))
        data = self.archive.read_bytes()
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
        url = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz'
        lock = json.dumps({'packages': {self.location: {'version': '1.0.0', 'resolved': url, 'integrity': integrity}}}).encode()
        (self.root / 'package-lock.json').write_bytes(lock)
        original = {'name': 'example', 'version': '1.0.0', 'declaredLicense': 'MIT', 'location': self.location,
                    'archive': {'file': 'example.tgz', 'url': url, 'bytes': len(data), 'sha256': mod.npm.sha256(data), 'integrity': integrity},
                    'notices': [{'file': 'example--LICENSE', 'packagePath': 'package/LICENSE', 'bytes': len(notice), 'sha256': mod.npm.sha256(notice)}]}
        self.index = {'schemaVersion': 1, 'packageLockSha256': mod.npm.sha256(lock), 'packages': [original]}
        (self.root / 'resources/npm-notices').mkdir(parents=True)
        (self.root / 'resources/npm-notices/example--LICENSE').write_bytes(notice)
        self.index_path = self.root / 'resources/npm-notices/SOURCES.json'
        self.index_path.write_text(json.dumps(self.index))
        package = {'location': self.location, 'name': 'example', 'version': '1.0.0', 'declaredLicense': 'MIT', 'url': url,
                   'integrity': integrity, 'packageJsonSha256': mod.npm.sha256(metadata)}
        self.inventory = {'schemaVersion': 1, 'packageLockSha256': mod.npm.sha256(lock), 'packages': [package], 'modules': [
            {'id': self.location+'/out/a.js', 'file': self.location+'/out/a.js', 'package': self.location, 'kind': 'npm-source', 'sourceBytes': len(self.code), 'sourceSha256': mod.npm.sha256(self.code)},
            {'id': self.location+'/src/a.ts', 'file': self.location+'/src/a.ts', 'package': self.location, 'kind': 'npm-source-map-content', 'sourceBytes': len(self.source.encode()), 'sourceSha256': mod.npm.sha256(self.source.encode()),
             'publishedSourceMaps': [{'file': self.location+'/out/a.js.map', 'sha256': mod.npm.sha256(source_map), 'sourceIndex': 0}]}]}
        self.inventory_path = self.root / 'inventory.json'

    def check(self):
        self.inventory_path.write_text(json.dumps(self.inventory))
        return mod.verify(self.inventory_path, self.root, self.root)

    def test_real_file_and_embedded_original_source_match_locked_archive(self):
        result = self.check()
        self.assertEqual(result['npmInputFilesMatched'], 1)
        self.assertEqual(result['embeddedOriginalSourcesMatched'], 1)
        self.assertEqual(result['originalArchivesChecked'], 1)

    def test_notice_coverage_and_publisher_bytes_required(self):
        self.index['packages'] = []
        self.index_path.write_text(json.dumps(self.index))
        with self.assertRaisesRegex(ValueError, 'notice index'):
            self.check()

    def test_altered_source_map_binding_or_source_digest_rejected(self):
        original = json.dumps(self.inventory)
        for kind in ['file', 'map', 'index', 'digest', 'metadata']:
            self.inventory = json.loads(original)
            item = self.inventory['modules'][1]
            if kind == 'file': item['file'] = self.location+'/src/other.ts'
            if kind == 'map': item['publishedSourceMaps'][0]['sha256'] = '0'*64
            if kind == 'index': item['publishedSourceMaps'][0]['sourceIndex'] = -1
            if kind == 'digest': self.inventory['modules'][0]['sourceSha256'] = '0'*64
            if kind == 'metadata': self.inventory['packages'][0]['packageJsonSha256'] = '0'*64
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.check()

    def test_archive_and_module_paths_cannot_escape_the_package(self):
        for file in ['../outside', '/outside', self.location+'/../outside', self.location+'x/file', self.location+'/a\\b']:
            with self.subTest(file=file), self.assertRaises(ValueError): mod.member_path(file, self.location)
        self.inventory['modules'][0]['package'] = 'node_modules/other'
        with self.assertRaisesRegex(ValueError, 'lacks a replay package'): self.check()


if __name__ == '__main__':
    unittest.main()
