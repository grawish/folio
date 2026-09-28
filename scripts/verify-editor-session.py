"""Independently check a retained Code/Chat ordinary-typing experiment.

Usage: python scripts/verify-editor-session.py CODE_EVIDENCE CHAT_EVIDENCE
Requires pypdf. Reads actual exports, saved history/source and raw native counters.
It neither launches Folio nor requests collection. JSON goes to stdout.
The optional --retain-protocol-deviations flag produces a failed protocol record
while still checking all sources, PDFs and counters; it does not turn deviations
into passing experiments. Without that flag, a deviation raises an error.
"""
from pathlib import Path
import datetime
import hashlib
import json
import statistics
import subprocess
import sys

from pypdf import PdfReader


def sha(data):
    return hashlib.sha256(data).hexdigest()


def record(path):
    data = path.read_bytes()
    return {"file": str(path), "bytes": len(data), "sha256": sha(data)}


def load(path):
    return json.loads(path.read_text())


def original(commit, path):
    return subprocess.check_output(["git", "show", f"{commit}:{path}"])


def require(condition, message):
    if not condition:
        raise ValueError(message)


BASE = r"""\documentclass{article}
\begin{document}
\section*{Typing session}
Ordinary edit number 0000.
\end{document}
% Notes"""
MIB = 1024 * 1024


def expected_source(cycle):
    return BASE.replace("number 0000.", f"number {cycle:04d}.") + "".join(
        f"\n% Edited sentence {i:04d} for this application." for i in range(1, cycle + 1)
    )


def read_pdf(path, cycle):
    reader = PdfReader(path)
    require(len(reader.pages) == 1, f"Expected one page: {path}")
    page = reader.pages[0]
    text = page.extract_text()
    require(text == f"Typing session\nOrdinary edit number {cycle:04d}.\n1", f"Wrong PDF text: {path}")
    return {"text": text, "mediaBox": list(map(float, page.mediabox)),
            "cropBox": list(map(float, page.cropbox)), "rotation": page.rotation}


