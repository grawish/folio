"""Retain native-library version evidence and original source/notice materials.

Reads the exact Biber payload and Mach-O data without loading libraries or
executing upstream code. Version evidence is not a reproducible native build,
proof of vendor patches, license compatibility decision or completed SBOM.
"""
import argparse
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import struct
import tarfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("native_biber", ROOT / "scripts/collect-biber-build-evidence.py")
biber = importlib.util.module_from_spec(spec); spec.loader.exec_module(biber)
shared = biber.shared
HOSTS = {"github.com", "release-assets.githubusercontent.com", "download.gnome.org",
         "ftp.gnu.org", "distfiles.macports.org", "zlib.net"}


def macho(data, requested=(), file_type=6, name_suffix=None):
    thin = biber.arm64_slice(data) if data[:4] == b"\xca\xfe\xba\xbe" else data
    if len(thin) < 32 or thin[:8] != b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01" or file_type not in (6, 8) or struct.unpack_from("<I", thin, 12)[0] != file_type:
        raise ValueError("Expected the reviewed arm64 Mach-O file type")
    count, size = struct.unpack_from("<2I", thin, 16)
    if not 1 <= count <= 512 or size > len(thin) - 32:
        raise ValueError("Invalid Mach-O command bounds")
    def cstring(start, end):
        if not 0 <= start < end <= len(thin): raise ValueError("Invalid Mach-O string bounds")
        stop = thin.find(b"\0", start, min(end, start + 4096))
        if stop < 0: raise ValueError("Unterminated Mach-O string")
        return thin[start:stop].decode("utf-8")
    version = lambda v: f"{v >> 16}.{(v >> 8) & 255}.{v & 255}"
    offset, identities, dependencies, segments, tables = 32, [], [], [], []
    section_count = 0
    for _ in range(count):
        if offset + 8 > 32 + size: raise ValueError("Truncated Mach-O command")
        command, length = struct.unpack_from("<2I", thin, offset)
        if length < 8 or length % 8 or offset + length > 32 + size:
            raise ValueError("Invalid Mach-O command length")
        if command in (0xC, 0xD, 0x80000018, 0x8000001F, 0x80000023):
            if length < 24: raise ValueError("Truncated Mach-O library command")
            name, _, current, compatibility = struct.unpack_from("<4I", thin, offset + 8)
            if not 24 <= name < length: raise ValueError("Invalid Mach-O library name")
            record = {"name": cstring(offset + name, offset + length),
                      "currentVersion": version(current), "compatibilityVersion": version(compatibility)}
            (identities if command == 0xD else dependencies).append(record)
        elif command == 0x19:
            if length < 72: raise ValueError("Truncated Mach-O segment")
            vm, virtual_size, file_offset, file_size = struct.unpack_from("<4Q", thin, offset + 24)
            sections = struct.unpack_from("<I", thin, offset + 64)[0]
            if length != 72 + 80 * sections or file_offset + file_size > len(thin) or file_size > virtual_size:
                raise ValueError("Invalid Mach-O segment extent")
            segments.append((vm, file_offset, file_size)); section_count += sections
        elif command == 2:
            if length != 24: raise ValueError("Invalid Mach-O symbol command")
            symbols, number, strings, string_size = struct.unpack_from("<4I", thin, offset + 8)
            if number > 200_000 or symbols + number * 16 > len(thin) or strings + string_size > len(thin):
                raise ValueError("Invalid Mach-O symbol bounds")
            tables.append((symbols, number, strings, string_size))
        offset += length
    if offset != 32 + size or len(identities) != (1 if file_type == 6 else 0) or len(tables) != 1:
        raise ValueError("Incomplete Mach-O identity or symbol table")
    if any(a < b + n and b < a + m for i, (_, a, m) in enumerate(segments) for _, b, n in segments[i+1:] if m and n):
        raise ValueError("Overlapping Mach-O file segments")
    wanted, found, boot_symbols, suffix_names = dict(requested), {}, [], []
    if any(not isinstance(n, int) or not 1 <= n <= 16 for n in wanted.values()):
        raise ValueError("Invalid requested scalar size")
    table, number, strings, string_size = tables[0]
    for i in range(number):
        index, kind, section, _, address = struct.unpack_from("<IBBHQ", thin, table + i * 16)
        if index >= string_size: raise ValueError("Symbol name escapes Mach-O string table")
        if not index or kind & 0xE0 or kind & 0x0F != 0x0F: continue
        name = cstring(strings + index, strings + string_size)
        boot = file_type == 8 and name.startswith("_boot_")
        matches_suffix = name_suffix is not None and name.endswith(name_suffix)
        if name not in wanted and not boot and not matches_suffix: continue
        mappings = [(file_offset + address - vm, length - (address - vm)) for vm, file_offset, length in segments if vm <= address < vm + length]
        width = wanted[name] * 4 if name in wanted else 1
        if len(mappings) != 1 or name in found or name in boot_symbols or mappings[0][1] < width or not section or (boot and section > section_count):
            raise ValueError("Invalid or ambiguous Mach-O scalar mapping")
        if boot: boot_symbols.append(name)
        if matches_suffix: suffix_names.append(name)
        if name not in wanted: continue
        file_offset = mappings[0][0]
        found[name] = {"arm64FileOffset": file_offset, "values": list(struct.unpack_from("<" + str(wanted[name]) + "I", thin, file_offset))}
    if found.keys() != wanted.keys(): raise ValueError("Missing requested Mach-O scalar")
    result = {"arm64Bytes": len(thin), "arm64Sha256": shared.digest(thin),
              "identity": identities[0] if identities else None, "dependencies": dependencies, "scalars": found}
    if file_type == 8: result["bootSymbols"] = sorted(boot_symbols)
    if name_suffix is not None: result["suffixNames"] = sorted(suffix_names)
    return thin, result


