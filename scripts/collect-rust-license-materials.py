"""Collect checksum-locked Rust sources and notices; never build or extract code.

Requires Python 3.11+. This is a developer inventory of the complete upstream
Cargo.lock, including unused platforms/features, not a final binary SBOM.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_MEMBER = 8 * 1024 * 1024
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
NOTICE = re.compile(r"^(licen[cs]e|copying|copyright|notice|authors)([._-].*)?$", re.I)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified_bytes(filename, checksum, expected_size=None):
    filename = Path(filename)
    stat = filename.lstat()
    if filename.is_symlink() or not filename.is_file() or stat.st_size > MAX_ARCHIVE:
        raise ValueError(f"Invalid source archive: {filename.name}")
    data = filename.read_bytes()
    if expected_size is not None and len(data) != expected_size:
        raise ValueError(f"Locked archive size mismatch: {filename.name}")
    if digest(data) != checksum:
        raise ValueError(f"Locked archive checksum mismatch: {filename.name}")
    return data


def safe_member(name, root):
    parts = name.split("/")
    if (not name or "\\" in name or name.startswith("/") or
            any(p in ("", ".", "..") for p in parts) or parts[0] != root):
        raise ValueError(f"Unexpected archive member: {name}")
    return "/".join(parts[1:])


def archive_files(data, root):
    # No extract/extractall call: links and paths never reach the filesystem.
    archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    files = {}
    expanded = 0
    for count, member in enumerate(archive, 1):
        if count > 30_000:
            raise ValueError("Too many archive entries")
        relative = safe_member(member.name.rstrip("/") if member.isdir() else member.name, root)
        expanded += member.size
        if expanded > MAX_EXPANDED or member.size < 0:
            raise ValueError("Archive exceeds the expanded-byte budget")
        if not member.isdir():
            if relative in files:
                raise ValueError("Duplicate archive member")
            files[relative] = member
    return archive, files


def read_member(archive, member):
    if not member.isfile() or member.size > MAX_MEMBER:
        raise ValueError(f"Material is not a bounded regular file: {member.name}")
    handle = archive.extractfile(member)
    if handle is None:
        raise ValueError(f"Missing archive material: {member.name}")
    data = handle.read(MAX_MEMBER + 1)
    if len(data) != member.size or len(data) > MAX_MEMBER:
        raise ValueError(f"Material size mismatch: {member.name}")
    return data


def crate_materials(data, name, version):
    archive, files = archive_files(data, f"{name}-{version}")
    with archive:
        manifest_bytes = read_member(archive, files["Cargo.toml"])
        package = tomllib.loads(manifest_bytes.decode("utf-8"))["package"]
        if package.get("name") != name or package.get("version") != version:
            raise ValueError("Package identity differs from Cargo.lock")
        names = {p for p in files if NOTICE.fullmatch(PurePosixPath(p).name)}
        declared_file = package.get("license-file")
        if declared_file:
            if not isinstance(declared_file, str):
                raise ValueError("Invalid declared license file")
            # The reference is relative to the crate root, not an arbitrary path.
            safe_member(f"{name}-{version}/{declared_file}", f"{name}-{version}")
            if declared_file not in files:
                raise ValueError("Declared license file is absent from the crate")
            names.add(declared_file)
        notices = sorted(names)
        names.update(p for p in ("Cargo.toml", "Cargo.toml.orig", ".cargo_vcs_info.json") if p in files)
        materials = {p: read_member(archive, files[p]) for p in sorted(names)}
        if sum(len(v) for v in materials.values()) > 16 * 1024 * 1024:
            raise ValueError("Selected notice materials exceed the byte budget")
        return {
            "declaredLicense": package.get("license"),
            "declaredLicenseFile": declared_file,
            "repository": package.get("repository"),
            "noticeFiles": notices,
            "state": "texts-collected" if notices else "license-text-review-needed",
        }, materials


def atomic_write(filename, data):
    # Output paths are fixed, app-owned inventory locations. Refuse links even
    # on a rerun, so a local archive cannot redirect a generated material.
    for parent in [filename, *filename.parents]:
        if parent.is_symlink():
            raise ValueError(f"Generated output cannot use a symbolic link: {parent}")
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = filename.with_name(filename.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)


def download_crate(entry, cache, offline):
    name, version, checksum = entry["name"], entry["version"], entry["checksum"]
    filename = cache / f"{name}-{version}.crate"
    try:
        return verified_bytes(filename, checksum)
    except FileNotFoundError:
        if offline:
            raise ValueError(f"Offline archive is missing: {filename.name}")
    encoded = urllib.parse.quote(f"{name}-{version}.crate", safe="")
    url = f"https://static.crates.io/crates/{name}/{encoded}"
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={
                "User-Agent": "Folio-source-inventory/1 (https://github.com/grawish/folio)"})
            with urllib.request.urlopen(request, timeout=60) as response:
                final = urllib.parse.urlparse(response.url)
                if final.scheme != "https" or final.hostname != "static.crates.io":
                    raise ValueError("Unexpected source download redirect")
                parts, size = [], 0
                while part := response.read(64 * 1024):
                    size += len(part)
                    if size > MAX_ARCHIVE:
                        raise ValueError("Source archive exceeds the download limit")
                    parts.append(part)
            data = b"".join(parts)
            if digest(data) != checksum:
                raise ValueError(f"Downloaded crate checksum mismatch: {name} {version}")
            atomic_write(filename, data)
            return data
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def collect(entry, cache, output, offline):
    data = download_crate(entry, cache, offline)
    details, materials = crate_materials(data, entry["name"], entry["version"])
    directory = output / "packages" / f'{entry["name"]}-{entry["version"]}'
    records = []
    for name, content in materials.items():
        atomic_write(directory / "materials" / name, content)
        records.append({"path": name, "bytes": len(content), "sha256": digest(content)})
    # Preserve the original source archive alongside the selected notices.
    atomic_write(directory / f'{entry["name"]}-{entry["version"]}.crate', data)
    return {**entry, **details, "archiveBytes": len(data), "materials": records}


def supplement_notices(report, output, offline):
    lock_bytes = Path("resources/rust-license-notices.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    if lock.get("schemaVersion") != 1 or lock.get("cargoLockSha256") != report["tectonic"]["cargoLockSha256"]:
        raise ValueError("Review the supplemental notices for the changed Cargo.lock")
    report["supplementalNoticeLockSha256"] = digest(lock_bytes)
    packages = {(p["name"], p["version"]): p for p in report["packages"]}
    for source in lock["sources"]:
        package = packages[(source["name"], source["version"])]
        directory = output / "packages" / f'{package["name"]}-{package["version"]}'
        vcs = json.loads((directory / "materials" / ".cargo_vcs_info.json").read_bytes())
        if (package["checksum"] != source["crateSha256"] or
                package["repository"] != "https://github.com/" + source["repository"] or
                vcs["git"]["sha1"] != source["commit"] or
                vcs.get("path_in_vcs", "") != source["pathInVcs"] or
                package["declaredLicense"] != source["declaredLicense"]):
            raise ValueError("Supplemental notice provenance differs from its crate")
        records = []
        for material in source["materials"]:
            relative = safe_member("upstream/" + material["path"], "upstream")
            expected_url = f'https://raw.githubusercontent.com/{source["repository"]}/{source["commit"]}/{relative}'
            if (material["url"] != expected_url or not re.fullmatch(r"[a-f0-9]{64}", material["sha256"]) or
                    not 0 < material["bytes"] <= 1024 * 1024):
                raise ValueError("Invalid supplemental notice lock entry")
            cached = Path(".cache/license-sources/rust-notices") / material["sha256"]
            try:
                content = verified_bytes(cached, material["sha256"], material["bytes"])
            except FileNotFoundError:
                if offline:
                    raise ValueError("Supplemental notice is missing from the offline cache")
                with urllib.request.urlopen(expected_url, timeout=60) as response:
                    final = urllib.parse.urlparse(response.url)
                    if final.scheme != "https" or final.hostname != "raw.githubusercontent.com":
                        raise ValueError("Unexpected supplemental notice redirect")
                    content = response.read(material["bytes"] + 1)
                if len(content) != material["bytes"] or digest(content) != material["sha256"]:
                    raise ValueError("Supplemental notice differs from its reviewed lock")
                atomic_write(cached, content)
            atomic_write(directory / "upstream-notices" / relative, content)
            records.append(material)
        package["upstreamNotices"] = {"repository": source["repository"], "commit": source["commit"], "materials": records}
        if not package["noticeFiles"]:
            package["state"] = "upstream-texts-collected"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    args = parser.parse_args()
    source_lock_bytes = Path("resources/runtime-license-sources.lock.json").read_bytes()
    source_lock = json.loads(source_lock_bytes)
    tectonic = next(p for p in source_lock["sources"] if p["id"] == "tectonic")
    source_archive = Path(".cache/license-sources") / tectonic["archive"]
    source = verified_bytes(source_archive, tectonic["sha256"], tectonic["bytes"])
    archive, files = archive_files(source, "tectonic-" + tectonic["commit"])
    with archive:
        lock_bytes = read_member(archive, files["Cargo.lock"])
        package = tomllib.loads(read_member(archive, files["Cargo.toml"]).decode("utf-8"))["package"]
        if (source_lock.get("schemaVersion") != 1 or package.get("name") != "tectonic" or
                package.get("version") != tectonic["version"] or
                tectonic["version"] != source_lock["compilerVersion"]):
            raise ValueError("Compiler source identity differs from the reviewed source lock")
    lock = tomllib.loads(lock_bytes.decode("utf-8"))
    if lock.get("version") != 4:
        raise ValueError("Review the changed upstream Cargo.lock format")
    packages, workspace, seen = [], [], set()
    for entry in lock["package"]:
        name, version = entry["name"], entry["version"]
        if (not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", name) or
                not re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,79}", version) or
                (name.lower(), version.lower()) in seen):
            raise ValueError("Invalid or duplicate package identity")
        seen.add((name.lower(), version.lower()))
        if "source" not in entry:
            workspace.append(entry)
        elif entry["source"] == REGISTRY and re.fullmatch(r"[a-f0-9]{64}", entry.get("checksum", "")):
            packages.append(entry)
        else:
            raise ValueError("Unreviewed dependency source in Cargo.lock")
    cache = Path(".cache/license-sources/rust")
    output = Path("artifacts/license-materials/compiler-rust")
    report = {
        "schemaVersion": 1,
        "scope": "Complete upstream Cargo.lock registry-source inventory, including development, optional and non-Mac dependencies. Not the exact shipped binary dependency graph or a legal approval.",
        "releaseAuditComplete": False,
        "collectorSha256": digest(Path(__file__).read_bytes()),
        "sourceLockSha256": digest(source_lock_bytes),
        "tectonic": {"version": tectonic["version"], "commit": tectonic["commit"], "archiveSha256": tectonic["sha256"], "cargoLockSha256": digest(lock_bytes)},
        "workspacePackages": workspace,
        "packages": [],
        "pending": [
            "Resolve the exact release target/features and match this source inventory to the distributed Tectonic binary.",
            "Review workspace crates and all linked native/submodule licenses and corresponding-source/build requirements.",
            "Complete Biber/Perl, TeX/font inventories and final signed-app SBOM/notices.",
        ],
    }
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(collect, entry, cache, output, args.offline): entry for entry in packages}
            try:
                for future in concurrent.futures.as_completed(futures):
                    report["packages"].append(future.result())
                    if len(report["packages"]) % 25 == 0:
                        print(f'Collected {len(report["packages"])}/{len(packages)} locked crates', flush=True)
            except Exception:
                for future in futures:
                    future.cancel()
                raise
        supplement_notices(report, output, args.offline)
    except Exception as error:
        report["error"] = str(error)
        report["packages"].sort(key=lambda p: (p["name"], p["version"]))
        atomic_write(output / "incomplete-inventory.json", (json.dumps(report, indent=2) + "\n").encode())
        raise
    report["packages"].sort(key=lambda p: (p["name"], p["version"]))
    report["registryCollectionComplete"] = True
    report["missingNoticeTexts"] = [f'{p["name"]}@{p["version"]}' for p in report["packages"] if not p["noticeFiles"] and not p.get("upstreamNotices")]
    atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps({"registryCrates": len(packages), "workspaceCrates": len(workspace),
                      "sourceBytes": sum(p["archiveBytes"] for p in report["packages"]),
                      "noticeReviewNeeded": report["missingNoticeTexts"], "output": str(output),
                      "completeBinaryAudit": False}, indent=2))


if __name__ == "__main__":
    main()
