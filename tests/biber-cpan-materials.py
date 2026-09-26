"""Offline controls for CPAN source identity and literal packager transformations."""
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cpan_materials", Path(__file__).resolve().parent.parent / "scripts/collect-biber-cpan-materials.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
FILTER = b"'Tk.pm' => [ 'original' => 'packaged', # reviewed comment\n ],\n"


def anchor_entry():
    return {"anchors": [{"payload": "par/lib/Tk.pm", "sha256": collector.shared.digest(b"packaged module"),
                         "source": "Tk.pm", "transformation": "PAR::Filter::PatchContent:Tk.pm"}]}


class CpanMaterials(unittest.TestCase):
    def test_literal_parser_preserves_perl_single_quote_semantics(self):
        literal = br"'a\\b\'c\nd'"
        result, end = collector.quoted_string(literal, 0)
        self.assertEqual(result, b"a\\b'c\\nd")
        self.assertEqual(end, len(literal))
        for data in [b"$dynamic", b"'unterminated"]:
            with self.assertRaises(ValueError): collector.quoted_string(data, 0)

    def test_patch_requires_static_pairs_and_rejects_executable_expressions(self):
        self.assertEqual(collector.patch_rules(FILTER, "Tk.pm"), [(b"original", b"packaged")])
        for source in [b"'Tk.pm' => [ 'only', ]", b"'Tk.pm' => [ 'x' => system('touch should-not-exist'), ]", b"'Tk.pm' => [ qr/x/ => 'y', ]"]:
            with self.assertRaises(ValueError): collector.patch_rules(source, "Tk.pm")
        with self.assertRaises(ValueError): collector.patch_rules(FILTER, "Unreviewed.pm")

    def test_patched_source_must_match_complete_payload_bytes(self):
        payload = {"par/lib/Tk.pm": b"packaged module", "par/lib/Other.pm": b"unaltered source"}
        sources = {"Tk.pm": b"original module", "lib/Other.pm": b"unaltered source"}
        matches = collector.match_sources(sources, collector.payload_index(payload), FILTER)
        self.assertEqual(len(matches), 2)
        collector.verify_anchors(anchor_entry(), matches, payload)
        for modified in [{**sources, "Tk.pm": b"original different module"}, {**sources, "Tk.pm": b"original module\n"}]:
            matches = collector.match_sources(modified, collector.payload_index(payload), FILTER)
            with self.assertRaisesRegex(ValueError, "source bytes"): collector.verify_anchors(anchor_entry(), matches, payload)

    def test_anchor_rejects_changed_identity_path_and_transformation(self):
        payload = {"par/lib/Tk.pm": b"packaged module"}
        matches = collector.match_sources({"Tk.pm": b"original module"}, collector.payload_index(payload), FILTER)
        for key, value in [("sha256", "0" * 64), ("source", "different.pm"), ("transformation", "none"), ("payload", "par/lib/Other.pm")]:
            entry = copy.deepcopy(anchor_entry()); entry["anchors"][0][key] = value
            with self.assertRaises(ValueError): collector.verify_anchors(entry, matches, payload)
        with self.assertRaises(ValueError): collector.verify_anchors({"anchors": []}, matches, payload)

    def test_empty_files_cannot_establish_source_provenance(self):
        result = collector.match_sources({"empty": b""}, collector.payload_index({"par/empty": b""}), FILTER)
        self.assertEqual(result, [])

    def test_notices_metadata_and_anchor_sources_retained_without_rewriting(self):
        sources = {"LICENSE": b"original legal text\r\n", "README.md": b"readme", "META.json": b"{}", "lib/Module.pm": b"source and embedded POD license", "unused": b"data"}
        entry = {"anchors": [{"source": "lib/Module.pm"}]}
        self.assertEqual(collector.material_names(sources, entry), ["LICENSE", "META.json", "README.md", "lib/Module.pm"])
        self.assertEqual(sources["LICENSE"], b"original legal text\r\n")
        with self.assertRaisesRegex(ValueError, "collide"):
            collector.material_names({**sources, "license": b"different"}, entry)
        with self.assertRaisesRegex(ValueError, "absent"):
            collector.material_names(sources, {"anchors": [{"source": "missing.pm"}]})

    def test_input_hosts_paths_and_bounds_are_restricted(self):
        entry = {"archive": "Module-1.0.tgz", "url": "https://cpan.metacpan.org/authors/id/A/AB/ABC/Module-1.0.tgz", "bytes": 4, "sha256": collector.shared.digest(b"data")}
        for key, value in [("archive", "../Module-1.0.tgz"), ("url", "https://untrusted.example/Module-1.0.tgz"), ("bytes", 33 * 1024 * 1024)]:
            with self.assertRaisesRegex(ValueError, "URL or bounds"): collector.get_input({**entry, key: value}, True)

    def test_download_and_cached_bytes_require_exact_digest_and_no_redirect(self):
        entry = {"archive": "Module-1.0.tgz", "url": "https://cpan.metacpan.org/authors/id/A/AB/ABC/Module-1.0.tgz", "bytes": 4, "sha256": collector.shared.digest(b"data")}
        with tempfile.TemporaryDirectory() as directory, patch.object(collector, "ROOT", Path(directory).resolve()):
            with self.assertRaisesRegex(ValueError, "Missing offline"): collector.get_input(entry, True)
            response = io.BytesIO(b"data"); response.url = "https://different.example/file"
            with patch.object(collector.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, "redirect"): collector.get_input(entry, False)
            response = io.BytesIO(b"evil"); response.url = entry["url"]
            with patch.object(collector.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, "differs from lock"): collector.get_input(entry, False)
            response = io.BytesIO(b"data"); response.url = entry["url"]
            with patch.object(collector.urllib.request, "urlopen", return_value=response):
                self.assertEqual(collector.get_input(entry, False), b"data")
            self.assertEqual(collector.get_input(entry, True), b"data")
            cached = Path(directory) / ".cache/license-sources/biber-cpan" / entry["archive"]
            cached.write_bytes(b"evil")
            with self.assertRaisesRegex(ValueError, "digest mismatch"): collector.get_input(entry, True)


if __name__ == "__main__":
    unittest.main()
