"""P18-T72: bounded static Siedler 3 containers in the existing E runner.
Format research: JSettlers settlers-remake (MIT), AdvancedDatFileReader,
DatBitmapReader, translators, SoundManager and OriginalMapFileContentReader.
Independent decoder; original files are opened read-only. MAP payload is not decrypted.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import struct
import time
from typing import Any, Callable
import zlib

GFX = b"\x04\x13\x04\x00\x0c\x00\x00\x00"
SND = b"\x44\x15\x01\x00\x02\x00\x00\x00"
GROUPS = {0x2412: "landscape", 0x106: "sprite", 0x3112: "torso",
          0x5982: "shadow", 0x11306: "gui"}

class Invalid(ValueError):
    pass

class Limit(ValueError):
    pass

class Reader:
    def __init__(self, stream, cap: dict[str, int], deadline: float):
        self.stream = stream
        self.size = os.fstat(stream.fileno()).st_size
        self.cap = cap
        self.deadline = deadline
        self.ram = cap["parser_ram_mb"] * 1024 * 1024

    def check(self):
        if time.monotonic() >= self.deadline:
            raise Limit("zeitlimit")

    def read(self, offset: int, length: int) -> bytes:
        self.check()
        if offset < 0 or length < 0 or offset + length > self.size:
            raise Invalid("Bereich ausserhalb der Datei")
        if length > self.ram // 8:
            raise Limit("speicherlimit")
        self.stream.seek(offset)
        data = self.stream.read(length)
        if len(data) != length:
            raise Invalid("Datei wurde waehrend des Lesens verkuerzt")
        return data

    def u32(self, offset: int) -> int:
        return struct.unpack("<I", self.read(offset, 4))[0]

    def pointers(self, offset: int, count: int) -> list[int]:
        if count > self.cap["max_dateien"]:
            raise Limit("zu_gross: Anzahl Indexeintraege")
        data = self.read(offset, count * 4)
        return [x[0] for x in struct.iter_unpack("<I", data)]

def identify(head: bytes, suffix: str = "") -> str | None:
    if head.startswith(GFX):
        return "siedler3-dat"
    if head.startswith(SND):
        return "siedler3-snd"
    # MAP has no fixed magic. Require extension, supported version and first bounded record.
    if suffix.lower() == ".map" and len(head) >= 16:
        version, kind, length = struct.unpack_from("<III", head, 4)
        if version in (10, 11) and kind and length >= 8:
            return "siedler3-map"
    return None

def png(width: int, height: int, pixels: bytes | bytearray) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")

def bitmap(r: Reader, offset: int, end: int, kind: str, masks: tuple[int, int, int]):
    displaced = kind in ("sprite", "torso", "shadow")
    length = 12 if displaced else 8 if kind == "gui" else 6
    head = r.read(offset, length)
    if displaced:
        if head[:4] != b"\x0c\0\0\0":
            raise Invalid("Unbekannter Bildheader")
        width, height, dx, dy = struct.unpack_from("<HHhh", head, 4)
    else:
        width, height = struct.unpack_from("<HH", head)
        dx = dy = 0
    if not width or not height or width * height * 4 > min(r.ram // 8, r.cap["max_bytes"]):
        raise Limit("speicherlimit: Bildflaeche")
    pixels = bytearray(width * height * 4)
    pos = offset + length
    pos += pos % 2
    def take(n: int) -> bytes:
        nonlocal pos
        if pos + n > end:
            raise Invalid("Bilddaten ueberlappen naechsten Record")
        data = r.read(pos, n)
        pos += n
        return data
    shifts = [(m & -m).bit_length() - 1 for m in masks]
    for y in range(height):
        x = 0
        while True:
            control = int.from_bytes(take(2), "little")
            count, skip = control & 255, (control >> 8) & 127
            x += skip
            if x + count > width:
                raise Invalid("RLE-Zeile ausserhalb Bildbreite")
            for _ in range(count):
                if kind == "shadow":
                    color = (0, 0, 0, 128)
                elif kind == "torso":
                    value = (take(1)[0] & 31) * 255 // 31
                    color = (value, value, value, 255)
                else:
                    value = int.from_bytes(take(2), "little")
                    color = tuple(((value & m) >> s) * 255 // (m >> s) for m, s in zip(masks, shifts)) + (255,)
                at = (y * width + x) * 4
                pixels[at:at + 4] = bytes(color)
                x += 1
            if control & 0x8000:
                break
    return png(width, height, pixels), pos - offset, {"breite": width, "hoehe": height, "versatz_x": dx, "versatz_y": dy, "darstellung": "graustufenmaske" if kind == "torso" else kind}

def gfx_records(r: Reader):
    head = r.read(0, 96)
    if r.u32(48) != r.size:
        raise Invalid("GFX-Dateigroesse stimmt nicht")
    masks = struct.unpack_from("<III", head, 32)
    if masks not in ((0xF800, 0x7E0, 0x1F), (0x7C00, 0x3E0, 0x1F)):
        raise Invalid("Unbekannte RGB-Masken")
    records = []
    boundaries = {r.size}
    extra = [struct.unpack_from("<I", head, pos)[0] for pos in (52, 80)]
    boundaries.update(extra)
    tables = []
    for table in struct.unpack_from("<6I", head, 56):
        boundaries.add(table)
        kind, length, count = struct.unpack("<IHH", r.read(table, 8))
        if length != count * 4 + 8:
            raise Invalid("Inkonsistente GFX-Indextabelle")
        pointers = r.pointers(table + 8, count)
        tables.append({"offset": table, "typ": kind, "anzahl": count, "zeiger": pointers})
        for i, pointer in enumerate(pointers):
            boundaries.add(pointer)
            label = GROUPS.get(kind, "unbekannt")
            if label in ("sprite", "torso", "shadow"):
                seq = r.read(pointer, 8)
                if seq[:7] != b"\x02\x14\0\0\x08\0\0":
                    raise Invalid("Unbekannter Sequenzheader")
                frames = r.pointers(pointer + 8, seq[7])
                for j, relative in enumerate(frames):
                    at = pointer + relative
                    if relative < 8 + seq[7] * 4:
                        raise Invalid("Frame ueberlappt Sequenzindex")
                    boundaries.add(at)
                    records.append((at, label, f"{kind:05x}-{i:05d}-{j:03d}"))
            else:
                records.append((pointer, label, f"{kind:05x}-{i:05d}"))
            if len(records) > r.cap["max_dateien"]:
                raise Limit("zu_gross: GFX-Frames")
    ordered = sorted(boundaries)
    ends = dict(zip(ordered, ordered[1:]))
    yield "struktur.json", json.dumps({"format": "siedler3-dat", "rgb_masken": masks, "tabellen": tables}, ensure_ascii=False).encode(), 0, 96, "application/json", {}
    for index, at in enumerate(extra):
        if at < 84 or at >= r.size:
            raise Invalid("Ungueltiger Metadatenzeiger")
        end = ends.get(at, r.size)
        yield f"metadaten-{index}.bin", r.read(at, end - at), at, end - at, "application/octet-stream", {"typ": "metadaten_roh"}
    for at, label, stem in records:
        end = ends.get(at, r.size)
        if at < 96 or at >= end:
            raise Invalid("Ungueltiger Bildzeiger")
        if label == "unbekannt":
            yield stem + ".bin", r.read(at, end - at), at, end - at, "application/octet-stream", {"typ": label}
        else:
            try:
                data, used, details = bitmap(r, at, end, label, masks)
            except Invalid as exc:
                yield stem + ".bin", r.read(at, end - at), at, end - at, "application/octet-stream", {"typ": label, "fehler": str(exc)}
            else:
                yield stem + ".png", data, at, used, "image/png", {"typ": label, **details}

def snd_records(r: Reader):
    if r.u32(16) != r.size or r.u32(24) != 28:
        raise Invalid("SND-Header inkonsistent")
    kind, length, count = struct.unpack("<IHH", r.read(28, 8))
    if kind != 0x11F74 or length != 8 + count * 4:
        raise Invalid("Unbekannte SND-Indextabelle")
    for i, pointer in enumerate(r.pointers(36, count)):
        n = r.u32(pointer)
        for j, at in enumerate(r.pointers(pointer + 4, n)):
            total = r.u32(at)
            if total < 20:
                raise Invalid("Soundrecord zu kurz")
            fmt = r.read(at + 4, 16)
            codec, channels, rate, byte_rate, align, bits = struct.unpack("<HHIIHH", fmt)
            info = {"gruppe": i, "variante": j, "samplerate": rate, "kanaele": channels, "bits": bits}
            if codec != 1 or not channels or not rate or bits not in (8, 16) or align != channels * bits // 8 or byte_rate != rate * align:
                yield f"sound-{i:03d}-{j:03d}.bin", r.read(at, total), at, total, "application/octet-stream", {**info, "fehler": "Unbekanntes oder inkonsistentes PCM-Format"}
                continue
            pcm = r.read(at + 20, total - 20)
            remainder = len(pcm) % align
            if remainder:
                # Original SND records can end halfway through a PCM frame.
                # Preserve the complete record; export only complete audio frames.
                yield f"sound-{i:03d}-{j:03d}.bin", r.read(at, total), at, total, "application/octet-stream", {**info, "fehler": f"Unvollstaendiges PCM-Sample: {remainder} Restbyte(s); Rohrecord erhalten"}
                pcm = pcm[:-remainder]
            pad = b"\0" if len(pcm) % 2 else b""
            wav = b"RIFF" + struct.pack("<I", 36 + len(pcm) + len(pad)) + b"WAVEfmt " + struct.pack("<I", 16) + fmt + b"data" + struct.pack("<I", len(pcm)) + pcm + pad
            yield f"sound-{i:03d}-{j:03d}.wav", wav, at, total, "audio/wav", {"gruppe": i, "variante": j, "samplerate": rate, "kanaele": channels, "bits": bits}

def map_structure(r: Reader):
    version = r.u32(4)
    if version not in (10, 11):
        raise Invalid("Unbekannte MAP-Version")
    records = []
    pos = 8
    while pos + 8 <= r.size:
        kind, length = struct.unpack("<II", r.read(pos, 8))
        if not kind:
            break
        if length < 8 or pos + length > r.size:
            raise Invalid("MAP-Block ausserhalb Datei")
        records.append({"typ": kind & 65535, "typ_roh": kind, "offset": pos + 8, "laenge": length - 8, "verschluesselt": True})
        if len(records) > r.cap["max_dateien"]:
            raise Limit("zu_gross: MAP-Bloecke")
        pos += length
    return {"format": "siedler3-map", "version": version, "pruefsumme": r.u32(0), "bloecke": records, "hinweis": "Nutzbloecke verschluesselt; keine Entschluesselung ausgefuehrt."}

def extract(source: Path, out: Path, source_rel: str, cap: dict[str, int], input_size: int,
            deadline: float, violation: Callable, initial: tuple[int, int, int]) -> dict[str, Any]:
    files, dirs, total = initial
    meta: dict[str, dict[str, Any]] = {}
    folder = source_rel + "~inhalt"
    suffix = 2
    while (out / folder).exists() or (out / folder).is_symlink():
        folder = source_rel + "~inhalt" + str(suffix)
        suffix += 1
    error = None
    details = ""
    def save(name: str, data: bytes, offset: int, length: int, mime: str, info: dict):
        nonlocal files, dirs, total, error, details
        r.check()
        target = out / folder
        rel = folder + "/" + name
        if len(Path(rel).parts) - 1 > cap["max_tiefe"]:
            raise Limit("bombe_verdacht: max_tiefe")
        bad = violation(files + 1, dirs + (not target.exists()), total + len(data), cap, input_size)
        if bad:
            raise Limit(bad[0] + ": " + bad[1])
        digest = hashlib.sha256()
        for start in range(offset, offset + length, min(r.ram // 8, 1024 * 1024)):
            digest.update(r.read(start, min(offset + length - start, r.ram // 8, 1024 * 1024)))
        if info.get("fehler"):
            error, details = "beschaedigt", info["fehler"]
        if not target.exists():
            target.mkdir(parents=True)
            dirs += 1
        with (out / rel).open("xb") as dest:
            dest.write(data)
        files += 1
        total += len(data)
        meta[rel] = {"herkunft": {"archiv": source_rel, "pfad": name, "tiefe": 1},
                     "siedler3": {"offset": offset, "laenge": length, "format": fmt, "quellbereich_sha256": digest.hexdigest(), **info},
                     "mime_type": mime,
                     "asset_type": "image" if mime.startswith("image/") else "audio" if mime.startswith("audio/") else "unbekannt"}
    try:
        with source.open("rb") as stream:
            r = Reader(stream, cap, deadline)
            fmt = identify(r.read(0, min(96, r.size)), Path(source_rel).suffix)
            if fmt == "siedler3-map":
                data = json.dumps(map_structure(r), ensure_ascii=False).encode()
                save("struktur.json", data, 0, 8, "application/json", {})
                error = "verschluesselt"
                details = "MAP-Nutzbloecke nicht entschluesselt"
            elif fmt in ("siedler3-dat", "siedler3-snd"):
                for record in (gfx_records(r) if fmt == "siedler3-dat" else snd_records(r)):
                    save(*record)
            else:
                raise Invalid("Unbekanntes Siedler-Format")
    except Limit as exc:
        error, details = str(exc).split(":")[0], str(exc)
    except (Invalid, OSError, struct.error) as exc:
        error, details = "beschaedigt", str(exc)
    return {"status": "teilweise" if error else "entpackt", "grund": error, "hinweis": details,
            "werkzeug": "siedler3", "inhalt": folder if meta else None, "dateien": len(meta), "metadaten": meta}
