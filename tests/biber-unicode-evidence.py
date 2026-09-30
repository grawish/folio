"""Offline controls for generated Unicode source attribution and execution bounds."""
import importlib.util
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("biber_unicode", Path(__file__).resolve().parent.parent / "scripts/collect-biber-unicode-evidence.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class UnicodeEvidence(unittest.TestCase):
    def test_generator_tamper_paths_and_collisions_rejected(self):
        for sources in [
            {collector.GENERATOR: b"changed generator"},
            {"lib/unicore/../../escape": b"outside"},
            {"lib/unicore/file": b"one", "lib/unicore/FILE": b"two"},
        ]:
            with self.assertRaises(ValueError): collector.selected_inputs(sources)

    def test_exact_bytes_distinguish_input_generation_and_renamed_tables(self):
        payload = {"lib/unicore/static.txt": b"original", "lib/unicore/Scx/A.pl": b"generated",
                   "lib/unicore/UCD.pl": b"unreproduced", "unrelated": b"ignored"}
        generated = {"lib/unicore/static.txt": b"original", "lib/unicore/Sc/A.pl": b"generated",
                     "lib/unicore/UCD.pl": b"different"}
        matches, unmatched = collector.compare_outputs(payload, generated, {"input.txt": b"original"})
        by_name = {m["path"]: m for m in matches}
        self.assertEqual(len(matches), 2)
        self.assertTrue(by_name["par/lib/unicore/static.txt"]["unchangedSourceInput"])
        self.assertFalse(by_name["par/lib/unicore/Scx/A.pl"]["samePath"])
        self.assertFalse(by_name["par/lib/unicore/Scx/A.pl"]["unchangedSourceInput"])
        self.assertEqual([m["path"] for m in unmatched], ["par/lib/unicore/UCD.pl"])

    def test_ucd_semantic_match_resolves_reordered_indices_and_known_aliases(self):
        perl = "/usr/bin/perl"
        def ucd(inline, entries):
            body = "@Unicode::UCD::inline_definitions = (\n" + ",\n".join(f"'{v}'" for v in inline) + "\n);\n"
            body += "%Unicode::UCD::loose_to_file_of = (\n"
            body += ",\n".join(f"'{k}' => '{v}'" for k, v in entries) + "\n);\n"
            body += "%Unicode::UCD::loose_property_name_of = ();\n"
            body += "%Unicode::UCD::strict_property_name_of = ();\n"
            body += "%Unicode::UCD::stricter_to_file_of = ();\n"
            body += "1;\n"
            return body.encode()
        payload = ucd(["def-A", "def-B"], [("sc=x", "#/0"), ("scx=x", "Sc/X")])
        reordered_same_values = ucd(["def-B", "def-A"], [("sc=x", "#/1"), ("scx=x", "Scx/X")])
        with tempfile.TemporaryDirectory() as work:
            self.assertTrue(collector.ucd_semantic_match(perl, payload, reordered_same_values, Path(work)))
        changed_value = ucd(["def-B", "def-A"], [("sc=x", "#/1"), ("scx=x", "Scx/Y")])
        with tempfile.TemporaryDirectory() as work:
            self.assertFalse(collector.ucd_semantic_match(perl, payload, changed_value, Path(work)))

    def test_headers_whitespace_and_partial_contents_are_not_normalized(self):
        for candidate in [b"data", b"data\r\n", b"other header\ndata\n", b"prefixdata\n"]:
            matched, unmatched = collector.compare_outputs({"lib/unicore/a.pl": b"data\n"},
                                                          {"lib/unicore/a.pl": candidate}, {})
            self.assertEqual(matched, [])
            self.assertEqual(len(unmatched), 1)

    def test_hash_lookup_still_requires_complete_byte_equality(self):
        with patch.object(collector.shared, "digest", return_value="collision"):
            matches, unmatched = collector.compare_outputs({"lib/unicore/a.pl": b"one"},
                                                          {"lib/unicore/b.pl": b"two"}, {})
        self.assertEqual(matches, [])
        self.assertEqual(len(unmatched), 1)

    def test_profile_rejects_injection_and_keeps_denials(self):
        for name in ['relative', '/tmp/"injection', '/tmp/back\\slash', '/tmp/new\nline']:
            with self.assertRaises(ValueError): collector.sandbox_profile(name)
        profile = collector.sandbox_profile('/tmp/unique work')
        self.assertIn('(deny network*)', profile)
        self.assertIn('(deny file-write*', profile)
        self.assertIn('(subpath "/tmp/unique work")', profile)

    def test_output_links_and_oversized_files_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); folder = root / "lib/unicore"; folder.mkdir(parents=True)
            (folder / "link").symlink_to(root / "missing")
            with self.assertRaises(ValueError): collector.read_generated(root)
            (folder / "link").unlink()
            with (folder / "large").open('wb') as handle: handle.truncate(16 * 1024 * 1024 + 1)
            with self.assertRaises(ValueError): collector.read_generated(root)

    def test_timeout_kills_and_reaps_the_process_group(self):
        process = Mock(pid=123); process.wait.side_effect = [subprocess.TimeoutExpired('generator', 180), -9]
        with tempfile.TemporaryDirectory() as directory, patch.object(collector.subprocess, "Popen", return_value=process) as spawn, patch.object(collector.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                collector.bounded_run(['generator'], directory, {}, Path(directory) / 'log')
            self.assertTrue(spawn.call_args.kwargs['start_new_session'])
            kill.assert_called_once_with(123, signal.SIGKILL)
            self.assertEqual(process.wait.call_count, 2)

    def test_failed_sandbox_control_prevents_generation(self):
        process = subprocess.CompletedProcess([], 0, b"unexpected", b"")
        with tempfile.TemporaryDirectory() as directory, patch.object(collector.subprocess, "run", return_value=process):
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "Sandbox control failed"):
                collector.check_sandbox(['perl'], root, {}, root / 'outside')


if __name__ == "__main__": unittest.main()
