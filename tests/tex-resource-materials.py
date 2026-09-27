"""Offline controls for cross-source coverage and historical source containers."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tex_resources', Path(__file__).resolve().parent.parent / 'scripts/collect-tex-resource-materials.py')
c = importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
record = lambda b: {'bytes':len(b), 'sha256':hashlib.sha256(b).hexdigest()}


class TeXResourceMaterials(unittest.TestCase):
    def test_source_archive_checksum_and_missing_catalogue_label(self):
        data=b'original editable source';h=hashlib.sha512(data).hexdigest()
        block=f'name example\nrevision 9\nsrccontainersize {len(data)}\nsrccontainerchecksum {h}'.encode()
        s={**record(data),'id':'example.source','package':'example','metadataBytes':len(block),'metadataSha256':record(block)['sha256'],'containerPrefix':'src','revision':9,'declaredLicense':None,'publisherSha512':h}
        self.assertEqual(c.c.verify_package(data,s,{'example':block}),block)
        for key,value in [('containerPrefix','doc'),('publisherSha512','0'*128),('declaredLicense','MIT')]:
            with self.assertRaises((ValueError,KeyError)):c.c.verify_package(data,{**s,key:value},{'example':block})

    def test_complete_coverage_keeps_generated_resources_unresolved(self):
        bundle={'file.sty':b'source','font.otf':b'font','language.dat':b'generated'}
        matches=[{'bundle':'file.sty',**record(b'source')}]
        font={'sources':[{'matches':[{'bundle':'font.otf',**record(b'font')}]}]}
        unresolved=[{'file':'language.dat','sha256':record(b'generated')['sha256']}]
        report=c.coverage(bundle,matches,font,unresolved)
        self.assertEqual(report['combinedMatchedResources'],2);self.assertEqual(report['unmatchedResources'],1)
        for missing in [[],unresolved*2,[{'file':'language.dat','sha256':'0'*64}]]:
            with self.assertRaises(ValueError):c.coverage(bundle,matches,font,missing)
        with self.assertRaises(ValueError):c.coverage({**bundle,'new.sty':b'new'},matches,font,unresolved)
        with self.assertRaises(ValueError):c.coverage({**bundle,'file.sty':b'changed'},matches,font,unresolved)

    def test_overlapping_or_duplicate_sources_cannot_inflate_coverage(self):
        b={'a':b'a'};m={'bundle':'a',**record(b'a')}
        with self.assertRaisesRegex(ValueError,'overlap'):c.coverage(b,[m],{'sources':[{'matches':[m]}]},[])
        with self.assertRaisesRegex(ValueError,'Duplicate'):c.coverage(b,[m,m],{'sources':[]},[])
        s={'id':'example','archive':'source.tar.xz','materials':[{'path':'LICENSE'}],'matches':[{'source':'file.sty'}]}
        good={'sources':[s],'texts':[]};c.source_identities(good)
        for other in [copy.deepcopy(s),{**s,'id':'other','archive':'SOURCE.TAR.XZ'}]:
            with self.assertRaises(ValueError):c.source_identities({'sources':[s,other],'texts':[]})
        for key,field in [('materials','path'),('matches','source')]:
            bad=copy.deepcopy(s);bad[key].append({field:bad[key][0][field].upper()})
            with self.assertRaisesRegex(ValueError,'Duplicate'):c.source_identities({'sources':[bad],'texts':[]})

    def test_supplemental_source_endpoints_are_exactly_constrained(self):
        commit='d46e94e2c78ceede1cfc63cfa0396472d2798d4c'
        valid='https://raw.githubusercontent.com/spdx/license-list-data/'+commit+'/text/MPL-1.1.txt'
        self.assertEqual(c.c.source_url(valid),valid)
        for url in [valid.replace(commit,'main'),valid.replace('MPL-1.1','unreviewed'),valid.replace('raw.githubusercontent.com','example.test'),valid+'?redirect=1']:
            with self.assertRaises(ValueError):c.c.source_url(url)


if __name__=='__main__':unittest.main()
