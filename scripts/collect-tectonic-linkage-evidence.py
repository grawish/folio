#!/usr/bin/env python3
"""Verify source-reachable native-linkage evidence for Folio's packaged Tectonic executable.

Re-derives every claim in resources/tectonic-linkage-anchors.lock.json directly
from the exact binary bytes by bounded, dependency-free Mach-O parsing (no
otool/nm/execution). It never loads or executes the compiler, never infers a
library's presence from anything other than a byte-identical code reference or
an exact, uniquely occurring version string, and fails closed on any identity,
offset or count mismatch. This is linkage-evidence collection, not a complete
static-linkage inventory, native build reproduction or redistribution review:
absence of an anchor here does not establish a library is unlinked, and a
confirmed anchor does not by itself complete LIC-03.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "resources/tectonic-linkage-anchors.lock.json"
PROVENANCE_LOCK = ROOT / "resources/compiler-build-provenance.lock.json"
NATIVE_SOURCES_LOCK = ROOT / "resources/native-license-sources.lock.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


class MachO:
    """Bounded, read-only parser for one non-fat arm64 Mach-O executable."""

    def __init__(self, data):
        if len(data) < 32:
            raise ValueError("Mach-O header truncated")
        magic, cputype, cpusubtype, filetype, ncmds, sizeofcmds, flags, _reserved = (
            struct.unpack_from("<8I", data, 0)
        )
        if magic != 0xFEEDFACF:
            raise ValueError("Expected a 64-bit little-endian Mach-O executable")
        if cputype != 0x0100000C:
            raise ValueError("Expected the arm64 CPU type")
        if filetype != 2:
            raise ValueError("Expected an MH_EXECUTE file type")
        if not 1 <= ncmds <= 512 or sizeofcmds > len(data) - 32:
            raise ValueError("Invalid Mach-O load command bounds")
        self.data = data
        self.segments = []
        self.dylibs = []
        symtab = None
        offset = 32
        for _ in range(ncmds):
            if offset + 8 > 32 + sizeofcmds:
                raise ValueError("Truncated Mach-O load command")
            cmd, cmdsize = struct.unpack_from("<2I", data, offset)
            if cmdsize < 8 or cmdsize % 4 or offset + cmdsize > 32 + sizeofcmds:
                raise ValueError("Invalid Mach-O load command length")
            if cmd == 0x19:  # LC_SEGMENT_64
                if cmdsize < 72:
                    raise ValueError("Truncated Mach-O segment command")
                segname = data[offset + 8 : offset + 24].rstrip(b"\0").decode("ascii")
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from(
                    "<4Q", data, offset + 24
                )
                if fileoff + filesize > len(data) or filesize > vmsize:
                    raise ValueError("Invalid Mach-O segment extent")
                self.segments.append((segname, vmaddr, vmsize, fileoff, filesize))
            elif cmd == 0x2:  # LC_SYMTAB
                if cmdsize != 24:
                    raise ValueError("Invalid Mach-O symtab command")
                if symtab is not None:
                    raise ValueError("Duplicate Mach-O symtab command")
                symoff, nsyms, stroff, strsize = struct.unpack_from(
                    "<4I", data, offset + 8
                )
                if nsyms > 2_000_000 or symoff + nsyms * 16 > len(data) or stroff + strsize > len(data):
                    raise ValueError("Invalid Mach-O symtab bounds")
                symtab = (symoff, nsyms, stroff, strsize)
            elif cmd == 0xC:  # LC_LOAD_DYLIB
                if cmdsize < 24:
                    raise ValueError("Truncated Mach-O dylib command")
                name_off, _timestamp, current, compat = struct.unpack_from(
                    "<4I", data, offset + 8
                )
                if not 24 <= name_off < cmdsize:
                    raise ValueError("Invalid Mach-O dylib name offset")
                end = data.find(b"\0", offset + name_off, offset + cmdsize)
                if end < 0:
                    raise ValueError("Unterminated Mach-O dylib name")
                name = data[offset + name_off : end].decode("utf-8")
                version = lambda v: f"{v >> 16}.{(v >> 8) & 255}.{v & 255}"
                self.dylibs.append(
                    {
                        "name": name,
                        "currentVersion": version(current),
                        "compatibilityVersion": version(compat),
                    }
                )
            offset += cmdsize
        if offset != 32 + sizeofcmds:
            raise ValueError("Mach-O load commands did not consume the declared size")
        if symtab is None:
            raise ValueError("Missing Mach-O symtab command")
        self._symtab = symtab

    def vmaddr_to_fileoff(self, addr):
        for _segname, vmaddr, vmsize, fileoff, filesize in self.segments:
            if vmaddr <= addr < vmaddr + vmsize:
                position = fileoff + (addr - vmaddr)
                if position >= fileoff + filesize:
                    raise ValueError("Address falls in an unmapped (zero-fill) region")
                return position
        raise ValueError("Address is outside every Mach-O segment")

    def defined_symbol_offsets(self, names):
        """Return {name: fileOffset} for exactly the requested defined symbols.

        Requires each symbol to be a Mach-O N_SECT-defined symbol (local or
        external) whose address maps into a mapped file region. Raises if any
        requested name is missing, duplicated, or ambiguous.
        """
        wanted = set(names)
        symoff, nsyms, stroff, strsize = self._symtab
        found = {}
        for i in range(nsyms):
            n_strx, n_type, _n_sect, _n_desc, n_value = struct.unpack_from(
                "<IBBHQ", self.data, symoff + i * 16
            )
            if n_strx == 0 or n_strx >= strsize:
                continue
            end = self.data.find(b"\0", stroff + n_strx, stroff + strsize)
            if end < 0:
                raise ValueError("Unterminated Mach-O symbol name")
            name = self.data[stroff + n_strx : end].decode("utf-8", "strict")
            if name not in wanted:
                continue
            if (n_type & 0x0E) != 0x0E:  # not N_SECT (defined-in-section)
                continue
            if name in found:
                raise ValueError("Duplicate defined symbol: " + name)
            found[name] = self.vmaddr_to_fileoff(n_value)
        missing = wanted - found.keys()
        if missing:
            raise ValueError("Missing defined symbol(s): " + ", ".join(sorted(missing)))
        return found

    def decode_adrp_add(self, adrp_fileoff):
        """Decode an ADRP+ADD(imm) pair at adrp_fileoff, returning the target vmaddr."""
        i0, i1 = struct.unpack_from("<2I", self.data, adrp_fileoff)
        if (i0 >> 31) != 1 or ((i0 >> 24) & 0x1F) != 0x10:
            raise ValueError("Expected an ADRP instruction")
        rd1 = i0 & 0x1F
        immlo = (i0 >> 29) & 0x3
        immhi = (i0 >> 5) & 0x7FFFF
        imm21 = (immhi << 2) | immlo
        if imm21 & (1 << 20):
            imm21 -= 1 << 21
        for _segname, vmaddr, _vmsize, fileoff, filesize in self.segments:
            if fileoff <= adrp_fileoff < fileoff + filesize:
                pc = vmaddr + (adrp_fileoff - fileoff)
                break
        else:
            raise ValueError("ADRP instruction is outside every mapped segment")
        page = (pc & ~0xFFF) + (imm21 << 12)
        sf, op, s_bit = (i1 >> 31) & 1, (i1 >> 30) & 1, (i1 >> 29) & 1
        fixed = (i1 >> 23) & 0x3F
        if sf != 1 or op != 0 or s_bit != 0 or fixed != 0b100010:
            raise ValueError("Expected an ADD (immediate) instruction")
        sh = (i1 >> 22) & 1
        imm12 = (i1 >> 10) & 0xFFF
        rn2, rd2 = (i1 >> 5) & 0x1F, i1 & 0x1F
        if rd1 != rn2 or rd1 != rd2:
            raise ValueError("ADRP/ADD register mismatch")
        return page + (imm12 << 12 if sh else imm12)


def check_string_anchor(data, anchor):
    text = anchor["text"].encode("utf-8")
    needle = b"\0" + text + b"\0"
    positions, start = [], 0
    while True:
        i = data.find(needle, start)
        if i < 0:
            break
        positions.append(i + 1)
        start = i + 1
    if len(positions) != anchor["textOccurrences"]:
        raise ValueError(
            f"{anchor['family']}: expected {anchor['textOccurrences']} occurrence(s) of "
            f"{anchor['text']!r}, found {len(positions)}"
        )
    if positions and positions[0] != anchor["textFileOffset"]:
        raise ValueError(f"{anchor['family']}: version text moved in the binary")
    if "resourceNamePrefixOccurrences" in anchor:
        prefix = text + b"/"
        count = data.count(prefix)
        if count != anchor["resourceNamePrefixOccurrences"]:
            raise ValueError(
                f"{anchor['family']}: resource-name prefix count changed "
                f"({count} != {anchor['resourceNamePrefixOccurrences']})"
            )


def check_code_reference(macho, anchor, reference):
    target = macho.decode_adrp_add(reference["adrpFileOffset"])
    target_fileoff = macho.vmaddr_to_fileoff(target)
    if target_fileoff != anchor["textFileOffset"]:
        raise ValueError(
            f"{anchor['family']}: code reference at {reference['adrpFileOffset']} "
            f"no longer targets the locked version string"
        )


def collect():
    if LOCK.is_symlink() or PROVENANCE_LOCK.is_symlink() or NATIVE_SOURCES_LOCK.is_symlink():
        raise ValueError("Linked lock file is not permitted")
    lock_bytes = LOCK.read_bytes()
    lock = json.loads(lock_bytes)
    if lock["schemaVersion"] != 1:
        raise ValueError("Unsupported tectonic-linkage-anchors schema version")

    provenance_bytes = PROVENANCE_LOCK.read_bytes()
    if digest(provenance_bytes) != lock["compilerBuildProvenanceLockSha256"]:
        raise ValueError("compiler-build-provenance.lock.json changed under this lock")
    provenance = json.loads(provenance_bytes)

    native_sources_bytes = NATIVE_SOURCES_LOCK.read_bytes()
    if digest(native_sources_bytes) != lock["nativeLicenseSourcesLockSha256"]:
        raise ValueError("native-license-sources.lock.json changed under this lock")
    native_sources = json.loads(native_sources_bytes)
    port_versions = {s["name"]: s["version"] for s in native_sources["sources"]}

    binary_path = ROOT / lock["binary"]["path"]
    if binary_path.is_symlink() or not binary_path.is_file():
        raise ValueError("Tectonic binary is missing, linked or not a regular file")
    data = binary_path.read_bytes()
    if len(data) != lock["binary"]["bytes"] or digest(data) != lock["binary"]["sha256"]:
        raise ValueError("Tectonic binary differs from the pinned identity")
    if len(data) != provenance["compiler"]["binaryBytes"] or digest(data) != provenance["compiler"]["binarySha256"]:
        raise ValueError("Tectonic binary differs from compiler-build-provenance.lock.json")

    macho = MachO(data)

    # Declared dynamic dependencies must match exactly, in order.
    if macho.dylibs != lock["declaredDynamicDependencies"]:
        raise ValueError("Declared dynamic dependency list changed")

    # Version-string anchors, with code-reference proof where recorded.
    confirmed_families = []
    for anchor in lock["versionStringAnchors"]:
        expected_version = port_versions.get(anchor["family"])
        if expected_version is None or expected_version != anchor["lockedPortVersion"]:
            raise ValueError(
                f"{anchor['family']}: native-license-sources.lock.json version no longer matches"
            )
        check_string_anchor(data, anchor)
        for reference in anchor["codeReferences"]:
            check_code_reference(macho, anchor, reference)
        confirmed_families.append(
            {
                "family": anchor["family"],
                "lockedPortVersion": anchor["lockedPortVersion"],
                "text": anchor["text"],
                "textFileOffset": anchor["textFileOffset"],
                "codeReferences": len(anchor["codeReferences"]),
            }
        )

    # Defined-symbol families: recompute every symbol's file offset and
    # require an exact match against the locked value.
    symbol_families = []
    for group in lock["definedSymbolFamilies"]:
        expected_version = port_versions.get(group["family"])
        if expected_version is None or expected_version != group["lockedPortVersion"]:
            raise ValueError(
                f"{group['family']}: native-license-sources.lock.json version no longer matches"
            )
        offsets = macho.defined_symbol_offsets(group["symbols"].keys())
        if offsets != group["symbols"]:
            raise ValueError(f"{group['family']}: defined symbol file offsets changed")
        symbol_families.append(
            {"family": group["family"], "lockedPortVersion": group["lockedPortVersion"], "symbols": len(offsets)}
        )

    unconfirmed = []
    for entry in lock["unconfirmedNativePorts"]:
        expected_version = port_versions.get(entry["family"])
        if expected_version is None or expected_version != entry["lockedPortVersion"]:
            raise ValueError(
                f"{entry['family']}: native-license-sources.lock.json version no longer matches"
            )
        unconfirmed.append({"family": entry["family"], "lockedPortVersion": entry["lockedPortVersion"], "reason": entry["reason"]})

    report = {
        "schemaVersion": 1,
        "releaseAuditComplete": False,
        "scope": lock["scope"],
        "collectorSha256": digest(Path(__file__).read_bytes()),
        "lockSha256": digest(lock_bytes),
        "compilerBuildProvenanceLockSha256": lock["compilerBuildProvenanceLockSha256"],
        "nativeLicenseSourcesLockSha256": lock["nativeLicenseSourcesLockSha256"],
        "binary": lock["binary"],
        "declaredDynamicDependencies": macho.dylibs,
        "confirmedVersionStringAnchors": confirmed_families,
        "confirmedDefinedSymbolFamilies": symbol_families,
        "unconfirmedNativePorts": unconfirmed,
        "summary": {
            "versionStringAnchorsConfirmed": len(confirmed_families),
            "codeReferencesConfirmed": sum(f["codeReferences"] for f in confirmed_families),
            "definedSymbolFamiliesConfirmed": len(symbol_families),
            "definedSymbolsConfirmed": sum(f["symbols"] for f in symbol_families),
            "unconfirmedNativePorts": len(unconfirmed),
        },
        "limits": (
            "Confirms named-function/version-string code references and exact defined-symbol "
            "file offsets for eight of eleven native build ports at this exact binary revision. "
            "It does not confirm expat, fontconfig or gperf linkage (no runtime symbol or "
            "embedded version string was found for any of the three), does not distinguish "
            "static-library source/build patches from unmodified upstream code, and is not a "
            "complete SBOM, build reproduction or redistribution review."
        ),
    }
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    result = collect()
    print(json.dumps(result["summary"], indent=2))
