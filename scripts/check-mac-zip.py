"""Validate a Mac app ZIP against an independently inventoried app before ditto.

This developer-only check streams members without extracting them. AppleDouble
metadata is bounded and may only accompany a real entry in the expected app.
"""

import hashlib
import json
import stat
import struct
import sys
import zipfile
import zlib


def read_member(container, raw, info, limit, capture=False):
    # ZipExtFile checks names and overlapping/local headers, but caps output at
    # the declared file_size. Independently consume the entire compressed stream
    # so a false size/CRC cannot hide additional output from ditto's extractor.
    with container.open(info):
        pass
    raw.seek(info.header_offset)
    header = raw.read(30)
    if len(header) != 30 or header[:4] != b"PK\x03\x04":
        raise ValueError("Invalid ZIP local header")
    name_size, extra_size = struct.unpack_from("<HH", header, 26)
    raw.seek(name_size + extra_size, 1)
    remaining = info.compress_size
    inflater = zlib.decompressobj(-15) if info.compress_type == zipfile.ZIP_DEFLATED else None
    total = 0
    crc = 0
    digest = hashlib.sha256()
    parts = []
    while remaining:
        block = raw.read(min(remaining, 1024 * 1024))
        if not block:
            raise ValueError("Truncated ZIP member: " + info.filename)
        remaining -= len(block)
        while block:
            data = inflater.decompress(block, min(1024 * 1024, limit - total + 1)) if inflater else block
            block = inflater.unconsumed_tail if inflater else b""
            total += len(data)
            if total > limit:
                raise ValueError("ZIP member has extra decompressed output: " + info.filename)
            if inflater and inflater.unused_data:
                raise ValueError("ZIP member has trailing compressed data: " + info.filename)
            digest.update(data)
            crc = zlib.crc32(data, crc)
            if capture:
                parts.append(data)
    if (inflater and not inflater.eof) or total != info.file_size or crc != info.CRC:
        raise ValueError("ZIP size, stream or CRC differs: " + info.filename)
    return digest.hexdigest(), b"".join(parts) if capture else None


def check_archive(archive, inventory, app_name):
    expected = {}
    for row in inventory["entries"]:
        name = app_name + ("" if row["path"] == "." else "/" + row["path"])
        expected[name + ("/" if row["kind"] == "directory" else "")] = row
    if not expected or len(expected) > 20000:
        raise ValueError("Invalid expected app inventory")
    seen = set()
    metadata_bytes = 0
    metadata_entries = 0
    with zipfile.ZipFile(archive) as container, open(archive, "rb") as raw:
        entries = container.infolist()
        if len(entries) > 40000:
            raise ValueError("ZIP exceeds the entry limit")
        for info in entries:
            name = info.filename
            if (
                name != info.orig_filename
                or name in seen
                or "\\" in name
                or name.startswith("/")
                or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
                or info.flag_bits & 1
                or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            ):
                raise ValueError("Unsafe, duplicate or unsupported ZIP member: " + name)
            seen.add(name)
            mode = info.external_attr >> 16
            if name.startswith("__MACOSX/"):
                # ditto stores macOS metadata next to the corresponding app entry.
                relative = name[len("__MACOSX/"):]
                parent, _, leaf = relative.rpartition("/")
                if info.is_dir():
                    if not stat.S_ISDIR(mode) or info.file_size or (
                        relative and relative not in expected
                    ):
                        raise ValueError("Unexpected AppleDouble directory: " + name)
                    read_member(container, raw, info, 0)
                    continue
                target = (parent + "/" if parent else "") + leaf[2:]
                if (
                    not leaf.startswith("._")
                    or not stat.S_ISREG(mode)
                    or (target not in expected and target + "/" not in expected)
                    or info.file_size > 1024 * 1024
                ):
                    raise ValueError("Unexpected AppleDouble member: " + name)
                metadata_bytes += info.file_size
                metadata_entries += 1
                if metadata_bytes > 16 * 1024 * 1024:
                    raise ValueError("AppleDouble metadata exceeds 16 MiB")
                _, data = read_member(container, raw, info, info.file_size, capture=True)
                if len(data) < 26 or data[:8] != bytes.fromhex("0005160700020000"):
                    raise ValueError("Invalid AppleDouble header: " + name)
                count = struct.unpack_from(">H", data, 24)[0]
                end = 26 + 12 * count
                if end > len(data):
                    raise ValueError("Truncated AppleDouble table: " + name)
                regions = []
                for index in range(count):
                    _, offset, size = struct.unpack_from(">III", data, 26 + 12 * index)
                    if offset < end or offset + size > len(data):
                        raise ValueError("Invalid AppleDouble range: " + name)
                    regions.append((offset, offset + size))
                regions.sort()
                if any(a[1] > b[0] for a, b in zip(regions, regions[1:])):
                    raise ValueError("Overlapping AppleDouble data: " + name)
                continue
            row = expected.get(name)
            if row is None:
                raise ValueError("Unexpected ZIP member: " + name)
            kind = {"directory": stat.S_IFDIR, "file": stat.S_IFREG, "symlink": stat.S_IFLNK}
            if stat.S_IFMT(mode) != kind[row["kind"]] or stat.S_IMODE(mode) != row["mode"]:
                raise ValueError("ZIP file type or permissions differ: " + name)
            if row["kind"] == "directory":
                if info.file_size != 0:
                    raise ValueError("Nonempty ZIP directory: " + name)
                read_member(container, raw, info, 0)
                continue
            content = row["target"].encode("utf-8") if row["kind"] == "symlink" else None
            length = len(content) if content is not None else row["bytes"]
            digest = hashlib.sha256(content).hexdigest() if content is not None else row["sha256"]
            if info.file_size != length:
                raise ValueError("ZIP member size differs: " + name)
            actual, _ = read_member(container, raw, info, length)
            if actual != digest:
                raise ValueError("ZIP member bytes differ: " + name)
    if set(expected) - seen:
        raise ValueError("ZIP omits expected app entries")
    return {"matchedEntries": len(expected), "metadataEntries": metadata_entries,
            "metadataBytes": metadata_bytes}


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: check-mac-zip.py archive.zip inventory.json App.app")
    with open(sys.argv[2], encoding="utf-8") as stream:
        inventory = json.load(stream)
    print(json.dumps(check_archive(sys.argv[1], inventory, sys.argv[3])))
