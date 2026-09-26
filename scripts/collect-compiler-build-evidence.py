"""Verify retained upstream build evidence against Folio's actual compiler.

Python 3.11+. Read-only toward the app/runtime; all output is an ignored audit
artifact. No network, native compiler execution, source builds or extraction.
"""
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile
import tomllib
import zipfile

spec = importlib.util.spec_from_file_location("materials", Path(__file__).with_name("collect-rust-license-materials.py"))
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)


def check_binary(artifact, compiler, runtime):
    """Match the GitHub artifact, its single archive and the installed executable."""
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        entries = archive.infolist()
        if (len(entries) != 1 or entries[0].filename != compiler["archive"] or
                entries[0].file_size != compiler["archiveBytes"] or
                not 0 < entries[0].file_size <= 64 * 1024 * 1024 or entries[0].flag_bits & 1):
            raise ValueError("Upstream build artifact has unexpected contents")
        content = archive.read(entries[0])
    if materials.digest(content) != compiler["archiveSha256"]:
        raise ValueError("Build artifact differs from the pinned release archive")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        entry = archive.next()
        if (entry is None or entry.name != "tectonic" or not entry.isfile() or
                entry.size != compiler["binaryBytes"] or not 0 < entry.size <= 64 * 1024 * 1024):
            raise ValueError("Release archive has an unexpected compiler member")
        binary = archive.extractfile(entry).read(entry.size + 1)
        if archive.next() is not None:
            raise ValueError("Release archive contains an extra member")
    if len(binary) != compiler["binaryBytes"] or materials.digest(binary) != compiler["binarySha256"]:
        raise ValueError("Release compiler differs from its reviewed digest")
    if binary != runtime:
        raise ValueError("Folio's compiler differs from the upstream build artifact")


def log_ports(log):
    return [{"name": name, "version": version, "features": features.split(",") if features else []}
            for name, features, version in re.findall(
                r"Installing \d+/20 ([\w-]+)(?:\[([^]]+)\])?:arm64-osx@([^\s]+?)\.\.\.", log)]


def main():
    lock_bytes = Path("resources/compiler-build-provenance.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    if lock.get("schemaVersion") != 1:
        raise ValueError("Review the changed compiler-build lock format")
    compiler, upstream, native = lock["compiler"], lock["upstream"], lock["vcpkg"]
    source_lock = json.loads(Path("resources/runtime-license-sources.lock.json").read_bytes())
    source = next(s for s in source_lock["sources"] if s["id"] == "tectonic")
    if source_lock["compilerVersion"] != compiler["version"] or source["commit"] != compiler["sourceCommit"]:
        raise ValueError("Compiler sources changed; review their build evidence")
    cache = Path(".cache/license-sources")
    artifact = materials.verified_bytes(cache / upstream["artifact"]["filename"], upstream["artifact"]["sha256"], upstream["artifact"]["bytes"])
    raw_log = materials.verified_bytes(cache / upstream["log"]["filename"], upstream["log"]["sha256"], upstream["log"]["bytes"])
    runtime = materials.verified_bytes(Path("resources/runtime/mac-arm64/tectonic"), compiler["binarySha256"], compiler["binaryBytes"])
    check_binary(artifact, compiler, runtime)
    source_archive, source_files = materials.archive_files(materials.verified_bytes(cache / source["archive"], source["sha256"], source["bytes"]), "tectonic-" + source["commit"])
    with source_archive:
        manifest = tomllib.loads(materials.read_member(source_archive, source_files["Cargo.toml"]).decode())
    if manifest["package"]["metadata"]["vcpkg"]["rev"] != native["commit"]:
        raise ValueError("Native source revision differs from Tectonic's build manifest")
    log = raw_log.decode("utf-8")
    if log_ports(log) != native["ports"] or len(native["ports"]) != 20:
        raise ValueError("Installed native dependencies differ from the reviewed build log")
    if f'Checkout rev {native["commit"]}' not in log or f'Updating {upstream["runHeadSha"][:8]}..{compiler["sourceCommit"][:8]}' not in log:
        raise ValueError("Build log does not record the reviewed source commits")
    for marker in [f'rustc {upstream["rustc"]} (', f'cargo {upstream["cargo"]} (',
                   f'commit-hash: {upstream["rustcCommit"]}',
                   f'cranko(fetch-latest.sh): downloading version {upstream["cranko"]} ']:
        if marker not in log:
            raise ValueError("Build tool versions differ from the reviewed log")
    output = Path("artifacts/license-materials/compiler-build")
    native_bytes = materials.verified_bytes(cache / native["archive"], native["sha256"], native["bytes"])
    archive, files = materials.archive_files(native_bytes, "vcpkg-" + native["commit"])
    records, ports = [], []
    names = {"LICENSE.txt", "NOTICE.txt", "triplets/arm64-osx.cmake"}
    with archive:
        for port in native["ports"]:
            prefix = "ports/" + port["name"] + "/"
            metadata = json.loads(materials.read_member(archive, files[prefix + "vcpkg.json"]))
            version = next((metadata[k] for k in ("version", "version-semver", "version-date", "version-string") if k in metadata), None)
            if metadata.get("port-version", 0):
                version += "#" + str(metadata["port-version"])
            if metadata["name"] != port["name"] or version != port["version"]:
                raise ValueError("Native port version differs from the actual build log")
            selected = sorted(name for name in files if name.startswith(prefix))
            names.update(selected)
            ports.append({**port, "declaredLicense": metadata.get("license"), "materialFiles": len(selected), "scope": "Installed in the upstream build; does not by itself establish final binary linkage."})
        for name in sorted(names):
            content = materials.read_member(archive, files[name])
            materials.atomic_write(output / "vcpkg-materials" / name, content)
            records.append({"path": name, "bytes": len(content), "sha256": materials.digest(content)})
    materials.atomic_write(output / "upstream-build.log", raw_log)
    report = {"schemaVersion": 1, "scope": lock["scope"], "releaseAuditComplete": False,
              "collectorSha256": materials.digest(Path(__file__).read_bytes()), "lockSha256": materials.digest(lock_bytes),
              "compiler": compiler, "upstream": upstream, "exactArtifactAndRuntimeMatch": True,
              "vcpkg": {**native, "ports": ports, "materials": records},
              "pending": ["Distinguish build-only dependencies from final linked code, and determine enabled Rust features.",
                          "Collect native dependency payload sources and licenses referenced by these verified recipes.",
                          "Complete all compiler/workspace, Biber, TeX/font and final signed-app redistribution materials."]}
    materials.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps({"exactArtifactAndRuntimeMatch": True, "installedNativePorts": len(ports), "materialFiles": len(records), "output": str(output), "releaseAuditComplete": False}, indent=2))


if __name__ == "__main__":
    main()
