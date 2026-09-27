"""Offline provenance, original-text and source-map controls for PDF.js notices."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pdfjs_materials', Path(__file__).resolve().parents[1] / 'scripts/collect-pdfjs-license-materials.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PdfjsMaterialsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.cache = self.root/'cache'; self.cache.mkdir()
        self.output = self.root/'output'; self.archive_cache = self.root/'archives'; self.archive_cache.mkdir()
        self.commit = 'a'*40; self.source_name = 'external/example/code.js'
        self.source = b'/* Copyright Original Author\n * Original terms.\n */\n\nexport const value = 42;\n'
        self.license = b'Original publisher license.\n'
        self.metadata = {'name':'pdfjs-dist','version':'1.0.0','gitHead':self.commit}
        self.mapping = {'sources':['webpack://pdf.js/./'+self.source_name], 'sourcesContent':[self.source.decode()]}
        map_bytes = json.dumps(self.mapping).encode()
        archive = self.archive_cache/'pdfjs.tgz'
        package_metadata = json.dumps({'name':'pdfjs-dist','version':'1.0.0','license':'Apache-2.0'}).encode()
        with tarfile.open(archive,'w:gz') as tar:
            for name,data in [('package/package.json',package_metadata),('package/LICENSE',self.license),('package/build/pdf.worker.mjs.map',map_bytes)]:
                m=tarfile.TarInfo(name);m.size=len(data);tar.addfile(m,io.BytesIO(data))
        archive_bytes=archive.read_bytes(); integrity='sha512-'+base64.b64encode(hashlib.sha512(archive_bytes).digest()).decode()
        url='https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-1.0.0.tgz'
        ref={'file':'pdfjs.tgz','url':url,**self.ref(archive_bytes),'integrity':integrity}
        pkg={'name':'pdfjs-dist','version':'1.0.0','location':'node_modules/pdfjs-dist','archive':ref}
        npm_pkg={**pkg,'declaredLicense':'Apache-2.0','notices':[{'file':'pdfjs--LICENSE','packagePath':'package/LICENSE',**self.ref(self.license)}]}
        (self.root/'resources/npm-notices').mkdir(parents=True)
        (self.root/'resources/npm-notices/SOURCES.json').write_text(json.dumps({'packages':[npm_pkg]}))
        (self.root/'package-lock.json').write_text(json.dumps({'packages':{pkg['location']:{'version':'1.0.0','resolved':url,'integrity':integrity}}}))
        self.metadata['dist']={'integrity':integrity,'tarball':url}; metadata_bytes=json.dumps(self.metadata).encode()
        (self.cache/'npm-metadata.json').write_bytes(metadata_bytes)
        source_file=self.cache/'upstream'/self.source_name;source_file.parent.mkdir(parents=True);source_file.write_bytes(self.source)
        self.notice_folder=self.root/'resources/pdfjs-notices'; self.notice_folder.mkdir()
        self.notice_folder.joinpath('example.txt').write_bytes(self.source[:self.source.index(b'export')])
        self.lock={'schemaVersion':1,'completeBinarySbom':False,'scope':'Test fixture only','package':pkg,
            'upstream':{'repository':'mozilla/pdf.js','commit':self.commit,'npmMetadata':{'file':'npm-metadata.json','url':'https://registry.npmjs.org/pdfjs-dist/1.0.0',**self.ref(metadata_bytes)}},
            'upstreamFiles':[{'path':self.source_name,'role':'source','url':'https://raw.githubusercontent.com/mozilla/pdf.js/'+self.commit+'/'+self.source_name,**self.ref(self.source)}],
            'publisherFiles':[{'path':'build/pdf.worker.mjs.map',**self.ref(map_bytes)}],
            'sourceMapBindings':[{'source':self.source_name,'bindings':[{'map':'build/pdf.worker.mjs.map','index':0}]}],
            'noticeFiles':[{'file':'example.txt','source':self.source_name,'copy':'original-comment-prefix','offset':0,**self.ref(self.source[:self.source.index(b'export')])}]}

    def ref(self,data): return {'bytes':len(data),'sha256':mod.npm.sha256(data)}
    def write_lock(self): self.notice_folder.joinpath('SOURCES.json').write_text(json.dumps(self.lock))
    def collect(self):
        self.write_lock()
        return mod.collect(self.output,self.cache,self.archive_cache,True,self.root)

    def test_complete_offline_collection_preserves_original_bytes_and_bindings(self):
        r=self.collect();self.assertTrue(r['passed']);self.assertEqual(r['sourceMapBindings'],1)
        for record in r['files']: self.assertEqual(mod.npm.sha256((self.output/record['file']).read_bytes()),record['sha256'])
        self.assertEqual((self.output/'upstream'/self.source_name).read_bytes(),self.source)
        self.assertFalse(r['completeBinarySbom'])

    def test_wrong_publisher_commit_rejected_even_if_metadata_hash_is_updated(self):
        self.metadata['gitHead']='b'*40; data=json.dumps(self.metadata).encode();(self.cache/'npm-metadata.json').write_bytes(data)
        self.lock['upstream']['npmMetadata'].update(self.ref(data))
        with self.assertRaisesRegex(ValueError,'publisher commit'):self.collect()

    def test_source_map_path_index_or_text_cannot_change(self):
        for kind in ['path','index','text']:
            mapping=copy.deepcopy(self.mapping); bindings=copy.deepcopy(self.lock['sourceMapBindings'])
            if kind=='path':mapping['sources'][0]='webpack://pdf.js/./another.js'
            if kind=='index':bindings[0]['bindings'][0]['index']=-1
            if kind=='text':mapping['sourcesContent'][0]='changed source'
            with self.subTest(kind=kind),self.assertRaisesRegex(ValueError,'source-map association'):
                mod.verify_map_bindings(bindings,{self.source_name:self.source},{'build/pdf.worker.mjs.map':json.dumps(mapping).encode()})

    def test_notices_require_complete_original_or_full_comment_prefix(self):
        ref=self.lock['noticeFiles'][0]; self.assertEqual(mod.original_notice(ref,self.source),self.source[:self.source.index(b'export')])
        shortened={**ref,**self.ref(b'Copyright Original Author')}
        with self.assertRaisesRegex(ValueError,'Changed'):mod.original_notice(shortened,self.source)
        with self.assertRaisesRegex(ValueError,'copy rule'):mod.original_notice({**ref,'offset':3},self.source)
        full={'copy':'complete-original',**self.ref(self.license)}
        self.assertEqual(mod.original_notice(full,self.license),self.license)
        self.notice_folder.joinpath('example.txt').write_bytes(b'Changed notice')
        with self.assertRaisesRegex(ValueError,'Bundled PDF.js notice'):self.collect()

    def test_unsafe_paths_or_wrong_upstream_host_rejected(self):
        for name in ['../escape','/absolute','a/../b','a\\b','a//b','a\0b','./a']:
            with self.subTest(name=name),self.assertRaises(ValueError):mod.relative(name)
        self.lock['upstreamFiles'][0]['url']='https://example.com/source.js'
        with self.assertRaisesRegex(ValueError,'upstream input'):self.collect()

    def test_linked_or_changed_cache_rejected(self):
        original=self.cache/'npm-metadata.json'; data=original.read_bytes(); original.write_bytes(data+b'changed')
        with self.assertRaisesRegex(ValueError,'Changed'):self.collect()
        original.unlink();other=self.root/'outside';other.write_bytes(data);original.symlink_to(other)
        with self.assertRaisesRegex(ValueError,'Linked'):self.collect()

    def test_interrupted_or_wrong_download_not_published_then_verified_retry_passes(self):
        ref={'url':'https://example.test/fixture',**self.ref(self.license)}; dest=self.cache/'download.txt'
        def failed(args,**kwargs):
            Path(args[args.index('--output')+1]).write_bytes(b'partial'); raise subprocess.CalledProcessError(18,args)
        def wrong(args,**kwargs): Path(args[args.index('--output')+1]).write_bytes(b'wrong')
        def good(args,**kwargs): Path(args[args.index('--output')+1]).write_bytes(self.license)
        for effect,error in [(failed,subprocess.CalledProcessError),(wrong,ValueError)]:
            with patch.object(mod.subprocess,'run',side_effect=effect),self.assertRaises(error):mod.cached(ref,dest,False)
            self.assertFalse(dest.exists());self.assertFalse(dest.with_name(dest.name+'.download').exists())
        with patch.object(mod.subprocess,'run',side_effect=good):self.assertEqual(mod.cached(ref,dest,False),self.license)


if __name__=='__main__':unittest.main()
