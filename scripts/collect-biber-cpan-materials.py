"""Collect reviewed Biber CPAN sources and notices without running upstream code.

Requires prepared Biber, its pinned source inputs and Python 3.11+. Only downloads
locked archives. Archive paths and Perl code are never extracted or executed.
"""
import argparse
import collections
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("biber_evidence", ROOT / "scripts/collect-biber-build-evidence.py")
biber = importlib.util.module_from_spec(spec)
spec.loader.exec_module(biber)
shared = biber.shared
PATCH_NAMES = ("AutoLoader.pm", "Pod/Usage.pm", "Tk.pm", "Tk/Widget.pm", "XSLoader.pm", "diagnostics.pm", "utf8_heavy.pl")


def get_input(entry, offline):
    name = entry["archive"]
    cpan = re.fullmatch(r"https://cpan\.metacpan\.org/authors/id/[A-Z0-9]/[A-Z0-9]{2}/[A-Z0-9-]+/" + re.escape(name), entry["url"])
    spdx = entry["url"] == "https://raw.githubusercontent.com/spdx/license-list-data/d46e94e2c78ceede1cfc63cfa0396472d2798d4c/text/Artistic-2.0.txt"
    if (not re.fullmatch(r"[A-Za-z0-9_.+-]+\.(?:tar\.gz|tgz|txt)", name) or not (cpan or spdx) or
            not 0 < entry["bytes"] <= 32 * 1024 * 1024):
        raise ValueError("Invalid CPAN material URL or bounds")
    filename = ROOT / ".cache/license-sources/biber-cpan" / name
    if not filename.exists():
        if offline:
            raise ValueError("Missing offline CPAN input: " + name)
        with urllib.request.urlopen(entry["url"], timeout=60) as response:
            if response.url != entry["url"]:
                raise ValueError("Unexpected CPAN material redirect")
            data = response.read(entry["bytes"] + 1)
        if len(data) != entry["bytes"] or shared.digest(data) != entry["sha256"]:
            raise ValueError("Downloaded CPAN material differs from lock")
        shared.atomic_write(filename, data)
    return biber.verified(filename, entry)


def quoted_string(data, offset):
    # Parse only Perl single-quoted literals: no interpolation or code evaluation.
    if data[offset:offset + 1] != b"'":
        raise ValueError("Expected a static packager replacement string")
    offset += 1
    result = bytearray()
    while offset < len(data):
        char = data[offset]; offset += 1
        if char == 39:
            return bytes(result), offset
        if char == 92 and offset < len(data) and data[offset] in (39, 92):
            char = data[offset]; offset += 1
        result.append(char)
    raise ValueError("Unterminated packager replacement string")


def patch_rules(filter_source, name):
    if name not in PATCH_NAMES:
        raise ValueError("Unreviewed packager patch name")
    match = re.search(rb"'" + re.escape(name.encode()) + rb"'\s*=>\s*\[", filter_source)
    if not match:
        raise ValueError("Missing reviewed packager patch")
    offset, values = match.end(), []
    while offset < len(filter_source):
        while offset < len(filter_source) and filter_source[offset:offset + 1] in b" \r\n\t,":
            offset += 1
        if filter_source[offset:offset + 1] == b"#":
            end = filter_source.find(b"\n", offset)
            if end < 0:
                raise ValueError("Unterminated packager patch comment")
            offset = end + 1
            continue
        if filter_source[offset:offset + 1] == b"]":
            if not values or len(values) % 2:
                raise ValueError("Incomplete packager replacement pairs")
            return list(zip(values[::2], values[1::2]))
        if filter_source[offset:offset + 2] == b"=>":
            offset += 2
            continue
        value, offset = quoted_string(filter_source, offset)
        if not value or len(values) >= 32:
            raise ValueError("Invalid packager replacement bounds")
        values.append(value)
    raise ValueError("Unterminated packager patch")


