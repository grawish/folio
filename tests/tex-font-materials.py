"""Offline checks for locked font sources, publisher metadata and notice output."""
import copy
import hashlib
import importlib.util
import io
import json
import lzma
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tex_fonts', Path(__file__).resolve().parent.parent / 'scripts/collect-tex-font-materials.py')
c = importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
record = lambda b: {'bytes':len(b), 'sha256':hashlib.sha256(b).hexdigest()}


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:xz') as a:
        for name, data, kind in entries:
            m = tarfile.TarInfo(name);m.type = kind;m.size = len(data) if kind == tarfile.REGTYPE else 0
            if kind == tarfile.SYMTYPE:m.linkname = '/outside'
            a.addfile(m, io.BytesIO(data) if m.isfile() else None)
    return out.getvalue()


def source(data):
    return {**record(data),'format':'tar.xz','id':'example',
            'materials':[{'path':'LICENSE', **record(b'license\n')}],
            'matches':[{'source':'font.otf','bundle':'font.otf', **record(b'font')}]}


class FontMaterials(unittest.TestCase):
    def test_locked_bytes_reject_truncation_and_changes(self):
        self.assertEqual(c.verify(b'original',record(b'original')),b'original')
        for value in [b'Original',b'origina',b'original\n']:
            with self.assertRaises(ValueError):c.verify(value,record(b'original'))

    def test_download_urls_and_redirects_remain_constrained(self):
        self.assertEqual(c.source_url('https://www.latex-project.org/lppl/lppl-1-3c.txt'),'https://www.latex-project.org/lppl/lppl-1-3c.txt')
        for url in ['http://www.latex-project.org/lppl/lppl-1-3c.txt','https://example.org/x','https://www.latex-project.org.evil.test/lppl/lppl-1-3c.txt','file:///etc/passwd']:
            with self.assertRaises(ValueError):c.source_url(url)
        with self.assertRaises(ValueError):c.NoRedirect().redirect_request(None,None,302,'',{},'https://example.org')

    def test_corrupt_offline_cache_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(c,'ROOT',Path(folder).resolve()):
            entry={'archive':'LPPL-1.3c.txt','url':'https://www.latex-project.org/lppl/lppl-1-3c.txt',**record(b'license')}
            p=Path(folder)/'.cache/license-sources/tex-fonts/LPPL-1.3c.txt';p.parent.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError,'Missing offline'):c.get_input(entry,True)
            p.write_bytes(b'changed')
            with patch.object(c.urllib.request,'build_opener',side_effect=AssertionError('must not fetch')):
                with self.assertRaises(ValueError):c.get_input(entry,False)
            p.unlink();p.symlink_to(Path(folder)/'outside')
            with self.assertRaisesRegex(ValueError,'Linked'):c.get_input(entry,True)

    def test_database_rejects_modified_or_duplicate_records(self):
        raw=b'name example\nrevision 1\n\n';data=lzma.compress(raw)
        entry={**record(data),'uncompressedBytes':len(raw),'uncompressedSha256':record(raw)['sha256']}
        self.assertEqual(c.database_records(data,entry),{'example':raw[:-2]})
        bad=copy.deepcopy(entry);bad['uncompressedSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'database differs'):c.database_records(data,bad)
        duplicate=raw+raw;packed=lzma.compress(duplicate)
        with self.assertRaisesRegex(ValueError,'Duplicate'):
            c.database_records(packed,{**record(packed),'uncompressedBytes':len(duplicate),'uncompressedSha256':record(duplicate)['sha256']})
        with self.assertRaises(ValueError):c.database_records(data+b'junk',{**entry,**record(data+b'junk')})

    def test_publisher_checksum_revision_and_license_are_bound(self):
        data=b'archive';h=hashlib.sha512(data).hexdigest()
        block=f'name example\nrevision 5\ncatalogue-license ofl\ncontainersize 7\ncontainerchecksum {h}'.encode()
        s={**record(data),'id':'example','package':'example','metadataBytes':len(block),'metadataSha256':record(block)['sha256'],'containerPrefix':'','revision':5,'declaredLicense':'ofl','publisherSha512':h}
        self.assertEqual(c.verify_package(data,s,{'example':block}),block)
        for key,value in [('revision',6),('declaredLicense','MIT'),('publisherSha512','0'*128)]:
            bad={**s,key:value}
            with self.assertRaises(ValueError):c.verify_package(data,bad,{'example':block})
        with self.assertRaises(ValueError):c.verify_package(data,s,{'example':block+b'\n'})

    def test_archive_matches_exact_bytes_and_keeps_original_notice(self):
        data=archive([('font.otf',b'font',tarfile.REGTYPE),('LICENSE',b'license\n',tarfile.REGTYPE)])
        selected,matched=c.archive_materials(data,source(data),{'font.otf':b'font'})
        self.assertEqual(selected,{'LICENSE':b'license\n'});self.assertEqual(len(matched),1)
        for value in [b'font\n',b'Font',b'fon']:
            with self.assertRaisesRegex(ValueError,'does not exactly match'):c.archive_materials(data,source(data),{'font.otf':value})
        missing=archive([('font.otf',b'font',tarfile.REGTYPE)])
        with self.assertRaisesRegex(ValueError,'Missing locked'):c.archive_materials(missing,source(missing),{'font.otf':b'font'})

    def test_archive_rejects_unsafe_names_links_and_collisions(self):
        good=[('font.otf',b'font',tarfile.REGTYPE),('LICENSE',b'license\n',tarfile.REGTYPE)]
        for name,kind in [('../escape',tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),('x',tarfile.SYMTYPE),('x',tarfile.FIFOTYPE),('FONT.OTF',tarfile.REGTYPE),('LICENSE',tarfile.REGTYPE)]:
            data=archive(good+[(name,b'x',kind)])
            with self.assertRaises(ValueError):c.archive_materials(data,source(data),{'font.otf':b'font'})
        data=archive(good)
        with patch.object(c,'MAX_EXPANDED',3):
            with self.assertRaisesRegex(ValueError,'audit bounds'):c.archive_materials(data,source(data),{'font.otf':b'font'})
        with patch.object(c,'MAX_MEMBER',3):
            with self.assertRaisesRegex(ValueError,'audit bounds'):c.archive_materials(data,source(data),{'font.otf':b'font'})

    def test_published_notice_bytes_and_names_must_match(self):
        data=b'copyright\nlicense\n';entry={'source':'source','member':'LICENSE','file':'source-LICENSE.txt',**record(data)}
        self.assertEqual(c.publishable_notices({'noticeFiles':[entry]},{('source','LICENSE'):data}),{'source-LICENSE.txt':data})
        for e in [{**entry,'file':'../escape'},{**entry,'file':'nested/file'}, {**entry,'sha256':'0'*64}]:
            with self.assertRaises(ValueError):c.publishable_notices({'noticeFiles':[e]},{('source','LICENSE'):data})
        with self.assertRaisesRegex(ValueError,'Colliding'):
            c.publishable_notices({'noticeFiles':[entry,{**entry,'file':'SOURCE-license.TXT'}]},{('source','LICENSE'):data})


if __name__=='__main__':unittest.main()