def source_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme != "https" or p.hostname not in HOSTS or p.username or p.password or p.port not in (None, 443) or p.fragment:
        raise ValueError("Native source URL is outside approved HTTPS hosts")
    return url


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, url):
        return super().redirect_request(req, fp, code, msg, headers, source_url(url))


def source_archive(entry, offline):
    name = entry["archive"]
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.(?:tar\.(?:gz|xz|bz2)|tgz)", name) or not 0 < entry["bytes"] <= 64 * 1024 * 1024:
        raise ValueError("Invalid native source archive identity or size")
    source_url(entry["url"])
    file = ROOT / ".cache/license-sources/biber-native" / name
    if any(p.is_symlink() for p in [file, *file.parents]): raise ValueError("Native source cache has a symbolic link")
    if file.exists(): return biber.verified(file, entry)
    if offline: raise ValueError("Missing offline native source archive: " + name)
    deadline, parts, size = time.monotonic() + 120, [], 0
    with urllib.request.build_opener(Redirect()).open(entry["url"], timeout=30) as response:
        source_url(response.url)
        while part := response.read(65536):
            size += len(part)
            if size > entry["bytes"] or time.monotonic() > deadline:
                raise ValueError("Native download exceeds byte or time bounds")
            parts.append(part)
    data = b"".join(parts)
    if len(data) != entry["bytes"] or shared.digest(data) != entry["sha256"]:
        raise ValueError("Downloaded native source differs from lock")
    shared.atomic_write(file, data)
    return data


def source_materials(data, entry):
    if len(data) != entry["bytes"] or shared.digest(data) != entry["sha256"]:
        raise ValueError("Native source archive differs from lock")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        files, total = {}, 0
        for count, member in enumerate(archive, 1):
            relative = shared.safe_member(member.name.rstrip("/") if member.isdir() else member.name, entry["root"])
            total += member.size
            if count > 30_000 or member.size < 0 or total > 256 * 1024 * 1024:
                raise ValueError("Native source archive exceeds audit bounds")
            if not member.isdir():
                if relative in files: raise ValueError("Duplicate native archive member")
                files[relative] = member
        names = {n for n, m in files.items() if shared.NOTICE.fullmatch(PurePosixPath(n).name)}
        names.update(entry["requiredMaterials"])
        names.update(a["path"] for a in entry["sourceAnchors"])
        if not names or len(names) > 512 or not names.issubset(files):
            raise ValueError("Required native source material is missing")
        if len({n.casefold() for n in names}) != len(names): raise ValueError("Selected source material paths collide")
        result = {n: shared.read_member(archive, files[n]) for n in sorted(names)}
        if sum(map(len, result.values())) > 16 * 1024 * 1024:
            raise ValueError("Native source materials exceed byte budget")
        for anchor in entry["sourceAnchors"]:
            content = result[anchor["path"]]
            if shared.digest(content) != anchor["sha256"] or any(s.encode() not in content for s in anchor["text"]):
                raise ValueError("Source version declaration differs from reviewed evidence")
        return result


