"""Inspect the pinned Biber executable, payload and source without executing Perl.

Requires prepared Biber and its cached official binary/source archives, plus
Python 3.11+. Downloads only pinned foundation sources unless --offline is set.
Never extracts archive paths or executes upstream code.
"""
import argparse
import collections
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tarfile
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("rust_materials", ROOT / "scripts/collect-rust-license-materials.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def verified(path, entry):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"] or entry["bytes"] > 256 * 1024 * 1024:
        raise ValueError("Unexpected Biber audit input size/type: " + path.name)
    data = path.read_bytes()
    if shared.digest(data) != entry["sha256"]:
        raise ValueError("Biber audit input digest mismatch: " + path.name)
    return data


def path_name(name):
    return shared.safe_member("payload/" + name, "payload")


def arm64_slice(data):
    if len(data) < 8 or data[:4] != b"\xca\xfe\xba\xbe":
        raise ValueError("Expected the reviewed universal Mach-O format")
    count = struct.unpack_from(">I", data, 4)[0]
    if not 1 <= count <= 8 or 8 + count * 20 > len(data):
        raise ValueError("Invalid universal architecture table")
    matches = []
    for i in range(count):
        cpu, subtype, offset, size, align = struct.unpack_from(">5I", data, 8 + i * 20)
        if offset < 8 + count * 20 or size < 32 or offset + size > len(data):
            raise ValueError("Universal architecture exceeds binary bounds")
        if cpu == 0x0100000C:
            matches.append(data[offset:offset + size])
    if len(matches) != 1 or matches[0][:8] != b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01":
        raise ValueError("Expected exactly one native arm64 executable")
    return matches[0]


def signature_offset(data):
    if len(data) < 32 or data[:8] != b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01":
        raise ValueError("Expected a thin arm64 Mach-O executable")
    count, size = struct.unpack_from("<2I", data, 16)
    if count > 512 or size > len(data) - 32:
        raise ValueError("Invalid Mach-O load commands")
    offset, signatures = 32, []
    for _ in range(count):
        if offset + 8 > 32 + size:
            raise ValueError("Truncated Mach-O command")
        command, length = struct.unpack_from("<2I", data, offset)
        if length < 8 or offset + length > 32 + size:
            raise ValueError("Invalid Mach-O command size")
        if command == 0x1D:
            if length != 16:
                raise ValueError("Unexpected code-signature command")
            start, length_signed = struct.unpack_from("<2I", data, offset + 8)
            if start < 32 + size or start + length_signed != len(data):
                raise ValueError("Invalid code-signature extent")
            signatures.append(start)
        offset += length
    if offset != 32 + size or len(signatures) != 1:
        raise ValueError("Expected one complete code-signature extent")
    return signatures[0]


def parse_payload(data, reviewed_duplicates=None):
    signature = signature_offset(data)
    marker = data.rfind(b"\nPAR.pm\n", 0, signature)
    if marker < 4 or any(data[marker + 8:signature]) or signature - marker > 4096:
        raise ValueError("PAR marker does not precede the code signature")
    length = struct.unpack_from(">I", data, marker - 4)[0]
    start = marker - 4 - length
    if start < 32 or start >= marker:
        raise ValueError("Invalid PAR payload extent")
    offset, loader = start, {}
    while data[offset:offset + 4] == b"FILE":
        offset += 4
        if offset + 4 > marker:
            raise ValueError("Truncated PAR loader header")
        name_size = struct.unpack_from(">I", data, offset)[0]; offset += 4
        if not 10 <= name_size <= 1024 or offset + name_size + 4 > marker:
            raise ValueError("Invalid PAR loader file name extent")
        name = data[offset:offset + name_size].decode(); offset += name_size
        path_name(name)
        if not re.fullmatch(r"[a-f0-9]{8}/.+", name) or name in loader:
            raise ValueError("Invalid or duplicate loader member")
        size = struct.unpack_from(">I", data, offset)[0]; offset += 4
        if size > 8 * 1024 * 1024 or offset + size > marker or len(loader) >= 512:
            raise ValueError("Invalid PAR loader file extent")
        content = data[offset:offset + size]; offset += size
        if f"{zlib.crc32(content):08x}" != name.partition("/")[0]:
            raise ValueError("PAR loader CRC mismatch")
        loader[name] = content
    if data[offset:offset + 4] != b"PK\x03\x04":
        raise ValueError("PAR loader is not followed by a ZIP payload")
    end = data.rfind(b"PK\x05\x06", offset, marker)
    if end < offset or end + 22 > marker:
        raise ValueError("Missing embedded ZIP directory")
    zip_end = end + 22 + struct.unpack_from("<H", data, end + 20)[0]
    if zip_end > marker:
        raise ValueError("Invalid embedded ZIP comment extent")
    files = read_zip(data[:zip_end], reviewed_duplicates)
    return loader, files, {"payloadStart": start, "loaderEnd": offset, "zipEnd": zip_end,
                           "parMarker": marker, "signatureStart": signature}


