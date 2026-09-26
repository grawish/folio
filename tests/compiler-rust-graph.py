"""Offline controls for Cargo audit provenance, archive paths and graph scope."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("graph_audit", Path(__file__).resolve().parent.parent / "scripts/resolve-compiler-rust-graph.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def fixture():
    ids = ["tectonic", "helper", "workspace-only"]
    metadata = {"packages": [{"id": name, "name": name, "version": "1.0.0", "source": None if name != "helper" else audit.REGISTRY} for name in ids]}
    locked = {(p["name"], p["version"]): {"name": p["name"], "version": p["version"], **({"source": p["source"], "checksum": "a" * 64} if p["source"] else {})} for p in metadata["packages"]}
    def unit(name, platform, kind, features, deps):
        return {"pkg_id": name, "platform": platform, "mode": "build", "features": features,
                "target": {"kind": [kind], "name": name}, "dependencies": [{"index": i} for i in deps]}
    graph = {"version": 1, "roots": [0, 3], "units": [
        unit("tectonic", audit.TARGET, "bin", ["default"], [1, 2]),
        unit("helper", audit.TARGET, "lib", ["runtime"], []),
        unit("helper", None, "proc-macro", ["build"], []),
        unit("workspace-only", audit.TARGET, "lib", [], []),
    ]}
    compiled = set(locked)
    locked[("unselected", "1.0.0")] = {"name": "unselected", "version": "1.0.0", "source": audit.REGISTRY, "checksum": "b" * 64}
    return graph, metadata, locked, compiled


class CompilerGraph(unittest.TestCase):
    def test_scope_keeps_host_target_features_and_workspace_only_separate(self):
        result = audit.analyze_graph(*fixture())
        helper = next(p for p in result["packages"] if p["name"] == "helper")
        self.assertEqual([u["features"] for u in helper["tectonicUnits"]], [["runtime"], ["build"]])
        self.assertEqual(result["tectonicUnitCount"], 3)
        self.assertEqual(next(p for p in result["packages"] if p["name"] == "workspace-only")["tectonicUnits"], [])
        self.assertEqual(result["notSelectedFromLock"], [{"name": "unselected", "version": "1.0.0", "source": audit.REGISTRY}])

    def test_changed_package_source_or_version_fails(self):
        for field, changed in [("source", None), ("version", "2.0.0")]:
            graph, metadata, locked, compiled = fixture()
            metadata["packages"][1][field] = changed
            with self.assertRaisesRegex(ValueError, "locked source"):
                audit.analyze_graph(graph, metadata, locked, compiled)

    def test_unmatched_upstream_build_set_fails(self):
        for change in ("missing", "extra"):
            graph, metadata, locked, compiled = fixture()
            if change == "missing": compiled.remove(("helper", "1.0.0"))
            else: compiled.add(("unexpected", "1.0.0"))
            with self.assertRaisesRegex(ValueError, "differ from upstream"):
                audit.analyze_graph(graph, metadata, locked, compiled)

    def test_other_target_test_mode_or_invalid_edges_fail(self):
        for field, changed in [("platform", "x86_64-pc-windows-msvc"), ("mode", "test"), ("dependencies", [{"index": -1}])]:
            graph, metadata, locked, compiled = fixture()
            graph["units"][0][field] = changed
            with self.assertRaises(ValueError):
                audit.analyze_graph(graph, metadata, locked, compiled)
        graph, metadata, locked, compiled = fixture()
        graph["roots"] = [999]
        with self.assertRaisesRegex(ValueError, "root index"):
            audit.analyze_graph(graph, metadata, locked, compiled)

    def test_build_log_excludes_tools_and_later_tests(self):
        command = "cargo build --workspace"
        log = '\n'.join([
            'time ##[group]Run install tool', 'time Compiling tool v2.0.0',
            'time ##[group]Run cargo build --workspace',
            'time    Compiling tectonic v1.0.0 (/workspace)',
            'time    Compiling helper v1.0.0',
            'time    Finished `release` profile [optimized] target(s) in 1s',
            'time ##[group]Run cargo test', 'time Compiling test-only v3.0.0',
        ])
        self.assertEqual(audit.compiled_packages(log, command), {("tectonic", "1.0.0"), ("helper", "1.0.0")})
        with self.assertRaises(ValueError): audit.compiled_packages(log.replace('Finished', 'Failed'), command)
        with self.assertRaises(ValueError): audit.compiled_packages(log + '\ntime ##[group]Run ' + command, command)

    def test_locked_bytes_size_and_symlinks_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source"
            path.write_bytes(b"correct")
            checksum = audit.sha(b"correct")
            self.assertEqual(audit.read_locked(path, checksum, 7), b"correct")
            with self.assertRaises(ValueError): audit.read_locked(path, checksum, 6)
            with self.assertRaises(ValueError): audit.read_locked(path, "a" * 64, 7)
            link = Path(folder) / "link"; link.symlink_to(path)
            with self.assertRaises(ValueError): audit.read_locked(link, checksum, 7)

    def test_unpack_rejects_links_escape_and_case_collisions(self):
        for names in [["root/../escaped"], ["root/LICENSE", "root/license"], ["root/link"]]:
            with tempfile.TemporaryDirectory() as folder:
                archive_path = Path(folder) / "input.tar.gz"
                with tarfile.open(archive_path, "w:gz") as archive:
                    for name in names:
                        member = tarfile.TarInfo(name)
                        if name.endswith('/link'):
                            member.type = tarfile.SYMTYPE; member.linkname = "../../escaped"
                            archive.addfile(member)
                        else:
                            member.size = 5; archive.addfile(member, io.BytesIO(b"bytes"))
                with self.assertRaises(ValueError):
                    audit.unpack(archive_path, "root", Path(folder) / "output")
                self.assertFalse((Path(folder) / "escaped").exists())

    def test_notice_mapping_requires_real_matching_texts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            report = audit.analyze_graph(*fixture())
            report.update({"sourceCommit": "c" * 40, "cargoLockSha256": "d" * 64})
            notice = root / "packages/helper-1.0.0/materials/LICENSE"
            notice.parent.mkdir(parents=True); notice.write_bytes(b"original")
            package = {"name": "helper", "version": "1.0.0", "checksum": "a" * 64, "declaredLicense": "MIT",
                "noticeFiles": ["LICENSE"], "materials": [{"path": "LICENSE", "sha256": audit.sha(b"original"), "bytes": 8}]}
            inventory = {"tectonic": {"commit": "c" * 40, "cargoLockSha256": "d" * 64}, "registryCollectionComplete": True, "packages": [package]}
            path = root / "inventory.json"; path.write_text(json.dumps(inventory))
            self.assertEqual(audit.match_notices(report, path)["noticeFileCount"], 1)
            notice.write_bytes(b"modified")
            with self.assertRaises(ValueError): audit.match_notices(report, path)
            notice.write_bytes(b"original")
            for field, value in [("checksum", "b" * 64), ("noticeFiles", [])]:
                changed = copy.deepcopy(inventory); changed["packages"][0][field] = value
                path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError): audit.match_notices(report, path)


if __name__ == "__main__":
    unittest.main()
