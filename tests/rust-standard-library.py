"""Offline provenance and malformed-input controls for the Rust std collector."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location("std_materials", Path(__file__).resolve().parent.parent / "scripts/collect-rust-standard-library.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def source_fixture():
    prefix = collector.SOURCE_PREFIX + "library/"
    vendor = prefix + "vendor/helper-1.0.0/"
    files = {
        prefix + "Cargo.lock": b'version=4\n[[package]]\nname="helper"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + b'a' * 64 + b'"\n',
        vendor + "Cargo.toml": b'[package]\nname="helper"\nversion="1.0.0"\nlicense="MIT"\n',
        vendor + "LICENSE": b"original notice\r\n",
        vendor + "src/lib.rs": b"pub fn helper() {}\n",
    }
    checksums = {n.removeprefix(vendor): collector.shared.digest(data) for n, data in files.items() if n.startswith(vendor)}
    files[vendor + ".cargo-checksum.json"] = json.dumps({"files": checksums, "package": "a" * 64}).encode()
    return files, vendor


class StandardLibrary(unittest.TestCase):
    def test_original_version_commit_and_notices_required(self):
        files = {"version": b"1.97.1 (commit date)", "git-commit-hash": b"a" * 40,
                 "LICENSE-MIT": b"mit", "LICENSE-APACHE": b"apache", "COPYRIGHT": b"copyright"}
        collector.check_identity(files, "1.97.1", "a" * 40)
        for name, value in [("version", b"1.97.2 (other date)"), ("git-commit-hash", b"b" * 40), ("LICENSE-MIT", b"")]:
            changed = {**files, name: value}
            with self.assertRaises(ValueError): collector.check_identity(changed, "1.97.1", "a" * 40)

    def test_vendored_source_checksums_and_notices_preserved(self):
        files, vendor = source_fixture()
        inventory, manifests = collector.source_inventory(files)
        package = inventory["vendorPackages"][0]
        self.assertEqual(package["verifiedFileCount"], 3)
        self.assertEqual(package["noticeFiles"], [vendor + "LICENSE"])
        self.assertEqual(files[package["noticeFiles"][0]], b"original notice\r\n")
        self.assertEqual(manifests[("helper", "1.0.0")], [vendor + "Cargo.toml"])
        for target in ["src/lib.rs", "LICENSE", "Cargo.toml"]:
            changed = {**files, vendor + target: b"modified"}
            with self.assertRaises(ValueError):
                collector.source_inventory(changed)

    def test_registry_identity_and_archive_checksum_match(self):
        files, vendor = source_fixture()
        checksum = json.loads(files[vendor + ".cargo-checksum.json"])
        checksum["package"] = "b" * 64
        changed = {**files, vendor + ".cargo-checksum.json": json.dumps(checksum).encode()}
        with self.assertRaisesRegex(ValueError, "package checksum"):
            collector.source_inventory(changed)
        files[vendor + "Cargo.toml"] = b'[package]\nname="different"\nversion="1.0.0"\n'
        checksum["package"] = "a" * 64
        checksum["files"]["Cargo.toml"] = collector.shared.digest(files[vendor + "Cargo.toml"])
        files[vendor + ".cargo-checksum.json"] = json.dumps(checksum).encode()
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            collector.source_inventory(files)

    def test_prebuilt_library_requires_locked_source_and_notice(self):
        files, _ = source_fixture()
        inventory, manifests = collector.source_inventory(files)
        binary = {"lib/libhelper-1234567890abcdef.rlib": b"verified archive fixture"}
        result = collector.binary_inventory(binary, inventory, manifests)
        self.assertEqual(result[0]["name"], "helper")
        self.assertEqual(result[0]["sha256"], collector.shared.digest(b"verified archive fixture"))
        with self.assertRaisesRegex(ValueError, "No source manifest"):
            collector.binary_inventory(binary, inventory, {})
        changed = copy.deepcopy(inventory); changed["vendorPackages"][0]["noticeFiles"] = []
        with self.assertRaisesRegex(ValueError, "no collected notice"):
            collector.binary_inventory(binary, changed, manifests)
        with self.assertRaisesRegex(ValueError, "Unrecognized"):
            collector.binary_inventory({"lib/libother-1234567890abcdef.rlib": b"data"}, inventory, manifests)

    def test_archive_rejects_links_traversal_and_collisions(self):
        for names in [["root/../escape"], ["root/LICENSE", "root/license"], ["root/link"]]:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:xz") as archive:
                for name in names:
                    member = tarfile.TarInfo(name)
                    if name.endswith('/link'):
                        member.type = tarfile.SYMTYPE; member.linkname = "../../escape"; archive.addfile(member)
                    else:
                        member.size = 4; archive.addfile(member, io.BytesIO(b"text"))
            with self.assertRaises(ValueError): collector.members(buffer.getvalue(), "root")

    def test_download_rejects_unreviewed_host_paths_and_bounds(self):
        entry = {"archive": "source.tar.xz", "url": "https://untrusted.example/source.tar.xz", "bytes": 12, "sha256": "a" * 64}
        with self.assertRaisesRegex(ValueError, "input URL"):
            collector.get_input(entry, True)
        for key, value in [("archive", "../source.tar.xz"), ("bytes", 70 * 1024 * 1024)]:
            changed = {**entry, "url": "https://static.rust-lang.org/dist/source.tar.xz", key: value}
            with self.assertRaises(ValueError): collector.get_input(changed, True)


if __name__ == "__main__":
    unittest.main()
