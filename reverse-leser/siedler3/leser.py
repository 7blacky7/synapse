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

from dekodierung import dekodiere, Dekodiergrenze, UnbekannteVariante


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
        items = [item]
        # Ein GFX-Record ist die Bestätigungsgrenze: Roh + PNG immer gemeinsam.
        if "dekodierung" in item:
            if self.count + 2 > self.limits["dateien"] or self.files + 3 > self.limits["dateien"]:
                raise Schrittgrenze("schritt_oder_dateigrenze")
            offset, end, kind = item["dekodierung"]
            try:
                png, used, details = dekodiere(self.source, offset, end, kind)
            except Dekodiergrenze as exc:
                raise Schrittgrenze(str(exc)) from exc
            except UnbekannteVariante as exc:
                item["metadata"]["grund"] = str(exc)
            else:
                image_id = item["id"] + "/bild"
                item["metadata"]["bild_member"] = image_id
                image = record(image_id, offset, used, "bild",
                               {**details, "roh_member": item["id"], "status": "dekodiert"})
                image["data"] = png
                items.append(image)
        planned = []
        for value in items:
            identity = value["id"]
            data = value.get("data")
            payload = value["payload"]
            has_file = data is not None or payload is not None
            length = (len(data) if data is not None else
                      len(value["prefix"]) + payload[1] + len(value["suffix"]) if payload is not None else 0)
            suffix = ".png" if data is not None else ".wav" if value["prefix"].startswith(b"RIFF") else ".bin"
            name = hashlib.sha256(identity.encode()).hexdigest() + suffix
            reference = {"pfad": name, "sha256": "0" * 64, "bytes": str(length)} if has_file else None
            obj = {"art": "objekt", "member_id": identity, "objektpfad": identity,
                   "typ": value["kind"], "quelle": {"offset": str(value["offset"]), "laenge": str(value["length"])},
                   "datei": reference, "metadaten": value["metadata"]}
            line_bytes = len(pack(obj).encode()) + 1
            planned.append((value, obj, length, line_bytes))
        artifact_count = sum(obj["datei"] is not None for _, obj, _, _ in planned)
        total_lines = sum(n for _, _, _, n in planned)
        total_bytes = sum(n + size for _, _, size, n in planned)
        if (self.count + len(planned) > self.limits["dateien"]
                or self.files + artifact_count + 1 > self.limits["dateien"]
                or any(size > self.limits["datei_bytes"] or n > self.limits["zeile_bytes"]
                       for _, _, size, n in planned)
                or self.segment_bytes + total_lines > self.limits["datei_bytes"]
                or self.bytes + total_bytes > self.limits["bytes"]):
            raise Schrittgrenze("schritt_oder_dateigrenze")
        # Alle Grenzen geprüft, bevor irgendein Artefakt dieses Records entsteht.
        for value, obj, length, _ in planned:
            reference = obj["datei"]
            if reference is not None:
                digest = hashlib.sha256()
                fd = os.open(self.root / reference["pfad"],
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "wb") as out:
                    try:
                        data = value.get("data")
                        if data is not None:
                            blocks = (memoryview(data)[i:i + self.source.chunk]
                                      for i in range(0, len(data), self.source.chunk))
                        else:
                            blocks = self.source.blocks(*value["payload"])
                        out.write(value["prefix"])
                        digest.update(value["prefix"])
                        for block in blocks:
                            self.source.check()
                            out.write(block)
                            digest.update(block)
                        out.write(value["suffix"])
                        digest.update(value["suffix"])
                        out.flush()
                        os.fsync(out.fileno())
                    except Schrittgrenze as exc:
                        raise ValueError("record_unbestaetigt:" + str(exc)) from exc
                reference["sha256"] = digest.hexdigest()
                self.files += 1
        # Erst nach ALLEN Artefakten die Recordzeilen in den Segmentbeleg aufnehmen.
        for _, obj, length, _ in planned:
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


from bisect import bisect_right

# Quellenwissen bleibt am Reverse-Eintrag; keine kopierten Objekt-/Volk-Enums.
# @ref rev-die-siedler-3-229a52:medium-2/inhalt/session1/S3/INSTALL/s3.ex_:FUN_005faaf0
# @ref rev-die-siedler-3-229a52:medium-2/inhalt/session1/S3/INSTALL/s3.ex_:FUN_00619610
# GFX-Header: hex_format 3ae70584-66b7-4cf9-8cd4-df3d3501c29e v1.
# Forschungs-/Fehlerbelege: Thoughts d3d355d5 und 44203040, P18-T83/T89.
GFX = b"\x04\x13\x04\x00\x0c\x00\x00\x00"
SND = b"\x44\x15\x01\x00\x02\x00\x00\x00"
SEQUENZEN = (0x106, 0x3112, 0x5982)


