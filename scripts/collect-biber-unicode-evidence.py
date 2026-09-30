"""Reproduce Biber's Unicode tables from checksum-verified Perl release source.

Developer-only macOS audit. Runs the pinned mktables generator with the system
Perl in a network-denied, temporary-write sandbox. Requires cached inputs; never
downloads, changes the runtime, or treats different output as a source match.
"""
import collections
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("biber_evidence", ROOT / "scripts/collect-biber-build-evidence.py")
biber = importlib.util.module_from_spec(spec)
spec.loader.exec_module(biber)
shared = biber.shared
GENERATOR = "lib/unicore/mktables"
GENERATOR_SHA256 = "ee0dd174fd5b158d82dfea95d7d822ca0bfcd490182669353dca3ab39a8ee807"
COMMAND = ["/usr/bin/perl", GENERATOR, "-C", "lib/unicore", "-q", "-w"]


def selected_inputs(sources):
    selected = {n: d for n, d in sources.items() if n.startswith("lib/unicore/")}
    for name in selected:
        shared.safe_member("source/" + name, "source")
    if len({n.casefold() for n in selected}) != len(selected):
        raise ValueError("Unicode input names collide on a case-insensitive filesystem")
    if shared.digest(selected.get(GENERATOR, b"")) != GENERATOR_SHA256:
        raise ValueError("Unicode generator differs from reviewed source")
    if len(selected) != 60 or sum(map(len, selected.values())) != 11643085:
        raise ValueError("Unicode inputs differ from reviewed source inventory")
    return selected


def sandbox_profile(directory):
    directory = str(directory)
    if not directory.startswith("/") or any(ord(c) < 32 or c in '"\\' for c in directory):
        raise ValueError("Unsafe sandbox working directory")
    # System Perl needs broad system reads on current macOS. This developer
    # generation sandbox does not claim read isolation or change the app policy.
    return ('(version 1)\n(allow default)\n(deny network*)\n'
            '(deny file-write* (require-all (require-not (subpath "' + directory +
            '")) (require-not (literal "/dev/null"))))\n')


def bounded_run(command, cwd, env, log, timeout=180):
    with log.open("wb") as handle:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=handle,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    if code:
        raise ValueError("Unicode generator failed; see retained generation log")


def check_sandbox(base, work, env, outside):
    inside = work / "control.txt"
    # Paths are arguments, never embedded in executable Perl source.
    controls = {
        "insideWrite": ['open my $f, ">", $ARGV[0] or die "$!"; print $f "ok";', str(inside)],
        "outsideWriteDenied": ['use Errno qw(EPERM); open my $f, ">", $ARGV[0] and die "unexpected write"; $! == EPERM or die "wrong error: $!"; print "denied";', str(outside)],
        "networkConnectDenied": ['use Socket; use Errno qw(EPERM); socket(my $s, AF_INET, SOCK_STREAM, 0) or die "$!"; connect($s, sockaddr_in(9, inet_aton("127.0.0.1"))) and die "unexpected connection"; $! == EPERM or die "wrong error: $!"; print "denied";'],
    }
    result = {}
    for name, args in controls.items():
        process = subprocess.run(base + ["-e"] + args, cwd=work, env=env,
                                 capture_output=True, timeout=20)
        expected = b"" if name == "insideWrite" else b"denied"
        if process.returncode or process.stdout != expected or process.stderr:
            raise ValueError("Sandbox control failed: " + name)
        result[name] = True
    if inside.read_bytes() != b"ok" or outside.exists():
        raise ValueError("Sandbox file-write result differs")
    inside.unlink()
    return result


def read_generated(work):
    files = {}
    total = 0
    for path in sorted((work / "lib/unicore").rglob("*")):
        if path.is_symlink():
            raise ValueError("Generator created a symlink")
        if not path.is_file():
            continue
        size = path.stat().st_size
        total += size
        if size > 16 * 1024 * 1024 or total > 64 * 1024 * 1024 or len(files) >= 5000:
            raise ValueError("Generated Unicode output exceeds audit bounds")
        files[str(path.relative_to(work))] = path.read_bytes()
    return files


