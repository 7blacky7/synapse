"""Externer Leser V1. Keine Installation, keine Projekt-/Netzzugriffe."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time


class Schrittgrenze(ValueError):
    pass


class Quelle:
    def __init__(self, request):
        self.request = request
        limits = request.get("grenzen")
        if not isinstance(limits, dict):
            raise ValueError("pg_grenzen_fehlen")
        if type(limits.get("version")) is not int or limits["version"] != 1:
            raise ValueError("pg_grenzen_version")
        self.limits = {}
        for key in ("zeit_ms", "ram_mib", "dateien", "bytes", "datei_bytes",
                    "protokoll_bytes", "zeile_bytes", "lese_bytes", "tiefe",
                    "cpu", "eingabe_bytes", "poll_ms", "wait_ms"):
            value = limits.get(key)
            if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*", value) or int(value) > 9223372036854775807:
                raise ValueError("pg_grenze_ungueltig:" + key)
            self.limits[key] = int(value)
        self.deadline = time.monotonic() + self.limits["zeit_ms"] / 1000
        self.chunk = min(self.limits["lese_bytes"], self.limits["ram_mib"] * 1048576)
        if request.get("schnittstelle_version") != 1:
            raise ValueError("schnittstelle_nicht_unterstuetzt")
        fd = os.open(request["eingabe"], os.O_RDONLY | os.O_NOFOLLOW)
        self.stream = os.fdopen(fd, "rb")
        self.size = os.fstat(fd).st_size
        if not stat.S_ISREG(os.fstat(fd).st_mode) or str(self.size) != request["groesse"]:
            raise ValueError("quelle_groesse_ungueltig")
        digest = hashlib.sha256()
        for block in self.blocks(0, self.size):
            digest.update(block)
        if digest.hexdigest() != request["quell_sha256"]:
            raise ValueError("quelle_hash_ungueltig")

    def check(self):
        if time.monotonic() >= self.deadline:
            raise Schrittgrenze("zeitlimit")

    def read(self, offset, length):
        self.check()
        if offset < 0 or length < 0 or offset + length > self.size:
            raise ValueError("quellbereich_ungueltig")
        if length > self.chunk:
            raise Schrittgrenze("speicherlimit_leseblock")
        self.stream.seek(offset)
        data = self.stream.read(length)
        if len(data) != length:
            raise ValueError("quelle_verkuerzt")
        return data

    def blocks(self, offset, length):
        while length:
            n = min(length, self.chunk)
            yield self.read(offset, n)
            offset += n
            length -= n

    def u32(self, offset):
        return struct.unpack("<I", self.read(offset, 4))[0]

    def close(self):
        self.stream.close()


def pack(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def event(value):
    print(pack(value), flush=True)


def binding(request):
    return {key: request[key] for key in (
        "eintrag_id", "datei_id", "quell_sha256", "groesse", "leser_revision",
        "code_sha256", "generation", "einstellungen_revision")}


def record(identity, offset, length, kind, metadata, prefix=b"", payload=None, suffix=b""):
    return {"id": identity, "offset": offset, "length": length, "kind": kind,
            "metadata": metadata, "prefix": prefix, "payload": payload, "suffix": suffix}


class Ausgabe:
    def __init__(self, source):
        self.source = source
        self.request = source.request
        self.limits = source.limits
        self.root = Path(self.request["ausgabe"])
        if not self.root.is_dir() or self.root.is_symlink():
            raise ValueError("ausgabe_muss_leer_und_eigen_sein")
        for entry in self.root.iterdir():
            # Der Host öffnet seinen stdout-Spool VOR dem Kindstart.
            info = entry.lstat()
            if (entry.name != ".leser-protokoll.jsonl"
                    or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                raise ValueError("ausgabe_muss_leer_und_eigen_sein")
        self.count = self.files = self.bytes = self.protocol = 0
        self.segment = None
        self.segment_bytes = 0
        self.digest = hashlib.sha256()

    def emit(self, value):
        line = pack(value)
        size = len(line.encode()) + 1
        if size > self.limits["zeile_bytes"] or self.protocol + size > self.limits["protokoll_bytes"]:
            raise Schrittgrenze("protokollgrenze")
        event(value)
        self.protocol += size

    def put(self, item):
        self.source.check()
        identity = item["id"]
        name = hashlib.sha256(identity.encode()).hexdigest() + (
            ".wav" if item["prefix"].startswith(b"RIFF") else ".bin")
        payload = item["payload"]
        length = (len(item["prefix"]) + payload[1] + len(item["suffix"])) if payload else 0
        reference = {"pfad": name, "sha256": "0" * 64, "bytes": str(length)} if payload is not None else None
        obj = {"art": "objekt", "member_id": identity, "objektpfad": identity,
               "typ": item["kind"], "quelle": {"offset": str(item["offset"]), "laenge": str(item["length"])},
               "datei": reference, "metadaten": item["metadata"]}
        planned = len(pack(obj).encode()) + 1
        # Ein Segment ist ebenfalls eine Datei; keine kumulative Containerquote.
        if (self.count + 1 > self.limits["dateien"]
                or self.files + int(reference is not None) + 1 > self.limits["dateien"]
                or length > self.limits["datei_bytes"]
                or self.segment_bytes + planned > self.limits["datei_bytes"]
                or planned > self.limits["zeile_bytes"]
                or self.bytes + length + planned > self.limits["bytes"]):
            raise Schrittgrenze("schritt_oder_dateigrenze")
        if reference is not None:
            assert payload is not None
            digest = hashlib.sha256()
            fd = os.open(self.root / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as out:
                for chunk in (item["prefix"],):
                    out.write(chunk)
                    digest.update(chunk)
                try:
                    for chunk in self.source.blocks(*payload):
                        out.write(chunk)
                        digest.update(chunk)
                except Schrittgrenze as exc:
                    raise ValueError("record_unbestaetigt:" + str(exc)) from exc
                out.write(item["suffix"])
                digest.update(item["suffix"])
                out.flush()
                os.fsync(out.fileno())
            reference["sha256"] = digest.hexdigest()
            self.files += 1
        line = (pack(obj) + "\n").encode()
        if self.segment is None:
            self.segment = (self.root / "segment-0001.jsonl").open("xb")
        self.segment.write(line)
        self.digest.update(line)
        self.segment_bytes += len(line)
        self.bytes += length + len(line)
        self.count += 1

    def finish(self, cursor, complete, reason=None, failed=False):
        if self.segment is not None:
            self.segment.flush()
            os.fsync(self.segment.fileno())
            self.segment.close()
            self.emit({"art": "schritt", "cursor": pack(cursor),
                       "segment": {"pfad": "segment-0001.jsonl", "sha256": self.digest.hexdigest(),
                                   "bytes": str(self.segment_bytes), "zeilen": str(self.count)}})
        self.emit({"art": "ende", "status": "fehler" if failed else "fertig" if complete else "teilweise",
                   "grund": reason, "offen": "0" if complete else "1", "objekte": str(self.count)})


def run(records, identify, format_name):
    source = None
    try:
        request = json.loads(sys.stdin.readline())
        source = Quelle(request)
        detected = identify(source)
        if not detected:
            event({"art": "ende", "status": "nicht_unterstuetzt", "grund": "magic_oder_struktur_fremd",
                   "offen": "0", "objekte": "0"})
            return
        stamp = binding(request)
        position = 0
        if request.get("cursor") is not None:
            previous = json.loads(request["cursor"])
            if (previous.get("v") != 1 or previous.get("format") != format_name
                    or previous.get("bindung") != stamp
                    or not isinstance(previous.get("position"), int)
                    or isinstance(previous["position"], bool) or previous["position"] < 0):
                raise ValueError("cursor_quellstand_abweichend")
            position = previous["position"]
        output = Ausgabe(source)
        index = 0
        current = None
        reason = None
        failed = False
        try:
            for index, current in enumerate(records(source, detected)):
                if index < position:
                    continue
                try:
                    output.put(current)
                except Schrittgrenze as exc:
                    reason = str(exc)
                    break
                position = index + 1
            else:
                current = None
                if position > index + 1:
                    raise ValueError("cursor_ausserhalb_container")
        except Schrittgrenze as exc:
            reason = str(exc)
        except ValueError as exc:
            reason, failed = str(exc), True
        if output.count == 0 and reason is not None:
            # Original bleibt der Rohbeleg; unbestätigten Record NICHT überspringen.
            output.put(record("offen/" + str(position), 0, 0, "struktur",
                              {"grund": reason, "original_erhalten": True, "position": str(position)}))
        if output.count == 0 and reason is None:
            raise ValueError("cursor_ohne_offene_records")
        cursor = {"v": 1, "format": format_name, "bindung": stamp, "position": position,
                  "naechster_record": current["id"] if current is not None else None}
        output.finish(cursor, current is None and reason is None, reason, failed)
    except (ValueError, OSError, KeyError, TypeError, struct.error) as exc:
        event({"art": "ende", "status": "fehler", "grund": str(exc),
               "offen": "1", "objekte": "0"})
    finally:
        if source is not None:
            source.close()


# Quake PACK: Spezifikation ist das on-disk Verzeichnis, keine Spiele-Enums.
def identify(source):
    return source.read(0, min(4, source.size)) == b"PACK"


def records(source, _detected):
    _, directory, size = struct.unpack("<4sii", source.read(0, 12))
    if directory < 12 or size < 0 or size % 64 or directory + size > source.size:
        raise ValueError("pak_verzeichnis_ungueltig")
    yield record("pak/header", 0, 12, "struktur",
                 {"format": "quake-pak", "verzeichnis_offset": str(directory),
                  "member": str(size // 64), "leeres_verzeichnis": size == 0})
    for index in range(size // 64):
        entry = directory + index * 64
        name, offset, length = struct.unpack("<56sii", source.read(entry, 64))
        raw = name.split(b"\0", 1)[0]
        text = raw.decode("ascii", errors="backslashreplace")
        safe = (bool(raw) and all(32 <= b < 127 for b in raw) and not text.startswith("/")
                and not any(part in ("", ".", "..") for part in text.split("/"))
                and not any(c in text for c in "\\:") and len(text.split("/")) - 1 <= source.limits["tiefe"])
        if (offset < 0 or length < 0 or offset + length > source.size
                or length and (offset < 12 or offset < directory + size and offset + length > directory)):
            raise ValueError("pak_memberbereich_ungueltig:" + str(index))
        metadata = {"name": text, "name_hex": raw.hex(), "verzeichnis_offset": str(entry),
                    "leerer_member": length == 0, "originalpfad_sicher": safe,
                    "grund": None if safe else "originalpfad_nicht_als_ziel_verwendet",
                    "verschachtelt": "separater_leser_schritt"}
        yield record("pak/member-" + str(index) + "-offset-" + str(offset),
                     offset, length, "binaer", metadata, payload=(offset, length))


if __name__ == "__main__":
    run(records, identify, "quake-pak-v1")