def identify(source):
    head = source.read(0, min(8, source.size))
    # Siedler3_18 und jedes andere MZ bleiben dem PE-Leser vorbehalten.
    if head.startswith(b"MZ"):
        return None
    return "gfx" if head == GFX else "snd" if head == SND else None


def gfx(source):
    if source.size < 96 or source.u32(48) != source.size:
        raise ValueError("gfx_header_groesse")
    masks = struct.unpack("<III", source.read(32, 12))
    tables = []
    bounds = {source.size}
    extra = (source.u32(52), source.u32(80))

    def boundary(offset):
        if offset < 84 or offset > source.size:
            raise ValueError("gfx_zeiger_ungueltig")
        bounds.add(offset)
        if len(bounds) * 64 > source.limits["ram_mib"] * 1048576:
            raise Schrittgrenze("speicherlimit_index")

    def frames(pointer):
        head = source.read(pointer, 8)
        if head[:7] != b"\x02\x14\0\0\x08\0\0":
            return None
        count = head[7]
        if pointer + 8 + count * 4 > source.size:
            raise ValueError("gfx_sequenzindex_ungueltig")
        return count

    for offset in extra:
        boundary(offset)
    for slot in range(6):
        table = source.u32(56 + slot * 4)
        if table < 96:
            raise ValueError("gfx_index_ueberlappt_header")
        boundary(table)
        kind, length, count = struct.unpack("<IHH", source.read(table, 8))
        if length != 8 + count * 4 or table + length > source.size:
            raise ValueError("gfx_indextabelle_ungueltig")
        tables.append((table, kind, count))
        for index in range(count):
            pointer = source.u32(table + 8 + index * 4)
            if pointer < 96:
                raise ValueError("gfx_record_ueberlappt_header")
            boundary(pointer)
            if kind in SEQUENZEN:
                n = frames(pointer)
                if n is not None:
                    for frame in range(n):
                        relative = source.u32(pointer + 8 + frame * 4)
                        if relative < 8 + n * 4:
                            raise ValueError("gfx_frame_ueberlappt_index")
                        boundary(pointer + relative)
    ordered = sorted(bounds)

    def end(offset):
        next_index = bisect_right(ordered, offset)
        return ordered[next_index] if next_index < len(ordered) else source.size

    yield record("gfx/header", 0, 96, "struktur",
                 {"format": "siedler3-gfx", "rgb_masken": [str(v) for v in masks],
                  "format_ref": "3ae70584-66b7-4cf9-8cd4-df3d3501c29e@v1"})
    for index, offset in enumerate(extra):
        yield record("gfx/metadaten-" + str(index), offset, end(offset) - offset,
                     "binaer", {"status": "roh", "grund": "metadaten_nicht_semantisch_gedeutet"},
                     payload=(offset, end(offset) - offset))
    for slot, (table, kind, count) in enumerate(tables):
        yield record("gfx/tabelle-" + str(slot), table, 8 + count * 4, "struktur",
                     {"gruppen_typ": hex(kind), "anzahl": str(count), "leere_tabelle": count == 0})
        for index in range(count):
            pointer = source.u32(table + 8 + index * 4)
            n = frames(pointer) if kind in SEQUENZEN else None
            if kind in SEQUENZEN and n is None:
                yield record("gfx/tabelle-" + str(slot) + "/index-" + str(index) + "/roh",
                             pointer, end(pointer) - pointer, "binaer",
                             {"gruppen_typ": hex(kind), "grund": "sequenzvariante_unbekannt"},
                             payload=(pointer, end(pointer) - pointer))
                continue
            positions = ((j, pointer + source.u32(pointer + 8 + j * 4)) for j in range(n)) if n is not None else ((0, pointer),)
            for frame, offset in positions:
                length = end(offset) - offset
                header_size = 12 if kind in SEQUENZEN else 8 if kind == 0x11306 else 6
                known = kind in SEQUENZEN or kind in (0x2412, 0x11306)
                meta: dict[str, object] = {"gruppen_typ": hex(kind), "index": str(index), "frame": str(frame),
                        "status": "roh", "grund": "variante_unbekannt" if not known else "rle_roh_link_schritt"}
                if known and length >= header_size:
                    head = source.read(offset, header_size)
                    displaced = kind in SEQUENZEN
                    if displaced and head[:4] != b"\x0c\0\0\0":
                        meta["grund"] = "bildheader_unbekannt"
                    else:
                        width, height = struct.unpack_from("<HH", head, 4 if displaced else 0)
                        meta.update(breite=str(width), hoehe=str(height), nullframe=width == height == 0)
                        if displaced:
                            dx, dy = struct.unpack_from("<hh", head, 8)
                            meta.update(versatz_x=str(dx), versatz_y=str(dy))
                        if width == height == 0:
                            meta["grund"] = "legitimer_nullframe"
                        elif not width or not height:
                            meta["grund"] = "dimension_ungueltig_roh_erhalten"
                        meta["rgb_masken"] = [str(v) for v in masks]
                        if masks not in ((0xf800, 0x7e0, 0x1f), (0x7c00, 0x3e0, 0x1f)):
                            meta["grund"] = "rgb_masken_unbekannt_roh_erhalten"
                elif known:
                    meta["grund"] = "bildrecord_zu_kurz_roh_erhalten"
                identity = "gfx/tabelle-" + str(slot) + "/index-" + str(index) + "/frame-" + str(frame) + "-offset-" + str(offset)
                item = record(identity, offset, length, "frames" if known else "binaer",
                              meta, payload=(offset, length))
                if (known and meta.get("breite") not in (None, "0")
                        and meta.get("hoehe") not in (None, "0")
                        and meta["grund"] == "rle_roh_link_schritt"):
                    item["dekodierung"] = (offset, offset + length, kind)
                yield item


