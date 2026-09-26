"""Negative controls for a source/notices collector; no downloads or execution."""
import importlib.util
import contextlib
import copy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("collector", Path(__file__).resolve().parent.parent / "scripts/collect-rust-license-materials.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def crate(extra=None, manifest=None):
    files = {"example-1.0.0/Cargo.toml": (manifest or '[package]\nname="example"\nversion="1.0.0"\nlicense="MIT"\n').encode(),
             "example-1.0.0/LICENSE": b"Original notice bytes\r\n"}
    files.update(extra or {})
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


class SourceMaterials(unittest.TestCase):
    def supplemental_fixture(self):
        content = b"Original exact-commit notice\n"
        checksum = collector.digest(content)
        package = {"name": "example", "version": "1.0.0", "checksum": "a" * 64,
                   "repository": "https://github.com/example/source", "declaredLicense": "MIT", "noticeFiles": []}
        report = {"tectonic": {"cargoLockSha256": "b" * 64}, "packages": [package]}
        source = {"name": "example", "version": "1.0.0", "crateSha256": "a" * 64,
                  "repository": "example/source", "commit": "c" * 40, "pathInVcs": "crate", "declaredLicense": "MIT",
                  "materials": [{"path": "LICENSE", "url": "https://raw.githubusercontent.com/example/source/" + "c" * 40 + "/LICENSE",
                                 "bytes": len(content), "sha256": checksum}]}
        lock = {"schemaVersion": 1, "cargoLockSha256": "b" * 64, "sources": [source]}
        output = Path("output")
        collector.atomic_write(Path("resources/rust-license-notices.lock.json"), json.dumps(lock).encode())
        collector.atomic_write(output / "packages/example-1.0.0/materials/.cargo_vcs_info.json",
                               json.dumps({"git": {"sha1": "c" * 40}, "path_in_vcs": "crate"}).encode())
        cached = Path(".cache/license-sources/rust-notices") / checksum
        collector.atomic_write(cached, content)
        return report, output, cached, content

    def test_supplemental_notices_require_matching_crate_provenance(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            report, output, _, content = self.supplemental_fixture()
            for key, value in [("checksum", "d" * 64), ("repository", "https://github.com/other/source"), ("declaredLicense", "Apache-2.0")]:
                changed = copy.deepcopy(report)
                changed["packages"][0][key] = value
                with self.assertRaises(ValueError):
                    collector.supplement_notices(changed, output, True)
            vcs_path = output / "packages/example-1.0.0/materials/.cargo_vcs_info.json"
            vcs = vcs_path.read_bytes()
            for changed in [{"git": {"sha1": "d" * 40}, "path_in_vcs": "crate"},
                            {"git": {"sha1": "c" * 40}, "path_in_vcs": "different"}]:
                vcs_path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    collector.supplement_notices(copy.deepcopy(report), output, True)
            vcs_path.write_bytes(vcs)
            collector.supplement_notices(report, output, True)
            self.assertEqual(report["packages"][0]["state"], "upstream-texts-collected")
            self.assertEqual((output / "packages/example-1.0.0/upstream-notices/LICENSE").read_bytes(), content)

    def test_supplemental_notice_bytes_must_match_the_lock(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            report, output, cached, content = self.supplemental_fixture()
            cached.write_bytes(b"X" + content[1:])
            with self.assertRaises(ValueError):
                collector.supplement_notices(report, output, True)
            self.assertFalse((output / "packages/example-1.0.0/upstream-notices/LICENSE").exists())
            cached.unlink()
            with self.assertRaises(ValueError):
                collector.supplement_notices(report, output, True)

    def test_exact_notice_bytes_and_declared_alternate_file_are_preserved(self):
        data = crate({"example-1.0.0/legal/terms.txt": b"Custom terms\n"}, '[package]\nname="example"\nversion="1.0.0"\nlicense-file="legal/terms.txt"\n')
        record, materials = collector.crate_materials(data, "example", "1.0.0")
        self.assertEqual(materials["LICENSE"], b"Original notice bytes\r\n")
        self.assertEqual(materials["legal/terms.txt"], b"Custom terms\n")
        self.assertIn("legal/terms.txt", record["noticeFiles"])

    def test_archive_traversal_and_wrong_package_identity_are_rejected(self):
        for name in ["example-1.0.0/../LICENSE", "/outside/LICENSE", "other-1.0.0/LICENSE", "example-1.0.0/a\\LICENSE"]:
            with self.assertRaises(ValueError):
                collector.crate_materials(crate({name: b"bad"}), "example", "1.0.0")
        with self.assertRaises(ValueError):
            collector.crate_materials(crate(manifest='[package]\nname="other"\nversion="1.0.0"\n'), "example", "1.0.0")

    def test_missing_or_escaping_declared_license_file_is_rejected(self):
        for name in ["missing.txt", "../LICENSE"]:
            with self.assertRaises(ValueError):
                collector.crate_materials(crate(manifest=f'[package]\nname="example"\nversion="1.0.0"\nlicense-file="{name}"\n'), "example", "1.0.0")

    def test_locked_cache_checks_checksum_size_and_file_type(self):
        with tempfile.TemporaryDirectory() as folder:
            filename = Path(folder) / "source.crate"
            data = crate()
            filename.write_bytes(data)
            self.assertEqual(collector.verified_bytes(filename, collector.digest(data), len(data)), data)
            with self.assertRaises(ValueError):
                collector.verified_bytes(filename, "0" * 64)
            with self.assertRaises(ValueError):
                collector.verified_bytes(filename, collector.digest(data), 1)
            linked = Path(folder) / "linked.crate"
            linked.symlink_to(filename)
            with self.assertRaises(ValueError):
                collector.verified_bytes(linked, collector.digest(data))

    def test_output_links_are_rejected_before_creating_nested_directories(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            outside = root / "outside"
            outside.mkdir()
            (root / "linked").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                collector.atomic_write(root / "linked" / "new" / "LICENSE", b"notice")
            self.assertEqual(list(outside.iterdir()), [])

    def test_a_notice_cannot_follow_an_archive_link(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, data in [("Cargo.toml", b'[package]\nname="example"\nversion="1.0.0"\n'), ("other", b"text")]:
                entry = tarfile.TarInfo("example-1.0.0/" + name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            link = tarfile.TarInfo("example-1.0.0/LICENSE")
            link.type = tarfile.SYMTYPE
            link.linkname = "other"
            archive.addfile(link)
        with self.assertRaises(ValueError):
            collector.crate_materials(output.getvalue(), "example", "1.0.0")


if __name__ == "__main__":
    unittest.main()