def compare_outputs(payload, generated, inputs):
    by_hash = collections.defaultdict(list)
    for name, data in sorted(generated.items()):
        by_hash[shared.digest(data)].append(name)
    original_hashes = {shared.digest(data) for data in inputs.values()}
    matches, unmatched = [], []
    for name, data in sorted(payload.items()):
        if not name.startswith("lib/unicore/"):
            continue
        digest = shared.digest(data)
        candidates = [n for n in by_hash[digest] if generated[n] == data]
        if not candidates:
            unmatched.append(biber.file_record("par/" + name, data))
            continue
        selected = name if name in candidates else candidates[0]
        matches.append({**biber.file_record("par/" + name, data), "generatedPath": selected,
                        "samePath": selected == name, "unchangedSourceInput": digest in original_hashes})
    return matches, unmatched

UCD_HASHES = ("loose_property_name_of", "strict_property_name_of", "stricter_to_file_of", "loose_to_file_of")
UCD_DUMP = (
    'my @a = @Unicode::UCD::inline_definitions; my @r;'
    'for my $hn (sort qw(' + " ".join(UCD_HASHES) + ')) {'
    ' no strict "refs"; my %h = %{"Unicode::UCD::$hn"};'
    ' for my $k (sort keys %h) { my $v = $h{$k};'
    ' $v = $a[$1] if $v =~ /^#\\/(\\d+)$/; push @r, "$hn\\x01$k\\x01$v"; } }'
    'print join("\\x00", sort @r);'
)


UCD_ALIAS_NORMALIZE = re.compile(rb"\x01Sc/")


def ucd_semantic_digest(perl, data, work):
    path = work / "ucd-check.pl"
    path.write_bytes(data)
    resolved = subprocess.run([perl, "-e", 'require $ARGV[0]; ' + UCD_DUMP, str(path)],
                               cwd=work, capture_output=True, timeout=20, check=True).stdout
    path.unlink()
    # Sc/<name> and Scx/<name> are the same generated table under the
    # already-documented short/full Script(x) alias (see compare_outputs);
    # normalize that one known alias before comparing, nothing else.
    resolved = UCD_ALIAS_NORMALIZE.sub(b"\x01Scx/", resolved)
    return shared.digest(resolved)


def ucd_semantic_match(perl, payload_data, generated_data, work):
    # UCD.pl's @inline_definitions array is built while iterating a Perl hash
    # inside mktables (see lib/unicore/mktables, "push @inline_definitions");
    # unpinned hash-seed randomization (PERL_HASH_SEED) across separate build
    # runs reorders that array and every numeric "#/N" index that points into
    # it, without changing any resolved property/table value. This check
    # resolves every such index in both files and compares the sorted,
    # fully-resolved (hash, key, value) records for exact equality; it does
    # not normalize or ignore textual differences elsewhere in the file.
    return ucd_semantic_digest(perl, payload_data, work) == ucd_semantic_digest(perl, generated_data, work)


