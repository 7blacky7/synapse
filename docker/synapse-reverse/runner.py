#!/usr/bin/env python3
"""JSON-lines runner for the isolated P18 reverse container."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BIB = Path("/bib")
WORK = Path("/arbeit")
PACKAGE_VERSION_FILE = Path("/opt/reverse/versionen-pakete.txt")
UPSTREAM_VERSION_FILE = Path("/opt/reverse/versionen.txt")
TOOL_PACKAGES = {
    "7zz": "7zip", "bsdtar": "libarchive-tools", "bchunk": "bchunk",
    "unshield": "unshield", "innoextract": "innoextract", "msiextract": "msitools",
    "cabextract": "cabextract", "unar": "unar", "lhasa": "lhasa", "arj": "arj",
    "file": "file", "llvm-readobj": "llvm", "wasm-objdump": "wabt", "wasm2wat": "wabt",
    "ffmpeg": "ffmpeg", "ffprobe": "ffmpeg", "javap": "openjdk-21-jdk-headless",
}
UPSTREAM_TOOLS = {"rizin": "rizin", "rz-bin": "rizin", "analyzeHeadless": "ghidra"}
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
# Formatwahl fuer 'extrahieren' ausschliesslich am Inhalt, nie an der Endung.
DISC_SECTOR = 2048
ISO_MAGIC_OFFSETS = (0x8001, 0x8801, 0x9001)
VRS_IDS = {b"CD001", b"BEA01", b"NSR02", b"NSR03", b"TEA01", b"BOOT2", b"CDW02"}
HEAD_BYTES = 64 * DISC_SECTOR + 8
SEVENZIP_TYPES = {"iso9660": "-tiso", "udf": "-tudf"}
FORMAT_TOOLS = {
    "iso9660": "7zz", "udf": "7zz", "7z": "7zz", "rar": "7zz", "zip": "7zz", "pe": "7zz",
    "cab": "cabextract", "ole": "msiextract", "gzip": "bsdtar", "bzip2": "bsdtar",
    "xz": "bsdtar", "tar": "bsdtar", "lha": "lhasa", "arj": "arj", "cue": "bchunk",
}
SIGNATURES = (
    (b"7z\xbc\xaf\x27\x1c", "7z"), (b"Rar!\x1a\x07", "rar"), (b"PK\x03\x04", "zip"),
    (b"MSCF", "cab"), (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole"), (b"\x1f\x8b", "gzip"),
    (b"BZh", "bzip2"), (b"\xfd7zXZ\x00", "xz"), (b"\x60\xea", "arj"), (b"MZ", "pe"),
)
CUE_RE = re.compile(rb'(?im)^[ \t]*FILE[ \t]+\S.*[ \t](?:BINARY|MOTOROLA)[ \t]*\r?$')
OUTPUT_RE = re.compile(r"^/arbeit/([^/]+)/?$")


def disc_format(head: bytes) -> str:
    """ISO9660 (CD001 an 0x8001/0x8801/0x9001) bzw. UDF (NSR02/NSR03 in der Volume Recognition Sequence)."""
    iso = any(head[offset:offset + 5] == b"CD001" for offset in ISO_MAGIC_OFFSETS)
    udf = False
    for sector in range(16, 64):
        ident = head[sector * DISC_SECTOR + 1:sector * DISC_SECTOR + 6]
        if ident not in VRS_IDS:
            break
        if ident in (b"NSR02", b"NSR03"):
            udf = True
    return "udf" if udf else "iso9660" if iso else ""


def detect_format(source: Path) -> str:
    with source.open("rb") as stream:
        head = stream.read(HEAD_BYTES)
    disc = disc_format(head)
    if disc:
        return disc
    if head[257:262] == b"ustar":
        return "tar"
    if head[2:4] == b"-l" and head[4:5] in (b"h", b"z") and head[6:7] == b"-":
        return "lha"
    for magic, name in SIGNATURES:
        if head.startswith(magic):
            return name
    if b"\x00" not in head[:65536] and CUE_RE.search(head[:65536]):
        return "cue"
    return ""


def job_id(req: dict[str, Any]) -> str:
    """auftrag_id ist optional; sonst gilt der Ordnername aus ausgabe=/arbeit/<jobId>."""
    raw_out = req.get("ausgabe")
    derived = ""
    if raw_out is not None:
        match = OUTPUT_RE.fullmatch(str(raw_out))
        derived = match.group(1) if match else str(raw_out)
    job = str(req.get("auftrag_id", derived))
    if not JOB_RE.fullmatch(job):
        raise ValueError("ungueltige auftrag_id")
    if raw_out is not None and derived != job:
        raise ValueError("Ausgabe muss /arbeit/<auftrag_id> sein")
    return job


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


FORBIDDEN_TOOLS = ("wine", "wine64", "qemu-system-i386", "qemu-system-x86_64", "dosbox", "dosbox-staging", "gdb", "gdb-multiarch", "gdbserver", "upx")


def self_probe() -> dict[str, Any]:
    try:
        socket.getaddrinfo("example.com", 443, type=socket.SOCK_STREAM)
        dns = "reachable"
    except OSError:
        dns = "blocked"
    try:
        connection = socket.create_connection(("1.1.1.1", 443), timeout=1)
    except OSError:
        tcp = "blocked"
    else:
        connection.close()
        tcp = "reachable"
    forbidden = [name for name in FORBIDDEN_TOOLS if shutil.which(name)]
    uid = os.getuid()
    status = "ok" if uid == 65532 and dns == "blocked" and tcp == "blocked" and not forbidden else "fehler"
    return {"status": status, "uid": uid, "dns": dns, "tcp": tcp, "forbidden_tools": forbidden}


def tool_version(tool: str) -> str:
    if tool in TOOL_PACKAGES:
        package = TOOL_PACKAGES[tool]
        manifest = PACKAGE_VERSION_FILE
    elif tool in UPSTREAM_TOOLS:
        package = UPSTREAM_TOOLS[tool]
        manifest = UPSTREAM_VERSION_FILE
    else:
        return "unbekannt"
    try:
        for line in manifest.read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition("=")
            if separator and name == package:
                return value.split()[0]
    except OSError:
        pass
    return "unbekannt"


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


def selected_tool(req: dict[str, Any], fmt: str = "") -> str:
    command = req.get("kommando")
    if command not in (None, "spurtabelle", "extrahieren", "leser_ausfuehren"):
        raise ValueError("Kommando nicht_unterstuetzt")
    if command == "extrahieren":
        return FORMAT_TOOLS.get(fmt, "")
    return str(req.get("werkzeug", ""))


def cue_image(source: Path) -> Path:
    cue_bytes = source.read_bytes()
    if len(cue_bytes) > 1_048_576:
        raise ValueError("CUE-Datei zu gross")
    cue_text = cue_bytes.decode("utf-8-sig")
    references = re.findall(r'(?im)^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+(?:BINARY|MOTOROLA)\s*$', cue_text)
    filenames = list(dict.fromkeys(first or second for first, second in references))
    if len(filenames) != 1:
        raise ValueError("nur CUE mit genau einem BIN/MOTOROLA-Image unterstuetzt")
    image = path_under(str(source.parent / filenames[0]), BIB, True)
    if not image.is_file():
        raise ValueError("CUE-Image ist keine regulaere Datei")
    return image


def command_for(tool: str, source: Path, out: Path, req: dict[str, Any], fmt: str = "") -> list[str]:
    if tool not in TOOLS or not shutil.which(TOOLS[tool][0]):
        raise ValueError("Werkzeug nicht_unterstuetzt")
    if tool == "7zz":
        forced = [SEVENZIP_TYPES[fmt]] if fmt in SEVENZIP_TYPES else []
        return [*TOOLS[tool], *forced, f"-o{out}", str(source)]
    if tool == "bsdtar":
        return [*TOOLS[tool], str(source), "-C", str(out), "--no-same-owner", "--no-same-permissions"]
    if tool == "bchunk":
        return [*TOOLS[tool], "-w", str(cue_image(source)), str(source), str(out / "track")]
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
    job = job_id(req)
    cap = limits(req)
    source = path_under(str(req.get("eingabe", "")), BIB, True)
    if not source.is_file():
        raise ValueError("Eingabe ist keine regulaere Datei")
    extract = req.get("kommando") == "extrahieren"
    fmt = detect_format(source) if extract else ""
    tool = selected_tool(req, fmt)
    if not tool:
        if extract:
            return [{"status": "fehler", "fehlercode": "nicht_unterstuetzt",
                     "meldung": "Format am Inhalt nicht erkannt", "manifest": []}]
        raise ValueError("kein Werkzeug angegeben")
    WORK.mkdir(parents=True, exist_ok=True)
    out = path_under(job, WORK, False)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError("Ausgabeordner muss leer sein")
    command = command_for(tool, source, out, req, fmt)
    started = time.monotonic()
    env = {**os.environ, "HOME": "/tmp", "TMPDIR": "/tmp",
           "LC_ALL": "C.UTF-8", "GHIDRA_HOME": "/opt/ghidra"}
    proc = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=cap["zeitlimit_s"], check=False,
                          text=True, env=env, cwd=str(out))
    if proc.returncode:
        return [{"status": "fehler", "fehlercode": "werkzeug_fehler",
                 "meldung": (proc.stderr or proc.stdout)[-4000:]}]
    files, size = output_manifest(out, cap, source.stat().st_size)
    version = tool_version(tool)
    return [
        {"status": "fortschritt", "funktionen_fertig": len(files), "gesamt": len(files)},
        {"status": "fertig", "fehlercode": None, "werkzeug_version": version, "format": fmt or None,
         "dauer_s": round(time.monotonic() - started, 3), "manifest": files, "ausgabe_bytes": size},
    ]


def main() -> int:
    if sys.argv[1:] == ["--self-probe"]:
        result = self_probe()
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 0 if result["status"] == "ok" else 1
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
