"""Retain the exact Rust standard-library sources, notices and binary inventory.

Reads verified archives in memory. Never extracts paths or executes upstream code.
Requires Python 3.11+. Full source archives include non-Mac/test code too.
"""
import argparse
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("rust_materials", ROOT / "scripts/collect-rust-license-materials.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
SOURCE_PREFIX = "rust-src/lib/rustlib/src/rust/"


def get_input(entry, offline):
    if (not re.fullmatch(r"[a-z0-9.-]+", entry["archive"]) or
            entry["url"] not in {"https://static.rust-lang.org/dist/2026-07-16/" + entry["archive"],
                                 "https://static.rust-lang.org/dist/" + entry["archive"]} or
            not 0 < entry["bytes"] <= 64 * 1024 * 1024):
        raise ValueError("Invalid standard-library input URL or bounds")
    path = ROOT / ".cache/compiler-audit/toolchain-archives" / entry["archive"]
    if not path.exists():
        if offline:
            raise ValueError("Missing offline standard-library input: " + entry["archive"])
        with urllib.request.urlopen(entry["url"], timeout=60) as response:
            if response.url != entry["url"]:
                raise ValueError("Unexpected standard-library source redirect")
            data = response.read(entry["bytes"] + 1)
        if len(data) != entry["bytes"] or shared.digest(data) != entry["sha256"]:
            raise ValueError("Downloaded standard-library input differs from lock")
        shared.atomic_write(path, data)
    return shared.verified_bytes(path, entry["sha256"], entry["bytes"])


def members(data, root):
    files, seen, total = {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
        for count, member in enumerate(archive, 1):
            name = shared.safe_member(member.name.rstrip("/") if member.isdir() else member.name, root)
            total += member.size
            if (count > 20_000 or total > 512 * 1024 * 1024 or not 0 <= member.size <= 256 * 1024 * 1024 or
                    name.casefold() in seen or not (member.isfile() or member.isdir())):
                raise ValueError("Unsafe or oversized standard-library archive member")
            seen.add(name.casefold())
            if member.isfile():
                content = archive.extractfile(member).read(member.size + 1)
                if len(content) != member.size:
                    raise ValueError("Truncated standard-library archive member")
                files[name] = content
    return files


def check_identity(files, version, commit):
    if (files["git-commit-hash"].decode().strip() != commit or
            not files["version"].decode().startswith(version + " (")):
        raise ValueError("Standard-library component has a different compiler identity")
    for required in ("LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT"):
        if not files.get(required):
            raise ValueError("Standard-library root notice is missing")


def source_inventory(files):
    prefix = SOURCE_PREFIX + "library/"
    cargo_lock = tomllib.loads(files[prefix + "Cargo.lock"].decode())
    if cargo_lock["version"] != 4:
        raise ValueError("Review changed standard-library lockfile format")
    locked = {(p["name"], p["version"]): p for p in cargo_lock["package"]}
    manifests = {}
    for name, content in files.items():
        if not name.startswith(prefix) or not name.endswith("/Cargo.toml"):
            continue
        package = tomllib.loads(content.decode()).get("package")
        if not package or not isinstance(package.get("version"), str):
            continue
        manifests.setdefault((package["name"], package["version"]), []).append(name)
    vendors = []
    for identity, package in locked.items():
        if "source" not in package:
            continue
        if package["source"] != shared.REGISTRY:
            raise ValueError("Unreviewed standard-library registry")
        directory = prefix + "vendor/" + "-".join(identity) + "/"
        checksum = json.loads(files[directory + ".cargo-checksum.json"])
        if checksum["package"] != package["checksum"]:
            raise ValueError("Vendored standard-library package checksum differs from lock")
        for relative, digest in checksum["files"].items():
            shared.safe_member("vendor/" + relative, "vendor")
            if shared.digest(files[directory + relative]) != digest:
                raise ValueError("Vendored standard-library source file checksum mismatch")
        manifest = tomllib.loads(files[directory + "Cargo.toml"].decode())["package"]
        if (manifest["name"], manifest["version"]) != identity:
            raise ValueError("Vendored standard-library package identity mismatch")
        notices = sorted(n for n in files if n.startswith(directory) and shared.NOTICE.fullmatch(PurePosixPath(n).name))
        vendors.append({"name": identity[0], "version": identity[1], "checksum": package["checksum"],
                        "declaredLicense": manifest.get("license"), "noticeFiles": notices,
                        "verifiedFileCount": len(checksum["files"])})
    return {"lockSha256": shared.digest(files[prefix + "Cargo.lock"]), "lockedPackages": list(locked.values()),
            "vendorPackages": sorted(vendors, key=lambda p: (p["name"], p["version"]))}, manifests


def binary_inventory(files, source, manifests):
    locked = {}
    for package in source["lockedPackages"]:
        key = package["name"].replace("-", "_")
        if key in locked:
            raise ValueError("Ambiguous standard-library package name")
        locked[key] = package
    result = []
    for name, content in sorted(files.items()):
        if not name.endswith(".rlib"):
            continue
        match = re.fullmatch(r"lib([A-Za-z0-9_]+)-([a-f0-9]{16})\.rlib", PurePosixPath(name).name)
        if not match or match[1] not in locked:
            raise ValueError("Unrecognized prebuilt standard-library archive")
        package = locked[match[1]]
        candidates = manifests.get((package["name"], package["version"]), [])
        if not candidates:
            raise ValueError("No source manifest for a prebuilt standard-library package")
        result.append({"name": package["name"], "version": package["version"], "registry": "source" in package,
                       "path": name, "bytes": len(content), "sha256": shared.digest(content), "sourceManifests": sorted(candidates)})
    if not result:
        raise ValueError("No standard-library binary archives")
    selected = {p["name"] for p in result if p["registry"]}
    if any(not p["noticeFiles"] for p in source["vendorPackages"] if p["name"] in selected):
        raise ValueError("A prebuilt registry package has no collected notice text")
    return result


def collect(offline, output):
    lock_bytes = (ROOT / "resources/rust-standard-library.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    build = json.loads((ROOT / "resources/compiler-build-provenance.lock.json").read_bytes())
    graph = json.loads((ROOT / "resources/compiler-rust-graph.lock.json").read_bytes())
    if (lock["schemaVersion"] != 1 or lock["version"] != build["upstream"]["rustc"] or
            lock["rustcCommit"] != build["upstream"]["rustcCommit"] or lock["target"] != build["compiler"]["target"]):
        raise ValueError("Standard-library lock differs from original compiler build")
    manifest_bytes = get_input(lock["manifest"], offline)
    manifest = tomllib.loads(manifest_bytes.decode())
    collections, inputs = {}, []
    for entry in lock["sources"]:
        upstream = manifest["pkg"][entry["id"]]
        target = upstream["target"]["*" if entry["id"] == "rust-src" else lock["target"]]
        if upstream["git_commit_hash"] != lock["rustcCommit"] or (entry["url"], entry["sha256"]) != (target["xz_url"], target["xz_hash"]):
            raise ValueError("Standard-library archive differs from official release manifest")
        if entry["id"] == "rust-std":
            original = next(c for c in graph["components"] if c["component"] == "rust-std")
            if any(entry[k] != original[k] for k in ("url", "sha256", "bytes")):
                raise ValueError("Standard-library archive differs from Cargo audit toolchain")
        data = get_input(entry, offline)
        files = members(data, entry["root"])
        check_identity(files, lock["version"], lock["rustcCommit"])
        collections[entry["id"]] = files
        selected = sorted(n for n in files if shared.NOTICE.fullmatch(PurePosixPath(n).name) or
                          PurePosixPath(n).name in {"Cargo.toml", "Cargo.toml.orig", "Cargo.lock", ".cargo-checksum.json", "git-commit-hash", "git-commit-info", "version", "builder-config"})
        records = []
        for name in selected:
            content = files[name]
            shared.atomic_write(output / entry["id"] / "materials" / name, content)
            records.append({"path": name, "bytes": len(content), "sha256": shared.digest(content),
                            "notice": bool(shared.NOTICE.fullmatch(PurePosixPath(name).name))})
        shared.atomic_write(output / entry["archive"], data)
        inputs.append({**entry, "materials": records})
    source, manifests = source_inventory(collections["rust-src"])
    binaries = binary_inventory(collections["rust-std"], source, manifests)
    binary = shared.verified_bytes(ROOT / "resources/runtime/mac-arm64/tectonic", build["compiler"]["binarySha256"], build["compiler"]["binaryBytes"])
    embedded = sorted(set(m.decode() for m in re.findall(rb"/rustc/([a-f0-9]{40})/", binary)))
    if embedded != [lock["rustcCommit"]]:
        raise ValueError("Compiler binary's embedded Rust source identity differs")
    report = {"schemaVersion": 1, "scope": lock["scope"], "releaseAuditComplete": False,
              "collectorSha256": shared.digest(Path(__file__).read_bytes()), "lockSha256": shared.digest(lock_bytes),
              "manifestSha256": shared.digest(manifest_bytes), "compilerBinarySha256": build["compiler"]["binarySha256"],
              "embeddedRustcCommits": embedded, "sources": inputs, "source": source, "prebuiltLibraries": binaries,
              "summary": {"archives": len(inputs), "archiveBytes": sum(i["bytes"] for i in inputs),
                          "noticeFiles": sum(r["notice"] for i in inputs for r in i["materials"]),
                          "vendorPackages": len(source["vendorPackages"]), "verifiedVendorFiles": sum(p["verifiedFileCount"] for p in source["vendorPackages"]),
                          "prebuiltLibraries": len(binaries), "prebuiltRegistryPackages": sum(p["registry"] for p in binaries)},
              "remaining": ["These prebuilt libraries include test/compiler support that may not be linked into Tectonic; complete final binary component mapping.",
                            "Complete native/workspace, Biber/Perl and TeX/font review and final app SBOM/notices."]}
    shared.atomic_write(output / lock["manifest"]["archive"], manifest_bytes)
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    output = ROOT / "artifacts/license-materials/rust-standard-library"
    try:
        report = collect(args.offline, output)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode())
        raise
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