def verify(root, mode, retain_protocol_deviations=False):
    report = load(root / "measurements.json")
    count = report["cycles"]
    require(report["mode"] == mode and 1 <= count <= 120, "Wrong run mode/count")
    require(report["passed"] and not report["errors"] and report["finalUndoRedoPreserved"], "Incomplete/failed run")
    require(report["host"]["platform"] == "darwin" and report["host"]["arch"] == "arm64", "Wrong host")
    require(report["instrumentation"] == {
        "explicitGcRequested": False, "heapSnapshotsRequested": False,
        "allocationSampling": False, "nativeSampleIntervalMs": 200,
        "nativeObserverSha256": sha((root / "sample-mac-processes").read_bytes()),
    }, "Wrong instrumentation/observer identity")
    for file, digest in report["scripts"].items():
        require(sha(original(report["sourceCommit"], file)) == digest, f"Source mismatch: {file}")
    require(sha((root / "harness.mjs").read_bytes()) == report["scripts"]["scripts/profile-editor-session.mjs"], "Harness copy mismatch")
    require(len(report["pdfs"]) == count, "Missing exports")
    parsed = []
    for cycle, item in enumerate(report["pdfs"], 1):
        expected = expected_source(cycle)
        require(item["cycle"] == cycle and item["source"] == expected, "Wrong source sequence")
        require(item["sourceSha256"] == sha(expected.encode()), "Source digest mismatch")
        file = root / f"cycle-{cycle:04d}.pdf"
        require(Path(item["path"]).name == file.name, "Wrong export filename")
        data = file.read_bytes()
        require(len(data) == item["bytes"] and sha(data) == item["sha256"], "PDF bytes mismatch")
        pdf = read_pdf(file, cycle)
        require(item["parsed"] == {"pages": 1, "text": pdf["text"]}, "Recorded parse differs")
        parsed.append(pdf)
    recovery = load(root / "app-data/recovery.json")
    require(recovery["project"]["files"] == [{"path": "main.tex", "content": expected_source(count)}], "Wrong final recovery")
    require(report["finalSourceSha256"] == sha(expected_source(count).encode()), "Final source hash mismatch")
    workspace = root / "app-data/workspaces" / recovery["project"]["id"]
    state = load(workspace / "state.json")
    require(len(state["versions"]) == count + 1, "Missing build history")
    require(not state["messages"] and not state["annotations"] and not state["draft"], "Unexpected fixture state")
    history_records = []
    for cycle, version in enumerate(state["versions"]):
        folder = workspace / "versions" / version["id"]
        source = load(folder / "source.json")
        require(source["id"] == recovery["project"]["id"] and source["revision"] == version["revision"], "Wrong history identity/revision")
        require(source["files"] == [{"path": "main.tex", "content": expected_source(cycle)}], "Wrong saved history source")
        pdf_file = folder / "resume.pdf"
        require(sha(pdf_file.read_bytes()) == version["pdfFingerprint"], "Wrong history PDF digest")
        actual = read_pdf(pdf_file, cycle)
        if cycle:
            require(actual == parsed[cycle - 1], "History and export content differ")
            require(pdf_file.read_bytes() == (root / f"cycle-{cycle:04d}.pdf").read_bytes(), "History and export bytes differ")
        history_records.extend([record(folder / "source.json"), record(pdf_file)])

    samples = report["samples"]
    require(len(samples) > count * 4 and samples[0]["phase"] == "startup", "Missing native samples")
    first = int(samples[0]["atAbstime"])
    previous, cumulative = {}, 0
    cpu_by_key = {}
    timebase = samples[0]["timebase"]
    by_time = {}
    for index, sample in enumerate(samples):
        require(sample["timebase"] == timebase, "Timebase changed")
        if index:
            require(sample["atMs"] > samples[index-1]["atMs"] and int(sample["atAbstime"]) > int(samples[index-1]["atAbstime"]), "Samples out of order")
        rows = sample["processes"]
        keys = [(row["pid"], row["birthAbstime"]) for row in rows]
        require(len(keys) == len(set(keys)) and rows, "Duplicate/empty process tree")
        require(sample["summedRssBytes"] == sum(row["rssBytes"] for row in rows), "RSS total mismatch")
        require(sample["summedFootprintBytes"] == sum(row["footprintBytes"] for row in rows), "Footprint total mismatch")
        for row, key in zip(rows, keys):
            ticks = int(row["userTicks"]) + int(row["systemTicks"])
            total = ticks * timebase["numer"] // timebase["denom"]
            before = previous.get(key, total if int(row["birthAbstime"]) < first else 0)
            require(total >= before, "CPU counter reversed")
            delta = total - before
            cumulative += delta
            cpu_by_key.setdefault(key, {"name": row["name"], "nanoseconds": 0})["nanoseconds"] += delta
            previous[key] = total
        require(abs(sample["observedCpuSeconds"] - cumulative / 1e9) < 1e-8, "CPU total mismatch")
        by_time[sample["atMs"]] = sample
    phases = report["phases"]
    expected_phases = [f"cycle-{cycle}-{phase}" for cycle in range(1, count+1) for phase in ["typing", "build", "export", "idle"]] + ["finished"]
    require([p["name"] for p in phases] == expected_phases, "Wrong phase sequence")
    for phase in phases:
        sample = by_time[phase["atMs"]]
        require(sample["phase"] == phase["name"] and sample["observedCpuSeconds"] == phase["observedCpuSeconds"], "Phase/sample mismatch")
    observations = report["observations"]
    require([o["label"] for o in observations] == ["ready"] + [f"cycle-{i}-idle-end" for i in range(1,count+1)], "Wrong observations")
    protocol_deviations = []
    atomic_view_state = report["scripts"]["scripts/profile-editor-session.mjs"] != "c5392f2cc57c46f4f81f81645e5975b91924a3456411f8488864a1cb81ab0a46"
    for index, obs in enumerate(observations):
        sample = by_time[obs["atMs"]]
        require(obs["label"] == sample["phase"], "Observation/sample mismatch")
        require(all(obs["native"][field] == sample[field] for field in obs["native"]), "Observation totals mismatch")
        expected_mode = "code" if index == 0 else mode
        expected_views = 1 if expected_mode == "code" else 0
        if atomic_view_state:
            require(obs["viewState"] == {"editorViews":expected_views, "selectedTabs":[f"workspace-{expected_mode}-tab"], "visiblePanels":[f"workspace-{expected_mode}-panel"]}, "Unexpected atomic tab/view state")
        if obs["connectedEditorViews"] != expected_views:
            protocol_deviations.append({"label":obs["label"], "expectedEditorViews":expected_views, "observedEditorViews":obs["connectedEditorViews"]})
            require(retain_protocol_deviations, "Incorrect editor view count")
    idle = []
    for cycle in range(1, count+1):
        start, end = phases[(cycle-1)*4+3], observations[cycle]
        seconds = (end["atMs"]-start["atMs"])/1000
        cpu = end["native"]["observedCpuSeconds"]-start["observedCpuSeconds"]
        require(seconds >= 2.5 and cpu >= 0, "Wrong idle interval")
        idle.append({"cycle": cycle, "seconds": seconds, "observedCpuSeconds": cpu, "percentOneCore": 100*cpu/seconds})
    blocks = []
    for start in range(1, count+1, 10):
        rows = observations[start:start+10]
        blocks.append({"cycles": [start, start+len(rows)-1],
            "medianRssMiB": statistics.median(o["native"]["summedRssBytes"]/MIB for o in rows),
            "medianFootprintMiB": statistics.median(o["native"]["summedFootprintBytes"]/MIB for o in rows),
            "medianRendererHeapMiB": statistics.median(o["heap"]["usedSize"]/MIB for o in rows),
            "medianDomNodes": statistics.median(o["dom"]["nodes"] for o in rows)})
    cpu_names = {}
    for item in cpu_by_key.values():
        cpu_names[item["name"]] = cpu_names.get(item["name"],0) + item["nanoseconds"]/1e9
    result = {
        "mode": mode, "cycles": count, "protocolPassed":not protocol_deviations, "protocolDeviations":protocol_deviations, "measurement": record(root/"measurements.json"),
        "nativeSnapshotsRecomputed": len(samples), "observedCpuSeconds": cumulative/1e9,
        "sampledSeconds": (samples[-1]["atMs"]-samples[0]["atMs"])/1000,
        "cpuByProcessNameSeconds": cpu_names,
        "recordedObserverCpuSeconds": sum(s["samplerCpuSeconds"] for s in samples),
        "sampleCollectionMs": {"min":min(s["collectionMs"] for s in samples), "median":statistics.median(s["collectionMs"] for s in samples), "max":max(s["collectionMs"] for s in samples)},
        "peakSummedRssMiB": max(s["summedRssBytes"] for s in samples)/MIB,
        "peakSummedFootprintMiB": max(s["summedFootprintBytes"] for s in samples)/MIB,
        "idleEndpoints": [{"label": o["label"], "domNodes": o["dom"]["nodes"],
             "rendererUsedHeapMiB": o["heap"]["usedSize"]/MIB,
             "summedRssMiB": o["native"]["summedRssBytes"]/MIB,
             "summedFootprintMiB": o["native"]["summedFootprintBytes"]/MIB} for o in [observations[0],observations[-1]]],
        "tenCycleIdleBlocks": blocks, "idleIntervals": idle,
        "maxIdlePercentOneCore": max(i["percentOneCore"] for i in idle),
        "idleIntervalsAboveTenPercentOneCore": [i for i in idle if i["percentOneCore"] > 10],
        "actualExportedPdfsVerified": count, "actualSavedVersionsVerified": count+1,
        "finalRecovery": record(root/"app-data/recovery.json"), "historyState": record(workspace/"state.json"),
        "historyFiles": history_records,
    }
    return report, result, parsed


