"""Offline controls for enc2xs symbol extraction and safe input paths."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "encode_xs", Path(__file__).resolve().parent.parent / "scripts/collect-biber-encode-xs-evidence.py"
)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class EncodeXsEvidence(unittest.TestCase):
    def test_generated_symbols_accepts_only_encode_table_definitions(self):
        source = b"""\
 const encode_t MacRoman_encoding = {};
static const encode_t hidden_encoding = {};
 const encode_t invalid = {};
 const encode_t cp1252_encoding = {};
"""
        self.assertEqual(collector.generated_symbols(source), [b"MacRoman_encoding", b"cp1252_encoding"])

    def test_input_paths_reject_archive_escapes_and_allow_regular_relative_paths(self):
        for path in ["", "../escape.ucm", "ucm/../escape.ucm", "/absolute.ucm", r"ucm\\escape.ucm"]:
            self.assertFalse(collector.valid_path(path))
        self.assertTrue(collector.valid_path("ucm/macRoman.ucm"))


if __name__ == "__main__":
    unittest.main()
