"""Offline controls for bounded native version/source evidence, not library execution."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("biber_native", Path(__file__).resolve().parent.parent / "scripts/collect-biber-native-materials.py")
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
sha = lambda b: hashlib.sha256(b).hexdigest()


def library(symbol="_version", value=272):
    def load(command, name):
        text = name.encode() + b"\0"; size = (24 + len(text) + 7) // 8 * 8
        return struct.pack("<6I", command, size, 24, 0, 0x10000, 0x10000) + text + bytes(size - 24 - len(text))
    segment = struct.pack("<II16s4Q4I", 0x19, 152, b"__DATA", 0x1000, 768, 0, 768, 3, 3, 1, 0)
    section = struct.pack("<16s16sQQ8I", b"__data", b"__DATA", 0x1000+400, 32, 400, 2, 0, 0, 0, 0, 0, 0)
    identity = load(0xD, "/synthetic/lib.dylib")
    dependency = load(0xC, "/usr/lib/libSystem.B.dylib")
    strings = b"\0" + symbol.encode() + b"\0"
    commands = segment + section + identity + dependency + struct.pack("<6I", 2, 24, 480, 1, 520, len(strings))
    data = bytearray(768)
    data[:32] = struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 6, 4, len(commands), 0, 0)
    data[32:32+len(commands)] = commands
    struct.pack_into("<I", data, 400, value)
    struct.pack_into("<IBBHQ", data, 480, 1, 0x0F, 1, 0, 0x1000+400)
    data[520:520+len(strings)] = strings
    data[600:619] = b"\0Synthetic 1.0.0\0xx"  # trailing contents are deliberately irrelevant
    return bytes(data)


def archive(items, mode="w:gz"):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode=mode) as a:
        for name, data, kind in items:
            info = tarfile.TarInfo(name); info.type = kind
            if kind == tarfile.REGTYPE: info.size = len(data); a.addfile(info, io.BytesIO(data))
            else: info.linkname = "../../outside"; a.addfile(info)
    return out.getvalue()


def source(data):
    header = b"#define VERSION 1\n"
    return {"name":"synthetic", "archive":"synthetic.tar.gz", "url":"https://ftp.gnu.org/gnu/synthetic.tar.gz",
            "root":"synthetic", "bytes":len(data), "sha256":sha(data), "requiredMaterials":["COPYING"],
            "sourceAnchors":[{"path":"version.h", "sha256":sha(header), "text":["#define VERSION 1"]}]}


class NativeMaterials(unittest.TestCase):
    def test_thin_and_universal_read_scalar_identity_and_dependency_without_loading(self):
        data = library()
        thin, result = c.macho(data, [("_version",1)])
        self.assertEqual(thin, data)
        self.assertEqual(result["scalars"]["_version"], {"arm64FileOffset":400,"values":[272]})
        self.assertEqual(result["dependencies"][0]["name"], "/usr/lib/libSystem.B.dylib")
        fat = struct.pack(">7I", 0xCAFEBABE, 1, 0x0100000C, 0, 4096, len(data), 12) + bytes(4096-28) + data
        self.assertEqual(c.macho(fat, [("_version",1)]), (thin,result))

    def test_malformed_commands_symbols_and_scalars_rejected(self):
        data = library()
        for offset,value in [(4,0), (16,513), (20,len(data)), (36,7), (480,9999), (488,0xFFFFFFF0)]:
            bad = bytearray(data); struct.pack_into("<I",bad,offset,value)
            with self.assertRaises(ValueError): c.macho(bytes(bad), [("_version",1)])
        with self.assertRaises(ValueError): c.macho(data, [("_absent",1)])
        with self.assertRaises(ValueError): c.macho(data, [("_version",17)])
        with self.assertRaises(ValueError): c.macho(data[:100], [("_version",1)])

    def test_expected_library_hash_identity_and_version_must_agree(self):
        data = library(); _, info = c.macho(data)
        entry = {"bytes":len(data),"sha256":sha(data),"identity":info["identity"],
                 "scalars":[{"symbol":"_version","values":[272]}],"strings":["Synthetic 1.0.0"]}
        self.assertEqual(c.check_library(data,entry)["scalars"]["_version"]["values"], [272])
        for field,value in [("sha256","0"*64),("identity",{}),("scalars",[{"symbol":"_version","values":[273]}]),("strings",["Synthetic 9.0.0"])]:
            bad=copy.deepcopy(entry); bad[field]=value
            with self.assertRaises(ValueError): c.check_library(data,bad)

    def test_source_notices_and_declarations_preserved_across_compressions(self):
        items=[("synthetic/COPYING",b"Original notice\n",tarfile.REGTYPE), ("synthetic/version.h",b"#define VERSION 1\n",tarfile.REGTYPE)]
        for mode in ["w:gz","w:xz","w:bz2"]:
            data=archive(items,mode); entry=source(data)
            self.assertEqual(c.source_materials(data,entry), {"COPYING":b"Original notice\n","version.h":b"#define VERSION 1\n"})
            bad=copy.deepcopy(entry);bad["sourceAnchors"][0]["text"]=["#define VERSION 2"]
            with self.assertRaisesRegex(ValueError,"version declaration"): c.source_materials(data,bad)
            with self.assertRaises(ValueError): c.source_materials(data+b"changed",entry)

    def test_unsafe_duplicate_link_and_missing_source_materials_rejected(self):
        base=[("synthetic/COPYING",b"notice",tarfile.REGTYPE), ("synthetic/version.h",b"#define VERSION 1\n",tarfile.REGTYPE)]
        cases=[base+[("synthetic/../escape",b"x",tarfile.REGTYPE)], base+[base[0]],
               [("synthetic/COPYING",b"",tarfile.SYMTYPE),base[1]], [base[1]]]
        for items in cases:
            data=archive(items)
            with self.assertRaises(ValueError): c.source_materials(data,source(data))

    def test_version_scalar_cannot_escape_file_backed_segment(self):
        data=bytearray(library());struct.pack_into("<Q",data,488,0x1000+768)
        with self.assertRaisesRegex(ValueError,"scalar mapping"):c.macho(bytes(data),[("_version",1)])

    def test_download_hosts_and_corrupt_offline_cache_fail_closed(self):
        for url in ["http://ftp.gnu.org/a", "https://example.com/a", "https://ftp.gnu.org@evil.test/a", "https://ftp.gnu.org:8443/a", "https://ftp.gnu.org/a#fragment"]:
            with self.assertRaises(ValueError):c.source_url(url)
        with tempfile.TemporaryDirectory() as d, patch.object(c,"ROOT",Path(d).resolve()), patch.object(c.urllib.request,"build_opener") as network:
            entry=source(b"original")
            file=c.ROOT/".cache/license-sources/biber-native"/entry["archive"]
            file.parent.mkdir(parents=True);file.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError,"digest mismatch"):c.source_archive(entry,True)
            network.assert_not_called()

    def test_name_suffix_collects_matching_exported_data_symbols(self):
        data = library(symbol="_MacRoman_encoding")
        thin, result = c.macho(data, [], name_suffix="_encoding")
        self.assertEqual(result["suffixNames"], ["_MacRoman_encoding"])
        thin, result = c.macho(data, [])
        self.assertNotIn("suffixNames", result)
        thin, result = c.macho(data, [], name_suffix="_nomatch")
        self.assertEqual(result["suffixNames"], [])


if __name__ == "__main__":unittest.main()