def check_library(data, entry):
    if len(data) != entry["bytes"] or shared.digest(data) != entry["sha256"]:
        raise ValueError("Native library differs from reviewed Biber bytes")
    thin, info = macho(data, [(a["symbol"], len(a["values"])) for a in entry.get("scalars", [])])
    if info["identity"] != entry["identity"]:
        raise ValueError("Native library identity differs")
    for anchor in entry.get("scalars", []):
        if info["scalars"][anchor["symbol"]]["values"] != anchor["values"]:
            raise ValueError("Native version scalar differs")
    for value in entry.get("strings", []):
        if b"\0" + value.encode() + b"\0" not in thin:
            raise ValueError("Native version string is absent")
    return info


def collect(output, offline):
    lock_bytes = (ROOT / "resources/biber-native-sources.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    foundation_bytes = (ROOT / "resources/biber-build-provenance.lock.json").read_bytes()
    foundation = json.loads(foundation_bytes)
    if lock["schemaVersion"] != 1 or lock["biberEvidenceLockSha256"] != shared.digest(foundation_bytes):
        raise ValueError("Native source lock differs from reviewed Biber identity")
    binary = biber.verified(ROOT / "resources/runtime/mac-arm64/biber", foundation["arm64Binary"])
    _, payload, _ = biber.parse_payload(binary, foundation["reviewedZipDuplicates"])
    manifest = json.loads(biber.verified(ROOT / "resources/runtime/mac-arm64/manifest.json", foundation["runtimeManifest"]))
    expected = {n for n in payload if n.startswith("shlib/") and n.endswith(".dylib")}
    if len(lock["libraries"]) != len(expected) or {e["path"] for e in lock["libraries"]} != expected:
        raise ValueError("Native library inventory is incomplete or duplicated")
    libraries, retained, sources = [], {}, []
    for entry in lock["libraries"]:
        data = payload[entry["path"]]
        runtime_path = "biber-cache/inc/" + entry["path"]
        if data != (ROOT / "resources/runtime/mac-arm64" / runtime_path).read_bytes() or shared.digest(data) != manifest["files"].get(runtime_path):
            raise ValueError("Prepared native library differs from Biber payload/manifest")
        libraries.append({**entry, "inspection": check_library(data, entry)})
    by_path = {e["path"]: e for e in libraries}
    for entry in libraries:
        linked_path = entry.get("linkedLibrary")
        if linked_path is None:
            continue
        linked = by_path.get(linked_path)
        if linked is None:
            raise ValueError("Native library linkedLibrary target is missing")
        if not linked.get("strings"):
            raise ValueError("Native library linkedLibrary target has no confirmed version string")
        deps = entry["inspection"]["dependencies"]
        if not any(d["name"] == linked["identity"]["name"] and d["currentVersion"] == linked["identity"]["currentVersion"] for d in deps):
            raise ValueError("Native library does not link the declared linkedLibrary identity/version")
    if len({e["name"] for e in lock["sources"]}) != len(lock["sources"]):
        raise ValueError("Duplicate native source component")
    for entry in lock["sources"]:
        if not re.fullmatch(r"[a-z0-9-]+", entry["name"]): raise ValueError("Invalid native source output identity")
        data = source_archive(entry, offline)
        materials = source_materials(data, entry)
        retained["sources/" + entry["archive"]] = data
        retained.update({"materials/" + entry["name"] + "/" + n: d for n, d in materials.items()})
        sources.append({**entry, "materials": [biber.file_record(n, d) for n, d in materials.items()]})
    source_names = {s["name"] for s in sources}
    if any(e.get("sourceComponent") not in source_names | {None} for e in libraries):
        raise ValueError("Native library references a missing source component")
    for name, data in sorted(retained.items()): shared.atomic_write(output / name, data)
    report = {"schemaVersion": 1, "releaseAuditComplete": False, "scope": lock["scope"],
              "collectorSha256": shared.digest(Path(__file__).read_bytes()), "lockSha256": shared.digest(lock_bytes),
              "biberEvidenceLockSha256": shared.digest(foundation_bytes), "arm64Binary": foundation["arm64Binary"],
              "libraries": libraries, "sources": sources,
              "summary": {"librariesInspected": len(libraries), "sourceArchives": len(sources),
                          "archiveBytes": sum(s["bytes"] for s in sources),
                          "sourceMaterials": sum(len(s["materials"]) for s in sources)},
              "evidence": [biber.file_record(n, d) for n, d in sorted(retained.items())],
              "remaining": lock["remaining"]}
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--offline", action="store_true")
    args = parser.parse_args(); output = ROOT / "artifacts/license-materials/biber-native"
    try: report = collect(output, args.offline)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode())
        raise
    (output / "incomplete-inventory.json").unlink(missing_ok=True)
    print(json.dumps(report["summary"], indent=2))
