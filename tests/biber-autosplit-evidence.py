"""Offline controls for exact AutoSplit source and generated-file attribution."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("biber_autosplit", Path(__file__).resolve().parent.parent / "scripts/collect-biber-autosplit-evidence.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class AutoSplitEvidence(unittest.TestCase):
    def test_missing_or_modified_generator_is_rejected(self):
        for sources in ({}, {collector.GENERATOR: b"not the reviewed generator"}):
            with self.assertRaisesRegex(ValueError, "generator differs"):
                collector.generator_bytes(sources)

    def test_module_requires_complete_byte_match_and_keeps_original_input(self):
        data = b"package Synthetic;\n__END__\nsub test { 1 }\n"
        sources = {"Module.pm": data}
        payload = {"lib/Module.pm": data}
        self.assertEqual(collector.source_input(sources, "Module.pm", "Module.pm", payload, b""), (data, "none"))
        for bad in ({}, {"lib/Module.pm": data + b"\n"}, {"lib/Module.pm": data[:-1]}):
            with self.assertRaisesRegex(ValueError, "does not match"):
                collector.source_input(sources, "Module.pm", "Module.pm", bad, b"")
        with self.assertRaisesRegex(ValueError, "input is missing"):
            collector.source_input({}, "Module.pm", "Module.pm", payload, b"")

    def test_packager_patch_proves_installed_copy_without_changing_generation_input(self):
        original = b"before;\n__END__\nsub original { 1 }\n"
        patch = b"'Tk.pm' => ['before;' => 'after;'],"
        installed = original.replace(b"before;", b"after;")
        data, method = collector.source_input({"Tk.pm": original}, "Tk.pm", "Tk.pm", {"lib/Tk.pm": installed}, patch)
        self.assertEqual(data, original)
        self.assertEqual(method, "PAR::Filter::PatchContent:Tk.pm")
        with self.assertRaises(ValueError):
            collector.source_input({"Tk.pm": original}, "Tk.pm", "Tk.pm", {"lib/Tk.pm": original}, patch)

    def test_generation_requires_exact_path_header_and_bytes(self):
        name = "lib/auto/Synthetic/function.al"
        original = b"# Derived from original\nsub function { 1 }\n"
        payload = {name: original, "lib/auto/Synthetic/autosplit.ix": b"index\n", "unrelated.pm": b"ignore"}
        good = {name: original, "lib/auto/Synthetic/autosplit.ix": b"index\n"}
        matches, unmatched = collector.compare_outputs(payload, good)
        self.assertEqual(len(matches), 2); self.assertEqual(unmatched, [])
        for candidate in [original[:-1], original + b"\n", original.replace(b"original", b"different")]:
            matches, unmatched = collector.compare_outputs({name: original}, {name: candidate})
            self.assertEqual(matches, []); self.assertEqual(len(unmatched), 1)
        matches, unmatched = collector.compare_outputs({name: original}, {"lib/auto/Other/function.al": original})
        self.assertEqual(matches, []); self.assertEqual(len(unmatched), 1)

    def test_generated_output_rejects_links_special_files_and_unexpected_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); output = root / "blib/lib/auto"; output.mkdir(parents=True)
            (output / "Synthetic").mkdir()
            file = output / "Synthetic/function.al"
            file.write_bytes(b"exact output\n")
            self.assertEqual(collector.read_generated(root), {"lib/auto/Synthetic/function.al": b"exact output\n"})
            file.unlink(); file.symlink_to(root / "missing")
            with self.assertRaisesRegex(ValueError, "symbolic link"): collector.read_generated(root)
            file.unlink(); os.mkfifo(file)
            with self.assertRaisesRegex(ValueError, "special file"): collector.read_generated(root)
            file.unlink(); (output / "unreviewed.txt").write_text("not a split file")
            with self.assertRaisesRegex(ValueError, "Unexpected"): collector.read_generated(root)

    def test_output_file_and_entry_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); output = root / "blib/lib/auto"; output.mkdir(parents=True)
            file = output / "large.al"
            with file.open("wb") as handle: handle.truncate(1024 * 1024 + 1)
            with self.assertRaisesRegex(ValueError, "audit bounds"): collector.read_generated(root)
            file.unlink()
            for i in range(501): (output / f"f{i:03}.al").write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "audit bounds"): collector.read_generated(root)


if __name__ == "__main__": unittest.main()
