"""Offline controls for the Tectonic native-linkage evidence collector.

Uses small synthetic Mach-O fixtures, never the real packaged executable, so
these checks run without the compiler and stay fast. They prove the parser's
ADRP/ADD decoding and defined-symbol lookup are exact, and that the collector
fails closed on identity, offset, count and lock-consistency mismatches.
"""
import hashlib
import importlib.util
import json
import struct
import tempfile
import shutil
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "tectonic_linkage", ROOT / "scripts/collect-tectonic-linkage-evidence.py"
)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
sha = lambda b: hashlib.sha256(b).hexdigest()


def encode_adrp(rd, imm21):
    immlo = imm21 & 0x3
    immhi = (imm21 >> 2) & 0x7FFFF
    return (1 << 31) | (immlo << 29) | (0b10000 << 24) | (immhi << 5) | rd


def encode_add_imm(rd, rn, imm12):
    return (1 << 31) | (0b100010 << 23) | ((imm12 & 0xFFF) << 10) | (rn << 5) | rd


def dylib_command(name, current=0x00010000, compat=0x00010000):
    raw = name.encode() + b"\0"
    size = (24 + len(raw) + 7) // 8 * 8
    return struct.pack("<6I", 0xC, size, 24, 0, current, compat) + raw + bytes(size - 24 - len(raw))


def synthetic(version_text="1.3.1", symbol="_zlibVersion", local=False, dylibs=("/usr/lib/libSystem.B.dylib",)):
    """Build a minimal, valid arm64 MH_EXECUTE: one defined symbol whose entire
    body is ADRP+ADD+RET computing the address of a following C string."""
    HEADER = 32
    dylib_cmds = b"".join(dylib_command(n) for n in dylibs)
    seg_cmd_size = 72
    symtab_cmd_size = 24
    cmds_size = seg_cmd_size + symtab_cmd_size + len(dylib_cmds)
    text_fileoff = HEADER + cmds_size
    text_fileoff += (16 - text_fileoff % 16) % 16
    text_vmaddr = 0x100000000 + text_fileoff

    string_fileoff = text_fileoff + 13
    string_vmaddr = text_vmaddr + 13
    page_func, page_str = text_vmaddr & ~0xFFF, string_vmaddr & ~0xFFF
    imm21 = (page_str - page_func) >> 12
    imm12 = string_vmaddr & 0xFFF

    code = struct.pack("<3I", encode_adrp(0, imm21), encode_add_imm(0, 0, imm12), 0xD65F03C0)
    strtext = b"\0" + version_text.encode() + b"\0"
    text_data = code + strtext
    text_filesize = len(text_data)

    symname = b"\0" + symbol.encode() + b"\0"
    strtab_fileoff = text_fileoff + text_filesize
    n_type = 0x0E if local else 0x0F  # N_SECT, external bit only when requested
    sym_entry = struct.pack("<IBBHQ", 1, n_type, 1, 0, text_vmaddr)
    symtab_fileoff = strtab_fileoff + len(symname)
    total_size = symtab_fileoff + len(sym_entry)

    segsize = total_size - text_fileoff
    seg_cmd = struct.pack(
        "<II16s4Q4I", 0x19, seg_cmd_size, b"__TEXT", text_vmaddr, segsize, text_fileoff, segsize, 7, 5, 0, 0
    )
    symtab_cmd = struct.pack("<6I", 0x2, symtab_cmd_size, symtab_fileoff, 1, strtab_fileoff, len(symname))
    cmds = seg_cmd + symtab_cmd + dylib_cmds
    header = struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 2 + len(dylibs), len(cmds), 0, 0)

    out = bytearray(total_size)
    out[0:HEADER] = header
    out[HEADER : HEADER + len(cmds)] = cmds
    out[text_fileoff : text_fileoff + text_filesize] = text_data
    out[strtab_fileoff : strtab_fileoff + len(symname)] = symname
    out[symtab_fileoff : symtab_fileoff + len(sym_entry)] = sym_entry
    return bytes(out), text_fileoff, string_fileoff


