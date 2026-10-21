"""P18-T76: bounded, static PE resource extraction for the existing E runner.

Directory/data layouts match exe-pe-resource (P21-T9) and S1's PE reader:
directory offsets relative to the resource root, payload RVAs through raw sections.
No loader, external program, network or executable code.
"""
from __future__ import annotations

import hashlib
import json
import struct
import time
from pathlib import Path
from typing import Any, Callable

TYPES = {1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG", 6: "STRING",
         9: "ACCELERATOR", 10: "RCDATA", 12: "GROUP_CURSOR", 14: "GROUP_ICON",
         16: "VERSION", 24: "MANIFEST"}


class ResourceError(ValueError):
    pass


class ResourceLimit(ResourceError):
    pass


def u16(b: bytes, p: int = 0) -> int:
    if p < 0 or p + 2 > len(b):
        raise ResourceError("abgeschnittenes WORD")
    return struct.unpack_from("<H", b, p)[0]


def u32(b: bytes, p: int = 0) -> int:
    if p < 0 or p + 4 > len(b):
        raise ResourceError("abgeschnittenes DWORD")
    return struct.unpack_from("<I", b, p)[0]


class PE:
    def __init__(self, stream: Any):
        self.stream = stream
        stream.seek(0, 2)
        self.size = stream.tell()
        head = self.read(0, 64)
        if head[:2] != b"MZ":
            raise ResourceError("kein MZ")
        off = u32(head, 60)
        coff = self.read(off, 24)
        if coff[:4] != b"PE\0\0":
            raise ResourceError("kein PE")
        n, opt_size = u16(coff, 6), u16(coff, 20)
        opt = self.read(off + 24, opt_size)
        magic = u16(opt)
        dirs = 96 if magic == 0x10b else 112 if magic == 0x20b else 0
        if not dirs:
            raise ResourceError("unbekannter PE-Optionalheader")
        self.sections = []
        for i in range(n):
            row = self.read(off + 24 + opt_size + i * 40, 40)
            self.sections.append((u32(row, 12), u32(row, 16), u32(row, 20)))
        self.root = self.length = 0
        if len(opt) >= dirs + 24 and u32(opt, dirs - 4) >= 3:
            rva, self.length = u32(opt, dirs + 16), u32(opt, dirs + 20)
            if rva and self.length:
                self.root = self.offset(rva, self.length)

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0 or offset + length > self.size:
            raise ResourceError("Bereich ausserhalb der PE-Datei")
        self.stream.seek(offset)
        data = self.stream.read(length)
        if len(data) != length:
            raise ResourceError("abgeschnittene PE-Datei")
        return data

    def offset(self, rva: int, length: int) -> int:
        for start, size, raw in self.sections:
            if start <= rva and rva - start + length <= size:
                off = raw + rva - start
                if off + length <= self.size:
                    return off
        raise ResourceError("Ressourcen-RVA ausserhalb dateigestuetzter Sektionen")

    def resource(self, offset: int, length: int) -> bytes:
        if offset < 0 or offset + length > self.length:
            raise ResourceError("Ressourcenverzeichnis ausserhalb seines Bereichs")
        return self.read(self.root + offset, length)

    def label(self, value: int) -> int | str:
        if value & 0x80000000:
            pos = value & 0x7fffffff
            n = u16(self.resource(pos, 2))
            return self.resource(pos + 2, n * 2).decode("utf-16-le", "replace")
        return value


def resource_leaves(pe: PE, cap: dict[str, int], deadline: float,
                    warn: Callable[[str], None]):
    """Exactly type/name/language, bounded traversal; corrupt siblings do not discard good leaves."""
    visited: set[int] = set()
    remaining = cap["max_dateien"] * 4 + 4

    def walk(pos: int, labels: tuple, indices: tuple):
        nonlocal remaining
        if time.monotonic() >= deadline:
            raise ResourceLimit("zeitlimit")
        if pos in visited:
            warn("Ressourcenzyklus oder mehrfach verwendetes Verzeichnis")
            return
        visited.add(pos)
        try:
            head = pe.resource(pos, 16)
            count = u16(head, 12) + u16(head, 14)
            for i in range(count):
                if time.monotonic() >= deadline:
                    raise ResourceLimit("zeitlimit")
                remaining -= 1
                if remaining < 0:
                    raise ResourceLimit("zu_gross: max_dateien (Ressourcenbaum)")
                try:
                    row = pe.resource(pos + 16 + i * 8, 8)
                    value, target = u32(row), u32(row, 4)
                    names = labels + (pe.label(value),)
                    numbers = indices + (i,)
                    if target & 0x80000000:
                        if len(names) >= 3:
                            raise ResourceError("Verzeichnis unter Sprachebene")
                        yield from walk(target & 0x7fffffff, names, numbers)
                    else:
                        if len(names) != 3:
                            raise ResourceError("Datenknoten vor Sprachebene")
                        data = pe.resource(target, 16)
                        length = u32(data, 4)
                        offset = pe.offset(u32(data), length)
                        yield names, numbers, offset, length, u32(data, 8)
                except ResourceLimit:
                    raise
                except ResourceError as exc:
                    warn(str(exc))
        except ResourceLimit:
            raise
        except ResourceError as exc:
            warn(str(exc))
    if pe.root and pe.length:
        yield from walk(0, (), ())


