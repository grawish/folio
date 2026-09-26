"""Compiler provenance controls: matching version labels cannot replace bytes."""
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("evidence", Path(__file__).resolve().parent.parent / "scripts/collect-compiler-build-evidence.py")
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


def artifact(binary=b"Synthetic compiler bytes", *, link=False, extra=False, zip_name="compiler.tar.gz"):
    tar = io.BytesIO()
    with tarfile.open(fileobj=tar, mode="w:gz") as archive:
        member = tarfile.TarInfo("tectonic")
        if link:
            member.type = tarfile.SYMTYPE
            member.linkname = "/outside/compiler"
            archive.addfile(member)
        else:
            member.size = len(binary)
            archive.addfile(member, io.BytesIO(binary))
        if extra:
            archive.addfile(tarfile.TarInfo("unexpected"))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(zip_name, tar.getvalue())
    record = {"archive": "compiler.tar.gz", "archiveBytes": len(tar.getvalue()),
              "archiveSha256": hashlib.sha256(tar.getvalue()).hexdigest(),
              "binaryBytes": len(binary), "binarySha256": hashlib.sha256(binary).hexdigest()}
    return output.getvalue(), record, binary


class CompilerProvenance(unittest.TestCase):
    def test_exact_archive_and_runtime_bytes_match(self):
        archive, compiler, runtime = artifact()
        evidence.check_binary(archive, compiler, runtime)

    def test_same_version_with_changed_runtime_is_rejected(self):
        archive, compiler, runtime = artifact()
        with self.assertRaises(ValueError):
            evidence.check_binary(archive, compiler, b"X" + runtime[1:])

    def test_replaced_release_archive_is_rejected(self):
        archive, compiler, runtime = artifact()
        compiler["archiveSha256"] = "0" * 64
        with self.assertRaises(ValueError):
            evidence.check_binary(archive, compiler, runtime)

    def test_replaced_compiler_digest_or_size_is_rejected(self):
        archive, compiler, runtime = artifact()
        for key, value in [("binarySha256", "0" * 64), ("binaryBytes", len(runtime) + 1)]:
            changed = copy.deepcopy(compiler)
            changed[key] = value
            with self.assertRaises(ValueError):
                evidence.check_binary(archive, changed, runtime)

    def test_links_and_unexpected_archive_members_are_rejected(self):
        for options in [{"link": True}, {"extra": True}, {"zip_name": "../compiler.tar.gz"}]:
            archive, compiler, runtime = artifact(**options)
            with self.assertRaises(ValueError):
                evidence.check_binary(archive, compiler, runtime)

    def test_wrong_archive_size_is_rejected_before_reading_contents(self):
        archive, compiler, runtime = artifact()
        compiler["archiveBytes"] += 1
        with self.assertRaises(ValueError):
            evidence.check_binary(archive, compiler, runtime)


if __name__ == "__main__":
    unittest.main()
