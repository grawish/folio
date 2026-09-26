"""Collect native build-port sources and notices without executing source code.

Python 3.11+. Inputs are bound to the verified Tectonic build and vcpkg recipes.
This inventory includes build tools/unused ports, not the final linked app SBOM.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import time
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location("materials", Path(__file__).with_name("collect-rust-license-materials.py"))
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)
HOSTS = frozenset({"github.com", "codeload.github.com", "release-assets.githubusercontent.com",
                   "sourceware.org", "ftp.gnu.org", "gitlab.freedesktop.org"})


def source_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.username or
            parsed.password or parsed.port not in (None, 443) or parsed.fragment):
        raise ValueError("Native source URL is outside the approved HTTPS hosts")
    return url


class SourceRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return super().redirect_request(request, fp, code, message, headers, source_url(url))


def check_source(data, source):
    if (not 0 < len(data) <= materials.MAX_ARCHIVE or len(data) != source["bytes"] or
            hashlib.sha512(data).hexdigest() != source["sha512"] or
            materials.digest(data) != source["sha256"]):
        raise ValueError("Native source differs from its locked size or archive digests")
    return data


def reviewed_sources(lock_bytes, build_bytes, vcpkg_bytes):
    lock, build = json.loads(lock_bytes), json.loads(build_bytes)
    if (lock.get("schemaVersion") != 1 or build.get("schemaVersion") != 1 or
            lock["buildEvidenceLockSha256"] != materials.digest(build_bytes) or
            lock["vcpkgCommit"] != build["vcpkg"]["commit"] or
            materials.digest(vcpkg_bytes) != build["vcpkg"]["sha256"] or
            len(vcpkg_bytes) != build["vcpkg"]["bytes"]):
        raise ValueError("Native payload lock differs from the verified compiler build")
    ports = {p["name"]: p for p in build["vcpkg"]["ports"]}
    sources = lock["sources"]
    if not isinstance(sources, list) or not 0 < len(sources) <= 32:
        raise ValueError("Invalid native source inventory")
    archive, files = materials.archive_files(vcpkg_bytes, "vcpkg-" + lock["vcpkgCommit"])
    names, archives, checked = set(), set(), []
    with archive:
        for source in sources:
            name = source["name"]
            if (not re.fullmatch(r"[a-z0-9-]+", name) or name in names or name not in ports or
                    source["version"] != ports[name]["version"] or source["features"] != ports[name]["features"]):
                raise ValueError("Native payload port differs from the original installed build")
            names.add(name)
            for field in ("archive", "archiveRoot"):
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", source[field]):
                    raise ValueError("Native archive names must be plain filenames")
            if source["archive"] in archives:
                raise ValueError("Duplicate native archive destination")
            archives.add(source["archive"])
            source_url(source["url"])
            if (type(source["bytes"]) is not int or not 0 < source["bytes"] <= materials.MAX_ARCHIVE or
                    not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]) or
                    not re.fullmatch(r"[a-f0-9]{128}", source["sha512"])):
                raise ValueError("Invalid native source size or digest")
            prefix = "ports/" + name + "/"
            recipe = materials.read_member(archive, files[prefix + "portfile.cmake"])
            manifest = materials.read_member(archive, files[prefix + "vcpkg.json"])
            if (materials.digest(recipe) != source["recipeSha256"] or
                    materials.digest(manifest) != source["manifestSha256"] or
                    source["sha512"] not in re.findall(r"SHA512\s+([a-f0-9]{128})", recipe.decode())):
                raise ValueError("Native source digest does not match its reviewed vcpkg recipe")
            required = source["requiredNotices"]
            if (not isinstance(required, list) or not 0 < len(required) <= 32 or
                    len(set(required)) != len(required)):
                raise ValueError("Invalid native notice inventory")
            for relative in required:
                if not materials.safe_member(source["archiveRoot"] + "/" + relative, source["archiveRoot"]):
                    raise ValueError("A required notice must be a file")
            checked.append({**source, "declaredLicense": json.loads(manifest).get("license")})
    return lock, checked


def download_source(source, cache, offline):
    filename = cache / source["archive"]
    for parent in [filename, *filename.parents]:
        if parent.is_symlink():
            raise ValueError("Native source cache cannot use symbolic links")
    try:
        stat = filename.lstat()
        if not filename.is_file() or stat.st_size != source["bytes"]:
            raise ValueError("Native source cache size or type differs from its lock")
        return check_source(filename.read_bytes(), source)
    except FileNotFoundError:
        if offline:
            raise ValueError("Native source is missing from the offline cache")
    request = urllib.request.Request(source_url(source["url"]), headers={
        "User-Agent": "Folio-source-inventory/1 (https://github.com/grawish/folio)"})
    deadline = time.monotonic() + 120
    with urllib.request.build_opener(SourceRedirect).open(request, timeout=30) as response:
        source_url(response.url)
        chunks, size = [], 0
        while chunk := response.read(64 * 1024):
            size += len(chunk)
            if size > source["bytes"] or time.monotonic() > deadline:
                raise ValueError("Native source download exceeded its size or time limit")
            chunks.append(chunk)
    data = check_source(b"".join(chunks), source)
    materials.atomic_write(filename, data)
    return data


def source_notices(data, source):
    check_source(data, source)
    archive, files = materials.archive_files(data, source["archiveRoot"])
    with archive:
        names = {p for p in files if materials.NOTICE.fullmatch(PurePosixPath(p).name)}
        names.update(source["requiredNotices"])
        if len(names) > 512 or any(name not in files for name in names):
            raise ValueError("Native source notice inventory is missing or exceeds its bounds")
        selected = {name: materials.read_member(archive, files[name]) for name in sorted(names)}
        if sum(map(len, selected.values())) > 16 * 1024 * 1024:
            raise ValueError("Native notice texts exceed the material budget")
        return selected


def collect(source, cache, output, offline):
    data = download_source(source, cache, offline)
    notices = source_notices(data, source)
    directory = output / "ports" / source["name"]
    records = []
    for name, content in notices.items():
        materials.atomic_write(directory / "notices" / name, content)
        records.append({"path": name, "bytes": len(content), "sha256": materials.digest(content)})
    materials.atomic_write(directory / source["archive"], data)
    return {**source, "materials": records,
            "scope": "Source payload of an installed upstream build port; final binary linkage is not asserted."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=3)
    args = parser.parse_args()
    lock_bytes = Path("resources/native-license-sources.lock.json").read_bytes()
    build_bytes = Path("resources/compiler-build-provenance.lock.json").read_bytes()
    native = json.loads(build_bytes)["vcpkg"]
    vcpkg_bytes = materials.verified_bytes(Path(".cache/license-sources") / native["archive"], native["sha256"], native["bytes"])
    lock, sources = reviewed_sources(lock_bytes, build_bytes, vcpkg_bytes)
    output = Path("artifacts/license-materials/compiler-native")
    report = {"schemaVersion": 1, "scope": lock["scope"], "releaseAuditComplete": False,
              "collectorSha256": materials.digest(Path(__file__).read_bytes()),
              "lockSha256": materials.digest(lock_bytes), "buildEvidenceLockSha256": materials.digest(build_bytes),
              "vcpkgCommit": lock["vcpkgCommit"], "ports": [], "errors": [],
              "otherBuildPorts": lock["otherBuildPorts"],
              "pending": ["Determine the exact linked Apple silicon dependency graph and enabled features.",
                          "Review build-helper tool payloads, source/patch sufficiency and redistribution obligations.",
                          "Complete workspace, Biber/Perl, TeX/font and final signed-app materials and SBOM."]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(collect, source, Path(".cache/license-sources/native"), output, args.offline): source for source in sources}
        for future in concurrent.futures.as_completed(futures):
            source = futures[future]
            try:
                result = future.result()
                report["ports"].append(result)
                print(f'{source["name"]}: retained source and {len(result["materials"])} notice files', flush=True)
            except Exception as error:
                report["errors"].append({"name": source["name"], "reason": str(error)})
    report["ports"].sort(key=lambda p: p["name"])
    report["complete"] = not report["errors"]
    filename = "inventory.json" if report["complete"] else "incomplete-inventory.json"
    materials.atomic_write(output / filename, (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps({"complete": report["complete"], "sourcePorts": len(report["ports"]),
                      "noticeFiles": sum(len(p["materials"]) for p in report["ports"]),
                      "output": str(output / filename), "releaseAuditComplete": False}, indent=2))
    if report["errors"]:
        raise SystemExit("Native source inventory is incomplete; inspect incomplete-inventory.json")


if __name__ == "__main__":
    main()