def strings(data: bytes, block: int | str) -> str:
    pos, lines = 0, []
    for index in range(16):
        n = u16(data, pos)
        pos += 2
        if pos + n * 2 > len(data):
            raise ResourceError("abgeschnittene Stringtabelle")
        value = data[pos:pos + n * 2].decode("utf-16-le", "replace")
        pos += n * 2
        if value:
            number = (block - 1) * 16 + index if isinstance(block, int) else index
            lines.append(json.dumps({"id": number, "text": value}, ensure_ascii=False))
    return "\n".join(lines) + "\n"


class Dialog:
    def __init__(self, data: bytes):
        self.data, self.pos = data, 0

    def word(self) -> int:
        n = u16(self.data, self.pos)
        self.pos += 2
        return n

    def skip(self, n: int) -> None:
        if self.pos + n > len(self.data):
            raise ResourceError("abgeschnittener Dialog")
        self.pos += n

    def field(self) -> str | int:
        n = self.word()
        if n == 0xffff:
            return self.word()
        chars = []
        while n:
            chars.append(struct.pack("<H", n))
            n = self.word()
        return b"".join(chars).decode("utf-16-le", "replace")


def dialog(data: bytes) -> str:
    d = Dialog(data)
    extended = u16(data) == 1 and u16(data, 2) == 0xffff
    style = u32(data, 12 if extended else 0)
    count = u16(data, 16 if extended else 8)
    d.skip(26 if extended else 18)
    result: dict[str, Any] = {"extended": extended, "style": style, "menu": d.field(),
                              "class": d.field(), "title": d.field(), "controls": []}
    if style & 0x40:
        result["pointsize"] = d.word()
        if extended:
            d.skip(4)
        result["font"] = d.field()
    for _ in range(count):
        d.pos = (d.pos + 3) & ~3
        start = d.pos
        d.skip(24 if extended else 18)
        control = {"id": u32(data, start + 20) if extended else u16(data, start + 16),
                   "class": d.field(), "title": d.field()}
        extra = d.word()
        d.skip(extra if extended else max(0, extra - 2))
        result["controls"].append(control)
    return json.dumps(result, ensure_ascii=False, indent=2) + "\n"


def version(data: bytes) -> str:
    """VS_VERSIONINFO blocks, including fixed-file-info bytes and localized key/value pairs."""
    result = []
    stack = [(0, len(data), 0)]
    while stack:
        start, end, depth = stack.pop()
        if depth > 16:  # VS_VERSIONINFO format nesting guard, not a job budget
            raise ResourceError("Versionsinfo zu tief")
        length, value_len, kind = u16(data, start), u16(data, start + 2), u16(data, start + 4)
        if length < 6 or start + length > end:
            raise ResourceError("kaputter Versionsblock")
        end = start + length
        d = Dialog(data)
        d.pos = start + 6
        key = d.field()
        pos = (d.pos + 3) & ~3
        value_end = pos + value_len * (2 if kind == 1 else 1)
        if value_end > end:
            raise ResourceError("Versionswert ausserhalb seines Blocks")
        value = data[pos:value_end]
        item: dict[str, Any] = {"key": key, "value": value.decode("utf-16-le", "replace").rstrip("\0")
                if kind == 1 else value.hex()}
        if key == "VS_VERSION_INFO" and kind == 0 and len(value) >= 52 and u32(value) == 0xfeef04bd:
            def version_number(offset: int) -> str:
                ms, ls = u32(value, offset), u32(value, offset + 4)
                return ".".join(str(n) for n in (ms >> 16, ms & 0xffff, ls >> 16, ls & 0xffff))
            item["fixed_file_info"] = {"file_version": version_number(8), "product_version": version_number(16),
                                       "flags_mask": u32(value, 24), "flags": u32(value, 28),
                                       "os": u32(value, 32), "file_type": u32(value, 36),
                                       "file_subtype": u32(value, 40)}
        result.append(item)
        child = (value_end + 3) & ~3
        children = []
        while child + 6 <= end:
            size = u16(data, child)
            if size < 6 or child + size > end:
                raise ResourceError("kaputter Versionsunterblock")
            children.append((child, end, depth + 1))
            child = (child + size + 3) & ~3
        stack.extend(reversed(children))
    return json.dumps(result, ensure_ascii=False, indent=2) + "\n"