def read_zip(data, reviewed_duplicates=None):
    reviewed_duplicates = reviewed_duplicates or {}
    files, seen, total, repeats = {}, set(), 0, collections.Counter()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 5000:
            raise ValueError("Too many Biber ZIP entries")
        for entry in entries:
            name = path_name(entry.filename.rstrip("/") if entry.is_dir() else entry.filename)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            total += entry.file_size
            if (mode not in (0, stat.S_IFDIR, stat.S_IFREG) or entry.flag_bits & 1 or
                    entry.file_size > 64 * 1024 * 1024 or total > 256 * 1024 * 1024):
                raise ValueError("Unsafe or oversized Biber ZIP member")
            content = b"" if entry.is_dir() else archive.read(entry)
            if name in seen:
                reviewed = reviewed_duplicates.get(name)
                if (entry.is_dir() or not reviewed or content != files[name] or
                        len(content) != reviewed["bytes"] or shared.digest(content) != reviewed["sha256"]):
                    raise ValueError("Unreviewed or differing duplicate Biber ZIP member")
                repeats[name] += 1
            seen.add(name)
            if not entry.is_dir():
                files[name] = content
    if dict(repeats) != {n: e["extraOccurrences"] for n, e in reviewed_duplicates.items()}:
        raise ValueError("Biber ZIP duplicate counts differ from reviewed values")
    return files


def embedded_binary(data, entry):
    size, offset, chunk = entry["bytes"], entry["offset"], entry["chunkBytes"]
    if not 0 < size <= 16 * 1024 * 1024 or chunk != 32768 or offset < 0:
        raise ValueError("Invalid embedded binary dimensions")
    result = bytearray()
    while len(result) < size:
        length = min(chunk, size - len(result))
        if offset + length >= len(data) or data[offset + length] != 0:
            raise ValueError("Invalid embedded binary chunk terminator")
        result.extend(data[offset:offset + length]); offset += length + 1
    if shared.digest(result) != entry["sha256"]:
        raise ValueError("Embedded binary bytes differ from reviewed identity")
    return bytes(result)


def map_cache(cache, expected, data, loader, files, lock):
    by_hash = collections.defaultdict(list)
    for prefix, contents in [("loader/", loader), ("par/", files)]:
        for name, content in contents.items():
            by_hash[shared.digest(content)].append(prefix + name)
    special = {}
    for entry in lock["embeddedBinaries"]:
        special[entry["cachePath"]] = (embedded_binary(data, entry), "embedded-native-chunks")
    for entry in lock["generatedScripts"]:
        name = path_name(entry["sourcePath"])
        wrapped = f'package main;\n#line 1 "{name}"\n'.encode() + files[name]
        special[entry["cachePath"]] = (wrapped, "generated-script-wrapper:" + name)
    actual = {}
    for path in cache.rglob("*"):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Prepared Biber cache contains a nonregular entry")
        if path.is_file():
            actual[str(path.relative_to(cache))] = path
    if set(actual) != set(expected):
        raise ValueError("Prepared Biber cache inventory differs from runtime manifest")
    records = []
    for name, path in sorted(actual.items()):
        path_name(name)
        content = verified(path, {"bytes": path.stat().st_size, "sha256": expected[name]})
        checksum = shared.digest(content)
        matches = by_hash.get(checksum, [])
        if name in special:
            original, kind = special[name]
            if content != original:
                raise ValueError("Generated/embedded Biber cache file differs")
            matches = [kind]
        elif name == lock["canary"]["cachePath"]:
            if checksum != lock["canary"]["sha256"] or len(content) != lock["canary"]["bytes"] or data.find(content) < 0:
                raise ValueError("Biber cache canary differs from embedded text")
            matches = ["embedded-canary-text"]
        if not matches:
            raise ValueError("Prepared Biber file has no payload provenance: " + name)
        records.append({"path": name, "bytes": len(content), "sha256": checksum, "payloadMatches": matches})
    return records


