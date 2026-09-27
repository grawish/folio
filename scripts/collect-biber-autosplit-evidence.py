"""Reproduce Biber's AutoSplit files from pinned, unchanged upstream modules.

Developer-only offline macOS audit. Only the reviewed AutoSplit generator runs;
input modules are parsed as text, not loaded or executed. This does not rebuild
native modules or complete the binary redistribution audit.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

cpan = load("autosplit_cpan", "collect-biber-cpan-materials.py")
generation = load("autosplit_sandbox", "collect-biber-unicode-evidence.py")
biber, shared = cpan.biber, cpan.shared
GENERATOR = "cpan/AutoLoader/lib/AutoSplit.pm"
GENERATOR_SHA256 = "87c24fe374c2d2c0e6c673684dce91a9900a274502f574b935e7f4f89489dcfb"
# Distribution, original source, installed module, build subdirectory. These
# literal paths reproduce the headers; no paths are taken from executable code.
MODULES = [
    ("Clone-0.45", "Clone.pm", "Clone.pm", ""),
    ("Data-Uniqid-0.12", "Uniqid.pm", "Data/Uniqid.pm", ""),
    ("Net-SSLeay-1.90", "lib/Net/SSLeay.pm", "Net/SSLeay.pm", ""),
    ("Tk-804.036", "Tk.pm", "Tk.pm", ""),
    ("Tk-804.036", "Tk/Clipboard.pm", "Tk/Clipboard.pm", ""),
    ("Tk-804.036", "Tk/Frame.pm", "Tk/Frame.pm", ""),
    ("Tk-804.036", "Listbox/Listbox.pm", "Tk/Listbox.pm", "Listbox"),
    ("Tk-804.036", "Scale/Scale.pm", "Tk/Scale.pm", "Scale"),
    ("Tk-804.036", "Scrollbar/Scrollbar.pm", "Tk/Scrollbar.pm", "Scrollbar"),
    ("Tk-804.036", "Text/Text.pm", "Tk/Text.pm", "Text"),
    ("Tk-804.036", "Tk/Toplevel.pm", "Tk/Toplevel.pm", ""),
    ("Tk-804.036", "Tk/Widget.pm", "Tk/Widget.pm", ""),
    ("Tk-804.036", "Tk/Wm.pm", "Tk/Wm.pm", ""),
]
PERL_COMMAND = "AutoSplit::autosplit($ARGV[0], $ARGV[1], 0, 0, 0);"


def generator_bytes(sources):
    data = sources.get(GENERATOR, b"")
    if shared.digest(data) != GENERATOR_SHA256:
        raise ValueError("AutoSplit generator differs from reviewed Perl source")
    return data


def source_input(sources, source, installed, payload, patch_source):
    data = sources.get(source)
    if data is None:
        raise ValueError("An original AutoSplit input is missing")
    # Two Tk modules were patched only when PAR was packed. Split the original
    # sources, while requiring the reviewed later patch to match installed code.
    transform = "none"
    candidate = data
    if installed in ("Tk.pm", "Tk/Widget.pm"):
        candidate = cpan.transformed(data, installed, patch_source)
        transform = "PAR::Filter::PatchContent:" + installed
    if payload.get("lib/" + installed) != candidate:
        raise ValueError("AutoSplit source does not match its installed module")
    return data, transform


def read_generated(work):
    root = work / "blib/lib/auto"
    if root.is_symlink() or not root.is_dir():
        raise ValueError("AutoSplit output must be an ordinary directory")
    output, total = {}, 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("AutoSplit created a symbolic link")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("AutoSplit created a special file")
        relative = path.relative_to(root).as_posix()
        shared.safe_member("source/" + relative, "source")
        if not (relative.endswith(".al") or relative.endswith("/autosplit.ix")):
            raise ValueError("Unexpected AutoSplit output")
        size = path.stat().st_size
        total += size
        if size > 1024 * 1024 or total > 20 * 1024 * 1024 or len(output) >= 500:
            raise ValueError("AutoSplit output exceeds audit bounds")
        output["lib/auto/" + relative] = path.read_bytes()
    if len({name.casefold() for name in output}) != len(output):
        raise ValueError("AutoSplit output paths collide")
    return output


def compare_outputs(payload, generated):
    matches, unmatched = [], []
    for name, data in sorted(payload.items()):
        if not name.startswith("lib/auto/") or not (name.endswith(".al") or name.endswith("/autosplit.ix")):
            continue
        record = biber.file_record("par/" + name, data)
        # Both exact path and all bytes must agree. Never edit a generated
        # header, remove whitespace, or substitute a same-named function.
        if generated.get(name) == data:
            matches.append({**record, "generatedPath": name})
        else:
            unmatched.append(record)
    return matches, unmatched


def collect(output):
    if sys.platform != "darwin":
        raise ValueError("This developer generator requires macOS sandbox-exec")
    foundation_bytes = (ROOT / "resources/biber-build-provenance.lock.json").read_bytes()
    foundation = json.loads(foundation_bytes)
    source_lock_bytes = (ROOT / "resources/biber-cpan-sources.lock.json").read_bytes()
    source_lock = json.loads(source_lock_bytes)
    if shared.digest(foundation_bytes) != source_lock["biberEvidenceLockSha256"]:
        raise ValueError("CPAN source lock differs from the Biber payload identity")
    binary = biber.verified(ROOT / "resources/runtime/mac-arm64/biber", foundation["arm64Binary"])
    _, payload, _ = biber.parse_payload(binary, foundation["reviewedZipDuplicates"])
    perl = next(e for e in foundation["foundationSources"] if e["id"] == "perl-5.32.1")
    perl_archive = biber.foundation_input(perl, True)
    generator = generator_bytes(biber.archive_sources(perl_archive, perl["root"]))
    packer = next(e for e in foundation["foundationSources"] if e["id"] == "PAR-Packer-" + foundation["packerVersion"])
    packer_sources = biber.archive_sources(biber.foundation_input(packer, True), packer["root"])
    patch_source = packer_sources["lib/PAR/Filter/PatchContent.pm"]
    if shared.digest(patch_source) != source_lock["packagerFilterSha256"]:
        raise ValueError("Packager patch differs from reviewed source")
    inputs, archives, records = {}, {}, []
    for identity in sorted({m[0] for m in MODULES}):
        entry = next(e for e in source_lock["sources"] if e["id"] == identity)
        archive = cpan.get_input(entry, True)
        sources = biber.archive_sources(archive, entry["root"])
        archives[entry["archive"]] = archive
        records.append(entry)
        for _, original, installed, _ in (m for m in MODULES if m[0] == identity):
            data, transform = source_input(sources, original, installed, payload, patch_source)
            inputs[installed] = {"data": data, "distribution": identity, "sourcePath": original,
                                 "installedTransformation": transform}
    (ROOT / "test-results").mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="biber-autosplit-", dir=ROOT / "test-results")).resolve()
    work = run / "work"; work.mkdir()
    for name in ["tmp", "home", "tools"]: (run / name).mkdir()
    (run / "tools/AutoSplit.pm").write_bytes(generator)
    (run / "sandbox.sb").write_text(generation.sandbox_profile(run))
    for name, record in inputs.items():
        target = work / "blib/lib" / name
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(record["data"])
    (work / "blib/lib/auto").mkdir()
    env = {"PATH": "/usr/bin:/bin", "HOME": str(run / "home"), "TMPDIR": str(run / "tmp"),
           "LC_ALL": "C", "LANG": "C", "PERL_HASH_SEED": "0", "PERL_PERTURB_KEYS": "0"}
    prefix = ["/usr/bin/sandbox-exec", "-f", str(run / "sandbox.sb"), "/usr/bin/perl"]
    controls = generation.check_sandbox(prefix, work, env, run.parent / (run.name + "-outside"))
    commands = []
    deadline = time.monotonic() + 180
    for index, (_, _, installed, directory) in enumerate(MODULES):
        cwd = work / directory; cwd.mkdir(exist_ok=True)
        build_root = "../blib/lib" if directory else "blib/lib"
        args = ["-I" + str(run / "tools"), "-MAutoSplit", "-e", PERL_COMMAND,
                build_root + "/" + installed, build_root + "/auto"]
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError("AutoSplit generation exceeded its deadline")
        generation.bounded_run(prefix + args, cwd, env, run / f"generate-{index}.log", remaining)
        commands.append({"cwd": directory or ".", "perlArguments": ["-I<retained-generator>"] + args[1:]})
    generated = read_generated(work)
    matches, unmatched = compare_outputs(payload, generated)
    details = (json.dumps({"matches": matches, "unmatched": unmatched}, indent=2) + "\n").encode()
    retained = {"sources/" + perl["archive"]: perl_archive,
                "generator/AutoSplit.pm": generator,
                "packager/PatchContent.pm": patch_source,
                "source-matches.json": details}
    retained.update({"sources/" + n: d for n, d in archives.items()})
    retained.update({"inputs/" + n: r["data"] for n, r in inputs.items()})
    retained.update({"generated/" + n: d for n, d in generated.items()})
    for name, data in sorted(retained.items()): shared.atomic_write(output / name, data)
    report = {
        "schemaVersion": 1, "releaseAuditComplete": False,
        "scope": "Exact reproduction of AutoSplit text files; no native rebuild or complete license/SBOM claim.",
        "collectorSha256": shared.digest(Path(__file__).read_bytes()),
        "helpers": {name: shared.digest((ROOT / "scripts" / name).read_bytes()) for name in
                    ["collect-biber-cpan-materials.py", "collect-biber-build-evidence.py",
                     "collect-biber-unicode-evidence.py", "collect-rust-license-materials.py"]},
        "biberEvidenceLockSha256": shared.digest(foundation_bytes),
        "cpanLockSha256": shared.digest(source_lock_bytes), "arm64Binary": foundation["arm64Binary"],
        "sourceArchives": [perl] + records, "generatorSha256": GENERATOR_SHA256,
        "inputs": [{"installedPath": name, **{k: v for k, v in record.items() if k != "data"},
                    **biber.file_record("inputs/" + name, record["data"])} for name, record in sorted(inputs.items())],
        "commands": commands,
        "hostPerl": {"path": "/usr/bin/perl", "sha256": shared.digest(Path("/usr/bin/perl").read_bytes()),
                     "version": subprocess.check_output(prefix + ["-e", 'print "$^V"'], cwd=work, env=env, timeout=20).decode()},
        "sandbox": {"controls": controls, "networkDenied": True, "readIsolation": False,
                    "writeScope": "unique temporary run directory and /dev/null", "deadlineSeconds": 180},
        "summary": {"inputModules": len(inputs), "payloadAutoSplitFiles": len(matches) + len(unmatched),
                    "generatedFiles": len(generated), "matchingFiles": len(matches), "unmatchedFiles": len(unmatched)},
        "evidence": [biber.file_record(n, d) for n, d in sorted(retained.items())],
        "remaining": ["System Perl/support modules differ from the original build host; exact output is checked, not assumed.",
                      "Generated/native modules, per-component licenses and complete redistribution/SBOM review remain open."]}
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    print("Retained generation run:", run)
    return report


if __name__ == "__main__":
    output = ROOT / "artifacts/license-materials/biber-autosplit"
    try:
        report = collect(output)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode())
        raise
    (output / "incomplete-inventory.json").unlink(missing_ok=True)
    print(json.dumps(report["summary"], indent=2))
