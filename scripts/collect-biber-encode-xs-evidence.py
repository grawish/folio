"""Reproduce bundled Encode table symbols from locked enc2xs inputs.

Developer-only macOS audit. Executes the retained enc2xs source in a network-denied,
temporary-write sandbox, then requires its generated encode_t symbols to match the
reviewed arm64 bundle symbols. It does not compile or execute native modules.
"""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


modules = load("encode_modules", "collect-biber-module-materials.py")
cpan = modules.cpan
native, biber, shared = modules.native, modules.biber, modules.shared
sandbox = load("encode_sandbox", "collect-biber-unicode-evidence.py")


def valid_path(name):
    return isinstance(name, str) and name and "\\" not in name and not name.startswith("/") and all(p not in ("", ".", "..") for p in name.split("/"))


def generated_symbols(data):
    return sorted(set(re.findall(rb"(?m)^ const encode_t ([A-Za-z_][A-Za-z0-9_]*_encoding)\b", data)))


def source_entry(lock, source_id):
    try:
        return next(entry for entry in lock["sources"] if entry["id"] == source_id)
    except StopIteration:
        raise ValueError("Encode XS source is absent from CPAN lock")


def collect(output):
    if sys.platform != "darwin":
        raise ValueError("Encode XS audit requires macOS sandbox-exec")
    lock_bytes = (ROOT / "resources/biber-encode-xs-sources.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    module_bytes = (ROOT / "resources/biber-module-sources.lock.json").read_bytes()
    cpan_bytes = (ROOT / "resources/biber-cpan-sources.lock.json").read_bytes()
    if (lock.get("schemaVersion") != 1 or lock.get("biberModuleLockSha256") != shared.digest(module_bytes)
            or lock.get("cpanLockSha256") != shared.digest(cpan_bytes)):
        raise ValueError("Encode XS lock differs from reviewed module/CPAN identity")
    module_lock, cpan_lock = json.loads(module_bytes), json.loads(cpan_bytes)
    expected = {row["module"]: row for row in module_lock["modules"] if row["module"] in modules.GENERATED_XS_MODULES}
    if set(expected) != modules.GENERATED_XS_MODULES or {row["module"] for row in lock["modules"]} != modules.GENERATED_XS_MODULES:
        raise ValueError("Encode XS module inventory differs")
    source_ids = {lock["generatorSource"]} | {row["inputSource"] for row in lock["modules"]}
    entries = {source_id: source_entry(cpan_lock, source_id) for source_id in source_ids}
    archives, sources = {}, {}
    for source_id, entry in entries.items():
        archive = cpan.get_input(entry, True)
        archives["sources/" + entry["archive"]] = archive
        sources[source_id] = biber.archive_sources(archive, entry["root"])
    generator = sources[lock["generatorSource"]].get(lock["generatorPath"])
    if generator is None or shared.digest(generator) != "0bb27e20782371f57e3ee5de97346bc0f32a5b952333d0437197cf616a7e1351":
        raise ValueError("enc2xs generator differs from reviewed source")
    foundation = json.loads((ROOT / "resources/biber-build-provenance.lock.json").read_bytes())
    binary = biber.verified(ROOT / "resources/runtime/mac-arm64/biber", foundation["arm64Binary"])
    _, payload, _ = biber.parse_payload(binary, foundation["reviewedZipDuplicates"])
    (ROOT / "test-results").mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="biber-encode-xs-", dir=ROOT / "test-results")).resolve()
    for name in ["tmp", "home", "controls"]: (run / name).mkdir()
    (run / "sandbox.sb").write_text(sandbox.sandbox_profile(run))
    env = {"PATH": "/usr/bin:/bin", "HOME": str(run / "home"), "TMPDIR": str(run / "tmp"), "LC_ALL": "C", "LANG": "C", "PERL_HASH_SEED": "0", "PERL_PERTURB_KEYS": "0"}
    prefix = ["/usr/bin/sandbox-exec", "-f", str(run / "sandbox.sb"), "/usr/bin/perl"]
    controls = sandbox.check_sandbox(prefix, run / "controls", env, run.parent / (run.name + "-outside"))
    retained = {**archives, "generator/enc2xs": generator}
    records, deadline = [], time.monotonic() + 180
    for row in lock["modules"]:
        module = row["module"]
        source = sources[row["inputSource"]]
        work = run / module.replace("::", "-"); work.mkdir()
        executable = work / "enc2xs"; executable.write_bytes(generator)
        all_inputs, symbols = [], set()
        for index, group in enumerate(row["inputGroups"]):
            if not isinstance(group, list) or not group or len(group) > 128:
                raise ValueError("Encode XS input group is invalid")
            fnm = work / f"{index}.fnm"; paths = []
            for original in group:
                if not valid_path(original) or original not in source:
                    raise ValueError(f"Encode XS input is absent or unsafe: {module} {original}")
                target = work / original; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(source[original])
                paths.append(original); all_inputs.append(original)
                retained[f"inputs/{module.replace('::', '-')}/{original}"] = source[original]
            fnm.write_text("\n".join(paths) + "\n")
            output_c = work / f"{index}.c"
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError("Encode XS generation exceeded its deadline")
            log = run / (module.replace("::", "-") + f"-{index}.log")
            sandbox.bounded_run(prefix + [str(executable), "-Q", "-O", "-o", str(output_c), "-f", str(fnm)], work, env, log, remaining)
            generated = output_c.read_bytes()
            group_symbols = generated_symbols(generated)
            symbols.update(group_symbols)
            retained[f"generated/{module.replace('::', '-')}/{index}.symbols.json"] = (json.dumps([symbol.decode() for symbol in group_symbols], indent=2) + "\n").encode()
            retained[f"logs/{module.replace('::', '-')}-{index}.log"] = log.read_bytes()
        payload_path = expected[module]["payloadPaths"][0].removeprefix("par/")
        info = native.macho(payload[payload_path], file_type=8, name_suffix="_encoding")[1]
        expected_symbols = expected[module]["expectedEncodingSymbols"]
        actual = info["suffixNames"]
        generated_prefixed = sorted("_" + symbol.decode() for symbol in symbols)
        if generated_prefixed != expected_symbols or actual != expected_symbols:
            raise ValueError("enc2xs symbols differ from reviewed bundle symbols")
        records.append({"module": module, "payload": "par/" + payload_path, "inputSource": row["inputSource"], "inputFiles": sorted(all_inputs), "symbolCount": len(actual), "symbols": actual})
    details = (json.dumps(records, indent=2) + "\n").encode()
    retained["modules.json"] = details
    for name, data in sorted(retained.items()): shared.atomic_write(output / name, data)
    report = {"schemaVersion": 1, "releaseAuditComplete": False, "scope": lock["scope"],
              "collectorSha256": shared.digest(Path(__file__).read_bytes()), "lockSha256": shared.digest(lock_bytes),
              "biberModuleLockSha256": shared.digest(module_bytes), "cpanLockSha256": shared.digest(cpan_bytes),
              "generator": {"source": lock["generatorSource"], "path": lock["generatorPath"], "sha256": shared.digest(generator)},
              "sandbox": {"controls": controls, "networkDenied": True, "writeScope": "unique temporary run directory and /dev/null", "deadlineSeconds": 180},
              "summary": {"modules": len(records), "generatedGroups": sum(len(row["inputGroups"]) for row in lock["modules"]), "inputFiles": sum(len(record["inputFiles"]) for record in records), "symbolsMatched": sum(record["symbolCount"] for record in records)},
              "modules": records, "evidence": [biber.file_record(name, data) for name, data in sorted(retained.items())],
              "remaining": ["Symbol reproduction proves generated XS table provenance, not byte-identical native compiler output or vendor build flags.", "Native build/source provenance, redistribution terms and the exact signed-app SBOM remain open."]}
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


if __name__ == "__main__":
    output = ROOT / "artifacts/license-materials/biber-encode-xs"
    try: report = collect(output)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode()); raise
    (output / "incomplete-inventory.json").unlink(missing_ok=True)
    print(json.dumps(report["summary"], indent=2))