class MachOParsing(unittest.TestCase):
    def test_decodes_adrp_add_to_the_exact_version_string_file_offset(self):
        data, func_fo, str_fo = synthetic()
        macho = c.MachO(data)
        self.assertEqual(macho.defined_symbol_offsets(["_zlibVersion"]), {"_zlibVersion": func_fo})
        target_vmaddr = macho.decode_adrp_add(func_fo)
        self.assertEqual(macho.vmaddr_to_fileoff(target_vmaddr), str_fo)

    def test_local_defined_symbols_are_found_like_external_ones(self):
        data, func_fo, _ = synthetic(symbol="_gr_make_seg", local=True)
        macho = c.MachO(data)
        self.assertEqual(macho.defined_symbol_offsets(["_gr_make_seg"]), {"_gr_make_seg": func_fo})

    def test_missing_requested_symbol_raises(self):
        data, _, _ = synthetic(symbol="_zlibVersion")
        macho = c.MachO(data)
        with self.assertRaisesRegex(ValueError, "Missing defined symbol"):
            macho.defined_symbol_offsets(["_not_present"])

    def test_dylib_list_is_parsed_in_order(self):
        data, _, _ = synthetic(dylibs=("/usr/lib/libSystem.B.dylib", "/usr/lib/libiconv.2.dylib"))
        macho = c.MachO(data)
        self.assertEqual([d["name"] for d in macho.dylibs], ["/usr/lib/libSystem.B.dylib", "/usr/lib/libiconv.2.dylib"])

    def test_rejects_non_arm64_or_non_executable_headers(self):
        data, _, _ = synthetic()
        bad = bytearray(data)
        struct.pack_into("<I", bad, 4, 0x01000007)  # x86_64 cputype
        with self.assertRaisesRegex(ValueError, "arm64"):
            c.MachO(bytes(bad))
        bad2 = bytearray(data)
        struct.pack_into("<I", bad2, 12, 6)  # MH_DYLIB filetype
        with self.assertRaisesRegex(ValueError, "MH_EXECUTE"):
            c.MachO(bytes(bad2))

    def test_decode_adrp_add_rejects_non_adrp_or_non_add_instructions(self):
        data, func_fo, _ = synthetic()
        macho = c.MachO(data)
        corrupt = bytearray(data)
        struct.pack_into("<I", corrupt, func_fo, 0xD65F03C0)  # RET instead of ADRP
        with self.assertRaisesRegex(ValueError, "ADRP"):
            c.MachO(bytes(corrupt)).decode_adrp_add(func_fo)


class StringAnchorChecks(unittest.TestCase):
    def anchor(self, **overrides):
        base = {
            "family": "zlib",
            "lockedPortVersion": "1.3.1",
            "text": "1.3.1",
            "textFileOffset": 0,
            "textOccurrences": 1,
            "codeReferences": [],
        }
        base.update(overrides)
        return base

    def test_confirms_a_unique_string_at_its_recorded_offset(self):
        data, _, str_fo = synthetic()
        c.check_string_anchor(data, self.anchor(textFileOffset=str_fo))

    def test_rejects_wrong_occurrence_count(self):
        data, _, str_fo = synthetic()
        with self.assertRaisesRegex(ValueError, "occurrence"):
            c.check_string_anchor(data, self.anchor(textFileOffset=str_fo, textOccurrences=2))

    def test_rejects_moved_string(self):
        data, _, str_fo = synthetic()
        with self.assertRaisesRegex(ValueError, "moved"):
            c.check_string_anchor(data, self.anchor(textFileOffset=str_fo + 1))

    def test_rejects_wrong_resource_prefix_count(self):
        data, _, str_fo = synthetic(version_text="icudt74l")
        with self.assertRaisesRegex(ValueError, "resource-name prefix"):
            c.check_string_anchor(
                data,
                self.anchor(
                    family="icu", text="icudt74l", textFileOffset=str_fo, resourceNamePrefixOccurrences=99
                ),
            )


class CodeReferenceChecks(unittest.TestCase):
    def test_confirms_matching_code_reference(self):
        data, func_fo, str_fo = synthetic()
        macho = c.MachO(data)
        anchor = {"family": "zlib", "textFileOffset": str_fo}
        c.check_code_reference(macho, anchor, {"adrpFileOffset": func_fo})

    def test_rejects_code_reference_to_a_different_offset(self):
        data, func_fo, str_fo = synthetic()
        macho = c.MachO(data)
        anchor = {"family": "zlib", "textFileOffset": str_fo + 8}
        with self.assertRaisesRegex(ValueError, "no longer targets"):
            c.check_code_reference(macho, anchor, {"adrpFileOffset": func_fo})


