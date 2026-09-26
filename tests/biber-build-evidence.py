"""Offline binary provenance and malformed-input controls for Biber evidence."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import tarfile
import tempfile
import unittest
import warnings
import zipfile
import zlib

spec = importlib.util.spec_from_file_location("biber_evidence", Path(__file__).resolve().parent.parent / "scripts/collect-biber-build-evidence.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def zip_bytes(entries):
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, data in entries:
                archive.writestr(name, data)
    return buffer.getvalue()


def thin_binary(payload):
    header = struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 1, 16, 0, 0)
    return header + struct.pack("<4I", 0x1D, 16, 48 + len(payload), 4) + payload + b"sign"


def par_binary():
    content = b"original loader\r\n"
    name = f"{zlib.crc32(content):08x}/lib/Test.pm".encode()
    loader = b"FILE" + struct.pack(">I", len(name)) + name + struct.pack(">I", len(content)) + content
    payload = loader + zip_bytes([("lib/Test.pm", b"original module")])
    return thin_binary(payload + struct.pack(">I", len(payload)) + b"\nPAR.pm\n"), content


class BiberEvidence(unittest.TestCase):
    def test_arm64_slice_and_signature_bounds(self):
        thin = thin_binary(b"payload")
        fat = b"\xca\xfe\xba\xbe" + struct.pack(">I5I", 1, 0x0100000C, 0, 28, len(thin), 0) + thin
        self.assertEqual(collector.arm64_slice(fat), thin)
        self.assertEqual(collector.signature_offset(thin), len(thin) - 4)
        for changed in [fat[:-1], b"bad" + fat[3:], fat[:4] + struct.pack(">I", 9) + fat[8:]]:
            with self.assertRaises(ValueError): collector.arm64_slice(changed)
        for changed in [thin[:-1], thin[:16] + struct.pack("<I", 513) + thin[20:]]:
            with self.assertRaises(ValueError): collector.signature_offset(changed)

    def test_par_loader_crc_trailer_and_contents(self):
        binary, content = par_binary()
        loader, files, layout = collector.parse_payload(binary)
        self.assertEqual(list(loader.values()), [content])
        self.assertEqual(files, {"lib/Test.pm": b"original module"})
        self.assertEqual(layout["payloadStart"], 48)
        for changed in [binary.replace(content, b"X" + content[1:]), binary.replace(b"\nPAR.pm\n", b"\nBAD.pm\n")]:
            with self.assertRaises(ValueError): collector.parse_payload(changed)
        changed = bytearray(binary)
        struct.pack_into(">I", changed, changed.index(b"\nPAR.pm\n") - 4, len(binary))
        with self.assertRaises(ValueError): collector.parse_payload(changed)

    def test_zip_duplicate_requires_exact_reviewed_identity_and_count(self):
        content = b"identical reviewed data"
        reviewed = {"lib/Test.pm": {"bytes": len(content), "sha256": collector.shared.digest(content), "extraOccurrences": 1}}
        duplicate = zip_bytes([("lib/Test.pm", content)] * 2)
        self.assertEqual(collector.read_zip(duplicate, reviewed), {"lib/Test.pm": content})
        with self.assertRaises(ValueError): collector.read_zip(duplicate)
        with self.assertRaises(ValueError): collector.read_zip(zip_bytes([("lib/Test.pm", content)] * 3), reviewed)
        with self.assertRaises(ValueError): collector.read_zip(zip_bytes([("lib/Test.pm", content)]), reviewed)
        with self.assertRaises(ValueError): collector.read_zip(zip_bytes([("lib/Test.pm", content), ("lib/Test.pm", b"changed")]), reviewed)
        wrong = copy.deepcopy(reviewed); wrong["lib/Test.pm"]["sha256"] = "0" * 64
        with self.assertRaises(ValueError): collector.read_zip(duplicate, wrong)

    def test_zip_paths_links_and_expanded_bounds_rejected(self):
        for name in ["../escape", "/absolute", "lib/../escape", "lib\\escape"]:
            with self.assertRaises(ValueError): collector.read_zip(zip_bytes([(name, b"data")]))
        link = zipfile.ZipInfo("link"); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(ValueError): collector.read_zip(zip_bytes([(link, b"target")]))
        huge = bytearray(zip_bytes([("file", b"data")]))
        central = huge.index(b"PK\x01\x02")
        struct.pack_into("<I", huge, central + 24, 65 * 1024 * 1024)
        with self.assertRaises(ValueError): collector.read_zip(huge)

    def test_native_chunk_terminators_and_hashes_required(self):
        content = b"a" * 32768 + b"final bytes"
        encoded = b"head" + content[:32768] + b"\0" + content[32768:] + b"\0"
        entry = {"offset": 4, "bytes": len(content), "chunkBytes": 32768, "sha256": collector.shared.digest(content)}
        self.assertEqual(collector.embedded_binary(encoded, entry), content)
        for changed in [encoded[:-1], encoded[:32772] + b"X" + encoded[32773:], b"headX" + encoded[5:]]:
            with self.assertRaises(ValueError): collector.embedded_binary(changed, entry)

    def test_cache_requires_exact_manifest_and_payload_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = b"ordinary payload"
            wrapper = b'package main;\n#line 1 "script/main.pl"\noriginal script'
            canary = b"reviewed canary"
            for name, data in {"module.pm": raw, "generated.pl": wrapper, "_CANARY_.txt": canary}.items():
                (root / name).write_bytes(data)
            expected = {p.name: collector.shared.digest(p.read_bytes()) for p in root.iterdir()}
            lock = {"embeddedBinaries": [], "generatedScripts": [{"cachePath": "generated.pl", "sourcePath": "script/main.pl"}],
                    "canary": {"cachePath": "_CANARY_.txt", "bytes": len(canary), "sha256": collector.shared.digest(canary)}}
            files = {"lib/module.pm": raw, "script/main.pl": b"original script"}
            records = collector.map_cache(root, expected, canary, {}, files, lock)
            self.assertEqual(len(records), 3)
            (root / "extra").write_bytes(b"extra")
            with self.assertRaisesRegex(ValueError, "inventory differs"): collector.map_cache(root, expected, canary, {}, files, lock)
            (root / "extra").unlink()
            (root / "module.pm").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "digest mismatch"): collector.map_cache(root, expected, canary, {}, files, lock)
            expected["module.pm"] = collector.shared.digest(b"tampered")
            with self.assertRaisesRegex(ValueError, "no payload provenance"): collector.map_cache(root, expected, canary, {}, files, lock)
            (root / "module.pm").write_bytes(raw); expected["module.pm"] = collector.shared.digest(raw)
            (root / "generated.pl").write_bytes(b"changed wrapper"); expected["generated.pl"] = collector.shared.digest(b"changed wrapper")
            with self.assertRaisesRegex(ValueError, "cache file differs"): collector.map_cache(root, expected, canary, {}, files, lock)

    def test_source_materials_preserve_bytes_reject_links_and_traversal(self):
        for unsafe in [None, "root/../outside", "root/link"]:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
                entry = tarfile.TarInfo(unsafe or "root/LICENSE")
                if unsafe == "root/link":
                    entry.type = tarfile.SYMTYPE; entry.linkname = "../../outside"; archive.addfile(entry)
                else:
                    entry.size = 7; archive.addfile(entry, io.BytesIO(b"legal\r\n"))
            if unsafe:
                with self.assertRaises(ValueError): collector.archive_sources(buffer.getvalue(), "root")
            else:
                self.assertEqual(collector.archive_sources(buffer.getvalue(), "root"), {"LICENSE": b"legal\r\n"})

    def test_foundation_download_requires_reviewed_host_paths_and_size(self):
        base = {"archive": "perl-test.tar.gz", "url": "https://cpan.metacpan.org/authors/id/S/SH/SHAY/perl-test.tar.gz", "bytes": 10, "sha256": "a" * 64}
        for key, value in [("archive", "../file.tar.gz"), ("url", "https://untrusted.example/file.tar.gz"), ("bytes", 33 * 1024 * 1024)]:
            with self.assertRaisesRegex(ValueError, "URL or bounds"): collector.foundation_input({**base, key: value}, True)
        with self.assertRaisesRegex(ValueError, "Missing offline"): collector.foundation_input(base, True)


if __name__ == "__main__":
    unittest.main()
