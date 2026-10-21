#!/bin/bash
# P18-T76: run on Docker host by coordinator. No deploy/build. Original read-only, all output in tmpfs.
# probe-pe-ressourcen.sh <existing-image> <original-exe> <working-source-directory>
set -euo pipefail
IMAGE=${1:?image}
EXE=${2:?original}
SRC=${3:?working-sources}
export RUNNER_B64=$(base64 -w0 "$SRC/runner.py")
export PE_B64=$(base64 -w0 "$SRC/pe_ressourcen.py")
export SOURCE_NAME=$(basename "$EXE")
PY='
import base64, hashlib, importlib.util, json, os, subprocess, time
from pathlib import Path
src = Path("/arbeit/_quelle"); src.mkdir()
for name, env in (("runner.py", "RUNNER_B64"), ("pe_ressourcen.py", "PE_B64")):
    (src / name).write_bytes(base64.b64decode(os.environ[env]))
spec = importlib.util.spec_from_file_location("probe_runner", src / "runner.py")
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
source, out = Path("/bib/probe.exe"), Path("/arbeit/pe-probe")
out.mkdir()
before = hashlib.sha256(source.read_bytes()).hexdigest()
meta = {}
start = time.monotonic()
runner.pe_ressourcen(source, out, os.environ["SOURCE_NAME"], runner.limits({}), source.stat().st_size, start + 60, meta)
manifest, size = runner.output_manifest(out, runner.limits({}), source.stat().st_size)
runner.merge_verschachtelt(manifest, meta)
raw = [m for m in manifest if m["pfad"].endswith(".bin")]
icons = [m for m in manifest if m["pfad"].endswith((".ico", ".png"))]
texts = [m for m in manifest if m["pfad"].endswith(".txt")]
previews = [{"pfad": m["pfad"], "text": (out / m["pfad"]).read_text()[:1200]} for m in texts[:10]]
render = None
if icons:
    command = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(out / icons[0]["pfad"]), "-frames:v", "1", "/arbeit/icon.png"]
    completed = subprocess.run(command, capture_output=True, timeout=30)
    render = {"exit_code": completed.returncode, "meldung": completed.stderr.decode(errors="replace")[:300],
              "png_bytes": Path("/arbeit/icon.png").stat().st_size if Path("/arbeit/icon.png").exists() else 0}
unchanged = before == hashlib.sha256(source.read_bytes()).hexdigest()
result = {"quelle": os.environ["SOURCE_NAME"], "quelle_sha256": before, "original_unveraendert": unchanged,
          "ressourcen": len(raw), "icons": len(icons), "texte": len(texts), "dauer_s": round(time.monotonic()-start, 3),
          "ausgabe_bytes": size, "diagnose": runner.pe_ressourcen_status(meta), "icon_ansicht": render,
          "text_beispiele": previews, "manifest": manifest}
result["bestanden"] = unchanged and bool(raw) and bool(icons) and bool(texts) and render["exit_code"] == 0
print(json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if result["bestanden"] else 1)
'
exec docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
 --pids-limit 256 --cpus 2 --memory 4g --memory-swap 4g \
 --tmpfs /tmp:size=512m,noexec,nosuid,nodev,mode=1777 --tmpfs /arbeit:size=1g,mode=1777 \
 --user 65532:65532 -v "$EXE":/bib/probe.exe:ro \
 -e RUNNER_B64 -e PE_B64 -e SOURCE_NAME --entrypoint python3 "$IMAGE" -I -c "$PY"
