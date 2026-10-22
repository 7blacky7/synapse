"""P18-T40: formatneutraler Prozessadapter. Vertrauen entsteht erst im Host-Validator."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time
from typing import BinaryIO, cast

PROTOKOLL = ".leser-protokoll.jsonl"
# Isolierter Interpreter, nur Standardbibliothek und das RO-Leserpaket.
_BOOTSTRAP = """
import resource,runpy,sys
resource.setrlimit(resource.RLIMIT_AS,(int(sys.argv[2]),int(sys.argv[2])))
resource.setrlimit(resource.RLIMIT_FSIZE,(int(sys.argv[3]),int(sys.argv[3])))
resource.setrlimit(resource.RLIMIT_CPU,(int(sys.argv[4]),int(sys.argv[4])))
sys.path.insert(0,'/leser')
runpy.run_path(sys.argv[1],run_name='__main__')
"""


def _zahl(grenzen: dict, name: str) -> int:
    wert = grenzen[name]
    if not isinstance(wert, str) or not wert.isascii() or not wert.isdecimal():
        raise ValueError("leser_grenze_ungueltig:" + name)
    return int(wert)


def _baum(wurzel: Path, grenzen: dict, deadline: float) -> None:
    """Kein Follow von Links/Spezialdateien; auch nicht gemeldete Dateien zählen."""
    anzahl = groesse = ordner = 0
    stapel = [(wurzel, 0)]
    while stapel:
        if time.monotonic() >= deadline:
            raise ValueError("leser_zeitlimit")
        pfad, tiefe = stapel.pop()
        if tiefe > _zahl(grenzen, "tiefe"):
            raise ValueError("leser_pfad_tiefe")
        with os.scandir(pfad) as eintraege:
            for eintrag in eintraege:
                if time.monotonic() >= deadline:
                    raise ValueError("leser_zeitlimit")
                s = eintrag.stat(follow_symlinks=False)
                if stat.S_ISDIR(s.st_mode):
                    ordner += 1
                    if ordner > _zahl(grenzen, "dateien") * (_zahl(grenzen, "tiefe") + 1):
                        raise ValueError("leser_verzeichnisse_limit")
                    stapel.append((Path(eintrag.path), tiefe + 1))
                elif stat.S_ISREG(s.st_mode) and s.st_nlink == 1:
                    anzahl += 1
                    groesse += s.st_size
                    if eintrag.name != PROTOKOLL and s.st_size > _zahl(grenzen, "datei_bytes"):
                        raise ValueError("leser_datei_zu_gross")
                else:
                    raise ValueError("leser_ausgabe_spezialdatei")
                if anzahl > _zahl(grenzen, "dateien") + 1 or groesse > _zahl(grenzen, "bytes") + _zahl(grenzen, "protokoll_bytes"):
                    raise ValueError("leser_schrittgrenze")



_GRENZEN_FELDER = ("zeit_ms", "ram_mib", "dateien", "bytes", "cpu", "datei_bytes", "protokoll_bytes", "zeile_bytes", "eingabe_bytes", "lese_bytes", "tiefe", "poll_ms", "wait_ms",)


def leser_stdin(auftrag: dict) -> bytes:
    """Nur die serverseitige PG-Projektion, niemals Grenzen aus leser_eingabe übernehmen."""
    grenzen = auftrag.get("leser_grenzen")
    if not isinstance(grenzen, dict):
        raise ValueError("leser_grenzen_fehlen")
    if set(grenzen) != set(_GRENZEN_FELDER):
        raise ValueError("leser_grenzen_felder")
    for name in _GRENZEN_FELDER:
        wert = grenzen[name]
        if (not isinstance(wert, str) or not wert.isascii() or not wert.isdecimal()
                or wert.startswith("0") or int(wert) > 9223372036854775807):
            raise ValueError("leser_grenze_ungueltig:" + name)
    eingabe = auftrag.get("leser_eingabe")
    if not isinstance(eingabe, dict):
        raise ValueError("leser_auftrag_ungueltig")
    payload = {**eingabe, "grenzen": {"version": 1, **grenzen}}
    daten = (json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    if len(daten) > _zahl(grenzen, "eingabe_bytes"):
        raise ValueError("leser_eingabe_limit")
    return daten


def ausfuehren(auftrag: dict) -> dict:
    """Genau ein Kind, ein Schritt. Keine Formatwahl, Installation, Queue oder Adoption."""
    daten = leser_stdin(auftrag)
    eingabe, grenzen = auftrag["leser_eingabe"], auftrag["leser_grenzen"]
    entrypoint = auftrag["leser_entrypoint"]
    if (eingabe["schnittstelle_version"] != 1 or eingabe["eingabe"] != "/eingabe"
            or eingabe["ausgabe"] != "/arbeit" or not isinstance(entrypoint, str)
            or entrypoint.startswith("/") or "\\" in entrypoint
            or any(t in ("", ".", "..") for t in entrypoint.split("/"))):
        raise ValueError("leser_auftrag_ungueltig")
    quellpfad, ziel, programm = Path("/eingabe"), Path("/arbeit"), Path("/leser") / entrypoint
    if not quellpfad.is_file() or quellpfad.is_symlink() or not programm.is_file() or programm.is_symlink():
        raise ValueError("leser_eingabe_ungueltig")
    if any(ziel.iterdir()):
        raise ValueError("leser_ausgabe_nicht_leer")
    zeit_ms = _zahl(grenzen, "zeit_ms")
    deadline = time.monotonic() + zeit_ms / 1000
    # daten enthält die bereits validierte, versionierte Grenzenprojektion.
    prozess = None
    digest, gesamt, zeilen = hashlib.sha256(), 0, 0
    rest = b""
    fehler = None
    fd = os.open(ziel / PROTOKOLL, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", buffering=0) as protokoll, selectors.DefaultSelector() as selector:
            prozess = subprocess.Popen(
                [sys.executable, "-I", "-B", "-u", "-c", _BOOTSTRAP, str(programm),
                 str(_zahl(grenzen, "ram_mib") * 1048576), str(_zahl(grenzen, "datei_bytes")),
                 str(max(1, math.ceil(zeit_ms / 1000) * _zahl(grenzen, "cpu")))],
                cwd=ziel, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent", "TMPDIR": "/tmp"},
                start_new_session=True, close_fds=True)
            for stream, ereignis, art in [(prozess.stdin, selectors.EVENT_WRITE, "in"),
                                         (prozess.stdout, selectors.EVENT_READ, "out"),
                                         (prozess.stderr, selectors.EVENT_READ, "err")]:
                if stream is None:
                    raise ValueError("leser_pipe_fehlt")
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, ereignis, art)
            pos = stderr_bytes = 0
            while selector.get_map() or prozess.poll() is None:
                if time.monotonic() >= deadline:
                    raise ValueError("leser_zeitlimit")
                _baum(ziel, grenzen, deadline)
                for key, _ in selector.select(min(_zahl(grenzen, "poll_ms") / 1000, max(0, deadline - time.monotonic()))):
                    if key.data == "in":
                        try:
                            pos += os.write(key.fd, daten[pos:pos + _zahl(grenzen, "lese_bytes")])
                        except BrokenPipeError:
                            pos = len(daten)
                        if pos == len(daten):
                            selector.unregister(key.fileobj)
                            cast(BinaryIO, key.fileobj).close()
                        continue
                    block = os.read(key.fd, _zahl(grenzen, "lese_bytes"))
                    if not block:
                        selector.unregister(key.fileobj)
                        cast(BinaryIO, key.fileobj).close()
                        continue
                    if key.data == "err":
                        stderr_bytes += len(block)
                        if stderr_bytes > _zahl(grenzen, "protokoll_bytes"):
                            raise ValueError("leser_stderr_limit")
                        continue  # Nutzdaten weder in API-Logs noch in PG.
                    gesamt += len(block)
                    if gesamt > _zahl(grenzen, "protokoll_bytes"):
                        raise ValueError("leser_protokoll_limit")
                    rest += block
                    while b"\n" in rest:
                        zeile, rest = rest.split(b"\n", 1)
                        if len(zeile) > _zahl(grenzen, "zeile_bytes"):
                            raise ValueError("leser_zeile_limit")
                        protokoll.write(zeile + b"\n")
                        digest.update(zeile + b"\n")
                        zeilen += 1
                    if len(rest) > _zahl(grenzen, "zeile_bytes"):
                        raise ValueError("leser_zeile_limit")
            if rest:
                raise ValueError("leser_ende_unvollstaendig")
            if prozess.returncode != 0:
                raise ValueError("leser_exit_fehler")
            _baum(ziel, grenzen, deadline)
            os.fsync(protokoll.fileno())
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        fehler = str(exc) if isinstance(exc, ValueError) else "leser_prozess_fehler"
    finally:
        if prozess is not None:
            try:
                os.killpg(prozess.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            prozess.wait(timeout=_zahl(grenzen, "wait_ms") / 1000)
            for stream in (prozess.stdin, prozess.stdout, prozess.stderr):
                if stream is not None:
                    stream.close()
    # Der Host stoppt zusätzlich den ganzen Jobcontainer und validiert JSONL UND Dateien.
    return {"status": "fehler" if fehler else "fertig", "fehlercode": fehler,
            "leser_protokoll": {"pfad": PROTOKOLL, "sha256": digest.hexdigest(),
                               "bytes": str(gesamt), "zeilen": str(zeilen)},
            "leser_exit": None if prozess is None else prozess.returncode}
