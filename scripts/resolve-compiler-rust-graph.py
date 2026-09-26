"""Resolve Tectonic's Apple silicon Cargo units without compiling dependencies.

Requires macOS arm64, Python 3.11+, and the existing verified source caches.
The official upstream toolchain is installed only in a temporary audit directory.
RUSTC_BOOTSTRAP enables Cargo's diagnostic unit-graph output, not a real build.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tarfile
import tempfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("rust_materials", ROOT / "scripts/collect-rust-license-materials.py")
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)
TARGET = "aarch64-apple-darwin"
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_locked(path, checksum, size=None, maximum=512 * 1024 * 1024):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValueError(f"Invalid audit input: {path.name}")
    data = path.read_bytes()
    if (size is not None and len(data) != size) or sha(data) != checksum:
        raise ValueError(f"Audit input differs from lock: {path.name}")
    return data


def write_json(path, value):
    materials.atomic_write(path, (json.dumps(value, indent=2) + "\n").encode())


def unpack(archive_path, root, output, prefix="", executable=False):
    """Write bounded regular files to a new, private directory; never make links."""
    output.mkdir(parents=True, exist_ok=True)
    hashes, seen, total = {}, set(), 0
    with tarfile.open(archive_path) as archive:
        for count, member in enumerate(archive, 1):
            relative = materials.safe_member(member.name.rstrip("/") if member.isdir() else member.name, root)
            key = relative.casefold()
            total += member.size
            if key in seen or count > 40_000 or not 0 <= member.size <= 512 * 1024 * 1024 or total > 1024 * 1024 * 1024:
                raise ValueError("Duplicate or oversized audit archive member")
            seen.add(key)
            if not (member.isdir() or member.isfile()):
                raise ValueError("Audit archive contains a link or special file")
            if member.isdir() or (prefix and not relative.startswith(prefix + "/")):
                continue
            relative = relative[len(prefix) + 1:] if prefix else relative
            # Each official component has its own installer manifest; it is
            # retained in the archive, not a file in the combined tool prefix.
            if executable and relative == "manifest.in":
                continue
            target = output / relative
            for parent in [target, *target.parents]:
                if parent.is_symlink():
                    raise ValueError("Audit output uses a symbolic link")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = archive.extractfile(member).read(member.size + 1)
            if len(data) != member.size:
                raise ValueError("Truncated audit archive member")
            with target.open("xb") as handle:
                handle.write(data)
            if executable and member.mode & 0o111:
                target.chmod(0o700)
            hashes[relative] = sha(data)
    return hashes


def toolchain_archives(lock, offline):
    paths = []
    cache = ROOT / ".cache/compiler-audit/toolchain-archives"
    for entry in lock["components"]:
        expected = f'https://static.rust-lang.org/dist/2026-07-16/{entry["archive"]}'
        if entry["url"] != expected or not re.fullmatch(r"(?:cargo|rustc|rust-std)-1\.97\.1-aarch64-apple-darwin\.tar\.xz", entry["archive"]):
            raise ValueError("Unreviewed toolchain URL")
        destination = cache / entry["archive"]
        if not destination.exists():
            if offline:
                raise ValueError(f'Missing offline toolchain: {entry["archive"]}')
            with urllib.request.urlopen(entry["url"], timeout=60) as response:
                if response.url != entry["url"]:
                    raise ValueError("Unexpected toolchain redirect")
                data = response.read(entry["bytes"] + 1)
            if len(data) != entry["bytes"] or sha(data) != entry["sha256"]:
                raise ValueError("Downloaded toolchain differs from reviewed lock")
            materials.atomic_write(destination, data)
        read_locked(destination, entry["sha256"], entry["bytes"])
        paths.append((entry, destination))
    return paths


def compiled_packages(log, command):
    """Only the release-build step: exclude tool installation and later tests."""
    lines = re.sub(r"\x1b\[[0-9;]*m", "", log).splitlines()
    starts = [i for i, line in enumerate(lines) if "##[group]Run " + command in line]
    if len(starts) != 1:
        raise ValueError("Cannot identify the single upstream release-build step")
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines)) if "##[group]" in lines[i]), len(lines))
    block = lines[start:end]
    if not any("Finished `release` profile [optimized]" in line for line in block):
        raise ValueError("Upstream release-build step did not finish")
    packages = set()
    for line in block:
        match = re.search(r"\sCompiling ([A-Za-z0-9_-]+) v([0-9A-Za-z.+-]+)(?:\s|$)", line)
        if match:
            packages.add((match[1], match[2]))
    if not packages:
        raise ValueError("No compiled packages in upstream release build")
    return packages


def analyze_graph(graph, metadata, locked, compiled):
    if graph.get("version") != 1:
        raise ValueError("Unreviewed Cargo unit-graph format")
    packages = {p["id"]: p for p in metadata["packages"]}
    units = graph["units"]
    if not units or len(units) > 10_000:
        raise ValueError("Invalid Cargo unit count")
    observed = set()
    if any(type(i) is not int or not 0 <= i < len(units) for i in graph["roots"]):
        raise ValueError("Invalid Cargo root index")
    for unit in units:
        package = packages[unit["pkg_id"]]
        identity = (package["name"], package["version"])
        if identity not in locked or package["source"] != locked[identity].get("source"):
            raise ValueError("Resolved package is not the locked source identity")
        if unit["platform"] not in (None, TARGET) or unit["mode"] not in ("build", "run-custom-build"):
            raise ValueError("Unexpected target or compilation mode")
        observed.add(identity)
        for dep in unit["dependencies"]:
            index = dep["index"]
            if type(index) is not int or not 0 <= index < len(units):
                raise ValueError("Invalid Cargo dependency index")
    if observed != compiled:
        raise ValueError(f"Cargo units differ from upstream build: only resolved={sorted(observed - compiled)}, only compiled={sorted(compiled - observed)}")
    roots = [i for i in graph["roots"] if units[i]["target"]["kind"] == ["bin"] and
             units[i]["target"]["name"] == "tectonic" and packages[units[i]["pkg_id"]]["name"] == "tectonic"]
    if len(roots) != 1:
        raise ValueError("Expected one Tectonic executable root")
    closure, pending = set(), roots.copy()
    while pending:
        index = pending.pop()
        if index not in closure:
            closure.add(index)
            pending.extend(dep["index"] for dep in units[index]["dependencies"])
    records = {}
    for i, unit in enumerate(units):
        package = packages[unit["pkg_id"]]
        identity = (package["name"], package["version"])
        entry = records.setdefault(identity, {"name": identity[0], "version": identity[1],
            "source": package["source"], "checksum": locked[identity].get("checksum"), "units": [], "tectonicUnits": []})
        detail = {"index": i, "kind": unit["target"]["kind"], "mode": unit["mode"],
                  "platform": unit["platform"], "features": unit["features"]}
        entry["units"].append(detail)
        if i in closure:
            entry["tectonicUnits"].append(detail)
    return {"unitCount": len(units), "tectonicRoot": roots[0], "tectonicUnitCount": len(closure),
            "upstreamCompiledPackageCount": len(compiled), "packages": [records[k] for k in sorted(records)],
            "notSelectedFromLock": [{"name": k[0], "version": k[1], "source": locked[k].get("source")} for k in sorted(locked.keys() - observed)]}


def match_notices(report, inventory_path):
    """Bind every selected registry package to retained, byte-checked notices."""
    inventory_bytes = inventory_path.read_bytes()
    inventory = json.loads(inventory_bytes)
    if (inventory["tectonic"]["commit"] != report["sourceCommit"] or
            inventory["tectonic"]["cargoLockSha256"] != report["cargoLockSha256"] or
            not inventory.get("registryCollectionComplete")):
        raise ValueError("Rust notice inventory is not for this complete source collection")
    packages = {(p["name"], p["version"]): p for p in inventory["packages"]}
    selected = []
    for package in report["packages"]:
        if package["source"] is None:
            continue
        collected = packages[(package["name"], package["version"])]
        if package["checksum"] != collected["checksum"]:
            raise ValueError("Selected notice package checksum differs from Cargo.lock")
        directory = inventory_path.parent / "packages" / f'{package["name"]}-{package["version"]}'
        records = []
        expected = {r["path"]: r for r in collected["materials"]}
        for name in collected["noticeFiles"]:
            material = expected[name]
            relative = materials.safe_member("notice/" + name, "notice")
            path = directory / "materials" / relative
            read_locked(path, material["sha256"], material["bytes"])
            records.append({**material, "path": str(path.relative_to(inventory_path.parent))})
        for material in collected.get("upstreamNotices", {}).get("materials", []):
            relative = materials.safe_member("notice/" + material["path"], "notice")
            path = directory / "upstream-notices" / relative
            read_locked(path, material["sha256"], material["bytes"])
            records.append({"path": str(path.relative_to(inventory_path.parent)), "bytes": material["bytes"], "sha256": material["sha256"]})
        if not records:
            raise ValueError("Selected registry package has no retained notice text")
        selected.append({"name": package["name"], "version": package["version"], "checksum": package["checksum"],
                         "declaredLicense": collected["declaredLicense"], "inTectonicBuildClosure": bool(package["tectonicUnits"]),
                         "materials": records})
    return {"scope": "Notice paths are relative to the compiler-rust inventory directory. License expressions are upstream declarations, not an adjudication of terms.",
            "sourceInventorySha256": sha(inventory_bytes), "packages": selected,
            "registryPackageCount": len(selected), "tectonicRegistryPackageCount": sum(p["inTectonicBuildClosure"] for p in selected),
            "noticeFileCount": sum(len(p["materials"]) for p in selected)}


def run_audit(offline, output):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("This audit requires native Apple silicon macOS, matching the upstream host")
    lock_path = ROOT / "resources/compiler-rust-graph.lock.json"
    lock = json.loads(lock_path.read_bytes())
    if (lock["upstreamBuildArgs"] != ["build", "--workspace", "--target", TARGET, "--release", "--features", ""] or
            lock["diagnosticArgs"] != ["--frozen", "--unit-graph", "-Z", "unstable-options"] or
            lock["diagnosticEnvironment"] != {"RUSTC_BOOTSTRAP": "1"} or
            lock["buildEnvironment"] != {"TECTONIC_DEP_BACKEND": "vcpkg", "CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_DEBUG": "true"}):
        raise ValueError("Only the reviewed diagnostic command/environment is allowed")
    build = json.loads((ROOT / "resources/compiler-build-provenance.lock.json").read_bytes())
    source_lock = json.loads((ROOT / "resources/runtime-license-sources.lock.json").read_bytes())
    source = next(s for s in source_lock["sources"] if s["id"] == "tectonic")
    if (lock["schemaVersion"] != 1 or lock["target"] != TARGET or
            lock["toolchainVersion"] != build["upstream"]["cargo"] or lock["toolchainVersion"] != build["upstream"]["rustc"] or
            lock["rustcCommit"] != build["upstream"]["rustcCommit"] or source["commit"] != build["compiler"]["sourceCommit"]):
        raise ValueError("Toolchain/source differs from verified build provenance")
    source_archive = ROOT / ".cache/license-sources" / source["archive"]
    read_locked(source_archive, source["sha256"], source["bytes"])
    log_entry = build["upstream"]["log"]
    log = read_locked(ROOT / ".cache/license-sources" / log_entry["filename"], log_entry["sha256"], log_entry["bytes"]).decode()
    command = 'cargo build --workspace --target aarch64-apple-darwin --release --features "" $CARGO_VERBOSE'
    compiled = compiled_packages(log, command)
    components = toolchain_archives(lock, offline)
    with tempfile.TemporaryDirectory(prefix="folio-cargo-audit-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        for ancestor in base.parents:
            if any((ancestor / ".cargo" / name).exists() for name in ("config", "config.toml")):
                raise ValueError("Audit directory would inherit an external Cargo configuration")
        toolchain, workspace, vendor = base / "toolchain", base / "source", base / "vendor"
        for entry, path in components:
            unpack(path, entry["archiveRoot"], toolchain, entry["componentRoot"], executable=True)
        unpack(source_archive, "tectonic-" + source["commit"], workspace)
        if (workspace / ".cargo").exists():
            raise ValueError("Review upstream Cargo configuration before running diagnostics")
        cargo_lock = (workspace / "Cargo.lock").read_bytes()
        locked = {(p["name"], p["version"]): p for p in tomllib.loads(cargo_lock.decode())["package"]}
        for identity, package in locked.items():
            if "source" not in package:
                continue
            if package["source"] != REGISTRY:
                raise ValueError("Unreviewed dependency source")
            name = "-".join(identity)
            path = ROOT / ".cache/license-sources/rust" / (name + ".crate")
            read_locked(path, package["checksum"], maximum=materials.MAX_ARCHIVE)
            hashes = unpack(path, name, vendor / name)
            write_json(vendor / name / ".cargo-checksum.json", {"package": package["checksum"], "files": hashes})
        cargo_home = base / "cargo-home"
        cargo_home.mkdir()
        (cargo_home / "config.toml").write_text('[source.crates-io]\nreplace-with="verified-vendor"\n[source.verified-vendor]\ndirectory=' + json.dumps(str(vendor)) + '\n[net]\noffline=true\n')
        env = {"PATH": str(toolchain / "bin") + ":/usr/bin:/bin", "CARGO_HOME": str(cargo_home),
               "RUSTC": str(toolchain / "bin/rustc"), "CARGO_TARGET_DIR": str(base / "target"),
               "LC_ALL": "C", "CARGO_TERM_COLOR": "never", **lock["buildEnvironment"]}
        def invoke(args, diagnostic=False):
            result = subprocess.run(args, cwd=workspace, env={**env, **(lock["diagnosticEnvironment"] if diagnostic else {})},
                                    capture_output=True, timeout=180, check=True)
            return result.stdout, result.stderr
        cargo = str(toolchain / "bin/cargo")
        versions = {}
        for program in ("cargo", "rustc"):
            versions[program] = invoke([str(toolchain / "bin" / program), "-vV"])[0].decode()
        if ("release: 1.97.1\n" not in versions["cargo"] or "release: 1.97.1\n" not in versions["rustc"] or
                "commit-hash: " + lock["cargoCommit"] not in versions["cargo"] or
                "commit-hash: " + lock["rustcCommit"] not in versions["rustc"] or
                any("host: " + TARGET not in value for value in versions.values())):
            raise ValueError("Official executable toolchain identity differs from upstream")
        tree_args = [cargo, "tree", "--workspace", "--target", TARGET, "--features", "", "--frozen", "--edges", "normal,build", "--prefix", "none", "--format", "{p}|{f}"]
        tree, tree_err = invoke(tree_args)
        diagnostic_tree, diagnostic_tree_err = invoke(tree_args, diagnostic=True)
        if tree != diagnostic_tree or tree_err != diagnostic_tree_err:
            raise ValueError("Diagnostic channel override changes the stable Cargo tree")
        metadata, metadata_err = invoke([cargo, "metadata", "--format-version", "1", "--frozen", "--filter-platform", TARGET])
        graph, graph_err = invoke([cargo, *lock["upstreamBuildArgs"], *lock["diagnosticArgs"]], diagnostic=True)
        if (workspace / "Cargo.lock").read_bytes() != cargo_lock:
            raise ValueError("Cargo changed its locked inputs")
        compiled_outputs = [p for p in (base / "target").rglob("*") if p.is_file() and p.name not in ("CACHEDIR.TAG", ".rustc_info.json", ".cargo-lock")]
        if compiled_outputs:
            raise ValueError("Unexpected compiled output from a diagnostic-only run")
        report = analyze_graph(json.loads(graph), json.loads(metadata), locked, compiled)
        report.update({"schemaVersion": 1, "scope": lock["scope"], "releaseAuditComplete": False,
            "collectorSha256": sha(Path(__file__).read_bytes()), "graphLockSha256": sha(lock_path.read_bytes()),
            "sourceCommit": source["commit"], "cargoLockSha256": sha(cargo_lock), "upstreamLogSha256": log_entry["sha256"],
            "toolchain": versions, "buildArgs": lock["upstreamBuildArgs"], "diagnosticArgs": lock["diagnosticArgs"],
            "diagnosticEnvironment": lock["diagnosticEnvironment"], "buildEnvironment": lock["buildEnvironment"],
            "stableTreeMatchesDiagnosticTree": True, "upstreamCompiledPackagesMatch": True,
            "compiledDependencyCode": False, "evidence": []})
        notices = match_notices(report, ROOT / "artifacts/license-materials/compiler-rust/inventory.json")
        report["notices"] = {k: v for k, v in notices.items() if k != "packages"}
        for name, data in [("unit-graph.json", graph), ("metadata.json", metadata), ("cargo-tree.txt", tree),
                           ("diagnostics.txt", tree_err + metadata_err + graph_err),
                           ("selected-notices.json", (json.dumps(notices, indent=2) + "\n").encode())]:
            # Relocate disposable audit paths for portable, deterministic evidence.
            data = data.replace(str(base).encode(), b"/FOLIO_COMPILER_AUDIT")
            materials.atomic_write(output / name, data)
            report["evidence"].append({"path": name, "bytes": len(data), "sha256": sha(data)})
        write_json(output / "inventory.json", report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Require already cached official toolchain archives")
    args = parser.parse_args()
    output = ROOT / "artifacts/license-materials/compiler-rust-graph"
    try:
        report = run_audit(args.offline, output)
    except Exception as error:
        message = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            message += "\n" + error.stderr.decode(errors="replace")
        write_json(output / "incomplete-inventory.json", {"releaseAuditComplete": False, "error": message})
        raise
    print(json.dumps({"packages": len(report["packages"]), "units": report["unitCount"],
        "tectonicUnits": report["tectonicUnitCount"], "notSelectedFromLock": len(report["notSelectedFromLock"]),
        "upstreamCompiledPackagesMatch": report["upstreamCompiledPackagesMatch"]}, indent=2))


if __name__ == "__main__":
    main()
