#!/bin/bash
# P18-T69: Regressionsprobe Ghidra/S3 im Live-Sandbox-Profil (Flags wie rest-api tool-container-docker.ts),
# laeuft auf dem Docker-Host. Ruft runner.run_request mit werkzeug analyzeHeadless auf und prueft die functions.jsonl.
#   probe-ghidra.sh <image> <exe> [quellordner]
# Mit quellordner (dieser Ordner im Arbeitsbaum) bzw. RUNNER_B64/JAVA_B64 in der Umgebung laufen runner.py und
# ghidra/ExportFunctions.java aus dem Arbeitsstand ohne Image-Neubau; auf dem Host wird nichts geschrieben.
# Abnahme (Standard: Siedler 3 AUTORUN.EXE): MIN_FUNKTIONEN=180, MAX_S=60, jede Funktion mit Adresse und Groesse.
set -euo pipefail
IMAGE=${1:?image}
EXE=${2:?exe}
SRC=${3:-}
if [ -n "$SRC" ]; then
  RUNNER_B64=$(base64 -w0 "$SRC/runner.py")
  JAVA_B64=$(base64 -w0 "$SRC/ghidra/ExportFunctions.java")
  PROBE_JAVA_B64=$(base64 -w0 "$SRC/ghidra/ProbeExportFunctions.java")
fi
export FORCE_FALLBACK=${FORCE_FALLBACK:-0} TESTEXPORT_TAR=${TESTEXPORT_TAR:-0} PROBE_JAVA_B64=${PROBE_JAVA_B64:-}
export RUNNER_B64=${RUNNER_B64:-} JAVA_B64=${JAVA_B64:-} MIN_FUNKTIONEN=${MIN_FUNKTIONEN:-180} MAX_S=${MAX_S:-60}
PY='
import base64, importlib.util, json, os, time, io, sys, tarfile
from pathlib import Path
src, scripts = Path("/opt/reverse/runner.py"), None
if os.environ.get("RUNNER_B64"):
    d = Path("/arbeit/_quelle"); (d / "ghidra").mkdir(parents=True)
    (d / "runner.py").write_bytes(base64.b64decode(os.environ["RUNNER_B64"]))
    (d / "ghidra" / "ExportFunctions.java").write_bytes(base64.b64decode(os.environ["JAVA_B64"]))
    if os.environ.get("PROBE_JAVA_B64"):
        (d / "ghidra" / "ProbeExportFunctions.java").write_bytes(base64.b64decode(os.environ["PROBE_JAVA_B64"]))
    src, scripts = d / "runner.py", d / "ghidra"
spec = importlib.util.spec_from_file_location("reverse_runner", src)
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
if scripts is not None:
    runner.GHIDRA_SCRIPTS = scripts
max_s, min_f = int(os.environ["MAX_S"]), int(os.environ["MIN_FUNKTIONEN"])
if os.environ.get("FORCE_FALLBACK") == "1":
    original = runner.command_for
    def command(*args, **kwargs):
        return ["ProbeExportFunctions.java" if x == "ExportFunctions.java" else x for x in original(*args, **kwargs)]
    runner.command_for = command
start = time.monotonic()
events = runner.run_request({"werkzeug": "analyzeHeadless", "eingabe": "/bib/probe.exe", "ausgabe": "/arbeit/probe",
                             "grenzen": {"zeitlimit_s": max_s * 3}})
dauer = time.monotonic() - start
final = events[-1]
out = Path("/arbeit/probe/functions.jsonl")
rows = [json.loads(line) for line in out.open(encoding="utf-8")] if out.exists() else []
voll = sum(1 for r in rows if isinstance(r.get("size"), int) and r["size"] > 0 and isinstance(r.get("address_offset"), int))
ok = sum(1 for r in rows if r.get("decompile_status") == "ok")
calls = sum(len(r.get("callees", [])) for r in rows)
refs = sum(len(r.get("references", [])) for r in rows)
entry = next((r for r in rows if r.get("name") == "entry"), {})
fallback = [r for r in rows if r.get("decompile_status") != "ok" and r.get("assembly", "").strip()]
peak = Path("/sys/fs/cgroup/memory.peak")
res = {"status": final.get("status"), "fehlercode": final.get("fehlercode"), "meldung": str(final.get("meldung", ""))[:300],
       "werkzeug_version": final.get("werkzeug_version"), "funktionen": len(rows), "mit_adresse_und_groesse": voll,
       "decompile_ok": ok, "dauer_s": round(dauer, 1), "ausgabe_bytes": final.get("ausgabe_bytes"),
       "manifest": [m.get("pfad") for m in final.get("manifest", [])][:5],
       "memory_peak_mb": round(int(peak.read_text()) / 1048576) if peak.exists() else None,
       "beispiel": {k: rows[0].get(k) for k in ("name", "address", "address_offset", "size", "decompile_status")} if rows else None}
raw_status = Path("/arbeit/probe/normalisierer-status.json")
res["normalisierer"] = json.loads(raw_status.read_text()) if raw_status.exists() else None
res["s1_rohdateien"] = [m.get("pfad") for m in final.get("manifest", []) if str(m.get("pfad", "")).startswith("s1-")]
res.update(calls=calls, references=refs, asm_fallback=len(fallback), truncated=sum(bool(r.get("export_truncated")) for r in rows),
           entry={k: entry.get(k) for k in ("name", "address_offset", "decompile_status", "callees")},
           reference_examples=[{k: r.get(k) for k in ("kind", "name", "address_offset", "from_offset")}
                               for row in rows for r in row.get("references", [])][:5],
           asm_example=fallback[0].get("assembly", "").splitlines()[:5] if fallback else [])
res["bestanden"] = final.get("status") == "fertig" and len(rows) >= min_f and voll == len(rows) and dauer < max_s and calls > 0 and refs > 0
if os.environ.get("FORCE_FALLBACK") == "1":
    res["bestanden"] = res["bestanden"] and entry.get("decompile_status") != "ok" and bool(entry.get("assembly", "").strip())
if os.environ.get("TESTEXPORT_TAR") == "1":
    # Only use with stdout piped directly into a local scratch directory, never a tool log.
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        sidecars = [(str(m["pfad"]), (out.parent / str(m["pfad"])).read_bytes()) for m in final.get("manifest", [])
                    if str(m.get("pfad", "")).startswith("s1-") or m.get("pfad") == "normalisierer-status.json"]
        for name, payload in [("summary.json", json.dumps(res, ensure_ascii=False).encode()), ("functions.jsonl", out.read_bytes()), *sidecars]:
            info = tarfile.TarInfo(name); info.size = len(payload); archive.addfile(info, io.BytesIO(payload))
else:
    print(json.dumps(res, ensure_ascii=False))
raise SystemExit(0 if res["bestanden"] else 1)
'
exec docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --cpus 2 --memory 4g --memory-swap 4g \
  --tmpfs /tmp:size=512m,noexec,nosuid,nodev,mode=1777 --tmpfs /arbeit:size=1g,mode=1777 \
  --user 65532:65532 -v "$EXE":/bib/probe.exe:ro \
  -e RUNNER_B64 -e JAVA_B64 -e PROBE_JAVA_B64 -e FORCE_FALLBACK -e TESTEXPORT_TAR -e MIN_FUNKTIONEN -e MAX_S \
  --entrypoint python3 "$IMAGE" -I -c "$PY"
