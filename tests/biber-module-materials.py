"""Offline checks for compiled-module evidence and source-association boundaries."""
import copy
import importlib.util
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parent.parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

c = load('module_collector', 'scripts/collect-biber-module-materials.py')
fixtures = load('module_native_fixtures', 'tests/biber-native-materials.py')


def bundle(symbol='_boot_Example'):
    data = bytearray(fixtures.library(symbol)); count, size = struct.unpack_from('<II', data, 16)
    offset, commands = 32, []
    for _ in range(count):
        command, length = struct.unpack_from('<II', data, offset)
        if command != 0xD: commands.append(bytes(data[offset:offset+length]))
        offset += length
    content = b''.join(commands); data[32:32+size] = content + bytes(size-len(content))
    struct.pack_into('<III', data, 12, 8, len(commands), len(content))
    return bytes(data)


def association(data):
    return {'module':'Example','payloadPaths':['par/lib/auto/Example/Example.bundle'],
            'bytes':len(data),'sha256':c.shared.digest(data),'bootSymbols':['_boot_Example'],
            'sources':[{'id':'one'}]}


def source_candidate(module=b'package Example; 1;\n', xs=b'MODULE = Example PACKAGE = Example\n'):
    return {'id':'one','anchors':[{'source':'lib/Example.pm','sourceSha256':c.shared.digest(module),
            'payload':['par/lib/Example.pm'],'payloadSha256':c.shared.digest(module),'transformation':'none'}],
            'xsDeclarations':[{'path':'Example.xs','bytes':len(xs),'sha256':c.shared.digest(xs),'modules':['Example']}]}


