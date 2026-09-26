"""Offline controls for the native payload collector; no real source execution."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

spec = importlib.util.spec_from_file_location("native", Path(__file__).resolve().parent.parent / "scripts/collect-native-license-materials.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        for name, content in entries:
            member = tarfile.TarInfo(name)
            if content is None:
                member.type = tarfile.SYMTYPE
                member.linkname = "/outside/notice"
                tar.addfile(member)
            else:
                member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
    return output.getvalue()


def fixture(entries=None):
    data = archive(entries if entries is not None else [
        ("example-1.0/LICENSE", b"Original notice\r\n"),
        ("example-1.0/docs/FTL.TXT", b"Required secondary notice\n"),
        ("example-1.0/embedded/COPYING", b"Embedded component terms\n"),
        ("example-1.0/source.c", b"/* synthetic source, never executed */")])
    sha512 = hashlib.sha512(data).hexdigest()
    recipe = f'vcpkg_from_github(SHA512 {sha512})\n'.encode()
    manifest = b'{"name":"example","version":"1.0","license":"MIT"}'
    vcpkg = archive([("vcpkg-abcdef/ports/example/portfile.cmake", recipe),
                      ("vcpkg-abcdef/ports/example/vcpkg.json", manifest)])
    port = {"name": "example", "version": "1.0", "features": []}
    build = json.dumps({"schemaVersion": 1, "vcpkg": {"commit": "abcdef", "archive": "vcpkg.tar.gz",
                        "bytes": len(vcpkg), "sha256": native.materials.digest(vcpkg), "ports": [port]}}).encode()
    source = {**port, "archive": "example-1.0.tar.gz", "archiveRoot": "example-1.0",
              "url": "https://github.com/example/example/archive/v1.0.tar.gz",
              "bytes": len(data), "sha256": native.materials.digest(data), "sha512": sha512,
              "recipeSha256": native.materials.digest(recipe), "manifestSha256": native.materials.digest(manifest),
              "requiredNotices": ["LICENSE", "docs/FTL.TXT"]}
    lock = {"schemaVersion": 1, "scope": "Synthetic test only", "buildEvidenceLockSha256": native.materials.digest(build),
            "vcpkgCommit": "abcdef", "sources": [source], "otherBuildPorts": []}
    return data, source, lock, build, vcpkg


class NativeMaterials(unittest.TestCase):
    def test_exact_recipe_archive_and_all_notice_bytes_are_retained(self):
        data, source, lock, build, vcpkg = fixture()
        _, checked = native.reviewed_sources(json.dumps(lock).encode(), build, vcpkg)
        self.assertEqual(checked[0]["declaredLicense"], "MIT")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / source["archive"]).write_bytes(data)
            report = native.collect(checked[0], root, root / "output", True)
            self.assertEqual(len(report["materials"]), 3)
            self.assertEqual((root / "output/ports/example" / source["archive"]).read_bytes(), data)
            self.assertEqual((root / "output/ports/example/notices/LICENSE").read_bytes(), b"Original notice\r\n")
            self.assertFalse((root / "output/ports/example/source.c").exists())

    def test_changed_sizes_and_either_digest_are_rejected(self):
        data, source, *_ = fixture()
        for key, value in [("bytes", len(data) + 1), ("sha256", "0" * 64), ("sha512", "0" * 128)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                native.check_source(data, {**source, key: value})
        with self.assertRaises(ValueError):
            native.check_source(data[:-1] + bytes([data[-1] ^ 1]), source)

    def test_changed_build_recipe_version_or_features_are_rejected(self):
        _, source, lock, build, vcpkg = fixture()
        for field, value in [("recipeSha256", "0" * 64), ("manifestSha256", "0" * 64),
                             ("sha512", "0" * 128), ("version", "2.0"), ("features", ["other"])]:
            changed = copy.deepcopy(lock)
            changed["sources"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                native.reviewed_sources(json.dumps(changed).encode(), build, vcpkg)
        with self.assertRaises(ValueError):
            native.reviewed_sources(json.dumps(lock).encode(), build + b" ", vcpkg)
        with self.assertRaises(ValueError):
            native.reviewed_sources(json.dumps(lock).encode(), build, vcpkg[:-1])

    def test_source_destinations_and_notice_references_cannot_escape(self):
        _, _, lock, build, vcpkg = fixture()
        for field, value in [("archive", "../source.tar.gz"), ("archiveRoot", "/outside"),
                             ("requiredNotices", ["../LICENSE"]), ("requiredNotices", []),
                             ("url", "file:///outside/source.tar.gz")]:
            changed = copy.deepcopy(lock)
            changed["sources"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                native.reviewed_sources(json.dumps(changed).encode(), build, vcpkg)

    def test_duplicate_ports_are_rejected(self):
        _, _, lock, build, vcpkg = fixture()
        lock["sources"].append(copy.deepcopy(lock["sources"][0]))
        with self.assertRaises(ValueError):
            native.reviewed_sources(json.dumps(lock).encode(), build, vcpkg)

    def test_links_traversal_duplicate_members_and_missing_notices_are_rejected(self):
        normal = [("example-1.0/LICENSE", b"Notice"), ("example-1.0/docs/FTL.TXT", b"Terms")]
        for entries in [[normal[0]], [(normal[0][0], None), normal[1]],
                        normal + [("example-1.0/../outside", b"No")], normal + [normal[0]]]:
            data, source, *_ = fixture(entries)
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                native.source_notices(data, source)

    def test_corrupt_cache_and_offline_absence_do_not_fetch_replacements(self):
        _, source, *_ = fixture()
        with tempfile.TemporaryDirectory() as folder, patch.object(urllib.request, "build_opener") as network:
            root = Path(folder).resolve()
            with self.assertRaises(ValueError):
                native.download_source(source, root, True)
            (root / source["archive"]).write_bytes(b"Changed cache")
            with self.assertRaises(ValueError):
                native.download_source(source, root, False)
            network.assert_not_called()

    def test_cache_and_output_links_cannot_redirect_collection(self):
        data, source, *_ = fixture()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            outside = root / "outside"
            outside.mkdir()
            (outside / source["archive"]).write_bytes(data)
            (root / "linked").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                native.download_source(source, root / "linked", True)
            with self.assertRaises(ValueError):
                native.collect(source, outside, root / "linked", True)
            self.assertEqual(list(outside.iterdir()), [outside / source["archive"]])

    def test_download_checks_bytes_before_publishing_cache(self):
        data, source, *_ = fixture()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            for payload, valid in [(data, True), (data + b"extra", False), (data[:-1], False)]:
                response = io.BytesIO(payload)
                response.url = source["url"]
                with patch.object(urllib.request, "build_opener") as opener:
                    opener.return_value.open.return_value = response
                    if valid:
                        self.assertEqual(native.download_source(source, root, False), data)
                        (root / source["archive"]).unlink()
                    else:
                        with self.assertRaises(ValueError):
                            native.download_source(source, root, False)
                        self.assertFalse((root / source["archive"]).exists())

    def test_unapproved_redirects_are_refused_before_following(self):
        handler = native.SourceRedirect()
        request = urllib.request.Request("https://github.com/example/source")
        for target in ["http://github.com/source", "https://example.net/source", "https://user:pass@github.com/source", "https://github.com:8443/source"]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        allowed = handler.redirect_request(request, None, 302, "Found", {}, "https://codeload.github.com/example/source")
        self.assertEqual(allowed.full_url, "https://codeload.github.com/example/source")

    def test_failed_run_preserves_last_success_and_records_incomplete_evidence(self):
        _, _, lock, build, vcpkg = fixture()
        before = Path.cwd()
        with tempfile.TemporaryDirectory() as folder:
            try:
                os.chdir(folder)
                Path("resources").mkdir()
                Path("resources/native-license-sources.lock.json").write_text(json.dumps(lock))
                Path("resources/compiler-build-provenance.lock.json").write_bytes(build)
                cache = Path(".cache/license-sources")
                cache.mkdir(parents=True)
                (cache / "vcpkg.tar.gz").write_bytes(vcpkg)
                output = Path("artifacts/license-materials/compiler-native")
                output.mkdir(parents=True)
                (output / "inventory.json").write_bytes(b"Previous verified inventory")
                with patch("sys.argv", ["collector", "--offline"]), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                    native.main()
                self.assertEqual((output / "inventory.json").read_bytes(), b"Previous verified inventory")
                report = json.loads((output / "incomplete-inventory.json").read_text())
                self.assertFalse(report["complete"])
                self.assertEqual(report["errors"][0]["name"], "example")
            finally:
                os.chdir(before)


if __name__ == "__main__":
    unittest.main()