def collect(output):
    if sys.platform != "darwin":
        raise ValueError("This developer generator requires macOS sandbox-exec")
    lock_bytes = (ROOT / "resources/biber-build-provenance.lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    entry = next(e for e in lock["foundationSources"] if e["id"] == "perl-5.32.1")
    archive = biber.foundation_input(entry, True)
    inputs = selected_inputs(biber.archive_sources(archive, entry["root"]))
    binary = biber.verified(ROOT / "resources/runtime/mac-arm64/biber", lock["arm64Binary"])
    _, payload, _ = biber.parse_payload(binary, lock["reviewedZipDuplicates"])
    (ROOT / "test-results").mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="biber-unicode-", dir=ROOT / "test-results")).resolve()
    work = run / "work"; work.mkdir(); (run / "tmp").mkdir(); (run / "home").mkdir()
    for name, data in inputs.items():
        path = work / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    (run / "sandbox.sb").write_text(sandbox_profile(run))
    env = {"PATH": "/usr/bin:/bin", "HOME": str(run / "home"), "TMPDIR": str(run / "tmp"),
           "LC_ALL": "C", "LANG": "C", "PERL_HASH_SEED": "0", "PERL_PERTURB_KEYS": "0"}
    prefix = ["/usr/bin/sandbox-exec", "-f", str(run / "sandbox.sb")]
    controls = check_sandbox(prefix + [COMMAND[0]], work, env, run.parent / (run.name + "-outside"))
    bounded_run(prefix + COMMAND, work, env, run / "generate.log")
    generated = read_generated(work)
    matches, unmatched = compare_outputs(payload, generated, inputs)
    details = {"matches": matches, "unmatched": unmatched}
    details_bytes = (json.dumps(details, indent=2) + "\n").encode()
    shared.atomic_write(output / "sources" / entry["archive"], archive)
    for name, data in inputs.items():
        shared.atomic_write(output / "inputs" / name, data)
    # Retain exact generated candidates, including the unresolved UCD.pl index.
    retained = {m["generatedPath"] for m in matches}
    retained.update(m["path"].removeprefix("par/") for m in unmatched
                    if m["path"].removeprefix("par/") in generated)
    for name in sorted(retained):
        shared.atomic_write(output / "generated" / name, generated[name])
    ucd_equivalence = None
    for record in unmatched:
        name = record["path"].removeprefix("par/")
        if name == "lib/unicore/UCD.pl" and name in generated:
            ucd_equivalence = {
                "path": record["path"],
                "semanticallyEquivalent": ucd_semantic_match(COMMAND[0], payload[name], generated[name], work),
                "explanation": "mktables builds @inline_definitions by pushing onto it while iterating a "
                               "Perl hash; hash iteration order is PERL_HASH_SEED-randomized per process "
                               "since Perl 5.18, so separate build runs reorder that array and every "
                               "numeric #/N index into it without changing any resolved value. This check "
                               "resolves every index in both files and compares sorted, fully-resolved "
                               "(hash, key, value) records.",
            }
    shared.atomic_write(output / "source-matches.json", details_bytes)
    report = {"schemaVersion": 1, "releaseAuditComplete": False,
              "scope": "Byte reproduction of selected Unicode files, not full Perl/native-build or redistribution acceptance.",
              "collectorSha256": shared.digest(Path(__file__).read_bytes()),
              "payloadCollectorSha256": shared.digest((ROOT / "scripts/collect-biber-build-evidence.py").read_bytes()),
              "sharedCollectorSha256": shared.digest((ROOT / "scripts/collect-rust-license-materials.py").read_bytes()),
              "biberEvidenceLockSha256": shared.digest(lock_bytes), "arm64Binary": lock["arm64Binary"],
              "sourceArchive": entry, "inputFiles": [biber.file_record(n, d) for n, d in sorted(inputs.items())],
              "generatorSha256": GENERATOR_SHA256, "command": COMMAND,
              "hostPerl": {"path": COMMAND[0], "sha256": shared.digest(Path(COMMAND[0]).read_bytes()),
                           "version": subprocess.check_output(prefix + [COMMAND[0], "-e", 'print "$^V"'], cwd=work, env=env, timeout=20).decode()},
              "sandbox": {"controls": controls, "networkDenied": True, "writeScope": "unique temporary run directory and /dev/null",
                          "readIsolation": False, "deadlineSeconds": 180,
                          "environment": {k: v for k, v in env.items() if k not in ("HOME", "TMPDIR")}},
              "summary": {"unicodePayloadFiles": len(matches) + len(unmatched), "matchingFiles": len(matches),
                          "unchangedSourceFiles": sum(m["unchangedSourceInput"] for m in matches),
                          "reproducedGeneratedFiles": sum(not m["unchangedSourceInput"] for m in matches),
                          "matchingBytesAtDifferentPaths": sum(not m["samePath"] for m in matches),
                          "unmatchedFiles": len(unmatched)},
              "ucdEquivalence": ucd_equivalence,
              "evidence": [biber.file_record("source-matches.json", details_bytes)] +
                          [biber.file_record("generated/" + n, generated[n]) for n in sorted(retained)],
              "remaining": ["Unmatched files other than the explained UCD.pl ordering are retained without "
                            "normalization or semantic-equivalence claims.",
                            "Generated/native Biber components and full notice/redistribution/SBOM review remain open."]}
    shared.atomic_write(output / "inventory.json", (json.dumps(report, indent=2) + "\n").encode())
    print("Retained generation run:", run)
    return report


if __name__ == "__main__":
    output = ROOT / "artifacts/license-materials/biber-unicode"
    try:
        report = collect(output)
    except Exception as error:
        shared.atomic_write(output / "incomplete-inventory.json", (json.dumps({"releaseAuditComplete": False, "error": str(error)}, indent=2) + "\n").encode())
        raise
    print(json.dumps(report["summary"], indent=2))
