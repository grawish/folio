"""Verify every remaining Biber byte gap has a bounded evidence disposition."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


def final_unmatched():
    cpan = json.loads((ROOT / "artifacts/license-materials/biber-cpan/source-matches.json").read_text())
    remaining = {row["path"]: row for row in cpan["unmatchedPayload"]}
    for name in ("autosplit", "unicode", "generated"):
        generated = json.loads((ROOT / f"artifacts/license-materials/biber-{name}/source-matches.json").read_text())
        for row in generated.get("matches", []):
            remaining.pop(row["path"], None)
    return remaining


class BiberRemainingDispositions(unittest.TestCase):
    def test_disposition_record_partitions_every_remaining_byte_gap(self):
        disposition = json.loads((ROOT / "docs/releases/biber-remaining-generated-dispositions.json").read_text())
        remaining = final_unmatched()
        nonbinary = {path for path in remaining if not path.endswith((".bundle", ".dylib"))}
        documented = {path for row in disposition["dispositions"] for path in row["paths"]}
        self.assertEqual(disposition["summary"]["totalPayloadFiles"], 3932)
        self.assertEqual(disposition["summary"]["totalExactSourceGeneratedMatches"], 3932 - len(remaining))
        self.assertEqual(disposition["summary"]["remainingByteGaps"], len(remaining))
        self.assertEqual(documented, nonbinary)
        self.assertEqual(len(nonbinary), disposition["summary"]["remainingNonbinaryPaths"])

    def test_compiled_and_native_residuals_are_covered_by_their_inventories(self):
        remaining = final_unmatched()
        modules = json.loads((ROOT / "artifacts/license-materials/biber-modules/inventory.json").read_text())
        native = json.loads((ROOT / "artifacts/license-materials/biber-native/inventory.json").read_text())
        bundle_paths = {path for path in remaining if path.endswith(".bundle")}
        dylib_paths = {path for path in remaining if path.endswith(".dylib")}
        module_paths = {path for module in modules["modules"] for path in module["payloadPaths"]}
        library_paths = {"par/" + library["path"] for library in native["libraries"]}
        self.assertEqual(bundle_paths, module_paths)
        self.assertEqual(dylib_paths, library_paths)
        self.assertEqual(len(bundle_paths), 99)
        self.assertEqual(len(dylib_paths), 14)

    def test_unrecoverable_and_empty_artifact_dispositions_stay_explicit(self):
        disposition = json.loads((ROOT / "docs/releases/biber-remaining-generated-dispositions.json").read_text())
        by_status = {row["status"]: row for row in disposition["dispositions"]}
        self.assertIn("semantic-equivalence-proven-byte-order-unrecoverable", by_status)
        self.assertIn("par/lib/unicore/UCD.pl", by_status["semantic-equivalence-proven-byte-order-unrecoverable"]["paths"])
        stubs = [row for row in disposition["dispositions"] if row["status"] == "empty-xs-bootstrap-stub"]
        self.assertEqual({path for row in stubs for path in row["paths"]}, {
            "par/lib/auto/Params/Validate/XS/XS.bs",
            "par/lib/auto/Text/BibTeX/BibTeX.bs",
        })
        self.assertTrue(all(row["reason"].startswith("The shipped .bs file is empty") for row in stubs))


if __name__ == "__main__":
    unittest.main()