def main():
    require(len(sys.argv) in [3,4] and (len(sys.argv)==3 or sys.argv[3]=="--retain-protocol-deviations"), "Supply Code and Chat evidence directories, optionally --retain-protocol-deviations")
    retain = len(sys.argv)==4
    code, code_result, code_pdfs = verify(Path(sys.argv[1]), "code", retain)
    chat, chat_result, chat_pdfs = verify(Path(sys.argv[2]), "chat", retain)
    for field in ["cycles", "sourceCommit", "scripts", "appAsarSha256", "runtimeManifestSha256", "host", "applicationVersions", "instrumentation"]:
        require(code[field] == chat[field], f"Pair identity differs: {field}")
    require(code["appAsarSha256"] == "52a2d038ad90da72682ccc05ba4aab688ce471a1609011312f48f307d4eefd4f", "Wrong measured application")
    require(code["runtimeManifestSha256"] == "7dfac8918325ac30e1cccdf38511068f3af1b0e29f5c86b805ecd0c9c7cb7da0", "Wrong measured runtime")
    require(code_pdfs == chat_pdfs, "Pair PDF text/geometry differs")
    require([p["sourceSha256"] for p in code["pdfs"]] == [p["sourceSha256"] for p in chat["pdfs"]], "Pair sources differ")
    print(json.dumps({"schemaVersion":1, "verifiedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "passed":code_result["protocolPassed"] and chat_result["protocolPassed"], "dataVerificationPassed":True, "harnessSource":code["sourceCommit"], "scripts":code["scripts"],
        "applicationSource":"d042c50356eb8644e3adf5db473eb515b0a18186",
        "appAsarSha256":code["appAsarSha256"], "runtimeManifestSha256":code["runtimeManifestSha256"],
        "host":code["host"], "applicationVersions":code["applicationVersions"],
        "sourceAndPdfContentPairsVerified":code["cycles"], "runs":[code_result,chat_result],
        "scope":"Sequential fresh-profile sessions with ordinary keyboard events and one-page PDFs. No explicit GC or heap snapshots. Actual exports, saved history and raw counters independently checked. Undo/redo and connected DOM view behavior were observed by the native harness. No randomized speed comparison, physical IME, sustained AI edits, large-document or supported-device budget claim. Summed process RSS/footprint are not unique physical memory and short-lived process CPU may be missed. The measured app predates the later Git tabpanel accessibility fix."}, indent=2))


if __name__ == "__main__":
    main()