def transformed(data, name, filter_source):
    result = data.removeprefix(b"\xef\xbb\xbf")
    for before, after in patch_rules(filter_source, name):
        result = result.replace(before, after)
    return result


def payload_index(payload):
    by_hash = collections.defaultdict(list)
    for name, data in payload.items():
        if data:
            by_hash[shared.digest(data)].append(name)
    return by_hash


def match_sources(sources, by_hash, filter_source):
    matches = []
    for name, content in sorted(sources.items()):
        checksum = shared.digest(content)
        if checksum in by_hash:
            matches.append({"source": name, "sourceSha256": checksum, "payload": by_hash[checksum],
                            "payloadSha256": checksum, "transformation": "none"})
        for patch in PATCH_NAMES:
            if name != patch and not name.endswith("/" + patch):
                continue
            changed = transformed(content, patch, filter_source)
            if changed != content and shared.digest(changed) in by_hash:
                matches.append({"source": name, "sourceSha256": checksum, "payload": by_hash[shared.digest(changed)],
                                "payloadSha256": shared.digest(changed), "transformation": "PAR::Filter::PatchContent:" + patch})
    return matches


def verify_anchors(entry, matches, payload):
    if not entry["anchors"]:
        raise ValueError("A CPAN source needs a reviewed anchor")
    for anchor in entry["anchors"]:
        name = anchor["payload"]
        if name not in payload or shared.digest(payload[name]) != anchor["sha256"]:
            raise ValueError("Anchor payload differs from reviewed identity")
        if not any(name in m["payload"] and m["source"] == anchor["source"] and
                   m["transformation"] == anchor["transformation"] for m in matches):
            raise ValueError("Anchor source bytes do not match the bundled module")


def material_names(sources, entry):
    names = {n for n in sources if shared.NOTICE.fullmatch(PurePosixPath(n).name)}
    names.update(n for n in sources if "/" not in n and
                 (re.fullmatch(r"README(?:[._-].*)?", n, re.I) or n in {"Artistic", "META.json", "META.yml", "Makefile.PL", "Build.PL"}))
    names.update(a["source"] for a in entry["anchors"])
    if not names.issubset(sources):
        raise ValueError("A reviewed source material is absent")
    if len({n.casefold() for n in names}) != len(names):
        raise ValueError("Selected source materials collide on a case-insensitive filesystem")
    return sorted(names)


