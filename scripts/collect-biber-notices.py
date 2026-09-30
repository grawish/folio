#!/usr/bin/env python3
"""Assemble original Biber/Perl notice documents from retained verified archives.

Read-only source collections; no downloads, native inspection or upstream execution.
Complete selected source modules and READMEs preserve embedded license statements.
The output is material evidence, not complete binary redistribution approval.
"""
from pathlib import Path, PurePosixPath
import argparse
import base64
import gzip
import hashlib
import json
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]
NOTICE = re.compile(r"(?:licen[cs]e|copying|copyright|notice|authors|artistic)(?:[._-].*)?", re.I)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        while block := stream.read(128 * 1024):
            h.update(block)
    return h.hexdigest()


def checked(file, ref):
    state = file.lstat()
    if not file.is_file() or file.is_symlink() or state.st_nlink != 1:
        raise ValueError(f"Nonregular original material: {file}")
    if state.st_size != ref["bytes"] or file_digest(file) != ref["sha256"]:
        raise ValueError(f"Changed original material: {file}")
    return file.read_bytes()


def member(archive, name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Unsafe original member path")
    entries = [m for m in archive.getmembers() if m.name == name]
    if len(entries) != 1:
        raise ValueError(f"Missing or repeated original member: {name}")
    m = entries[0]
    if not m.isfile() or m.issym() or m.islnk() or m.size > 8 * 1024 * 1024:
        raise ValueError(f"Nonregular or oversized original member: {name}")
    return archive.extractfile(m).read()


def collect(materials):
    inputs, originals, components, archives = {}, {}, [], []

    def load(relative, repository=False):
        raw = ((ROOT if repository else materials) / relative).read_bytes()
        inputs[relative] = digest(raw)
        return json.loads(raw)

    def lock(name):
        return load("resources/" + name, True)

    def verified_inventory(collection, public_name):
        public = load("docs/releases/" + public_name, True)
        prefix = "artifacts/license-materials/" + collection + "/"
        for ref in public["evidence"]:
            if ref["path"].startswith(prefix):
                checked(materials / ref["path"].removeprefix("artifacts/license-materials/"), ref)
        return load(collection + "/inventory.json")

    def open_archive(file, ref):
        checked(file, ref)
        archives.append({"file": str(file.relative_to(materials)), "bytes": ref["bytes"], "sha256": ref["sha256"]})
        return tarfile.open(file, "r:*")

    def add(component, original_path, content, ref, kind):
        p = PurePosixPath(original_path)
        if p.is_absolute() or ".." in p.parts or not p.parts:
            raise ValueError("Unsafe notice reference")
        h = digest(content)
        if len(content) != ref["bytes"] or h != ref["sha256"]:
            raise ValueError("Notice member differs from retained material")
        originals[h] = base64.b64encode(content).decode("ascii")
        component["notices"].append({"originalPath": original_path, "kind": kind, "bytes": len(content), "sha256": h, "file": h + ".txt"})

    pin = lock("biber-build-provenance.lock.json")
    source_lock = lock("runtime-license-sources.lock.json")
    cpan_lock = lock("biber-cpan-sources.lock.json")
    native_lock = lock("biber-native-sources.lock.json")
    if cpan_lock["biberEvidenceLockSha256"] != inputs["resources/biber-build-provenance.lock.json"]:
        raise ValueError("CPAN materials target a different Biber")
    if native_lock["biberEvidenceLockSha256"] != inputs["resources/biber-build-provenance.lock.json"]:
        raise ValueError("Native materials target a different Biber")
    build = verified_inventory("biber-build", "biber-build-verification.json")
    cpan = verified_inventory("biber-cpan", "biber-cpan-verification.json")
    payload = load("biber-build/payload-inventory.json")
    matches = load("biber-cpan/source-matches.json")
    native = load("biber-native/inventory.json")
    native_public = load("docs/releases/biber-native-verification.json", True)
    checked(materials / "biber-native/inventory.json", native_public["retainedInventory"])
    for record in [build, cpan, native]:
        if record["arm64Binary"] != pin["arm64Binary"]:
            raise ValueError("Collected materials target a different binary")

    ref = next(s for s in source_lock["sources"] if s["id"] == "biber")
    if ref["commit"] != pin["sourceCommit"] or ref["version"] != pin["biberVersion"]:
        raise ValueError("Biber source identity changed")
    source = next(s for s in load("compiler-sources/inventory.json")["sources"] if s["id"] == "biber")
    if any(source[k] != ref[k] for k in ["commit", "version", "bytes", "sha256"]):
        raise ValueError("Retained Biber source identity changed")
    c = {"id": "biber-" + ref["version"], "kind": "bibliography-helper-source", "version": ref["version"], "source": ref, "declarationNote": "README names Artistic 2.0; Build.PL declares perl. Both original declarations are preserved without resolving that discrepancy.", "notices": []}
    with open_archive(materials / "compiler-sources/biber" / ref["archive"], ref) as archive:
        for item in source["materials"]:
            content = checked(materials / "compiler-sources/biber/materials" / item["path"], item)
            if content != member(archive, "biber-" + ref["commit"] + "/" + item["path"]):
                raise ValueError("Changed Biber declaration")
            add(c, item["path"], content, item, "original-declaration-document")
    license_ref = cpan_lock["biberLicenseText"]
    content = checked(materials / "biber-cpan/materials/biber/Artistic-2.0.txt", license_ref)
    c["supplementalSources"] = [license_ref]
    add(c, "Artistic-2.0.txt", content, license_ref, "complete-license-text")
    components.append(c)

    for source in payload["foundationSources"]:
        ref = next(s for s in pin["foundationSources"] if s["id"] == source["id"])
        if any(source[k] != ref[k] for k in ref):
            raise ValueError("Changed foundation source")
        c = {"id": source["id"], "kind": "perl-and-packager-notice-superset", "version": source["version"], "declaredLicense": source["licenseDeclaration"], "source": ref, "notices": []}
        with open_archive(materials / "biber-build/sources" / source["archive"], ref) as archive:
            for item in source["materials"]:
                if not NOTICE.fullmatch(PurePosixPath(item["path"]).name):
                    continue
                content = checked(materials / "biber-build/sources" / source["id"] / "materials" / item["path"], item)
                if content != member(archive, source["root"] + "/" + item["path"]):
                    raise ValueError("Changed foundation notice")
                add(c, item["path"], content, item, "original-notice")
        components.append(c)

    for source in matches["sources"]:
        ref = next(s for s in cpan_lock["sources"] if s["id"] == source["id"])
        if any(source[k] != ref[k] for k in ref):
            raise ValueError("Changed CPAN source")
        c = {"id": source["id"], "kind": "cpan-source-notice-documents", "version": source["version"], "declaredLicense": source["declaredLicense"], "source": ref, "standaloneNoticeFiles": source["standaloneNoticeFiles"], "notices": []}
        anchors = {a["source"] for a in source.get("anchors", [])}
        generators = {a["source"] for a in source.get("generatedAnchors", [])}
        with open_archive(materials / "biber-cpan/sources" / source["archive"], ref) as archive:
            for item in source["materials"]:
                name = item["path"]
                standalone = name in source["standaloneNoticeFiles"]
                readme = "/" not in name and re.fullmatch(r"README(?:[._-].*)?", name, re.I)
                if not (standalone or readme or name in anchors or name in generators):
                    continue
                content = checked(materials / "biber-cpan/materials" / source["id"] / name, item)
                if content != member(archive, source["root"] + "/" + name):
                    raise ValueError("Changed CPAN notice document")
                kind = "original-notice" if standalone else ("generator-source-document" if name in generators else "complete-source-or-readme-document")
                add(c, name, content, item, kind)
        components.append(c)

    for source in native["sources"]:
        ref = next(s for s in native_lock["sources"] if s["name"] == source["name"])
        if any(source[k] != ref[k] for k in ref):
            raise ValueError("Changed native source")
        c = {"id": source["name"] + "-" + source["version"], "kind": "native-library-source-material-superset", "version": source["version"], "source": ref, "versionBasis": "Original source materials match inspected version evidence; exact vendor builds and patches remain unproven.", "notices": []}
        with open_archive(materials / "biber-native/sources" / source["archive"], ref) as archive:
            for item in source["materials"]:
                content = checked(materials / "biber-native/materials" / source["name"] / item["path"], item)
                if content != member(archive, source["root"] + "/" + item["path"]):
                    raise ValueError("Changed native source material")
                kind = "original-notice" if NOTICE.fullmatch(PurePosixPath(item["path"]).name) else "complete-source-or-declaration-document"
                add(c, item["path"], content, item, kind)
        components.append(c)

    if len({c["id"] for c in components}) != len(components) or not all(c["notices"] for c in components):
        raise ValueError("Missing or repeated notice component")
    payload_bytes = json.dumps(originals, sort_keys=True, separators=(",", ":")).encode()
    compressed = gzip.compress(payload_bytes, mtime=0)
    text_bytes = sum(len(base64.b64decode(v)) for v in originals.values())
    if len(payload_bytes) > 16 * 1024 * 1024 or len(compressed) > 4 * 1024 * 1024 or text_bytes > 8 * 1024 * 1024:
        raise ValueError("Notice collection exceeds packaging limits")
    index = {"schemaVersion": 1, "compiler": "Biber", "compilerVersion": pin["biberVersion"], "compilerSourceCommit": pin["sourceCommit"], "originalCompilerSha256": pin["arm64Binary"]["sha256"], "completeBinarySbom": False, "scope": "Original Biber, Perl/PAR, CPAN and native-library notice/declaration materials. Complete source and README documents preserve embedded license statements. Supersets and unresolved source/version/grant obligations remain explicit; this is not final linked-component mapping or redistribution approval.", "inputs": inputs, "components": components, "originalNoticeReferences": sum(len(c["notices"]) for c in components), "uniqueOriginalTexts": len(originals), "expandedTextBytes": text_bytes, "payload": {"file": "ORIGINALS.json.gz", "bytes": len(compressed), "sha256": digest(compressed), "expandedJsonBytes": len(payload_bytes), "expandedJsonSha256": digest(payload_bytes)}, "verifiedArchives": archives, "collectorSha256": file_digest(Path(__file__))}
    for relative, h in inputs.items():
        if file_digest((ROOT if relative.startswith(("resources/", "docs/")) else materials) / relative) != h:
            raise ValueError("A source index changed during collection")
    index_bytes = (json.dumps(index, indent=2) + "\n").encode()
    output = ROOT / "artifacts/license-materials/biber-notices" / digest(index_bytes)
    output.mkdir(parents=True, exist_ok=True)
    for name, content in [("SOURCES.json", index_bytes), ("ORIGINALS.json.gz", compressed)]:
        target = output / name
        if target.exists():
            if target.is_symlink() or not target.is_file() or target.read_bytes() != content:
                raise ValueError("An immutable prior result differs")
        else:
            with target.open("xb") as stream:
                stream.write(content)
    return {"passed": True, "output": str(output), "components": len(components), "archives": len(archives), "noticeReferences": index["originalNoticeReferences"], "uniqueOriginalTexts": len(originals), "expandedTextBytes": text_bytes, "compressedBytes": len(compressed)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--materials", type=Path, default=ROOT / "artifacts/license-materials")
    args = parser.parse_args()
    print(json.dumps(collect(args.materials.resolve()), indent=2))