def snd(source):
    if source.size < 36 or source.u32(16) != source.size or source.u32(24) != 28:
        raise ValueError("snd_header_groesse")
    kind, length, count = struct.unpack("<IHH", source.read(28, 8))
    if kind != 0x11F74 or length != 8 + count * 4 or 28 + length > source.size:
        raise ValueError("snd_indextabelle_ungueltig")
    yield record("snd/header", 0, 36, "struktur",
                 {"format": "siedler3-snd", "gruppen": str(count), "leere_tabelle": count == 0})
    for group in range(count):
        pointer = source.u32(36 + group * 4)
        if pointer < 28 + length:
            raise ValueError("snd_gruppe_ueberlappt_index")
        n = source.u32(pointer)
        if pointer + 4 + n * 4 > source.size:
            raise ValueError("snd_variantenindex_ungueltig")
        for variant in range(n):
            offset = source.u32(pointer + 4 + variant * 4)
            total = source.u32(offset)
            if (total < 4 or offset + total > source.size or offset < 28 + length
                    or offset < pointer + 4 + n * 4 and offset + total > pointer):
                raise ValueError("snd_recordbereich_ungueltig")
            identity = "snd/gruppe-" + str(group) + "/variante-" + str(variant) + "-offset-" + str(offset)
            info = {"gruppe": str(group), "variante": str(variant)}
            fmt = source.read(offset + 4, 16) if total >= 20 else None
            codec, channels, rate, byte_rate, align, bits = struct.unpack("<HHIIHH", fmt) if fmt else (0,) * 6
            valid = (codec == 1 and channels > 0 and rate > 0 and bits in (8, 16)
                     and align == channels * bits // 8 and byte_rate == rate * align)
            if fmt is None or not valid:
                yield record(identity + "/roh", offset, total, "binaer",
                             {**info, "grund": "pcm_variante_unbekannt", "status": "roh"},
                             payload=(offset, total))
                continue
            payload = total - 20
            remainder = payload % align
            info.update(kanaele=str(channels), samplerate=str(rate), bits=str(bits), restbytes=str(remainder))
            if remainder:
                yield record(identity + "/roh", offset, total, "binaer",
                             {**info, "grund": "pcm_rest_erhalten", "status": "roh"},
                             payload=(offset, total))
            size = payload - remainder
            padding = b"\0" if size % 2 else b""
            header = b"RIFF" + struct.pack("<I", 36 + size + len(padding)) + b"WAVEfmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", size)
            yield record(identity + "/wav", offset, total, "sound",
                         {**info, "grund": "pcm_rest_im_rohrecord" if remainder else None,
                          "roh_member": identity + "/roh" if remainder else None},
                         prefix=header, payload=(offset + 20, size), suffix=padding)


def records(source, detected):
    yield from gfx(source) if detected == "gfx" else snd(source)


if __name__ == "__main__":
    run(records, identify, "siedler3-gfx-snd-v2")
