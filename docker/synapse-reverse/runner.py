#!/usr/bin/env python3
"""JSON-lines runner for the isolated P18 reverse container."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BIB = Path("/bib")
WORK = Path("/arbeit")
JOB_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
TOOLS: dict[str, tuple[str, ...]] = {
    "7zz": ("7zz", "x", "-y", "-snld", "-aoa"),
    "bsdtar": ("bsdtar", "-xvf"),
    "bchunk": ("bchunk",),
    "unshield": ("unshield", "x"),
    "innoextract": ("innoextract", "--extract"),
    "msiextract": ("msiextract",),
    "cabextract": ("cabextract", "-d"),
    "unar": ("unar", "-no-directory"),
    "lhasa": ("lhasa", "-x"),
    "arj": ("arj", "x"),
    "file": ("file", "--"),
    "rz-bin": ("rz-bin", "-I"),
    "llvm-readobj": ("llvm-readobj", "--file-headers"),
    "rizin": ("rizin", "-q"),
    "wasm-objdump": ("wasm-objdump", "-x"),
    "wasm2wat": ("wasm2wat",),
    "ffprobe": ("ffprobe", "-v", "error"),
    "ffmpeg": ("ffmpeg", "-nostdin", "-v", "error", "-i"),
    "javap": ("javap", "-c", "-p"),
    "analyzeHeadless": ("analyzeHeadless",),
}
EXTRACTORS = {
    ".iso": "7zz", ".img": "7zz", ".bin": "7zz", ".7z": "7zz", ".zip": "7zz",
    ".rar": "7zz", ".cab": "cabextract", ".msi": "msiextract", ".exe": "7zz",
    ".tar": "bsdtar", ".gz": "bsdtar", ".bz2": "bsdtar", ".xz": "bsdtar",
    ".lha": "lhasa", ".lzh": "lhasa", ".arj": "arj",
}


def path_under(value: str, root: Path, must_exist: bool) -> Path:
    raw = Path(value)
    prefix = str(root) + os.sep
    if raw.is_absolute():
        if not str(raw).startswith(prefix):
            raise ValueError("Pfad ausserhalb des erlaubten Mounts")
        raw = Path(str(raw)[len(prefix):])
    if not raw.parts or any(part in ("", ".", "..") for part in raw.parts):
        raise ValueError("ungueltiger Pfad")
    cursor = root
    for part in raw.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("Symlinks sind im Auftrag nicht erlaubt")
    resolved_root = root.resolve(strict=True)
    result = cursor.resolve(strict=must_exist)
    if result != resolved_root and resolved_root not in result.parents:
        raise ValueError("Pfad ausserhalb des erlaubten Mounts")
    return result


def limits(req: dict[str, Any]) -> dict[str, int]:
    raw = req.get("grenzen") if isinstance(req.get("grenzen"), dict) else {}
    return {
        "zeitlimit_s": min(max(int(raw.get("zeitlimit_s", 3600)), 1), 86400),
        "max_dateien": min(max(int(raw.get("max_dateien", 20000)), 1), 200000),
        "max_bytes": min(max(int(raw.get("max_bytes", 2_000_000_000)), 1), 20_000_000_000),
        "max_tiefe": min(max(int(raw.get("max_tiefe", 32)), 1), 128),
        "max_kompressionsfaktor": min(max(int(raw.get("max_kompressionsfaktor", 200)), 1), 1000),
    }


def output_manifest(root: Path, cap: dict[str, int], input_size: int) -> tuple[list[dict[str, Any]], int]:
    entries: list[dict[str, Any]] = []
    total = 0
    for current, dirs, files in os.walk(root, followlinks=False):
        here = Path(current)
        symlink_dirs = [d for d in dirs if (here / d).is_symlink()]
        if symlink_dirs:
            raise ValueError("Symlink-Verzeichnis im Ergebnis verboten")
        dirs[:] = sorted(dirs)
        if len(here.relative_to(root).parts) > cap["max_tiefe"]:
            raise ValueError("max_tiefe ueberschritten")
        for name in sorted(files):
            path = here / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Symlinks und Nicht-Dateien sind verboten")
            size = path.stat().st_size
            total += size
            if len(entries) >= cap["max_dateien"] or total > cap["max_bytes"]:
                raise ValueError("Ausgabelimit ueberschritten")
            if input_size and total > input_size * cap["max_kompressionsfaktor"]:
                raise ValueError("Ausgabelimit ueberschritten")
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            entries.append({"pfad": path.relative_to(root).as_posix(),
                            "groesse": size, "sha256": digest.hexdigest()})
    return entries, total


def selected_tool(req: dict[str, Any]) -> str:
    command = req.get("kommando")
    if command not in (None, "spurtabelle", "extrahieren", "leser_ausfuehren"):
        raise ValueError("Kommando nicht_unterstuetzt")
    if command == "extrahieren":
        return EXTRACTORS.get(Path(str(req.get("eingabe", ""))).suffix.lower(), "")
    return str(req.get("werkzeug", ""))


def command_for(tool: str, source: Path, out: Path, req: dict[str, Any]) -> list[str]:
    if tool not in TOOLS or not shutil.which(TOOLS[tool][0]):
        raise ValueError("Werkzeug nicht_unterstuetzt")
    if tool == "7zz":
        return [*TOOLS[tool], f"-o{out}", str(source)]
    if tool == "bsdtar":
        return [*TOOLS[tool], str(source), "-C", str(out), "--no-same-owner", "--no-same-permissions"]
    if tool == "cabextract":
        return [*TOOLS[tool], str(out), str(source)]
    if tool in ("msiextract", "innoextract", "unar", "lhasa", "arj", "unshield"):
        return [*TOOLS[tool], str(source), "-d", str(out)]
    if tool == "wasm2wat":
        return [*TOOLS[tool], str(source), "-o", str(out / "module.wat")]
    if tool == "ffmpeg":
        return [*TOOLS[tool], str(source), "-map", "0", "-c", "copy", str(out / "media.mkv")]
    if tool == "analyzeHeadless":
        project = out / "ghidra-project"
        export = out / "functions.jsonl"
        return [*TOOLS[tool], str(project), "analysis", "-import", str(source),
                "-scriptPath", "/opt/reverse/ghidra_scripts",
                "-postScript", "ExportFunctions.java", str(export), "-deleteProject"]
    if tool == "rizin":
        return [*TOOLS[tool], "-c", "aaa;afl", str(source)]
    return [*TOOLS[tool], str(source)]


def run_request(req: dict[str, Any]) -> list[dict[str, Any]]:
    job = str(req.get("auftrag_id", ""))
    if not JOB_RE.fullmatch(job):
        raise ValueError("ungueltige auftrag_id")
    cap = limits(req)
    source = path_under(str(req.get("eingabe", "")), BIB, True)
    if not source.is_file():
        raise ValueError("Eingabe ist keine regulaere Datei")
    raw_out = str(req.get("ausgabe", f"/arbeit/{job}"))
    if raw_out not in (f"/arbeit/{job}", job):
        raise ValueError("Ausgabe muss /arbeit/<auftrag_id> sein")
    WORK.mkdir(parents=True, exist_ok=True)
    out = path_under(job, WORK, False)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError("Ausgabeordner muss leer sein")
    tool = selected_tool(req)
    if not tool:
        raise ValueError("kein Extraktor fuer dieses Format")
    command = command_for(tool, source, out, req)
    started = time.monotonic()
    env = {**os.environ, "HOME": "/arbeit", "TMPDIR": "/opt/reverse/tmp",
           "LC_ALL": "C.UTF-8", "GHIDRA_HOME": "/opt/ghidra"}
    proc = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=cap["zeitlimit_s"], check=False,
                          text=True, env=env, cwd=str(out))
    if proc.returncode:
        return [{"status": "fehler", "fehlercode": "werkzeug_fehler",
                 "meldung": (proc.stderr or proc.stdout)[-4000:]}]
    files, size = output_manifest(out, cap, source.stat().st_size)
    version = (proc.stdout.strip().splitlines() or ["unbekannt"])[0][:300]
    return [
        {"status": "fortschritt", "funktionen_fertig": len(files), "gesamt": len(files)},
        {"status": "fertig", "fehlercode": None, "werkzeug_version": version,
         "dauer_s": round(time.monotonic() - started, 3), "manifest": files, "ausgabe_bytes": size},
    ]


def main() -> int:
    for line in sys.stdin:
        try:
            if len(line.encode("utf-8")) > 65536:
                raise ValueError("Auftrag zu gross")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("JSON-Zeile muss ein Objekt sein")
            events = run_request(request)
            for event in events:
                print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)
        except subprocess.TimeoutExpired:
            print(json.dumps({"status": "teilweise", "fehlercode": "deadline", "manifest": []}), flush=True)
        except (ValueError, OSError, json.JSONDecodeError, TypeError) as exc:
            print(json.dumps({"status": "fehler", "fehlercode": "ungueltiger_auftrag",
                              "meldung": str(exc)}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