class CollectorEndToEnd(unittest.TestCase):
    """Runs the real collect() against the repository's actual lock files and
    packaged Tectonic binary. Skips if the runtime binary was not fetched by
    `npm run setup` in this checkout."""

    def setUp(self):
        self.binary = ROOT / "resources/runtime/mac-arm64/tectonic"
        if not self.binary.is_file():
            self.skipTest("resources/runtime/mac-arm64/tectonic not present (run npm run setup)")

    def test_collect_confirms_every_locked_anchor_against_the_real_binary(self):
        report = c.collect()
        self.assertFalse(report["releaseAuditComplete"])
        self.assertEqual(report["summary"]["unconfirmedNativePorts"], 3)
        self.assertGreater(report["summary"]["versionStringAnchorsConfirmed"], 0)
        self.assertGreater(report["summary"]["definedSymbolsConfirmed"], 0)
        families = {f["family"] for f in report["confirmedVersionStringAnchors"]}
        self.assertEqual(families, {"zlib", "libpng", "bzip2", "icu"})

    def test_collect_rejects_a_substituted_binary(self):
        lock = json.loads((ROOT / "resources/tectonic-linkage-anchors.lock.json").read_bytes())
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for rel in [
                "resources/tectonic-linkage-anchors.lock.json",
                "resources/compiler-build-provenance.lock.json",
                "resources/native-license-sources.lock.json",
            ]:
                dest = tmp / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / rel, dest)
            rt = tmp / "resources/runtime/mac-arm64"
            rt.mkdir(parents=True, exist_ok=True)
            tampered = bytearray(self.binary.read_bytes())
            tampered[1000] ^= 0xFF
            (rt / "tectonic").write_bytes(bytes(tampered))

            module_source = (ROOT / "scripts/collect-tectonic-linkage-evidence.py").read_text()
            namespace = {"__name__": "tectonic_linkage_tamper", "__file__": str(ROOT / "scripts/collect-tectonic-linkage-evidence.py")}
            exec(compile(module_source, "tectonic_linkage_tamper", "exec"), namespace)
            namespace["ROOT"] = tmp
            namespace["LOCK"] = tmp / "resources/tectonic-linkage-anchors.lock.json"
            namespace["PROVENANCE_LOCK"] = tmp / "resources/compiler-build-provenance.lock.json"
            namespace["NATIVE_SOURCES_LOCK"] = tmp / "resources/native-license-sources.lock.json"
            with self.assertRaisesRegex(ValueError, "differs from the pinned identity"):
                namespace["collect"]()

    def test_collect_rejects_a_changed_native_license_sources_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for rel in [
                "resources/tectonic-linkage-anchors.lock.json",
                "resources/compiler-build-provenance.lock.json",
                "resources/native-license-sources.lock.json",
            ]:
                dest = tmp / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / rel, dest)
            rt = tmp / "resources/runtime/mac-arm64"
            rt.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.binary, rt / "tectonic")
            with open(tmp / "resources/native-license-sources.lock.json", "a") as f:
                f.write(" ")

            module_source = (ROOT / "scripts/collect-tectonic-linkage-evidence.py").read_text()
            namespace = {"__name__": "tectonic_linkage_lock_change", "__file__": str(ROOT / "scripts/collect-tectonic-linkage-evidence.py")}
            exec(compile(module_source, "tectonic_linkage_lock_change", "exec"), namespace)
            namespace["ROOT"] = tmp
            namespace["LOCK"] = tmp / "resources/tectonic-linkage-anchors.lock.json"
            namespace["PROVENANCE_LOCK"] = tmp / "resources/compiler-build-provenance.lock.json"
            namespace["NATIVE_SOURCES_LOCK"] = tmp / "resources/native-license-sources.lock.json"
            with self.assertRaisesRegex(ValueError, "native-license-sources.lock.json changed"):
                namespace["collect"]()

    def test_collect_rejects_a_symlinked_lock_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for rel in [
                "resources/compiler-build-provenance.lock.json",
                "resources/native-license-sources.lock.json",
            ]:
                dest = tmp / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / rel, dest)
            rt = tmp / "resources/runtime/mac-arm64"
            rt.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.binary, rt / "tectonic")
            outside = tmp / "outside-lock.json"
            shutil.copyfile(ROOT / "resources/tectonic-linkage-anchors.lock.json", outside)
            linked = tmp / "resources/tectonic-linkage-anchors.lock.json"
            linked.symlink_to(outside)

            module_source = (ROOT / "scripts/collect-tectonic-linkage-evidence.py").read_text()
            namespace = {"__name__": "tectonic_linkage_symlink", "__file__": str(ROOT / "scripts/collect-tectonic-linkage-evidence.py")}
            exec(compile(module_source, "tectonic_linkage_symlink", "exec"), namespace)
            namespace["ROOT"] = tmp
            namespace["LOCK"] = linked
            namespace["PROVENANCE_LOCK"] = tmp / "resources/compiler-build-provenance.lock.json"
            namespace["NATIVE_SOURCES_LOCK"] = tmp / "resources/native-license-sources.lock.json"
            with self.assertRaisesRegex(ValueError, "Linked lock file"):
                namespace["collect"]()


if __name__ == "__main__":
    unittest.main()