class ModuleMaterials(unittest.TestCase):
    def test_bundle_export_and_dylib_modes_remain_distinct(self):
        data=bundle();row=association(data);info=c.check_native(data,row)
        self.assertEqual(info['bootSymbols'],['_boot_Example']);self.assertIsNone(info['identity'])
        with self.assertRaises(ValueError):c.native.macho(data)
        with self.assertRaises(ValueError):c.native.macho(fixtures.library(),file_type=8)
        self.assertEqual(c.native.macho(fixtures.library())[1]['identity']['name'],'/synthetic/lib.dylib')

    def test_boot_symbols_need_file_backed_addresses_and_real_sections(self):
        for offset,fmt,value in [(488,'<Q',0x1000+768),(485,'<B',0),(485,'<B',2)]:
            data=bytearray(bundle());struct.pack_into(fmt,data,offset,value)
            with self.assertRaises(ValueError):c.native.macho(bytes(data),file_type=8)
        data=bundle('_boot_Another');row=association(data)
        with self.assertRaisesRegex(ValueError,'entry points'):c.check_native(data,row)
        data=bundle();row=association(data)
        with self.assertRaisesRegex(ValueError,'bytes differ'):c.check_native(data+b'x',row)

    def test_inventory_requires_all_paths_without_overlap_or_changed_bytes(self):
        data=bundle();row=association(data);payload={row['payloadPaths'][0]:data}
        c.validate_inventory(payload,[row])
        for rows in [[],[row,row],[{**row,'payloadPaths':row['payloadPaths']*2}],[{**row,'module':'../escape'}]]:
            with self.assertRaises(ValueError):c.validate_inventory(payload,rows)
        with self.assertRaises(ValueError):c.validate_inventory({**payload,'par/lib/auto/New/New.bundle':data},[row])
        with self.assertRaises(ValueError):c.validate_inventory({row['payloadPaths'][0]:data+b'x'},[row])

    def test_source_association_preserves_both_perl_and_xs_bytes(self):
        pm=b'package Example; 1;\n';xs=b'MODULE = Example PACKAGE = Example\n';candidate=source_candidate(pm,xs)
        source={'lib/Example.pm':pm,'Example.xs':xs};payload={'par/lib/Example.pm':pm}
        self.assertEqual(c.check_source(candidate,'Example',['_boot_Example'],source,payload,b''),source)
        for changed in [{'lib/Example.pm':pm+b'x','Example.xs':xs},{'lib/Example.pm':pm,'Example.xs':xs+b'x'}]:
            with self.assertRaises(ValueError):c.check_source(candidate,'Example',['_boot_Example'],changed,payload,b'')
        with self.assertRaises(ValueError):c.check_source(candidate,'Example',['_boot_Example'],source,{'par/lib/Example.pm':b'other'},b'')

    def test_mismatched_or_missing_declarations_cannot_claim_a_source(self):
        pm=b'package Example; 1;\n';xs=b'MODULE = Different PACKAGE = Different\n';candidate=source_candidate(pm,xs)
        with self.assertRaisesRegex(ValueError,'XS declaration'):c.check_source(candidate,'Example',['_boot_Example'],{'lib/Example.pm':pm,'Example.xs':xs},{'par/lib/Example.pm':pm},b'')
        for anchors in [[],[{**candidate['anchors'][0],'payload':['par/lib/Other.pm']}]]:
            with self.assertRaises(ValueError):c.check_source({**candidate,'anchors':anchors},'Example',['_boot_Example'],{'lib/Example.pm':pm,'Example.xs':xs},{'par/lib/Other.pm':pm},b'')

    def test_only_original_reviewed_packager_transformations_are_applied(self):
        original=b'package Tk; original;\n';patched=b'package Tk; changed;\n'
        candidate={'id':'tk','anchors':[{'source':'Tk.pm','sourceSha256':c.shared.digest(original),'payload':['par/lib/Tk.pm'],'payloadSha256':c.shared.digest(patched),'transformation':'PAR::Filter::PatchContent:Tk.pm'}],'xsDeclarations':[]}
        patch=b"'Tk.pm' => ['original', 'changed'],\n"
        self.assertEqual(c.check_source(candidate,'Tk',['_boot_Tk'],{'Tk.pm':original},{'par/lib/Tk.pm':patched},patch),{'Tk.pm':original})
        bad=copy.deepcopy(candidate);bad['anchors'][0]['transformation']='normalize-whitespace'
        with self.assertRaisesRegex(ValueError,'Unknown'):c.check_source(bad,'Tk',['_boot_Tk'],{'Tk.pm':original},{'par/lib/Tk.pm':patched},patch)

    def test_ambiguous_candidates_remain_separate_without_choosing_a_version(self):
        data=bundle();row=association(data);row['sources']=[{'id':'version-one'},{'id':'version-two'}]
        c.validate_inventory({row['payloadPaths'][0]:data},[row]);self.assertEqual(len(row['sources']),2)
        row['sources'].append({'id':'version-one'})
        with self.assertRaisesRegex(ValueError,'Duplicate source'):c.validate_inventory({row['payloadPaths'][0]:data},[row])

    def test_module_paths_require_the_full_namespace_not_a_suffix(self):
        self.assertTrue(c.paired_module_path('par/lib/DBI.pm','DBI'))
        self.assertTrue(c.paired_module_path('loader/618bfe32/Digest/SHA.pm','Digest::SHA'))
        for path in ['par/lib/Log/Log4perl/Appender/DBI.pm','par/lib/AnyEvent/Impl/DBI.pm','loader/618bfe32/Other/DBI.pm']:
            self.assertFalse(c.paired_module_path(path,'DBI'))

    def test_dependency_candidates_do_not_establish_runtime_resolution(self):
        info={'dependencies':[{'name':n} for n in ['/usr/lib/libSystem.B.dylib','/opt/local/lib/libxml2.2.dylib','/opt/local/lib/libX11.6.dylib']]}
        rows=c.dependency_references(info,{'par/shlib/arch/libxml2.2.dylib':b'inert'})
        self.assertTrue(rows[0]['macosSystemPath']);self.assertEqual(rows[1]['bundledBasenameCandidates'],['par/shlib/arch/libxml2.2.dylib']);self.assertTrue(rows[2]['unbundledNonSystemReference'])
        self.assertNotIn('resolved',rows[1])


if __name__ == '__main__':unittest.main()
