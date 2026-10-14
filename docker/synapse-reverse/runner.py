#!/usr/bin/env python3
"""JSON-lines runner for the isolated P18 reverse container."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import resource
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

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
    "libmirage": "libmirage11",
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
# P18-T64: bekannte, noch nicht unterstuetzte Medienformate klar benennen (Unterstuetzung: P18-T46/RV32, P18-T49/RV34).
RAW_SYNC = b"\x00" + b"\xff" * 10 + b"\x00"
MAX_BEGLEIT = 64
# P18-T64/M1: ein Dauer-Container fuer viele Auftraege -> je Auftrag eigenes TMPDIR, danach /tmp leer und
# keine ueberlebenden Prozesse. Der Sweep ueber /proc und das Leeren von ganz /tmp laufen nur im Container
# (uid 65532), nie auf einem Entwickler-Rechner.
TMP_ROOT = Path("/tmp")
CONTAINER_MODUS = os.getuid() == 65532
OUTPUT_RE = re.compile(r"^/arbeit/([^/]+)/?$")
# P18-T62: Grenzen gelten WAEHREND des Entpackens. Die Ausgabe wird in diesem Takt geprueft; bei Verletzung stirbt
# die Prozessgruppe sofort und die Teilausgabe wird geloescht. Zusaetzlich begrenzt RLIMIT_FSIZE jede einzelne Datei.
GUARD_INTERVAL_S = 0.5
# P18-T49/RV34: Disc-Images ueber Spurtabelle + gemeinsamen Extraktor (disc.py neben dem Runner). Formate ohne
# verfuegbaren Parser, die frueher schon einen Weg hatten, nehmen ihn weiter (CUE ohne libmirage -> bchunk).
DISC_PY = Path(__file__).with_name("disc.py")
ALTER_WEG = frozenset({"cue"})
ROH_ENDUNGEN = (".bin", ".img", ".iso")
_DISC: Any = None


def disc_modul() -> Any:
    """Spurtabellen-Modul einmal laden (per Pfad, unabhaengig von sys.path)."""
    global _DISC
    if _DISC is None:
        spec = importlib.util.spec_from_file_location("reverse_disc", DISC_PY)
        if spec is None or spec.loader is None:
            raise ValueError("disc.py fehlt")
        modul = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(modul)
        _DISC = modul
    return _DISC


class GrenzeUeberschritten(ValueError):
    """P18-T62: Ausgabegrenze verletzt. code = bombe_verdacht | zu_gross (fachlich, deterministisch: kein Neuversuch)."""

    def __init__(self, code: str, meldung: str) -> None:
        super().__init__(meldung)
        self.code = code


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


def head_bytes(source: Path, size: int = 64) -> bytes:
    with source.open("rb") as stream:
        return stream.read(size)


def unsupported_format(source: Path, begleit: list[tuple[str, Path]] | None = None) -> str:
    """'clonecd' (Steuerdatei [CloneCD]) bzw. 'raw2352' (Raw-Sektoren ohne CUE), sonst ''."""
    head = head_bytes(source)
    if head[:9].lower() == b"[clonecd]":
        return "clonecd"
    if head[:12] == RAW_SYNC and not cue_companion(begleit):
        return "raw2352"
    return ""


def cue_companion(begleit: list[tuple[str, Path]] | None) -> Path | None:
    for name, path in begleit or []:
        if name.lower().endswith(".cue"):
            return path
    return None


def kill_group(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def parent_of(pid: int) -> int:
    stat = Path(f"/proc/{pid}/stat").read_text()
    return int(stat.rsplit(")", 1)[1].split()[1])


def alive(pid: int) -> bool:
    """Lebt und ist kein Zombie."""
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return False


def sweep_processes() -> int:
    """Im Container: alle Prozesse ausser dem Runner und seinen Vorfahren beenden. Rueckgabe: Restanzahl."""
    if not CONTAINER_MODUS:
        return 0
    keep, pid = set(), os.getpid()
    while pid > 0 and pid not in keep:
        keep.add(pid)
        try:
            pid = parent_of(pid)
        except (OSError, ValueError, IndexError):
            break
    def others() -> list[int]:
        return [int(p.name) for p in Path("/proc").iterdir() if p.name.isdigit() and int(p.name) not in keep and alive(int(p.name))]
    rest = others()
    deadline = time.monotonic() + 2
    while rest and time.monotonic() < deadline:
        for victim in rest:
            try:
                os.kill(victim, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.05)
        try:  # als PID 1 erben wir verwaiste Kinder und muessen sie einsammeln
            while os.waitpid(-1, os.WNOHANG)[0] > 0:
                pass
        except ChildProcessError:
            pass
        rest = others()
    return len(rest)


def clean_tmp(job_tmp: Path) -> None:
    shutil.rmtree(job_tmp, ignore_errors=True)
    if CONTAINER_MODUS:
        for entry in TMP_ROOT.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                try:
                    entry.unlink()
                except OSError:
                    pass


def limit_violation(files: int, dirs: int, total: int, cap: dict[str, int], input_size: int) -> tuple[str, str] | None:
    """(fehlercode, meldung) bei verletzter Ausgabegrenze, sonst None."""
    if input_size and total > input_size * cap["max_kompressionsfaktor"]:
        return "bombe_verdacht", (f"Kompressionsfaktor ueberschritten: mehr als {total} Bytes aus "
                                  f"{input_size} Bytes Eingabe (max_kompressionsfaktor {cap['max_kompressionsfaktor']})")
    if total > cap["max_bytes"]:
        return "zu_gross", f"max_bytes ueberschritten: mehr als {cap['max_bytes']} Bytes Ausgabe"
    if files > cap["max_dateien"] or dirs > cap["max_dateien"]:
        return "zu_gross", f"max_dateien ueberschritten: mehr als {cap['max_dateien']} Eintraege"
    return None


def scan_output(root: Path, cap: dict[str, int], input_size: int) -> tuple[str, str] | None:
    """P18-T62: laufende Pruefung der Ausgabe (Groesse, Anzahl, Tiefe) mit fruehem Abbruch; folgt keinen Symlinks."""
    files = dirs = total = 0
    stack: list[tuple[str, int]] = [(str(root), 0)]
    while stack:
        here, depth = stack.pop()
        if depth > cap["max_tiefe"]:
            return "bombe_verdacht", f"max_tiefe ueberschritten: tiefer als {cap['max_tiefe']} Ebenen"
        try:
            entries = list(os.scandir(here))
        except PermissionError:
            # Archive koennen Ordner ohne Leserecht anlegen; der Runner ist Eigentuemer und darf sie oeffnen.
            try:
                if not os.path.islink(here):
                    os.chmod(here, 0o700)
                entries = list(os.scandir(here))
            except OSError:
                continue
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    dirs += 1
                    stack.append((entry.path, depth + 1))
                    continue
                total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
            files += 1
        violation = limit_violation(files, dirs, total, cap, input_size)
        if violation:
            return violation
    return None


def per_file_limit(cap: dict[str, int], input_size: int) -> int:
    """RLIMIT_FSIZE fuer das Werkzeug: eine einzelne Datei darf die Gesamtgrenze nur um 1 Byte ueberschreiten."""
    threshold = cap["max_bytes"]
    if input_size:
        threshold = min(threshold, input_size * cap["max_kompressionsfaktor"])
    return threshold + 1


def file_limit_violation(cap: dict[str, int], input_size: int) -> tuple[str, str]:
    """Werkzeug ist an RLIMIT_FSIZE gescheitert: Code nach der engeren der beiden Grenzen."""
    if input_size and input_size * cap["max_kompressionsfaktor"] < cap["max_bytes"]:
        return "bombe_verdacht", ("Einzeldatei ueber der Grenze (RLIMIT_FSIZE): mehr als "
                                  f"{input_size * cap['max_kompressionsfaktor']} Bytes aus {input_size} Bytes Eingabe")
    return "zu_gross", f"Einzeldatei ueber der Grenze (RLIMIT_FSIZE): mehr als {cap['max_bytes']} Bytes"


def file_size_limit(limit_bytes: int) -> Callable[[], None]:
    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit_bytes, limit_bytes))
    return apply


def clear_output(out: Path) -> None:
    """P18-T62: Teilausgabe nach Grenzverletzung loeschen, auch schreib-/lesegeschuetzte Ordner aus dem Archiv."""
    def retry(func: Callable[..., Any], path: str, _exc: Any) -> None:
        for target in (os.path.dirname(path), path):
            try:
                if not os.path.islink(target):
                    os.chmod(target, 0o700)
            except OSError:
                pass
        try:
            # rmtree meldet unter Python >= 3.12 auch os.open (braucht flags); ohne flags kam TypeError durch.
            result = func(path, os.O_RDONLY) if func is os.open else func(path)
            if isinstance(result, int):
                os.close(result)
            elif hasattr(result, "close"):
                result.close()
        except (OSError, TypeError):
            pass
    handler: dict[str, Any] = {"onexc": retry} if sys.version_info >= (3, 12) else {"onerror": retry}
    for _ in range(3):
        try:
            entries = list(out.iterdir())
        except OSError:
            return
        if not entries:
            return
        for entry in entries:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, **handler)
            else:
                try:
                    entry.unlink()
                except OSError:
                    pass


def run_isolated(command: list[str], timeout: int, env: dict[str, str], cwd: Path, job_tmp: Path,
                 guard: Callable[[], tuple[str, str] | None] | None = None,
                 preexec: Callable[[], None] | None = None) -> tuple[int, str]:
    """Werkzeug in eigener Prozessgruppe; Ausgaben in Dateien (verwaiste Kinder halten keine Pipe offen).

    P18-T62: mit guard wird die Ausgabe alle GUARD_INTERVAL_S geprueft. Bei einer Grenzverletzung stirbt die ganze
    Prozessgruppe sofort und GrenzeUeberschritten wird geworfen; die Teilausgabe raeumt run_request.
    """
    violation: tuple[str, str] | None = None
    code = -1
    with (job_tmp / ".stdout").open("w+b") as out_stream, (job_tmp / ".stderr").open("w+b") as err_stream:
        proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out_stream, stderr=err_stream,
                                env=env, cwd=str(cwd), start_new_session=True, preexec_fn=preexec)
        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    code = proc.wait(timeout=min(GUARD_INTERVAL_S, remaining) if guard else remaining)
                    break
                except subprocess.TimeoutExpired:
                    violation = guard() if guard else None
                    if violation:
                        break
        finally:
            kill_group(proc.pid)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        tail = b""
        for stream in (err_stream, out_stream):
            stream.seek(max(0, stream.seek(0, os.SEEK_END) - 4000))
            tail = stream.read()
            if tail.strip():
                break
    if violation:
        raise GrenzeUeberschritten(*violation)
    return code, tail.decode("utf-8", "replace")[-4000:]


def companions(req: dict[str, Any]) -> list[tuple[str, Path]]:
    """Begleitdateien desselben Mediums (z. B. BIN zur CUE), nur unter /bib, nur regulaere Dateien."""
    raw = req.get("begleitdateien") or []
    if not isinstance(raw, list) or len(raw) > MAX_BEGLEIT:
        raise ValueError("begleitdateien ungueltig")
    result: list[tuple[str, Path]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("begleitdateien ungueltig")
        path = path_under(str(item.get("pfad", "")), BIB, True)
        if not path.is_file():
            raise ValueError("Begleitdatei ist keine regulaere Datei")
        result.append((str(item.get("name") or path.name), path))
    return result


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
        # P18-T49: Adressraum-Grenze fuer den Parser-Prozess (libmirage liest fremde, evtl. defekte Images).
        "parser_ram_mb": min(max(int(raw.get("parser_ram_mb", 2048)), 256), 65536),
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
            raise GrenzeUeberschritten("bombe_verdacht", "max_tiefe ueberschritten")
        for name in sorted(files):
            path = here / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("Symlinks und Nicht-Dateien sind verboten")
            size = path.stat().st_size
            total += size
            violation = limit_violation(len(entries) + 1, 0, total, cap, input_size)
            if violation:
                raise GrenzeUeberschritten(*violation)
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


def cue_image(source: Path, begleit: list[tuple[str, Path]] | None = None) -> Path:
    cue_bytes = source.read_bytes()
    if len(cue_bytes) > 1_048_576:
        raise ValueError("CUE-Datei zu gross")
    cue_text = cue_bytes.decode("utf-8-sig")
    references = re.findall(r'(?im)^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+(?:BINARY|MOTOROLA)\s*$', cue_text)
    filenames = list(dict.fromkeys(first or second for first, second in references))
    if len(filenames) != 1:
        raise ValueError("nur CUE mit genau einem BIN/MOTOROLA-Image unterstuetzt")
    wanted = Path(filenames[0].replace("\\", "/")).name.lower()
    # P18-T64: im Speicher liegt jede Datei in eigenem sha-Ordner; BIN zuerst unter den Begleitdateien suchen.
    for name, path in begleit or []:
        if Path(name).name.lower() == wanted:
            return path
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
        return [*TOOLS[tool], "-w", str(cue_image(source, companions(req))), str(source), str(out / "track")]
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


def sicherer_name(name: str) -> str:
    """Dateiname fuer den Medium-Ordner: nur der letzte Teil, keine Steuerzeichen (CUE/CCD verweisen per Name)."""
    teil = Path(str(name).replace("\\", "/")).name
    teil = "".join(c if c.isprintable() else "_" for c in teil)[:255]
    return teil if teil not in ("", ".", "..") else "datei"


def disc_medium(req: dict[str, Any], source: Path, begleit: list[tuple[str, Path]]) -> list[tuple[str, Path]]:
    """Hauptdatei zuerst; Namen = Originalnamen (eingabe_name/begleitdateien[].name), eindeutig ohne Gross/Klein."""
    medium = [(sicherer_name(str(req.get("eingabe_name") or source.name)), source)]
    medium += [(sicherer_name(name), path) for name, path in begleit]
    gesehen: set[str] = set()
    for name, _ in medium:
        if name.lower() in gesehen:
            raise ValueError("Dateinamen im Medium doppelt: " + name)
        gesehen.add(name.lower())
    return medium


def disc_grenzen(cap: dict[str, int], input_size: int) -> Callable[[], None]:
    fsize = per_file_limit(cap, input_size)
    ram = int(cap.get("parser_ram_mb", 2048)) * 1024 * 1024

    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_AS, (ram, ram))
    return apply


def entpacke_iso(out: Path, eintrag: dict[str, Any], cap: dict[str, int], input_size: int, env: dict[str, str],
                 job_tmp: Path, hinweise: list[dict[str, Any]]) -> bool:
    """P18-T49: ISO aus dem Extraktor -> E-Profil ISO/UDF (RV13) per 7-Zip nach inhalt/<abbild>/. False = nicht entpackt."""
    iso = out / eintrag["pfad"]
    fmt = detect_format(iso)
    if fmt not in SEVENZIP_TYPES:
        hinweise.append({"code": "kein_dateisystem", "pfad": eintrag["pfad"],
                         "meldung": "Datenspur ohne erkanntes ISO9660/UDF; nur das Abbild liegt vor"})
        return True
    ziel = out / "inhalt" / Path(eintrag["pfad"]).stem
    ziel.mkdir(parents=True, exist_ok=True)
    try:
        command = command_for("7zz", iso, ziel, {}, fmt)
    except ValueError:
        hinweise.append({"code": "iso_nicht_entpackt", "pfad": eintrag["pfad"], "meldung": "7-Zip nicht verfuegbar"})
        ziel.rmdir()
        return False
    code, meldung = run_isolated(command, cap["zeitlimit_s"], env, ziel, job_tmp,
                                 guard=lambda: scan_output(out, cap, input_size),
                                 preexec=file_size_limit(per_file_limit(cap, input_size)))
    final = scan_output(out, cap, input_size)
    if final:
        raise GrenzeUeberschritten(*final)
    if code == -signal.SIGXFSZ or (code and "File too large" in meldung):
        raise GrenzeUeberschritten(*file_limit_violation(cap, input_size))
    if code:
        clear_output(ziel)
        ziel.rmdir()
        hinweise.append({"code": "iso_nicht_entpackt", "pfad": eintrag["pfad"], "meldung": meldung[-500:]})
        return False
    eintrag.setdefault("metadaten", {})["inhalt"] = ziel.relative_to(out).as_posix()
    return True


def run_disc(req: dict[str, Any], job: str, cap: dict[str, int], input_size: int, medium: list[tuple[str, Path]],
             erkennung: Any, nur_tabelle: bool = False) -> list[dict[str, Any]]:
    """P18-T49/RV34: Parser (Registry) -> Spurtabelle -> gemeinsamer Extraktor im eigenen Prozess mit Zeit-, RAM- und
    Dateigroessen-Grenzen; danach ISO -> E-Profil. Das Ergebnis traegt Spurtabelle, Hinweise und je Datei art/metadaten."""
    disc = disc_modul()
    started = time.monotonic()
    if not erkennung.parser:
        return [{"status": "fehler", "fehlercode": "format_nicht_unterstuetzt", "format_detail": erkennung.format,
                 "meldung": "Format " + erkennung.format + " wird noch nicht unterstuetzt (kein Parser verfuegbar)",
                 "parser_registry_version": disc.REGISTRY_VERSION, "manifest": []}]
    out: Path | None = None
    if not nur_tabelle:
        WORK.mkdir(parents=True, exist_ok=True)
        out = path_under(job, WORK, False)
        out.mkdir(parents=True, exist_ok=True)
        if any(out.iterdir()):
            raise ValueError("Ausgabeordner muss leer sein")
    job_tmp = TMP_ROOT / job
    shutil.rmtree(job_tmp, ignore_errors=True)
    job_tmp.mkdir(mode=0o700, parents=True)
    env = {**os.environ, "HOME": str(job_tmp), "TMPDIR": str(job_tmp), "LC_ALL": "C.UTF-8"}
    optionen = req.get("optionen") if isinstance(req.get("optionen"), dict) else {}
    hinweise: list[dict[str, Any]] = []
    teilweise = False
    try:
        try:
            ordner = job_tmp / "medium"
            ordner.mkdir(mode=0o700)
            dateien, steuer = [], erkennung.steuer
            for name, path in medium:
                link = name
                # libmirage waehlt den ISO/BIN-Parser an der Endung: Raw-2352 ohne passende Endung als .bin anbieten.
                if erkennung.format == "raw2352" and name == erkennung.steuer and not name.lower().endswith(ROH_ENDUNGEN):
                    link = name + ".bin"
                    steuer = link
                (ordner / link).symlink_to(path)
                dateien.append({"name": link, "pfad": str(ordner / link)})
            auftrag_pfad, ergebnis_pfad = job_tmp / ".disc-auftrag.json", job_tmp / ".disc-ergebnis.json"
            auftrag_pfad.write_text(json.dumps({
                "kommando": "spurtabelle" if nur_tabelle else "extrahieren", "parser": erkennung.parser,
                "format": erkennung.format, "steuer": steuer, "dateien": dateien,
                "ausgabe": str(out or job_tmp), "ergebnis": str(ergebnis_pfad),
                "optionen": {"wav_pregap": optionen.get("wav_pregap") is True}}), encoding="utf-8")
            guard = (lambda: scan_output(out, cap, input_size)) if out else None
            code, meldung = run_isolated([sys.executable, "-I", str(DISC_PY), str(auftrag_pfad)], cap["zeitlimit_s"],
                                         env, job_tmp, job_tmp, guard=guard, preexec=disc_grenzen(cap, input_size))
            if out:
                final = scan_output(out, cap, input_size)
                if final:
                    raise GrenzeUeberschritten(*final)
            if code == -signal.SIGXFSZ or (code and "File too large" in meldung):
                raise GrenzeUeberschritten(*file_limit_violation(cap, input_size))
            try:
                ergebnis = json.loads(ergebnis_pfad.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                # Absturz/RAM-Grenze im Parser: kein Haenger, sondern ein klarer Fehler.
                ergebnis = {"status": "fehler", "fehlercode": "beschaedigt" if code else "werkzeug_fehler",
                            "meldung": (meldung or "")[-1000:] or f"Parser-Prozess endete mit {code}"}
            if ergebnis.get("status") != "fertig":
                if out:
                    clear_output(out)
                fehler = str(ergebnis.get("fehlercode") or "werkzeug_fehler")
                event = {"status": "fehler", "fehlercode": fehler, "meldung": ergebnis.get("meldung"), "manifest": [],
                         "format": erkennung.format, "dauer_s": round(time.monotonic() - started, 3)}
                if fehler == "format_nicht_unterstuetzt":
                    event["format_detail"] = ergebnis.get("format_detail") or erkennung.format
                return [event]
            tabelle = ergebnis.get("spurtabelle") or {}
            hinweise = list(ergebnis.get("hinweise") or [])
            meta = {str(d["pfad"]): d for d in ergebnis.get("dateien") or [] if isinstance(d, dict) and d.get("pfad")}
            if out:
                for eintrag in list(meta.values()):
                    if (eintrag.get("metadaten") or {}).get("rolle") == "iso":
                        teilweise = not entpacke_iso(out, eintrag, cap, input_size, env, job_tmp, hinweise) or teilweise
        finally:
            rest = sweep_processes()
            clean_tmp(job_tmp)
            if rest:
                print(json.dumps({"status": "fehler", "fehlercode": "werkzeug_fehler",
                                  "meldung": f"{rest} Prozess(e) ueberlebten den Auftrag"}), flush=True)
                raise SystemExit(3)
        parser = tabelle.get("parser") or {}
        version = f"disc-registry {disc.REGISTRY_VERSION}; {parser.get('id', erkennung.parser)} {parser.get('version', '')}".strip()
        if out is None:
            return [{"status": "fertig", "fehlercode": None, "werkzeug_version": version, "format": erkennung.format,
                     "spurtabelle": tabelle, "manifest": [], "dauer_s": round(time.monotonic() - started, 3)}]
        files, size = output_manifest(out, cap, input_size)
    except GrenzeUeberschritten as exc:
        if out:
            clear_output(out)
        return [{"status": "fehler", "fehlercode": exc.code, "meldung": str(exc), "manifest": [],
                 "dauer_s": round(time.monotonic() - started, 3)}]
    for datei in files:
        zusatz = meta.get(datei["pfad"])
        if zusatz:
            datei["art"] = zusatz.get("art")
            datei["metadaten"] = zusatz.get("metadaten") or {}
    return [
        {"status": "fortschritt", "funktionen_fertig": len(files), "gesamt": len(files)},
        {"status": "teilweise" if teilweise else "fertig", "fehlercode": "werkzeug_fehler" if teilweise else None,
         "werkzeug_version": version, "format": erkennung.format, "spurtabelle": tabelle, "hinweise": hinweise,
         "dauer_s": round(time.monotonic() - started, 3), "manifest": files, "ausgabe_bytes": size},
    ]


def run_request(req: dict[str, Any]) -> list[dict[str, Any]]:
    job = job_id(req)
    cap = limits(req)
    source = path_under(str(req.get("eingabe", "")), BIB, True)
    if not source.is_file():
        raise ValueError("Eingabe ist keine regulaere Datei")
    extract = req.get("kommando") == "extrahieren"
    input_size = source.stat().st_size
    if req.get("kommando") == "spurtabelle" and not req.get("werkzeug"):
        # P18-T49: nur die Spurtabelle (kein Schreiben in /arbeit); mit 'werkzeug' bleibt der bisherige Weg.
        medium = disc_medium(req, source, companions(req))
        erkennung = disc_modul().erkenne(medium)
        if erkennung is None:
            return [{"status": "fehler", "fehlercode": "nicht_unterstuetzt", "meldung": "kein Disc-Image erkannt",
                     "manifest": []}]
        size = sum(path.stat().st_size for _, path in medium)
        return run_disc(req, job, cap, size, medium, erkennung, nur_tabelle=True)
    if extract:
        begleit = companions(req)
        # P18-T62: Grenzen beziehen sich auf das ganze Medium (Hauptdatei + Begleitdateien, z. B. CUE + BIN).
        input_size = sum(path.stat().st_size for path in {source, *(item for _, item in begleit)})
        # P18-T49: Disc-Images (CUE, CloneCD, MDS, NRG, ... und Raw-2352) ueber Registry + gemeinsamen Extraktor.
        medium = disc_medium(req, source, begleit)
        erkennung = disc_modul().erkenne(medium)
        if erkennung is not None and (erkennung.parser or erkennung.format not in ALTER_WEG):
            return run_disc(req, job, cap, input_size, medium, erkennung)
        unsupported = unsupported_format(source, begleit)
        cue = cue_companion(begleit)
        if not unsupported and cue is not None and head_bytes(source, 12) == RAW_SYNC:
            source = cue  # N3: Raw-BIN als Hauptdatei, CUE als Begleitdatei -> ueber die CUE (bchunk)
        if unsupported:
            return [{"status": "fehler", "fehlercode": "format_nicht_unterstuetzt", "format_detail": unsupported,
                     "meldung": "Format " + unsupported + " wird noch nicht unterstuetzt", "manifest": []}]
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
    job_tmp = TMP_ROOT / job
    shutil.rmtree(job_tmp, ignore_errors=True)
    job_tmp.mkdir(mode=0o700, parents=True)
    env = {**os.environ, "HOME": str(job_tmp), "TMPDIR": str(job_tmp),
           "LC_ALL": "C.UTF-8", "GHIDRA_HOME": "/opt/ghidra"}
    # P18-T62: beim Entpacken laufende Pruefung + Groessengrenze je Datei; Analysewerkzeuge wie bisher.
    guard = (lambda: scan_output(out, cap, input_size)) if extract else None
    preexec = file_size_limit(per_file_limit(cap, input_size)) if extract else None
    try:
        try:
            code, meldung = run_isolated(command, cap["zeitlimit_s"], env, out, job_tmp, guard=guard, preexec=preexec)
        finally:
            rest = sweep_processes()
            clean_tmp(job_tmp)
            if rest:
                # Isolation nicht wiederhergestellt: Auftrag scheitert, Runner beendet sich -> der Lebenszyklus
                # erkennt den toten Container (container_crashed) und startet beim naechsten Auftrag frisch.
                print(json.dumps({"status": "fehler", "fehlercode": "werkzeug_fehler",
                                  "meldung": f"{rest} Prozess(e) ueberlebten den Auftrag"}), flush=True)
                raise SystemExit(3)
        if extract:
            # Endpruefung nach Prozessende (auch nach RLIMIT_FSIZE-Abbruch des Werkzeugs).
            final = scan_output(out, cap, input_size)
            if final:
                raise GrenzeUeberschritten(*final)
            # Das Werkzeug kann die abgeschnittene Datei selbst entfernt haben: SIGXFSZ bzw. EFBIG zaehlt als Grenze.
            if code == -signal.SIGXFSZ or (code and "File too large" in meldung):
                raise GrenzeUeberschritten(*file_limit_violation(cap, input_size))
        if code:
            return [{"status": "fehler", "fehlercode": "werkzeug_fehler", "meldung": meldung}]
        files, size = output_manifest(out, cap, input_size)
    except GrenzeUeberschritten as exc:
        clear_output(out)
        return [{"status": "fehler", "fehlercode": exc.code, "meldung": str(exc), "manifest": [],
                 "dauer_s": round(time.monotonic() - started, 3)}]
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