def archive_sources(data, root):
    archive, members = shared.archive_files(data, root)
    with archive:
        if any(not m.isfile() for m in members.values()):
            raise ValueError("Biber source archive contains nonregular members")
        return {n: shared.read_member(archive, m) for n, m in members.items() if m.isfile()}


def foundation_input(entry, offline):
    if (not re.fullmatch(r"[A-Za-z0-9.-]+\.tar\.gz", entry["archive"]) or
            not re.fullmatch(r"https://cpan\.metacpan\.org/authors/id/(S/SH/SHAY|R/RS/RSCHUPP)/" + re.escape(entry["archive"]), entry["url"]) or
            not 0 < entry["bytes"] <= 32 * 1024 * 1024):
        raise ValueError("Invalid Biber foundation URL or bounds")
    path = ROOT / ".cache/license-sources/biber-perl" / entry["archive"]
    if not path.exists():
        if offline:
            raise ValueError("Missing offline Biber foundation input: " + entry["archive"])
        with urllib.request.urlopen(entry["url"], timeout=60) as response:
            if response.url != entry["url"]:
                raise ValueError("Unexpected Biber foundation redirect")
            data = response.read(entry["bytes"] + 1)
        if len(data) != entry["bytes"] or shared.digest(data) != entry["sha256"]:
            raise ValueError("Downloaded Biber foundation differs from lock")
        shared.atomic_write(path, data)
    return verified(path, entry)


def file_record(name, data):
    return {"path": name, "bytes": len(data), "sha256": shared.digest(data)}