def collect(offline, output):
    lock_bytes = (ROOT / "resources/biber-cpan-sources.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    foundation_bytes = (ROOT / "resources/biber-build-provenance.lock.json").read_bytes()
    if lock["schemaVersion"] != 1 or shared.digest(foundation_bytes) != lock["biberEvidenceLockSha256"]:
        raise ValueError("Biber source lock differs from reviewed payload identity")
    foundation = json.loads(foundation_bytes)
    binary = biber.verified(ROOT / "resources/runtime/mac-arm64/biber", foundation["arm64Binary"])
    loader, files, _ = biber.parse_payload(binary, foundation["reviewedZipDuplicates"])
    payload = {**{"par/" + n: d for n, d in files.items()}, **{"loader/" + n: d for n, d in loader.items()}}
    by_hash = payload_index(payload)
    foundation_sources = {}
    for entry in foundation["foundationSources"]:
        foundation_sources[entry["id"]] = biber.archive_sources(biber.foundation_input(entry, offline), entry["root"])
    packer = foundation_sources["PAR-Packer-" + foundation["packerVersion"]]
    patch_path = "lib/PAR/Filter/PatchContent.pm"
    patch_source = packer[patch_path]
    if shared.digest(patch_source) != lock["packagerFilterSha256"]:
        raise ValueError("Packager patch differs from reviewed source")
    shared.atomic_write(output / "packager" / patch_path, patch_source)
    records, covered, total_bytes = [], set(), 0
    for entry in lock["sources"]:
        if not re.fullmatch(r"[A-Za-z0-9_.+-]+", entry["id"]):
            raise ValueError("Invalid CPAN output identity")
        archive = get_input(entry, offline)
        sources = biber.archive_sources(archive, entry["root"])
        matches = match_sources(sources, by_hash, patch_source)
        verify_anchors(entry, matches, payload)
        names = material_names(sources, entry)
        materials = [biber.file_record(n, sources[n]) for n in names]
        shared.atomic_write(output / "sources" / entry["archive"], archive)
        for name in names:
            shared.atomic_write(output / "materials" / entry["id"] / name, sources[name])
        covered.update(n for m in matches for n in m["payload"])
        total_bytes += len(archive)
        records.append({**entry, "materials": materials, "matches": matches,
                        "standaloneNoticeFiles": [n for n in names if shared.NOTICE.fullmatch(PurePosixPath(n).name) or PurePosixPath(n).name == "Artistic"]})
    foundation_matches = {}
    for name, sources in foundation_sources.items():
        matches = match_sources(sources, by_hash, patch_source)
        foundation_matches[name] = matches
        covered.update(n for m in matches for n in m["payload"])
    biber_lock = json.loads((ROOT / "resources/runtime-license-sources.lock.json").read_bytes())
    source_entry = next(s for s in biber_lock["sources"] if s["id"] == "biber")
    if source_entry["commit"] != foundation["sourceCommit"]:
        raise ValueError("Biber source commit differs from payload provenance")
    biber_sources = biber.archive_sources(biber.verified(ROOT / ".cache/license-sources" / source_entry["archive"], source_entry), "biber-" + source_entry["commit"])
    biber_matches = match_sources(biber_sources, by_hash, patch_source)
    covered.update(n for m in biber_matches for n in m["payload"])
    license_text = get_input(lock["biberLicenseText"], offline)
    shared.atomic_write(output / "materials/biber/Artistic-2.0.txt", license_text)
    for name in ("README.md", "Build.PL"):
        shared.atomic_write(output / "materials/biber" / name, biber_sources[name])
    unmatched = [biber.file_record(n, d) for n, d in sorted(payload.items()) if n not in covered]
    detailed = {"sources": records, "foundationMatches": foundation_matches, "biberMatches": biber_matches,
                "unmatchedPayload": unmatched}
    detailed_bytes = (json.dumps(detailed, indent=2) + "\n").encode()
    shared.atomic_write(output / "source-matches.json", detailed_bytes)
    report = {"schemaVersion": 1, "scope": lock["scope"], "releaseAuditComplete": False,
              "lockSha256": shared.digest(lock_bytes), "collectorSha256": shared.digest(Path(__file__).read_bytes()),
              "payloadCollectorSha256": shared.digest((ROOT / "scripts/collect-biber-build-evidence.py").read_bytes()),
              "sharedCollectorSha256": shared.digest((ROOT / "scripts/collect-rust-license-materials.py").read_bytes()),
              "biberEvidenceLockSha256": shared.digest(foundation_bytes), "arm64Binary": foundation["arm64Binary"],
              "packagerFilterSha256": shared.digest(patch_source), "biberLicenseText": lock["biberLicenseText"],
              "summary": {"sourceArchives": len(records), "archiveBytes": total_bytes,
                          "retainedMaterials": sum(len(r["materials"]) for r in records),
                          "sourcesWithoutStandaloneNotice": [r["id"] for r in records if not r["standaloneNoticeFiles"]],
                          "payloadFiles": len(payload), "sourceMatchedPayloadFiles": len(covered), "unmatchedPayloadFiles": len(unmatched)},
              "evidence": [biber.file_record("source-matches.json", detailed_bytes)],
              "remaining": ["Map generated core/Unicode/autosplit files, native modules and libraries to complete build/source/license evidence.",
                            "Review embedded notice grants, upstream license-metadata discrepancies, final redistribution obligations and the exact-app SBOM."]}
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Require existing checksum-locked inputs")
    args = parser.parse_args()
    output = ROOT / "artifacts/license-materials/biber-cpan"
    try:
        report = collect(args.offline, output)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode())
        raise
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
