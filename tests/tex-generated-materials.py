# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright 2026 Folio contributors. Tests for the separately licensed replay tool.
"""Offline source, range, replay and corruption controls; no upstream downloads."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec=importlib.util.spec_from_file_location('tex_generated',Path(__file__).resolve().parent.parent/'scripts/collect-tex-generated-materials.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
record=lambda b:{'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
commit='082081a375be008c2e049cd7cf1137314f888b18'
lock={'upstream':{'texliveGitHash':commit,'archiveBytes':4096},'builderCommit':'dfed7aa15e17b9c93bc2606020a98ef32c8da61e'}
url='https://git.texlive.info/texlive/plain/Master/LICENSE.TL?id='+commit
context={'installRoot':'/recorded/texmf-dist','languageProgram':'./bin/x86_64-linux/tlmgr','languageLocaltime':'Mon Sep 19 03:27:42 2022','mapLocaltime':'Mon Sep 19 03:27:39 2022'}


class GeneratedTeXMaterials(unittest.TestCase):
    def test_only_reviewed_https_endpoints_and_safe_paths_are_allowed(self):
        self.assertEqual(c.allowed_url(url,lock),url)
        for bad in [url.replace('https:','http:'),url.replace(commit,'main'),url.replace('git.texlive.info','example.test'),url+'&extra=1',url.replace('/Master/','/Master/../')]:
            with self.assertRaises(ValueError):c.allowed_url(bad,lock)
        for name in ['../outside','/absolute','a//b','a/./b','a\\b','a:b','x\n']:
            with self.assertRaises(ValueError):c.safe_path(name)

    def test_bounded_downloader_checks_status_content_and_does_not_follow_redirects(self):
        original=subprocess.Popen
        def process(body):
            return lambda *a,**kw:original([sys.executable,'-c','import sys;sys.stdout.buffer.write('+repr(body)+')'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        entry={'file':'source','url':url,**record(b'original')}
        with patch.object(c.subprocess,'Popen',side_effect=process(b'original\nFOLIO_HTTP_STATUS:200')):
            self.assertEqual(c.fetch(entry,lock),b'original')
        for body in [b'changed!\nFOLIO_HTTP_STATUS:200',b'original\nFOLIO_HTTP_STATUS:302',b'x'*65536]:
            with patch.object(c.subprocess,'Popen',side_effect=process(body)):
                with self.assertRaises(ValueError):c.fetch(entry,lock)
        with patch.object(c.subprocess,'Popen',side_effect=AssertionError('invalid range must not download')):
            with self.assertRaises(ValueError):c.fetch({**entry,'offset':1,'contentBytes':8},lock)

    def test_corrupt_missing_and_linked_cache_fail_without_replacement(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(c,'ROOT',Path(folder).resolve()):
            entry={'file':'source','url':url,**record(b'original')};p=c.ROOT/'.cache/license-sources/tex-generated/source';p.parent.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError,'Missing offline'):c.get_input(entry,lock,True)
            p.write_bytes(b'changed!')
            with patch.object(c,'fetch',side_effect=AssertionError('must not replace changed cache')):
                with self.assertRaises(ValueError):c.get_input(entry,lock,False)
            self.assertEqual(p.read_bytes(),b'changed!');p.unlink();p.symlink_to(c.ROOT/'outside')
            with self.assertRaisesRegex(ValueError,'Linked'):c.get_input(entry,lock,True)

    def test_index_and_tar_member_must_agree_on_names_sizes_and_offsets(self):
        content=b'62885\n';h=tarfile.TarInfo('SVNREV');h.size=len(content);data=h.tobuf()+content
        row={'name':'SVNREV','offset':512,'contentBytes':len(content),'contentSha256':c.digest(content),**record(data)}
        index={'SVNREV':(512,len(content))};self.assertEqual(c.member_content(data,row,index),content)
        for r,i in [({**row,'name':'GITHASH'},index),(row,{'SVNREV':(1536,len(content))}),(row,{'SVNREV':(512,len(content)+1)})]:
            with self.assertRaises(ValueError):c.member_content(data,r,i)
        h.type=tarfile.SYMTYPE;h.linkname='/outside';linked=h.tobuf()+content
        with self.assertRaises(ValueError):c.member_content(linked,{**row,**record(linked)},index)
        for raw,valid in [(b'SVNREV 512 6\nGITHASH 1536 41\n',True),(b'SVNREV 512 6\nSVNREV 1536 41\n',False),(b'a 512 900\nb 1024 10\n',False),(b'../a 512 6\n',False)]:
            zipped=gzip.compress(raw);rules={**lock,'index':{**record(zipped),'uncompressedBytes':len(raw)}}
            if valid:self.assertEqual(len(c.index_records(zipped,rules)),2)
            else:
                with self.assertRaises(ValueError):c.index_records(zipped,rules)

    def test_package_selection_drives_both_language_and_map_configuration(self):
        records={'scheme-minimal':'name scheme-minimal\ndepend collection-basic','collection-basic':'name collection-basic\ndepend hyphen-one\ndepend font-one',
                 'hyphen-one':'name hyphen-one\nexecute AddHyphen name=one file=one.tex synonyms=uno,un comment="Original grant kept"\nexecute AddHyphen name=lua-only file=other.tex databases=lua',
                 'font-one':'name font-one\nexecute addMap      euler.map\nexecute addMixedMap a.map'}
        selected=c.package_selection(records,b'collection-basic\n',b'selected_scheme scheme-minimal\n')
        self.assertEqual(selected,sorted(records))
        generated,packages=c.language_bytes(records,selected,b'% original base\n',context)
        self.assertEqual(generated,b'% Generated by ./bin/x86_64-linux/tlmgr on Mon Sep 19 03:27:42 2022\n% original base\n% from hyphen-one:\n% Original grant kept\none one.tex\n=uno\n=un\n')
        self.assertEqual(packages,['hyphen-one'])
        config=c.configuration_bytes(records,selected,b'# original header\n',context)
        self.assertEqual(config,b'# Generated by ./bin/x86_64-linux/tlmgr on Mon Sep 19 03:27:39 2022\n# original header\nMap      euler.map\nMixedMap a.map\n')
        with self.assertRaisesRegex(ValueError,'Unknown'):c.package_selection(records,b'absent\n',b'selected_scheme scheme-minimal\n')
        with self.assertRaisesRegex(ValueError,'Malformed'):c.language_bytes({'p':'name p\nexecute AddHyphen name=x file=y alien=yes'},['p'],b'',context)

    def test_map_replay_preserves_postscript_spaces_and_rejects_ambiguity(self):
        config=b'LW35 URWkb\npdftexDownloadBase14 true\njaEmbed example\nKanjiMap @jaEmbed@.map\nMixedMap mixed.map\nMap normal.map\n'
        kinds,_=c.configuration(config)
        contents={'ps2pk35.map':b'% untouched source header\nbase Base "TeXnANSIEncoding ReEncodeFont" <base.pfb\n','example.map':b'z H Example.otf\n','mixed.map':b'font Font " .5 ExtendFont " <font.pfb\n','normal.map':b'other Other <other.pfb\n'}
        outputs=c.font_maps(kinds,contents,context)
        self.assertTrue(outputs['kanjix.map'].endswith(b'% example.map\nz H Example.otf\n'))
        self.assertTrue(outputs['pdftex.map'].endswith(b'% ps2pk35.map\nbase Base " TeXnANSIEncoding ReEncodeFont " <base.pfb\n% mixed.map\nfont Font " .5 ExtendFont " <font.pfb\n% normal.map\nother Other <other.pfb\n'))
        with self.assertRaisesRegex(ValueError,'Ambiguous'):c.font_maps(kinds,{**contents,'normal.map':b'font Different <x.pfb\n'},context)
        with self.assertRaisesRegex(ValueError,'Incomplete'):c.font_maps(kinds,{k:v for k,v in contents.items() if k!='mixed.map'},context)
        with self.assertRaisesRegex(ValueError,'Unreviewed'):c.configuration(config.replace(b'URWkb',b'ADOBE'))

    def test_runtime_resource_and_generated_marker_are_checked_independently(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(c,'ROOT',Path(folder).resolve()):
            root=c.ROOT;runtime=root/'resources/runtime/mac-arm64';runtime.mkdir(parents=True)
            expected={'x.tex':c.digest(b'source')};bundle_lock={'files':expected,'upstreamBundleDigest':'identity'};raw=(json.dumps(bundle_lock)+'\n').encode()
            (root/'resources/bundle.lock.json').write_bytes(raw);(runtime/'bundle.lock.json').write_bytes(raw)
            def make(content,marker):
                out=io.BytesIO()
                with zipfile.ZipFile(out,'w') as z:z.writestr('x.tex',content);z.writestr('SHA256SUM',marker)
                data=out.getvalue();(runtime/'bundle.zip').write_bytes(data);(runtime/'manifest.json').write_text(json.dumps({'files':{'bundle.zip':c.digest(data)}}))
            marker=c.digest(json.dumps(expected,separators=(',',':')).encode()).encode();rules={'bundleLockSha256':c.digest(raw),'upstream':{'identity':'identity'}}
            make(b'source',marker);self.assertEqual(c.actual_bundle(rules),{'x.tex':b'source'})
            make(b'changed',marker)
            with self.assertRaisesRegex(ValueError,'resource differs'):c.actual_bundle(rules)
            make(b'source',b'0'*64)
            with self.assertRaisesRegex(ValueError,'marker differs'):c.actual_bundle(rules)


if __name__=='__main__':unittest.main()