def collect(output, offline=False):
    lock_bytes = (ROOT / "resources/biber-build-provenance.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    config = (ROOT / "scripts/runtime-config.mjs").read_text()
    if lock["schemaVersion"] != 1 or lock["upstreamArchive"]["sha256"] not in config or f"version: '{lock['biberVersion']}'" not in config:
        raise ValueError("Biber evidence does not match configured runtime")
    upstream = verified(ROOT / ".cache/downloads" / lock["upstreamArchive"]["archive"], lock["upstreamArchive"])
    with tarfile.open(fileobj=io.BytesIO(upstream), mode="r:gz") as archive:
        entries = archive.getmembers()
        if len(entries) != 1 or entries[0].name != "biber" or not entries[0].isfile() or entries[0].size != lock["universalBinary"]["bytes"]:
            raise ValueError("Unexpected official Biber archive contents")
        universal = archive.extractfile(entries[0]).read()
    if shared.digest(universal) != lock["universalBinary"]["sha256"]:
        raise ValueError("Universal Biber binary differs from lock")
    binary = verified(ROOT / "resources/runtime/mac-arm64/biber", lock["arm64Binary"])
    if arm64_slice(universal) != binary:
        raise ValueError("Prepared Biber is not the exact upstream arm64 slice")
    loader, files, layout = parse_payload(binary, lock["reviewedZipDuplicates"])
    manifest = json.loads(verified(ROOT / "resources/runtime/mac-arm64/manifest.json", lock["runtimeManifest"]))
    expected = {n.removeprefix("biber-cache/"): h for n, h in manifest["files"].items() if n.startswith("biber-cache/")}
    cache = map_cache(ROOT / "resources/runtime/mac-arm64/biber-cache", expected, binary, loader, files, lock)
    if (f"version='{lock['perlVersion']}'\n".encode() not in files["lib/Config_heavy.pl"] or
            f"generated_by: 'PAR::Packer version {lock['packerVersion']}'".encode() not in files["META.yml"] or
            f"  version: {lock['parVersion']}\n".encode() not in files["META.yml"]):
        raise ValueError("Bundled Perl/PAR identity differs from reviewed values")
    source_lock_bytes = (ROOT / "resources/runtime-license-sources.lock.json").read_bytes()
    source_lock = json.loads(source_lock_bytes)
    biber = next(s for s in source_lock["sources"] if s["id"] == "biber")
    if biber["commit"] != lock["sourceCommit"] or biber["version"] != lock["biberVersion"]:
        raise ValueError("Biber source differs from reviewed identity")
    source = archive_sources(verified(ROOT / ".cache/license-sources" / biber["archive"], biber), "biber-" + biber["commit"])
    source_matches = []
    for name, content in files.items():
        if not name.startswith("lib/Biber") and name != "script/biber-darwin":
            continue
        target = lock["biberSourceMappings"].get(name, name)
        if source.get(target) != content:
            raise ValueError("Embedded Biber file differs from release source: " + name)
        source_matches.append({"payload": name, "source": target, "sha256": shared.digest(content)})
    hashes = collections.defaultdict(list)
    for prefix, contents in [("loader/", loader), ("par/", files)]:
        for name, content in contents.items():
            hashes[shared.digest(content)].append(prefix + name)
    metadata_bytes = verified(ROOT / "resources/biber-foundation-releases.json", lock["foundationReleaseSnapshot"])
    releases = json.loads(metadata_bytes)
    foundations = []
    for entry in lock["foundationSources"]:
        metadata = releases[entry["id"]]["release"]
        if (metadata["download_url"] != entry["url"] or metadata["checksum_sha256"] != entry["sha256"] or
                str(metadata["version"]) != entry["version"] or metadata["license"] != entry["licenseDeclaration"]):
            raise ValueError("Foundation source differs from retained release metadata")
        data = foundation_input(entry, offline)
        sources = archive_sources(data, entry["root"])
        selected = {n: d for n, d in sources.items() if shared.NOTICE.fullmatch(PurePosixPath(n).name) or
                    PurePosixPath(n).name in {"Artistic", "META.yml", "META.json"} or
                    n in {"myldr/Makefile.PL", "myldr/embed_files.pl", "script/par.pl"}}
        for required in (["Artistic", "Copying"] if entry["id"].startswith("perl-") else ["LICENSE"]):
            if required not in selected:
                raise ValueError("Required foundation license file is missing")
        matches = [{"source": n, "payload": hashes[shared.digest(d)], "sha256": shared.digest(d)} for n, d in sources.items() if shared.digest(d) in hashes]
        shared.atomic_write(output / "sources" / entry["archive"], data)
        for name, content in selected.items():
            shared.atomic_write(output / "sources" / entry["id"] / "materials" / name, content)
        foundations.append({**entry, "materials": [file_record(n, d) for n, d in sorted(selected.items())], "exactPayloadMatches": matches})
    payload = {"loaderFiles": [file_record(n, d) for n, d in sorted(loader.items())],
               "zipFiles": [file_record(n, d) for n, d in sorted(files.items())], "cacheFiles": cache,
               "biberSourceMatches": source_matches, "foundationSources": foundations}
    evidence = []
    for name, content in [("payload-inventory.json", (json.dumps(payload, indent=2) + "\n").encode()),
                           ("foundation-releases.json", metadata_bytes),
                           *[("metadata/" + n, files[n]) for n in ["META.yml", "MANIFEST", "lib/Config.pm", "lib/Config_heavy.pl"]]]:
        shared.atomic_write(output / name, content)
        evidence.append(file_record(name, content))
    report = {"schemaVersion": 1, "scope": lock["scope"], "releaseAuditComplete": False,
              "collectorSha256": shared.digest(Path(__file__).read_bytes()), "lockSha256": shared.digest(lock_bytes),
              "sharedCollectorSha256": shared.digest((ROOT / "scripts/collect-rust-license-materials.py").read_bytes()),
              "biberSourceArchive": biber, "sourceLockSha256": shared.digest(source_lock_bytes),
              "upstreamArchive": lock["upstreamArchive"], "arm64Binary": lock["arm64Binary"], "runtimeManifest": lock["runtimeManifest"],
              "versions": {"biber": lock["biberVersion"], "perl": lock["perlVersion"], "par": lock["parVersion"], "packer": lock["packerVersion"]},
              "layout": layout, "summary": {"loaderFiles": len(loader), "zipFiles": len(files), "cacheFiles": len(cache),
                  "cacheBytes": sum(r["bytes"] for r in cache), "biberSourceMatches": len(source_matches), "foundationArchives": len(foundations),
                  "foundationArchiveBytes": sum(f["bytes"] for f in foundations), "foundationMaterials": sum(len(f["materials"]) for f in foundations),
                  "foundationSourceFileMatches": {f["id"]: len(f["exactPayloadMatches"]) for f in foundations}},
              "reviewedZipDuplicates": lock["reviewedZipDuplicates"],
              "evidence": evidence, "remaining": ["Map all additional CPAN modules and native libraries to exact sources, notices and build inputs.",
                  "Complete Biber Artistic 2.0 notice materials and final exact-app SBOM/redistribution review."]}
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Require cached foundation sources")
    args = parser.parse_args()
    output = ROOT / "artifacts/license-materials/biber-build"
    try:
        report = collect(output, args.offline)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode())
        raise
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
