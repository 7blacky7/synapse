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
import threading
import time
from collections import deque
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
# P18-T69: Ghidra-Post-Skripte und JVM-Heap. Container-Budget je S3-Lauf 4 GB (User-Entscheidung): 3 GB Heap,
# der Rest bleibt fuer den nativen Decompiler-Prozess und die JVM selbst.
GHIDRA_SCRIPTS = Path("/opt/reverse/ghidra_scripts")
GHIDRA_HEAP = "3g"
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


# P18-T85: Live-Fortschritt. Mit 'fortschritt': {'takt_s': n} im Auftrag meldet ein Hintergrund-Thread alle n Sekunden
# {status:'fortschritt', phase, dateien_bisher, bytes_geschrieben, aktuelle_datei, gesamt, seit_s}. Die Zahlen stammen aus der
# ohnehin laufenden Grenzpruefung (scan_output) bzw. dem Manifest, nie aus einem eigenen Vollscan; gesamt ist nur in der Phase
# manifest bekannt, sonst null. Ohne die Option bleibt alles beim Alten (nur Endmeldungen).
FORTSCHRITT_TAKT_MAX_S = 600
FORTSCHRITT_DATEI_ZEICHEN = 160
_AUSGABE = threading.Lock()


def ausgabe(event: dict[str, Any]) -> None:
    """Eine JSON-Zeile auf stdout; der Fortschritts-Thread schreibt parallel, deshalb unter Sperre."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _AUSGABE:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def kurz_pfad(pfad: str) -> str:
    return pfad if len(pfad) <= FORTSCHRITT_DATEI_ZEICHEN else "..." + pfad[-(FORTSCHRITT_DATEI_ZEICHEN - 3):]


class Fortschritt:
    """P18-T85: Stand des laufenden Auftrags; der Thread liest ihn nur (GIL), die Arbeit schreibt ihn nebenbei."""

    def __init__(self, takt_s: float) -> None:
        self.takt_s = takt_s
        self.start = time.monotonic()
        self.phase = "start"
        self.datei: str | None = None
        self.dateien = 0
        self.bytes = 0
        self.gesamt: int | None = None
        self._stopp = threading.Event()
        self._thread = threading.Thread(target=self._lauf, name="fortschritt", daemon=True)

    @staticmethod
    def aus_auftrag(req: Any) -> Fortschritt | None:
        raw = req.get("fortschritt") if isinstance(req, dict) else None
        takt = raw.get("takt_s") if isinstance(raw, dict) else None
        if isinstance(takt, bool) or not isinstance(takt, (int, float)) or not 1 <= takt <= FORTSCHRITT_TAKT_MAX_S:
            return None
        return Fortschritt(float(takt))

    def ereignis(self) -> dict[str, Any]:
        return {"status": "fortschritt", "phase": self.phase, "dateien_bisher": self.dateien,
                "bytes_geschrieben": self.bytes, "aktuelle_datei": self.datei, "gesamt": self.gesamt,
                "seit_s": round(time.monotonic() - self.start, 1)}

    def _lauf(self) -> None:
        while not self._stopp.wait(self.takt_s):
            try:
                ausgabe(self.ereignis())
            except (OSError, ValueError):
                return

    def starten(self) -> None:
        self._thread.start()

    def stoppen(self) -> None:
        self._stopp.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5)


_FORTSCHRITT: Fortschritt | None = None


def fortschritt_phase(phase: str, datei: str | None = None) -> None:
    if _FORTSCHRITT is not None:
        _FORTSCHRITT.phase = phase
        _FORTSCHRITT.datei = kurz_pfad(datei) if datei else None


def fortschritt_stoppen() -> None:
    """P18-T85: vor einer Endmeldung aus der Tiefe (danach SystemExit) darf keine Fortschrittszeile mehr folgen."""
    if _FORTSCHRITT is not None:
        _FORTSCHRITT.stoppen()


def fortschritt_stand(dateien: int, total: int, datei: str | None = None) -> None:
    if _FORTSCHRITT is not None:
        _FORTSCHRITT.dateien = dateien
        _FORTSCHRITT.bytes = total
        if datei:
            _FORTSCHRITT.datei = kurz_pfad(datei)


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
    if not cap.get("blockuebernahme") and (files > cap["max_dateien"] or dirs > cap["max_dateien"]):
        return "zu_gross", f"max_dateien ueberschritten: mehr als {cap['max_dateien']} Eintraege"
    return None


# P18-T87 (XP-SP2-Befund): Nach max_dateien lief der Runner ohne zu schreiben bis weit ueber das Zeitlimit, weil je
# verschachteltem Container bzw. je PE-Datei der GANZE Ausgabebaum neu gezaehlt wurde (O(n^2) bei 20000 Dateien) und die
# Frist nur beim Start eines Werkzeugs galt. Jetzt: Bestand einmal zaehlen und nur um Neues ergaenzen, vor jeder Datei Frist
# und Grenzen pruefen, bei Erreichen sofort enden (_STOPP); das bis dahin Entpackte kommt ins Manifest.
_STOPP: dict[str, Any] | None = None


def halte_an(grund: str, fehlercode: str, phase: str, pfad: str | None, meldung: str, offen: int | None = None) -> dict[str, Any]:
    """Ersten Abbruchgrund des Auftrags festhalten (grund: deadline | grenze); spaetere Gruende aendern ihn nicht."""
    global _STOPP
    if _STOPP is None:
        _STOPP = {"grund": grund, "fehlercode": fehlercode, "phase": phase, "pfad": kurz_pfad(pfad) if pfad else None,
                  "offen": offen, "meldung": meldung}
    return _STOPP


def abbruch_code(abgebrochen: bool) -> str | None:
    """Endcode eines vorzeitig beendeten Laufs: Frist -> deadline, Grenze -> deren Code (zu_gross/bombe_verdacht)."""
    if _STOPP is not None:
        return str(_STOPP["fehlercode"])
    return "deadline" if abgebrochen else None


def lauf_ende(started: float, cap: dict[str, int]) -> float:
    """Harte Frist des ganzen Laufs inklusive Manifest."""
    return cap["zeitlimit_s"] + started


def arbeitsende(started: float, cap: dict[str, int]) -> float:
    """Frist fuer alle Entpack-/Analysephasen: zeitlimit_s minus Nachlauf fuer Manifest und Hashing."""
    return lauf_ende(started, cap) - min(int(cap.get("nachlauf_s", 0)), cap["zeitlimit_s"] // 4)


def restzeit(deadline: float) -> int:
    """Ganze Sekunden bis zur Frist, aufgerundet (der Start des Werkzeugs soll keine Sekunde kosten), mindestens 1."""
    return max(1, int(deadline - time.monotonic() + 0.999))


def baum_zaehlen(root: Path) -> tuple[int, int, int]:
    """Dateien, Ordner und Bytes unter root (wie scan_output, folgt keinen Symlinks); einmal je Teilbaum."""
    files = dirs = total = 0
    stack = [str(root)]
    while stack:
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    dirs += 1
                    stack.append(entry.path)
                    continue
                total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
            files += 1
    return files, dirs, total


class Bestand:
    """P18-T87: Zaehlstand der Ausgabe; einmal gezaehlt, danach nur um neu Entpacktes ergaenzt."""

    def __init__(self, root: Path) -> None:
        self.dateien, self.ordner, self.bytes = baum_zaehlen(root)

    def plus(self, dateien: int, ordner: int, groesse: int) -> None:
        self.dateien += dateien
        self.ordner += ordner
        self.bytes += groesse

    def zahlen(self) -> tuple[int, int, int]:
        return self.dateien, self.ordner, self.bytes

    def voll(self, cap: dict[str, int], input_size: int) -> tuple[str, str] | None:
        """Grenze, sobald nicht einmal eine weitere Datei samt Ordner Platz hat."""
        return limit_violation(self.dateien + 1, self.ordner + 1, self.bytes, cap, input_size)


def scan_output(root: Path, cap: dict[str, int], input_size: int, basis: tuple[int, int, int] = (0, 0, 0),
                tiefe0: int = 0, anzeige: Path | None = None) -> tuple[str, str] | None:
    """P18-T62: laufende Pruefung der Ausgabe (Groesse, Anzahl, Tiefe) mit fruehem Abbruch; folgt keinen Symlinks.

    P18-T87: mit basis/tiefe0 wird nur ein Teilbaum (der gerade entpackte Container) auf dem bekannten Bestand der uebrigen
    Ausgabe geprueft, statt alle GUARD_INTERVAL_S den ganzen Ausgabebaum zu durchlaufen.
    """
    files, dirs, total = basis
    neueste: str | None = None
    neueste_ns = -1
    stack: list[tuple[str, int]] = [(str(root), tiefe0)]
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
                info = entry.stat(follow_symlinks=False)
                total += info.st_size
                # P18-T85: juengste Datei = die gerade geschriebene (Werkzeuge setzen Archivzeiten erst beim Schliessen).
                if info.st_mtime_ns > neueste_ns:
                    neueste, neueste_ns = entry.path, info.st_mtime_ns
            except OSError:
                continue
            files += 1
        violation = limit_violation(files, dirs, total, cap, input_size)
        if violation:
            return violation
    fortschritt_stand(files, total, os.path.relpath(neueste, anzeige or root) if neueste else None)
    return None


def per_file_limit(cap: dict[str, int], input_size: int) -> int:
    """RLIMIT_FSIZE fuer das Werkzeug: eine einzelne Datei darf die Gesamtgrenze nur um 1 Byte ueberschreiten."""
    threshold = min(cap["max_bytes"], cap.get("max_datei_bytes", cap["max_bytes"]))
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
    """P18-T86/T88: Mit Einstellungs-Snapshot (reverse_einstellungen, version 1) kommen alle Grenzen vom Executor; sie sind
    dort gegen den Katalog validiert. Fehlt ein Wert, ist der Auftrag ungueltig (keine stillen Runner-Standards).
    Nur das alte Protokoll ohne Snapshot (altes API-/Image-Paar, Blockuebernahme AUS) nutzt die technischen Notgrenzen unten."""
    candidate = req.get("grenzen")
    raw: dict[str, Any] = candidate if isinstance(candidate, dict) else {}
    snapshot = req.get("einstellungen")
    if isinstance(snapshot, dict) and snapshot.get("version") == 1:
        values = snapshot.get("werte")
        if not isinstance(values, dict):
            raise ValueError("konfiguration_unvollstaendig:einstellungen")

        def value(name: str) -> int:
            row = values.get(name)
            raw_value = row.get("wert") if isinstance(row, dict) else None
            if not isinstance(raw_value, str) or not raw_value.isascii() or not raw_value.isdigit():
                raise ValueError("konfiguration_unvollstaendig:" + name)
            number = int(raw_value)
            if number > 9223372036854775807:
                raise ValueError("konfiguration_unvollstaendig:" + name)
            return number

        is_s3 = req.get("schicht") == "S3"
        # Die Transportfrist des Executors ist die harte Obergrenze; ein kleineres Zeitlimit aus grenzen gewinnt.
        zeitlimit = value("s3_zeitlimit_s" if is_s3 else "e_zeitlimit_s")
        if isinstance(raw.get("zeitlimit_s"), int) and 0 < raw["zeitlimit_s"] < zeitlimit:
            zeitlimit = raw["zeitlimit_s"]
        return {
            "zeitlimit_s": zeitlimit,
            "max_dateien": value("e_schritt_dateien"),
            "max_bytes": value("s3_lauf_bytes" if is_s3 else "e_lauf_bytes"),
            "max_tiefe": value("pfad_tiefe_max"),
            "max_kompressionsfaktor": value("kompressionsfaktor_max"),
            "parser_ram_mb": value("parser_ram_mib"),
            "max_verschachtelung": value("verschachtelung_max"),
            "nachlauf_s": value("nachlauf_s"),
            "max_datei_bytes": value("max_datei_bytes"),
            "lese_block_bytes": value("lese_block_bytes"),
            "manifest_record_bytes": value("manifest_record_bytes"),
            "manifest_segment_zeilen": value("manifest_segment_zeilen"),
            # Blockuebernahme: Dateianzahl ist keine Grenze; das Manifest geht als JSONL-Datei an die API.
            "blockuebernahme": int(req.get("blockuebernahme") is True and not is_s3),
        }
    # Altprotokoll: technische Notgrenzen (Kompatibilitaet), keine fachliche Quelle.
    return {
        "zeitlimit_s": min(max(int(raw.get("zeitlimit_s", 3600)), 1), 86400),
        "max_dateien": min(max(int(raw.get("max_dateien", 20000)), 1), 200000),
        "max_bytes": min(max(int(raw.get("max_bytes", 2_000_000_000)), 1), 20_000_000_000),
        "max_tiefe": min(max(int(raw.get("max_tiefe", 32)), 1), 128),
        "max_kompressionsfaktor": min(max(int(raw.get("max_kompressionsfaktor", 200)), 1), 1000),
        # P18-T49: Adressraum-Grenze fuer den Parser-Prozess (libmirage liest fremde, evtl. defekte Images).
        "parser_ram_mb": min(max(int(raw.get("parser_ram_mb", 2048)), 256), 65536),
        # P18-T71: Tiefe verschachtelter Container (Archiv im Archiv); 0 schaltet das rekursive Entpacken ab.
        "max_verschachtelung": min(max(int((raw or {}).get("max_verschachtelung", 8)), 0), 32),
        # P18-T87: Teil des Zeitlimits fuer Manifest/Hashing nach dem Entpacken (hoechstens ein Viertel, siehe arbeitsende).
        "nachlauf_s": min(max(int(raw.get("nachlauf_s", 300)), 0), 86400),
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


_MANIFEST: Any = None


def manifest_modul() -> Any:
    """P18-T88: manifest.py liegt neben runner.py (Dockerfile); erst bei Blockuebernahme geladen."""
    global _MANIFEST
    if _MANIFEST is None:
        spec = importlib.util.spec_from_file_location("reverse_manifest", Path(__file__).with_name("manifest.py"))
        if spec is None or spec.loader is None:
            raise ValueError("manifest.py fehlt")
        _MANIFEST = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_MANIFEST)
    return _MANIFEST


def manifest_wire(files: Any) -> dict[str, Any]:
    """Blockuebernahme: Antwort nur mit Verweis und Hash, nie die ganze Liste."""
    if hasattr(files, "descriptor"):
        return {"manifest": [], "manifest_datei": files.descriptor()}
    return {"manifest": files}


def output_manifest(root: Path, cap: dict[str, int], input_size: int,
                    frist: float | None = None) -> tuple[Any, int]:
    entries: Any = (manifest_modul().ManifestListe(root, cap["manifest_record_bytes"], cap["manifest_segment_zeilen"])
                    if cap.get("blockuebernahme") else [])
    try:
        return manifest_fuellen(root, cap, input_size, frist, entries)
    finally:
        # Auch bei Frist/Abbruch: die bis hier geschriebenen Zeilen bleiben ein abgeschlossenes, gehashtes Manifest.
        if hasattr(entries, "finish") and not entries.sha256:
            entries.finish()


def manifest_fuellen(root: Path, cap: dict[str, int], input_size: int, frist: float | None,
                     entries: Any) -> tuple[Any, int]:
    total = 0
    fortschritt_phase("manifest")
    if _FORTSCHRITT is not None:
        _FORTSCHRITT.gesamt = _FORTSCHRITT.dateien or None
    for current, dirs, files in os.walk(root, followlinks=False):
        here = Path(current)
        symlink_dirs = [d for d in dirs if (here / d).is_symlink()]
        if symlink_dirs:
            raise ValueError("Symlink-Verzeichnis im Ergebnis verboten")
        dirs[:] = sorted(dirs)
        if len(here.relative_to(root).parts) > cap["max_tiefe"]:
            raise GrenzeUeberschritten("bombe_verdacht", "max_tiefe ueberschritten")
        for name in sorted(files):
            if cap.get("blockuebernahme") and here == root and name.startswith(".e-"):
                continue
            path = here / name
            if frist is not None and time.monotonic() >= frist:
                # P18-T87: Frist im Manifest -> nur die bis hier gepruefte Ausgabe wird uebernommen, kein Leerlauf.
                halte_an("deadline", "deadline", "manifest", path.relative_to(root).as_posix(),
                         f"Zeitlimit {cap['zeitlimit_s']} s im Manifest erreicht; {len(entries)} Dateien uebernommen")
                return entries, total
            if path.is_symlink() or not path.is_file():
                raise ValueError("Symlinks und Nicht-Dateien sind verboten")
            size = path.stat().st_size
            total += size
            violation = limit_violation(len(entries) + 1, 0, total, cap, input_size)
            if violation:
                raise GrenzeUeberschritten(*violation)
            fortschritt_stand(len(entries), total, path.relative_to(root).as_posix())
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(cap.get("lese_block_bytes", 1024 * 1024)), b""):
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
    if tool == "msiextract":
        # P18-T71: msiextract kennt nur -C/--directory; mit -d scheiterte jedes MSI als Medium.
        return [*TOOLS[tool], "-C", str(out), str(source)]
    # P18-T71: Zielverzeichnis je Werkzeug (laut --help im Image): lhasa w=<dir>, arj x <archiv> <dir>/, unar -o <dir>.
    if tool == "lhasa":
        return [TOOLS[tool][0], f"-xw={out}", str(source)]
    if tool == "arj":
        return [*TOOLS[tool], "-y", str(source), str(out) + os.sep]
    if tool == "unar":
        return [*TOOLS[tool], "-o", str(out), str(source)]
    if tool in ("innoextract", "unshield"):
        return [*TOOLS[tool], str(source), "-d", str(out)]
    if tool == "wasm2wat":
        return [*TOOLS[tool], str(source), "-o", str(out / "module.wat")]
    if tool == "ffmpeg":
        return [*TOOLS[tool], str(source), "-map", "0", "-c", "copy", str(out / "media.mkv")]
    if tool == "analyzeHeadless":
        project = out / "ghidra-project"
        export = out / "functions.jsonl"
        return [*TOOLS[tool], str(project), "analysis", "-import", str(source),
                "-scriptPath", str(GHIDRA_SCRIPTS),
                "-postScript", "ExportFunctions.java", str(export),
                str(limits(req)["max_dateien"]), str(min(limits(req)["max_bytes"], 2147483647)),
                str(limits(req)["zeitlimit_s"]), "-deleteProject"]
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
                 job_tmp: Path, hinweise: list[dict[str, Any]], deadline: float | None = None) -> bool:
    """P18-T49: ISO aus dem Extraktor -> E-Profil ISO/UDF (RV13) per 7-Zip nach inhalt/<abbild>/. False = nicht entpackt."""
    iso = out / eintrag["pfad"]
    fmt = detect_format(iso)
    if fmt not in SEVENZIP_TYPES:
        hinweise.append({"code": "kein_dateisystem", "pfad": eintrag["pfad"],
                         "meldung": "Datenspur ohne erkanntes ISO9660/UDF; nur das Abbild liegt vor"})
        return True
    ziel = out / "inhalt" / Path(eintrag["pfad"]).stem
    fortschritt_phase("iso_entpacken", eintrag["pfad"])
    ziel.mkdir(parents=True, exist_ok=True)
    try:
        command = command_for("7zz", iso, ziel, {}, fmt)
    except ValueError:
        hinweise.append({"code": "iso_nicht_entpackt", "pfad": eintrag["pfad"], "meldung": "7-Zip nicht verfuegbar"})
        ziel.rmdir()
        return False
    code, meldung = run_isolated(command, restzeit(deadline) if deadline is not None else cap["zeitlimit_s"], env, ziel, job_tmp,
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


# P18-T71: verschachtelte Container. Nach dem Entpacken wird jede Datei der Ausgabe am Inhalt geprueft; bekannte
# Container werden daneben nach '<name>~inhalt/' entpackt, deren Inhalte wieder, bis nur Nutzdaten bleiben. Grenzen
# wie E (ganze Ausgabe gegen das Medium), dazu max_verschachtelung (0 = aus). Nichts wird still verworfen: jeder
# erkannte Container traegt metadaten.verschachtelt (status, format, grund), jede Datei daraus metadaten.herkunft
# (archiv, pfad, tiefe). Kopierschutz/Verschluesselung wird nur gemeldet (Werkzeugfehler), nie umgangen.
INHALT_SUFFIX = "~inhalt"
VERSCHACHTELT_TOOLS = {
    "iso9660": "7zz", "udf": "7zz", "7z": "7zz", "rar": "7zz", "zip": "7zz", "gzip": "7zz", "bzip2": "7zz",
    "xz": "7zz", "lha": "7zz", "arj": "7zz", "tar": "bsdtar", "cab": "cabextract", "pe-cab": "cabextract",
    "msi": "msiextract", "installshield": "unshield", "inno": "innoextract", "pe-7z": "7zz", "pe-zip": "7zz",
    "pe-rar": "7zz",
}
ISC_MAGIC = b"ISc("
# Root-CLSID {000C1084|000C1086-0000-0000-C000-000000000046}: Installer-Paket bzw. Patch (OLE-Verzeichniseintrag 0).
MSI_CLSID_REST = b"\x10\x0c\x00\x00\x00\x00\x00\xc0\x00\x00\x00\x00\x00\x00\x46"
INNO_MARKER = b"Inno Setup Setup Data ("
CAB_MARKER = b"MSCF\x00\x00\x00\x00"
PE_SCAN_BYTES = 64 * 1024 * 1024
PE_OVERLAY_MIN = 64 * 1024
# Spieleigene Daten-Container: erkannt und als Folgeschritt (Parser/Inspektor) vorgemerkt, nicht entpackt.
SPIEL_CONTAINER = (
    (b"MPQ\x1a", "mpq"), (b"IWAD", "wad"), (b"PWAD", "wad"), (b"PACK", "quake-pak"), (b"BIGF", "ea-big"),
    (b"\x04\x13\x04\x00\x0c\x00\x00\x00", "siedler3-dat"),
)
SPIEL_FORMATE = frozenset(name for _, name in SPIEL_CONTAINER) | {"siedler3-snd", "siedler3-map"}
SATZ_RE = re.compile(r"^(.*?)(\d+)$")


def pe_overlay(path: Path) -> tuple[int, int]:
    """(Beginn, Groesse) der Daten hinter dem letzten Abschnitt (ohne Signaturtabelle); (0, 0) ohne Overlay."""
    try:
        with path.open("rb") as stream:
            head = stream.read(4096)
            size = os.fstat(stream.fileno()).st_size
    except OSError:
        return 0, 0
    if len(head) < 0x40:
        return 0, 0
    pe = int.from_bytes(head[0x3C:0x40], "little")
    if pe + 24 > len(head) or head[pe:pe + 4] != b"PE\x00\x00":
        return 0, 0
    sections = int.from_bytes(head[pe + 6:pe + 8], "little")
    optional = int.from_bytes(head[pe + 20:pe + 22], "little")
    table = pe + 24 + optional
    end = 0
    for index in range(min(sections, 96)):
        entry = head[table + index * 40:table + index * 40 + 40]
        if len(entry) < 40:
            break
        raw_size, raw_ptr = int.from_bytes(entry[16:20], "little"), int.from_bytes(entry[20:24], "little")
        end = max(end, raw_ptr + raw_size)
    magic = int.from_bytes(head[pe + 24:pe + 26], "little")
    dirs = pe + 24 + (96 if magic == 0x10B else 112 if magic == 0x20B else 0)
    if dirs > pe + 24 and dirs + 40 <= len(head):
        sec_off = int.from_bytes(head[dirs + 32:dirs + 36], "little")
        sec_len = int.from_bytes(head[dirs + 36:dirs + 40], "little")
        if sec_off and sec_off <= end + 8 and sec_off + sec_len <= size:
            end = max(end, sec_off + sec_len)
    if not end or end >= size:
        return 0, 0
    return end, size - end


def marker_in(path: Path, markers: tuple[bytes, ...], limit: int = PE_SCAN_BYTES) -> set[bytes]:
    """Welche Marker in den ersten limit Bytes vorkommen (ein Durchlauf, blockweise mit Ueberlappung)."""
    gefunden: set[bytes] = set()
    rest, gelesen, ueberlappung = b"", 0, max(len(m) for m in markers)
    with path.open("rb") as stream:
        while gelesen < limit and len(gefunden) < len(markers):
            block = stream.read(min(4 * 1024 * 1024, limit - gelesen))
            if not block:
                break
            gelesen += len(block)
            fenster = rest + block
            gefunden.update(m for m in markers if m in fenster)
            rest = fenster[-ueberlappung:]
    return gefunden


def pe_container(path: Path) -> tuple[str, str | None, str] | None:
    """Selbstentpackende EXE/Installer-Stub: (format, werkzeug|None, grund); None = gewoehnliches Programm."""
    try:
        marker = marker_in(path, (INNO_MARKER, CAB_MARKER, b"InstallShield"))
        if INNO_MARKER in marker:
            return "inno", VERSCHACHTELT_TOOLS["inno"], ""
        start, laenge = pe_overlay(path)
        kopf = b""
        if laenge:
            with path.open("rb") as stream:
                stream.seek(start)
                kopf = stream.read(64)
    except OSError:
        return None
    for magic, name in ((b"7z\xbc\xaf\x27\x1c", "pe-7z"), (b"PK\x03\x04", "pe-zip"), (b"Rar!\x1a\x07", "pe-rar")):
        if kopf.startswith(magic):
            return name, VERSCHACHTELT_TOOLS[name], ""
    if kopf.startswith(ISC_MAGIC) or (laenge and b"InstallShield" in marker):
        return "installshield-sfx", None, "InstallShield-Selbstentpacker, kein Werkzeug im Image"
    if CAB_MARKER in marker:
        return "pe-cab", VERSCHACHTELT_TOOLS["pe-cab"], ""
    if laenge >= PE_OVERLAY_MIN:
        return "pe-overlay", None, f"{laenge} Bytes unbekannte Daten hinter dem Programm"
    return None


def ist_msi(path: Path) -> bool:
    """OLE-Verbunddatei mit Installer-CLSID im Wurzeleintrag (sonst z. B. Office-Dokument, kein Container)."""
    try:
        with path.open("rb") as stream:
            head = stream.read(512)
            shift = int.from_bytes(head[0x1E:0x20], "little")
            if not 7 <= shift <= 16:
                return False
            stream.seek((int.from_bytes(head[0x30:0x34], "little") + 1) << shift)
            root = stream.read(128)
    except OSError:
        return False
    clsid = root[0x50:0x60]
    return len(clsid) == 16 and clsid[0] in (0x84, 0x86) and clsid[1:] == MSI_CLSID_REST


def installshield_satz(path: Path) -> str:
    """Name des Satzanfangs, wenn path nur ein Teil ist (DATA1.HDR zu DATA1.CAB, DATA2.CAB zu DATA1.CAB), sonst ''.
    unshield findet Header und Folgebaende selbst ueber die Namen; entpackt wird nur der erste Band."""
    stem, endung = path.stem, path.suffix.lower()
    try:
        nachbarn = {p.name.lower(): p.name for p in path.parent.iterdir() if p.is_file() and not p.is_symlink()}
    except OSError:
        return ""
    if endung == ".hdr" and (stem + ".cab").lower() in nachbarn:
        return nachbarn[(stem + ".cab").lower()]
    satz = SATZ_RE.match(stem)
    if satz and int(satz.group(2)) > 1 and (satz.group(1) + "1.cab").lower() in nachbarn:
        return nachbarn[(satz.group(1) + "1.cab").lower()]
    return ""


def container_art(path: Path) -> tuple[str, str | None, str] | None:
    """(format, werkzeug|None, grund) am Inhalt, nie an der Endung; None = Nutzdaten."""
    try:
        with path.open("rb") as stream:
            head = stream.read(HEAD_BYTES)
    except OSError:
        return None
    siedler = siedler3_modul().identify(head, path.suffix)
    if siedler:
        return siedler, "siedler3", ""
    if head.startswith(ISC_MAGIC):
        satz = installshield_satz(path)
        if satz:
            return "installshield", None, "teil_eines_satzes:" + satz
        return "installshield", VERSCHACHTELT_TOOLS["installshield"], ""
    fmt = detect_format(path)
    if fmt == "pe":
        return pe_container(path)
    if fmt == "ole":
        return ("msi", VERSCHACHTELT_TOOLS["msi"], "") if ist_msi(path) else None
    if fmt == "cue":
        return "cue", None, "Disc-Steuerdatei in einem Archiv"
    if fmt in VERSCHACHTELT_TOOLS:
        return fmt, VERSCHACHTELT_TOOLS[fmt], ""
    for magic, name in SPIEL_CONTAINER:
        if head.startswith(magic):
            return name, None, "spieleigener Container, Parser/Inspektor als Folgeschritt"
    return None


def verschachtelt_kommando(tool: str, source: Path, ziel: Path, fmt: str) -> list[str]:
    if tool == "unshield":
        return [TOOLS[tool][0], "-d", str(ziel), "x", str(source)]
    if tool == "msiextract":
        return [TOOLS[tool][0], "-C", str(ziel), str(source)]
    if tool == "innoextract":
        return [*TOOLS[tool], "--output-dir", str(ziel), str(source)]
    return command_for(tool, source, ziel, {}, fmt)


def dateien_unter(root: Path) -> list[str]:
    """Regulaere Dateien relativ zu root (posix), ohne Symlinks zu folgen."""
    result = []
    for current, dirs, files in os.walk(root, followlinks=False):
        here = Path(current)
        dirs[:] = sorted(d for d in dirs if not (here / d).is_symlink())
        for name in sorted(files):
            path = here / name
            if path.is_file() and not path.is_symlink():
                result.append(path.relative_to(root).as_posix())
    return result


def entferne_nicht_dateien(root: Path) -> int:
    """Symlinks, Geraete und Pipes aus einem entpackten Container entfernen (das Manifest erlaubt nur Dateien)."""
    weg = 0
    for current, dirs, files in os.walk(root, followlinks=False):
        here = Path(current)
        for name in [*dirs, *files]:
            path = here / name
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                try:
                    path.unlink()
                    weg += 1
                except OSError:
                    pass
    return weg


def utf8_namen(root: Path) -> int:
    """Nicht-UTF-8-Namen (alte Installer/Archive, meist CP1252) umbenennen; sonst scheitert die JSON-Ausgabe."""
    umbenannt = 0
    for current, dirs, files in os.walk(root, topdown=False, followlinks=False):
        for name in [*files, *dirs]:
            try:
                name.encode("utf-8")
                continue
            except UnicodeEncodeError:
                pass
            neu = Path(current) / os.fsencode(name).decode("cp1252", "replace")
            if not neu.exists() and not neu.is_symlink():
                try:
                    os.rename(Path(current) / name, neu)
                    umbenannt += 1
                except OSError:
                    pass
    return umbenannt


def inhalt_ordner(source: Path) -> Path:
    ziel = source.with_name(source.name + INHALT_SUFFIX)
    nummer = 2
    while ziel.exists() or ziel.is_symlink():
        ziel = source.with_name(f"{source.name}{INHALT_SUFFIX}{nummer}")
        nummer += 1
    return ziel


def entpacke_container(out: Path, rel: str, fmt: str, tool: str, cap: dict[str, int], input_size: int,
                       env: dict[str, str], job_tmp: Path, deadline: float, stand: Bestand | None = None) -> dict[str, Any]:
    """Einen Container nach <name>~inhalt/ entpacken. Grenzverletzung/Fehler betreffen nur diesen Container."""
    source = out / rel
    rest = deadline - time.monotonic()
    if rest < 1:
        return {"status": "fehler", "grund": "zeitlimit"}
    ziel = inhalt_ordner(source)
    ziel.mkdir()
    if stand is not None:
        # P18-T87: nur den neuen Teilbaum pruefen, auf dem bekannten Bestand (+1 fuer den Zielordner selbst).
        basis, tiefe0 = (stand.dateien, stand.ordner + 1, stand.bytes), len(ziel.relative_to(out).parts)

        def pruefe() -> tuple[str, str] | None:
            return scan_output(ziel, cap, input_size, basis, tiefe0, out)
    else:
        def pruefe() -> tuple[str, str] | None:
            return scan_output(out, cap, input_size)

    def verwerfen(grund: str, meldung: str = "") -> dict[str, Any]:
        clear_output(ziel)
        shutil.rmtree(ziel, ignore_errors=True)
        return {"status": "fehler", "grund": grund, **({"meldung": meldung[-300:]} if meldung else {})}
    try:
        command = verschachtelt_kommando(tool, source, ziel, fmt)
    except ValueError:
        return verwerfen("nicht_unterstuetzt:" + fmt, f"Werkzeug {tool} nicht verfuegbar")
    try:
        code, meldung = run_isolated(command, max(1, int(rest)), env, ziel, job_tmp,
                                     guard=pruefe, preexec=file_size_limit(per_file_limit(cap, input_size)))
    except GrenzeUeberschritten as exc:
        return verwerfen(exc.code, str(exc))
    except subprocess.TimeoutExpired:
        return verwerfen("zeitlimit")
    final = pruefe()
    if final:
        return verwerfen(*final)
    if code == -signal.SIGXFSZ or (code and "File too large" in meldung):
        return verwerfen(*file_limit_violation(cap, input_size))
    entfernt = entferne_nicht_dateien(ziel)
    umbenannt = utf8_namen(ziel)
    anzahl = len(dateien_unter(ziel))
    if not anzahl:
        return verwerfen("werkzeug_fehler", meldung or f"{tool} lieferte keine Dateien")
    eintrag: dict[str, Any] = {"status": "entpackt" if code == 0 else "teilweise", "werkzeug": tool,
                               "inhalt": ziel.relative_to(out).as_posix(), "dateien": anzahl}
    if code:
        eintrag["meldung"] = meldung[-300:]
    if entfernt:
        eintrag["nicht_dateien_entfernt"] = entfernt
    if umbenannt:
        eintrag["namen_umkodiert"] = umbenannt
    return eintrag



# P18-T72: builtin static decoder, same E budgets and manifest as other containers.
_SIEDLER3: Any = None


def siedler3_modul() -> Any:
    global _SIEDLER3
    if _SIEDLER3 is None:
        spec = importlib.util.spec_from_file_location("reverse_siedler3", Path(__file__).with_name("siedler3.py"))
        if spec is None or spec.loader is None:
            raise ValueError("siedler3.py fehlt")
        _SIEDLER3 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_SIEDLER3)
    return _SIEDLER3


def siedler3_entpacken(source: Path, out: Path, rel: str, cap: dict[str, int], input_size: int,
                       deadline: float, meta: dict[str, dict[str, Any]], stand: Bestand | None = None) -> dict[str, Any]:
    stand = stand or Bestand(out)
    result = siedler3_modul().extract(source, out, rel, cap, input_size, deadline, limit_violation, stand.zahlen())
    # P18-T87: Bestand nur um die neuen Dateien (und ihren einen Ordner) ergaenzen statt die Ausgabe neu zu zaehlen.
    if result["metadaten"]:
        stand.plus(len(result["metadaten"]), 1, sum((out / p).stat().st_size for p in result["metadaten"]))
    depth = int(meta.get(rel, {}).get("herkunft", {}).get("tiefe", 0)) + 1
    for item in result["metadaten"].values():
        item["herkunft"]["tiefe"] = depth
    meta.update(result["metadaten"])
    return {k: v for k, v in result.items() if k != "metadaten"}


def siedler3_status(meta: dict[str, dict[str, Any]]) -> dict[str, Any]:
    results = {p: m["verschachtelt"] for p, m in meta.items()
               if m.get("verschachtelt", {}).get("werkzeug") == "siedler3"}
    errors = [v.get("grund") for v in results.values() if v.get("status") != "entpackt"]
    return {"ergebnisse": results, "fehlercode": errors[0] if errors else None}


# P18-T76: same E budgets and manifest/import path; no PE loader or subprocess.
_PE_RES: Any = None


def pe_ressourcen_modul() -> Any:
    global _PE_RES
    if _PE_RES is None:
        spec = importlib.util.spec_from_file_location("reverse_pe_ressourcen", Path(__file__).with_name("pe_ressourcen.py"))
        if spec is None or spec.loader is None:
            raise ValueError("pe_ressourcen.py fehlt")
        _PE_RES = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_PE_RES)
    return _PE_RES


def pe_ressourcen(source: Path, out: Path, rel: str, cap: dict[str, int], input_size: int,
                  deadline: float, meta: dict[str, dict[str, Any]], stand: Bestand | None = None) -> bool:
    stand = stand or Bestand(out)
    result = pe_ressourcen_modul().extract(source, out, rel, cap, input_size, deadline, limit_violation, stand.zahlen())
    # P18-T87: Bestand nur um die neuen Dateien (und ihren einen Ordner) ergaenzen statt die Ausgabe neu zu zaehlen.
    if result["metadaten"]:
        stand.plus(len(result["metadaten"]), 1, sum((out / p).stat().st_size for p in result["metadaten"]))
    parent_depth = int(meta.get(rel, {}).get("herkunft", {}).get("tiefe", 0))
    for item in result["metadaten"].values():
        item["herkunft"]["tiefe"] = parent_depth + 1
    meta.update(result["metadaten"])
    meta.setdefault(rel, {})["pe_ressourcen"] = {k: v for k, v in result.items() if k != "metadaten"}
    return result["status"] == "teilweise"


def pe_ressourcen_status(meta: dict[str, dict[str, Any]]) -> dict[str, Any]:
    results = {p: m["pe_ressourcen"] for p, m in meta.items() if "pe_ressourcen" in m}
    errors = [v.get("fehlercode") for v in results.values() if v.get("status") == "teilweise"]
    return {"ergebnisse": results, "fehlercode": errors[0] if errors else None}


def entpacke_verschachtelt(out: Path, cap: dict[str, int], input_size: int, env: dict[str, str], job_tmp: Path,
                           started: float, ueberspringen: frozenset[str] = frozenset(),
                           pe_aktiv: bool = False, siedler_aktiv: bool = False) -> tuple[dict[str, dict[str, Any]], bool]:
    """Rekursiv bis keine neuen Container auftauchen. Rueckgabe: Zusatzmetadaten je Pfad, vorzeitig beendet.

    P18-T87: Die Ausgabe wird einmal gezaehlt (Bestand) und nur um neu Entpacktes ergaenzt; Dateien aus einem entpackten
    Container kommen in die Warteschlange, statt die Ausgabe je Runde neu zu lesen. Vor jeder Datei gelten Frist
    (arbeitsende) und Grenzen: ist die Frist um oder passt keine weitere Datei, endet die Phase sofort (_STOPP mit Phase,
    Pfad und Anzahl offener Dateien). Das bis dahin Entpackte bleibt und kommt ins Manifest.
    """
    global _STOPP
    _STOPP = None
    meta: dict[str, dict[str, Any]] = {}
    if cap["max_verschachtelung"] < 1:
        return meta, False
    utf8_namen(out)
    tiefe: dict[str, int] = {}
    deadline = arbeitsende(started, cap)
    stand = Bestand(out)
    warteschlange = deque(rel for rel in dateien_unter(out) if rel not in ueberspringen)
    while warteschlange:
        rel = warteschlange[0]
        if time.monotonic() >= deadline:
            halte_an("deadline", "deadline", "verschachtelt", rel,
                     f"Zeitlimit {cap['zeitlimit_s']} s erreicht; {len(warteschlange)} Dateien nicht mehr geprueft",
                     len(warteschlange))
            return meta, True
        voll = stand.voll(cap, input_size)
        if voll:
            halte_an("grenze", voll[0], "verschachtelt", rel,
                     f"Grenze erreicht ({stand.dateien} Dateien, {stand.ordner} Ordner, {stand.bytes} Bytes): {voll[1]}; "
                     f"{len(warteschlange)} Dateien nicht mehr geprueft", len(warteschlange))
            return meta, True
        warteschlange.popleft()
        if pe_aktiv and head_bytes(out / rel, 2) == b"MZ":
            fortschritt_phase("pe_ressourcen", rel)
            pe_ressourcen(out / rel, out, rel, cap, input_size, deadline, meta, stand)
            if meta.get(rel, {}).get("pe_ressourcen", {}).get("fehlercode") == "zeitlimit":
                halte_an("deadline", "deadline", "pe_ressourcen", rel, f"Zeitlimit {cap['zeitlimit_s']} s erreicht",
                         len(warteschlange))
                return meta, True
        art = container_art(out / rel)
        if art is None:
            continue
        fmt, tool, grund = art
        eintrag: dict[str, Any] = {"format": fmt}
        if tool == "siedler3" and not siedler_aktiv:
            tool, grund = None, "Produktschalter reverse_siedler3 ist AUS"
        if tool is None and grund.startswith("teil_eines_satzes:"):
            eintrag.update(status="teil", grund=grund)
        elif tool is None:
            eintrag.update(status="vorgemerkt" if fmt in SPIEL_FORMATE else "nicht_unterstuetzt",
                           grund="nicht_unterstuetzt:" + fmt, hinweis=grund)
        elif tiefe.get(rel, 0) >= cap["max_verschachtelung"]:
            eintrag.update(status="fehler", grund="tiefenlimit")
        elif tool == "siedler3":
            fortschritt_phase("siedler3", rel)
            eintrag.update(siedler3_entpacken(out / rel, out, rel, cap, input_size, deadline, meta, stand))
        else:
            fortschritt_phase("verschachtelt", rel)
            eintrag.update(entpacke_container(out, rel, fmt, tool, cap, input_size, env, job_tmp, deadline, stand))
            if eintrag.get("inhalt"):
                f, d, t = baum_zaehlen(out / eintrag["inhalt"])
                stand.plus(f, d + 1, t)
                for inner in dateien_unter(out / eintrag["inhalt"]):
                    pfad = eintrag["inhalt"] + "/" + inner
                    tiefe[pfad] = tiefe.get(rel, 0) + 1
                    meta.setdefault(pfad, {})["herkunft"] = {"archiv": rel, "pfad": inner, "tiefe": tiefe[pfad]}
                    warteschlange.append(pfad)
        meta.setdefault(rel, {})["verschachtelt"] = eintrag
        if eintrag.get("grund") == "zeitlimit":
            halte_an("deadline", "deadline", "verschachtelt", rel, f"Zeitlimit {cap['zeitlimit_s']} s erreicht",
                     len(warteschlange))
            return meta, True
    return meta, False


def verschachtelt_zusammenfassung(meta: dict[str, dict[str, Any]]) -> dict[str, Any]:
    container = {pfad: m["verschachtelt"] for pfad, m in meta.items() if "verschachtelt" in m}
    offen = [{"pfad": pfad, "format": v["format"], "status": v["status"], "grund": v.get("grund")}
             for pfad, v in sorted(container.items()) if v["status"] not in ("entpackt", "teil")]
    return {"container": len(container), "entpackt": sum(v["status"] == "entpackt" for v in container.values()),
            "nicht_entpackt": offen[:200], "nicht_entpackt_gesamt": len(offen), **({"abbruch": _STOPP} if _STOPP else {})}


def merge_verschachtelt(files: Any, meta: dict[str, dict[str, Any]]) -> None:
    def update(datei: dict[str, Any]) -> None:
        zusatz = meta.get(datei["pfad"])
        if zusatz:
            datei["metadaten"] = {**(datei.get("metadaten") or {}), **zusatz}
            if "verschachtelt" in zusatz:
                datei["art"] = "archiv"
            elif "siedler3" in zusatz:
                mime = zusatz.get("mime_type", "")
                datei["art"] = "asset" if mime.startswith(("image/", "audio/")) else "text" if mime == "application/json" else "binaer"
            elif "pe_ressource" in zusatz:
                mime = zusatz.get("mime_type", "")
                datei["art"] = "asset" if mime.startswith("image/") else "text" if mime.startswith("text/") else "binaer"

    # P18-T88: das Dateimanifest wird zeilenweise ergaenzt, nie als ganze Liste im Speicher.
    if hasattr(files, "augment"):
        files.augment(update)
    else:
        for datei in files:
            update(datei)


def verschachtelt_isoliert(out: Path, cap: dict[str, int], input_size: int, env: dict[str, str], job_tmp: Path,
                           started: float, pe_aktiv: bool = False, siedler_aktiv: bool = False) -> tuple[dict[str, dict[str, Any]], bool]:
    """Wie entpacke_verschachtelt, mit eigenem TMPDIR und Prozess-Sweep danach (nach dem Hauptwerkzeug)."""
    job_tmp.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        return entpacke_verschachtelt(out, cap, input_size, env, job_tmp, started, pe_aktiv=pe_aktiv, siedler_aktiv=siedler_aktiv)
    finally:
        rest = sweep_processes()
        clean_tmp(job_tmp)
        if rest:
            fortschritt_stoppen()
            ausgabe({"status": "fehler", "fehlercode": "werkzeug_fehler",
                     "meldung": f"{rest} Prozess(e) ueberlebten den Auftrag"})
            raise SystemExit(3)


def run_disc(req: dict[str, Any], job: str, cap: dict[str, int], input_size: int, medium: list[tuple[str, Path]],
             erkennung: Any, nur_tabelle: bool = False) -> list[dict[str, Any]]:
    """P18-T49/RV34: Parser (Registry) -> Spurtabelle -> gemeinsamer Extraktor im eigenen Prozess mit Zeit-, RAM- und
    Dateigroessen-Grenzen; danach ISO -> E-Profil. Das Ergebnis traegt Spurtabelle, Hinweise und je Datei art/metadaten."""
    global _STOPP
    disc = disc_modul()
    started = time.monotonic()
    _STOPP = None
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
    raw_optionen = req.get("optionen")
    optionen: dict[str, Any] = raw_optionen if isinstance(raw_optionen, dict) else {}
    hinweise: list[dict[str, Any]] = []
    teilweise = abgebrochen = False
    verschachtelt: dict[str, dict[str, Any]] = {}
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
            fortschritt_phase("iso_entpacken")
            code, meldung = run_isolated([sys.executable, "-I", str(DISC_PY), str(auftrag_pfad)], restzeit(arbeitsende(started, cap)),
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
                        teilweise = not entpacke_iso(out, eintrag, cap, input_size, env, job_tmp, hinweise,
                                                     arbeitsende(started, cap)) or teilweise
                iso = frozenset(p for p, e in meta.items() if (e.get("metadaten") or {}).get("rolle") == "iso")
                verschachtelt, abgebrochen = entpacke_verschachtelt(out, cap, input_size, env, job_tmp, started, iso, optionen.get("pe_ressourcen") is True, optionen.get("siedler3") is True)
        finally:
            rest = sweep_processes()
            clean_tmp(job_tmp)
            if rest:
                fortschritt_stoppen()
                ausgabe({"status": "fehler", "fehlercode": "werkzeug_fehler",
                         "meldung": f"{rest} Prozess(e) ueberlebten den Auftrag"})
                raise SystemExit(3)
        parser = tabelle.get("parser") or {}
        version = f"disc-registry {disc.REGISTRY_VERSION}; {parser.get('id', erkennung.parser)} {parser.get('version', '')}".strip()
        if out is None:
            return [{"status": "fertig", "fehlercode": None, "werkzeug_version": version, "format": erkennung.format,
                     "spurtabelle": tabelle, "manifest": [], "dauer_s": round(time.monotonic() - started, 3)}]
        files, size = output_manifest(out, cap, input_size, lauf_ende(started, cap))
    except GrenzeUeberschritten as exc:
        if out:
            clear_output(out)
        return [{"status": "fehler", "fehlercode": exc.code, "meldung": str(exc), "manifest": [],
                 "dauer_s": round(time.monotonic() - started, 3)}]
    def disc_meta(datei: dict[str, Any]) -> None:
        zusatz = meta.get(datei["pfad"])
        if zusatz:
            datei["art"] = zusatz.get("art")
            datei["metadaten"] = zusatz.get("metadaten") or {}
    if hasattr(files, "augment"):
        files.augment(disc_meta)
    else:
        for datei in files:
            disc_meta(datei)
    merge_verschachtelt(files, verschachtelt)
    pe_status = pe_ressourcen_status(verschachtelt)
    siedler_status = siedler3_status(verschachtelt)
    teilweise = teilweise or bool(pe_status["fehlercode"] or siedler_status["fehlercode"])
    abgebrochen = abgebrochen or _STOPP is not None
    return [
        {"status": "fortschritt", "funktionen_fertig": len(files), "gesamt": len(files)},
        {"status": "teilweise" if teilweise or abgebrochen else "fertig",
         "fehlercode": pe_status["fehlercode"] or siedler_status["fehlercode"] or ("werkzeug_fehler" if teilweise else abbruch_code(abgebrochen)),
         **({"abbruch": _STOPP} if _STOPP else {}),
         "pe_ressourcen": {"aktiv": optionen.get("pe_ressourcen") is True, "stand": optionen.get("pe_ressourcen_stand"), **pe_status},
         "siedler3": {"aktiv": optionen.get("siedler3") is True, "stand": optionen.get("siedler3_stand"), **siedler_status},
         "werkzeug_version": version, "format": erkennung.format, "spurtabelle": tabelle, "hinweise": hinweise,
         "verschachtelt": verschachtelt_zusammenfassung(verschachtelt),
         "dauer_s": round(time.monotonic() - started, 3), **manifest_wire(files), "ausgabe_bytes": str(size) if cap.get("blockuebernahme") else size},
    ]



def normalisierer_rohausgaben(source: Path, out: Path, cap: dict[str, int], env: dict[str, str],
                              job_tmp: Path, deadline: float) -> None:
    """RV14: static S1 tools in the SAME requested S3 job; original is read-only.
    Raw stdout stays on the dataset; only manifest-verified normalization enters PG.
    """
    magic = head_bytes(source, 8)
    if magic.startswith(b"\0asm"):
        commands = [("wasm-objdump", "s1-wasm.txt", ["wasm-objdump", "-x", "-d", str(source)])]
    elif magic.startswith(b"\xca\xfe\xba\xbe"):
        commands = [("javap", "s1-javap.txt", ["javap", "-c", "-p", source.as_uri()])]
    elif magic.startswith((b"MZ", b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xce")):
        commands = [("rz-bin", "s1-rz-" + name + ".json", ["rz-bin", "-" + flag + "j", str(source)])
                    for name, flag in (("strings", "z"), ("imports", "i"), ("symbols", "s"))]
    else:
        return
    failures, tools = [], []
    for tool, filename, command in commands:
        remaining = int(deadline - time.monotonic())
        if remaining < 1 or not shutil.which(tool):
            failures.append("zeitlimit" if remaining < 1 else "werkzeug_fehlt:" + tool)
            continue
        try:
            code, _ = run_isolated(command, remaining, env, out, job_tmp,
                                   preexec=file_size_limit(cap["max_bytes"]))
            stdout = job_tmp / ".stdout"
            if code or not stdout.is_file():
                failures.append("werkzeug_fehler:" + tool)
                continue
            size = stdout.stat().st_size
            if size > cap["max_bytes"]:
                failures.append("zu_gross:" + tool)
                continue
            # No logs/metadata carry the unmasked raw values.
            payload = stdout.read_bytes()
            if limit_violation(len(dateien_unter(out)) + 1, 0,
                               sum((out / p).stat().st_size for p in dateien_unter(out)) + size,
                               cap, source.stat().st_size):
                failures.append("zu_gross:" + tool)
                continue
            (out / filename).write_bytes(payload)
            tools.append(tool)
        except subprocess.TimeoutExpired:
            failures.append("zeitlimit:" + tool)
    (out / "normalisierer-status.json").write_text(json.dumps({
        "status": "teilweise" if failures else "fertig", "werkzeuge": sorted(set(tools)), "fehler": failures}), encoding="utf-8")


def run_request(req: dict[str, Any]) -> list[dict[str, Any]]:
    # P18-T40: separater Vertragsadapter vor jedem E-/S3-/BIB-Pfad.
    if req.get("kommando") == "leser_ausfuehren":
        from leser import ausfuehren
        return [ausfuehren(req)]
    global _STOPP
    _STOPP = None
    job = job_id(req)
    cap = limits(req)
    source = path_under(str(req.get("eingabe", "")), BIB, True)
    if not source.is_file():
        raise ValueError("Eingabe ist keine regulaere Datei")
    extract = req.get("kommando") == "extrahieren"
    raw_options = req.get("optionen")
    optionen: dict[str, Any] = raw_options if isinstance(raw_options, dict) else {}
    pe_aktiv = optionen.get("pe_ressourcen") is True
    siedler_aktiv = optionen.get("siedler3") is True
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
    siedler_fmt = siedler3_modul().identify(head_bytes(source, 96), Path(str(req.get("eingabe_name") or source.name)).suffix) if extract else None
    siedler_only = bool(siedler_fmt and siedler_aktiv)
    tool = "siedler3" if siedler_only else selected_tool(req, fmt)
    if siedler_only:
        fmt = str(siedler_fmt)
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
    pe_only = extract and fmt == "pe" and pe_aktiv and pe_container(source) is None
    command = [] if pe_only or siedler_only else command_for(tool, source, out, req, fmt)
    started = time.monotonic()
    job_tmp = TMP_ROOT / job
    shutil.rmtree(job_tmp, ignore_errors=True)
    job_tmp.mkdir(mode=0o700, parents=True)
    env = {**os.environ, "HOME": str(job_tmp), "TMPDIR": str(job_tmp),
           "LC_ALL": "C.UTF-8", "GHIDRA_HOME": "/opt/ghidra"}
    if tool == "analyzeHeadless":
        # P18-T69/E0: Java nimmt user.home aus passwd (/nonexistent, read-only rootfs), HOME wirkt nicht. Ghidra
        # verlangt ausserdem einen vorhandenen Projektordner (sonst 'Directory not found').
        env["JAVA_TOOL_OPTIONS"] = f"-Duser.home={job_tmp} -Djava.io.tmpdir={job_tmp} -Xmx{GHIDRA_HEAP}"
        (out / "ghidra-project").mkdir()
    # P18-T62: beim Entpacken laufende Pruefung + Groessengrenze je Datei; Analysewerkzeuge wie bisher.
    guard = (lambda: scan_output(out, cap, input_size)) if extract else None
    preexec = file_size_limit(per_file_limit(cap, input_size)) if extract else None
    try:
        try:
            if pe_only or siedler_only:
                code, meldung = 0, ""  # ordinary PE: resources are not an archive for 7zz
            else:
                fortschritt_phase("iso_entpacken" if fmt in SEVENZIP_TYPES else "werkzeug")
                code, meldung = run_isolated(command, restzeit(arbeitsende(started, cap)), env, out, job_tmp, guard=guard, preexec=preexec)
                if tool == "analyzeHeadless" and code == 0:
                    normalisierer_rohausgaben(source, out, cap, env, job_tmp, arbeitsende(started, cap))
        finally:
            rest = sweep_processes()
            clean_tmp(job_tmp)
            if rest:
                # Isolation nicht wiederhergestellt: Auftrag scheitert, Runner beendet sich -> der Lebenszyklus
                # erkennt den toten Container (container_crashed) und startet beim naechsten Auftrag frisch.
                fortschritt_stoppen()
                ausgabe({"status": "fehler", "fehlercode": "werkzeug_fehler",
                         "meldung": f"{rest} Prozess(e) ueberlebten den Auftrag"})
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
        verschachtelt, abgebrochen = (verschachtelt_isoliert(out, cap, input_size, env, job_tmp, started, pe_aktiv, siedler_aktiv)
                                      if extract else ({}, False))
        if extract and fmt == "pe" and pe_aktiv:
            rel = Path(str(req.get("eingabe_name") or source.name)).name
            fortschritt_phase("pe_ressourcen", rel)
            pe_ressourcen(source, out, rel, cap, input_size, arbeitsende(started, cap), verschachtelt)
        if siedler_only:
            rel = Path(str(req.get("eingabe_name") or source.name)).name
            fortschritt_phase("siedler3", rel)
            result = siedler3_entpacken(source, out, rel, cap, input_size, arbeitsende(started, cap), verschachtelt)
            verschachtelt.setdefault(rel, {})["verschachtelt"] = {"format": siedler_fmt, **result}
        files, size = output_manifest(out, cap, input_size, lauf_ende(started, cap))
    except GrenzeUeberschritten as exc:
        clear_output(out)
        return [{"status": "fehler", "fehlercode": exc.code, "meldung": str(exc), "manifest": [],
                 "dauer_s": round(time.monotonic() - started, 3)}]
    version = "siedler3 P18-T72" if siedler_only else "pe-ressourcen P18-T76" if pe_only else tool_version(tool)
    merge_verschachtelt(files, verschachtelt)
    abgebrochen = abgebrochen or _STOPP is not None
    ende: dict[str, Any] = {"status": "teilweise" if abgebrochen else "fertig", "fehlercode": abbruch_code(abgebrochen),
                            "werkzeug_version": version, "format": fmt or None,
                            "dauer_s": round(time.monotonic() - started, 3), **manifest_wire(files), "ausgabe_bytes": str(size) if cap.get("blockuebernahme") else size}
    if _STOPP is not None:
        ende["abbruch"] = _STOPP
    if extract:
        pe_status = pe_ressourcen_status(verschachtelt)
        if pe_status["fehlercode"]:
            ende.update(status="teilweise", fehlercode=pe_status["fehlercode"])
        ende["pe_ressourcen"] = {"aktiv": pe_aktiv, "stand": optionen.get("pe_ressourcen_stand"), **pe_status}
        siedler_status = siedler3_status(verschachtelt)
        if siedler_status["fehlercode"]:
            ende.update(status="teilweise", fehlercode=siedler_status["fehlercode"])
        ende["siedler3"] = {"aktiv": siedler_aktiv, "stand": optionen.get("siedler3_stand"), **siedler_status}
        ende["verschachtelt"] = verschachtelt_zusammenfassung(verschachtelt)
    return [{"status": "fortschritt", "funktionen_fertig": len(files), "gesamt": len(files)}, ende]


def main() -> int:
    global _FORTSCHRITT
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
            # P18-T85: Live-Fortschritt nur fuer die Dauer dieses Auftrags; gestoppt vor jeder Endmeldung.
            _FORTSCHRITT = Fortschritt.aus_auftrag(request)
            if _FORTSCHRITT is not None:
                _FORTSCHRITT.starten()
            try:
                events = run_request(request)
            finally:
                if _FORTSCHRITT is not None:
                    _FORTSCHRITT.stoppen()
                _FORTSCHRITT = None
            for event in events:
                ausgabe(event)
        except subprocess.TimeoutExpired:
            ausgabe({"status": "teilweise", "fehlercode": "deadline", "manifest": []})
        except (ValueError, OSError, json.JSONDecodeError, TypeError) as exc:
            ausgabe({"status": "fehler", "fehlercode": "ungueltiger_auftrag", "meldung": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