def view(typ: int | str, name: int | str, data: bytes) -> tuple[str, str, bytes] | None:
    if typ == 3:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return ".png", "image/png", data
        if u32(data) < 40 or len(data) < 40:
            raise ResourceError("ICON ohne BITMAPINFOHEADER")
        width, height = struct.unpack_from("<ii", data, 4)
        if not 1 <= width <= 256 or not 1 <= height // 2 <= 256 or height % 2:
            raise ResourceError("ICON-Abmessungen ungueltig")
        entry = struct.pack("<BBBBHHII", width % 256, (height // 2) % 256, 0, 0,
                            u16(data, 12), u16(data, 14), len(data), 22)
        return ".ico", "image/x-icon", struct.pack("<HHH", 0, 1, 1) + entry + data
    if typ == 2:
        size = u32(data)
        if size == 12:
            colors = (1 << u16(data, 10)) if u16(data, 10) <= 8 else 0
            pixels = 14 + 12 + colors * 3
        elif size >= 40 and size <= len(data):
            bits, compression = u16(data, 14), u32(data, 16)
            colors = u32(data, 32) or ((1 << bits) if bits <= 8 else 0)
            masks = (12 if compression == 3 else 16 if compression == 6 else 0) if size == 40 else 0
            pixels = 14 + size + masks + colors * 4
        else:
            raise ResourceError("BITMAP ohne gueltigen DIB-Header")
        if pixels > len(data) + 14:
            raise ResourceError("BITMAP-Palette abgeschnitten")
        return ".bmp", "image/bmp", struct.pack("<2sIHHI", b"BM", len(data) + 14, 0, 0, pixels) + data
    if typ == 6:
        return ".txt", "text/plain", strings(data, name).encode()
    if typ == 5:
        return ".txt", "text/plain", dialog(data).encode()
    if typ == 16:
        return ".txt", "text/plain", version(data).encode()
    return None


def extract(source: Path, out: Path, source_rel: str, cap: dict[str, int], input_size: int,
            deadline: float, violation: Callable, initial: tuple[int, int, int] = (0, 0, 0)) -> dict[str, Any]:
    """Raw bytes + optional view, each with source location/hash. Never overwrite an existing path."""
    files, dirs, total = initial
    meta: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    failed = 0
    error_code = None

    def warn(message: str):
        nonlocal failed
        failed += 1
        if len(warnings) < min(20, cap["max_dateien"]):
            warnings.append(message[:300])

    folder = source_rel + "~ressourcen"
    # Numeric indices cannot escape, collide through duplicate IDs or carry untrusted names into paths.
    target = out / folder
    suffix = 2
    while target.exists() or target.is_symlink():
        folder = source_rel + "~ressourcen" + str(suffix)
        target = out / folder
        suffix += 1

    def check(length: int, rel: str):
        if time.monotonic() >= deadline:
            raise ResourceLimit("zeitlimit")
        if len(Path(rel).parts) - 1 > cap["max_tiefe"]:
            raise ResourceLimit("bombe_verdacht: max_tiefe")
        limit = violation(files + 1, dirs + (0 if target.exists() else 1), total + length, cap, input_size)
        if limit:
            raise ResourceLimit(limit[0] + ": " + limit[1])

    def save(rel: str, data: bytes, details: dict, mime: str):
        nonlocal files, dirs, total
        check(len(data), rel)
        if not target.exists():
            target.mkdir(parents=True)
            dirs += 1
        with (out / rel).open("xb") as stream:
            stream.write(data)
        files += 1
        total += len(data)
        meta[rel] = {"herkunft": {"archiv": source_rel, "pfad": rel[len(folder) + 1:], "tiefe": 1},
                     "pe_ressource": details, "mime_type": mime}

    try:
        with source.open("rb") as stream:
            pe = PE(stream)
            for labels, indices, offset, length, codepage in resource_leaves(pe, cap, deadline, warn):
                typ, name, language = labels
                stem = folder + "/" + "-".join(map(str, indices))
                # Decoders are bounded by the existing parser RAM and output budget.
                ram = cap.get("parser_ram_mb", 2048) * 1024 * 1024
                if length > ram // 8:
                    raise ResourceLimit("speicherlimit")
                check(length, stem + ".bin")
                data = pe.read(offset, length)
                details = {"typ": typ, "typ_name": TYPES.get(typ, str(typ)), "name": name,
                           "sprache": language, "offset": offset, "laenge": length,
                           "sha256": hashlib.sha256(data).hexdigest(), "codepage": codepage,
                           "format_beschreibung": "exe-pe-resource"}
                save(stem + ".bin", data, details, "application/octet-stream")
                try:
                    converted = view(typ, name, data)
                    if converted:
                        ext, mime, payload = converted
                        save(stem + ext, payload, {**details, "ableitung": ext[1:]}, mime)
                except ResourceLimit:
                    raise
                except (ResourceError, struct.error, UnicodeError) as exc:
                    warn(str(exc))
    except ResourceLimit as exc:
        error_code = str(exc).split(":")[0].split(" ")[0]
        warn(str(exc))
    except (ResourceError, OSError, struct.error) as exc:
        warn(str(exc))
    return {"metadaten": meta, "status": "teilweise" if failed else "fertig",
            "hinweise": warnings, "fehler_gesamt": failed, "dateien": len(meta),
            "fehlercode": error_code or ("beschaedigt" if failed else None)}
