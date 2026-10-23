"""P18-T97 Schritt2: nur eigene Fixturebytes, keine Live-Dateien."""
from __future__ import annotations

import importlib.util
import json
import random
from pathlib import Path
import struct
import sys
import time
import tempfile
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_leser as fixtures
from test_leser import gfx, snd, pak, sha, checkpoint, ROOT


def legacy():
    spec = importlib.util.spec_from_file_location(
        "legacy_siedler_oracle", ROOT.parent / "docker/synapse-reverse/siedler3.py")
    if spec is None or spec.loader is None:
        raise AssertionError("legacy_oracle_fehlt")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ORACLE = legacy()
KINDS = (0x106, 0x3112, 0x5982, 0x11306, 0x2412)


def image(kind, masks, width=3, height=2, broken=False):
    displaced = kind in KINDS[:3]
    head = (struct.pack("<IHHhh", 12, width, height, -2, 3) if displaced
            else struct.pack("<HH", width, height) + b"\0" * (4 if kind == 0x11306 else 2))
    body = bytearray()
    for y in range(height):
        skip, count = (1, 2) if y == 0 else (0, 1)
        body += struct.pack("<H", 0x8000 | skip << 8 | (width + 1 if broken else count))
        if kind == 0x3112:
            body += bytes([31, 16][:count])
        elif kind != 0x5982:
            body += b"".join(struct.pack("<H", c) for c in [masks[0], masks[1]][:count])
    return head + body


def graphics(masks=(0xf800, 0x7e0, 0x1f), many=None, broken=False):
    # Alle bekannten Gruppen, oder viele einfache Bilder ohne Gesamtkappung.
    data = bytearray(96)
    data[:8] = b"\x04\x13\x04\0\x0c\0\0\0"
    struct.pack_into("<III", data, 32, *masks)
    tables = []
    counts = [0, 0, 0, 0, many, 0] if many is not None else [1, 1, 1, 1, 1, 0]
    kinds = [*KINDS, 0x21702]
    for kind, count in zip(kinds, counts):
        tables.append(len(data))
        data += struct.pack("<IHH", kind, 8 + count * 4, count) + b"\0" * (count * 4)
    for slot, count in enumerate(counts):
        for index in range(count):
            if len(data) % 2:
                data += b"\0"
            at = len(data)
            struct.pack_into("<I", data, tables[slot] + 8 + index * 4, at)
            if kinds[slot] in KINDS[:3]:
                data += b"\x02\x14\0\0\x08\0\0\x01" + struct.pack("<I", 12)
            data += image(kinds[slot], masks, broken=broken)
    struct.pack_into("<I", data, 52, len(data))
    data += b"meta"
    struct.pack_into("<I", data, 80, len(data))
    data += b"farb"
    struct.pack_into("<6I", data, 56, *tables)
    struct.pack_into("<I", data, 48, len(data))
    return bytes(data)


def sounds():
    data = bytearray(40)
    data[:8] = b"\x44\x15\x01\0\x02\0\0\0"
    struct.pack_into("<I", data, 24, 28)
    struct.pack_into("<IHHI", data, 28, 0x11f74, 12, 1, 40)
    data += struct.pack("<I", 208) + b"\0" * (208 * 4)
    for i in range(208):
        at = len(data)
        struct.pack_into("<I", data, 44 + i * 4, at)
        pcm = b"abcd" + (b"x" if i < 45 else b"")
        data += struct.pack("<IHHIIHH", 20 + len(pcm), 1, 2, 8000, 32000, 4, 16) + pcm
    struct.pack_into("<I", data, 16, len(data))
    return bytes(data)


def oracle_records(data, audio=False):
    with tempfile.TemporaryFile() as stream:
        stream.write(data)
        stream.flush()
        reader = ORACLE.Reader(stream, {"parser_ram_mb": 64, "max_bytes": 16777216,
                               "max_dateien": 10000, "max_datei_bytes": 16777216},
                               time.monotonic() + 10)
        return list(ORACLE.snd_records(reader) if audio else ORACLE.gfx_records(reader))


def pixels(data):
    """Unabhängiger PNG-Chunk/CRC- und verlustfreier Pixelprüfer für RGBA8."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError("png_signature")
    pos, size, compressed, seen = 8, None, bytearray(), []
    while pos < len(data):
        n = struct.unpack_from(">I", data, pos)[0]
        kind, payload = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
        crc = struct.unpack_from(">I", data, pos + 8 + n)[0]
        if zlib.crc32(kind + payload) != crc:
            raise AssertionError("png_crc")
        seen.append(kind)
        if kind == b"IHDR":
            w, h, bits, color, comp, filt, interlace = struct.unpack(">IIBBBBB", payload)
            if (bits, color, comp, filt, interlace) != (8, 6, 0, 0, 0):
                raise AssertionError("png_rgba")
            size = (w, h)
        elif kind == b"IDAT":
            compressed.extend(payload)
        pos += n + 12
    if seen != [b"IHDR", b"IDAT", b"IEND"] or size is None or pos != len(data):
        raise AssertionError("png_chunks")
    rows = zlib.decompress(compressed)
    w, h = size
    if len(rows) != (w * 4 + 1) * h:
        raise AssertionError("png_rows")
    rgba = bytearray()
    for y in range(h):
        row = rows[y * (w * 4 + 1):(y + 1) * (w * 4 + 1)]
        if row[0] != 0:
            raise AssertionError("png_filter")
        rgba.extend(row[1:])
    return size, bytes(rgba)


def decoder():
    spec = importlib.util.spec_from_file_location("externer_gfx_decoder", ROOT / "siedler3/dekodierung.py")
    if spec is None or spec.loader is None:
        raise AssertionError("paket_decoder_fehlt")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DECODER = decoder()


class Bildquelle:
    """Reiner Fixture-Reader für die IO-freie Dekodierfunktion."""
    def __init__(self, data):
        self.data = data
        self.chunk = 4096
        self.limits = {"ram_mib": 64, "bytes": 16777216, "datei_bytes": 16777216}

    def read(self, off, n):
        if off < 0 or off + n > len(self.data):
            raise AssertionError("fixture_quellbereich")
        return self.data[off:off+n]

    def check(self):
        pass


def fixture_bitmap(kind, masks, width, height, dx, dy, rng, odd=False):
    off = 96 + int(odd)
    data = bytearray(off)
    struct.pack_into("<III", data, 32, *masks)
    displaced = kind in KINDS[:3]
    data += (struct.pack("<IHHhh", 12, width, height, dx, dy) if displaced
             else struct.pack("<HH", width, height) + b"\0" * (4 if kind == 0x11306 else 2))
    if len(data) % 2:
        data += b"\0"
    rgba = bytearray(width * height * 4)
    for y in range(height):
        x = 0
        while x < width:
            skip = rng.randint(0, min(3, width - x))
            x += skip
            count = rng.randint(1, min(12, width - x)) if x < width else 0
            final = x + count == width
            data += struct.pack("<H", count | skip << 8 | (0x8000 if final else 0))
            for _ in range(count):
                if kind == 0x5982:
                    color = (0, 0, 0, 128)
                elif kind == 0x3112:
                    word = rng.randrange(256)
                    data.append(word)
                    gray = (word & 31) * 255 // 31
                    color = (gray, gray, gray, 255)
                else:
                    word = rng.randrange(65536)
                    data += struct.pack("<H", word)
                    if masks[0] == 0xf800:
                        color = ((word >> 11) * 255 // 31,
                                 ((word >> 5) & 63) * 255 // 63, (word & 31) * 255 // 31, 255)
                    else:
                        color = (((word >> 10) & 31) * 255 // 31,
                                 ((word >> 5) & 31) * 255 // 31, (word & 31) * 255 // 31, 255)
                rgba[(y * width + x) * 4:(y * width + x + 1) * 4] = bytes(color)
                x += 1
    return bytes(data), off, bytes(rgba)


def legacy_bitmap(data, off, kind, masks):
    with tempfile.TemporaryFile() as stream:
        stream.write(data)
        stream.flush()
        r = ORACLE.Reader(stream, {"parser_ram_mb": 64, "max_bytes": 16777216,
                                  "max_dateien": 10000}, time.monotonic() + 10)
        return ORACLE.bitmap(r, off, len(data), ORACLE.GROUPS[kind], masks)


class Regression(unittest.TestCase):
    def invoke(self, *args, **kwargs):
        return fixtures.LeserTests().invoke(*args, **kwargs)

    def test_shadow_17x6_exact_legacy_bitstream(self):
        # rea4 R1: 6 Zeilen mit je zwei Spans 8+9, Alpha128, (-2,+3).
        masks = (0xf800, 0x7e0, 0x1f)
        data = bytearray(96)
        struct.pack_into("<III", data, 32, *masks)
        data += struct.pack("<IHHhh", 12, 17, 6, -2, 3)
        data += struct.pack("<HH", 8, 0x8009) * 6
        blob, used, meta = DECODER.dekodiere(Bildquelle(bytes(data)), 96, len(data), 0x5982)
        old, old_used, _ = legacy_bitmap(bytes(data), 96, 0x5982, masks)
        self.assertEqual(blob, old)
        self.assertEqual(used, old_used)
        self.assertEqual(pixels(blob), ((17, 6), bytes((0, 0, 0, 128)) * (17 * 6)))
        self.assertEqual((meta["versatz_x"], meta["versatz_y"]), ("-2", "3"))
        print("R1 Shadow17x6: PNG-bytegleich, Bytes=" + str(len(blob)) + " SHA256=" + sha(blob))

    def test_deterministic_120_case_matrix_png_bytes_pixels_offsets(self):
        rng = random.Random(970023)
        checks = 0
        for masks in ((0xf800, 0x7e0, 0x1f), (0x7c00, 0x3e0, 0x1f)):
            for kind in KINDS:
                for i in range(12):
                    width, height = rng.randint(1, 33), rng.randint(1, 9)
                    dx, dy = rng.randint(-32768, 32767), rng.randint(-32768, 32767)
                    data, off, expected = fixture_bitmap(kind, masks, width, height, dx, dy, rng, odd=bool(i % 2))
                    new, used, meta = DECODER.dekodiere(Bildquelle(data), off, len(data), kind)
                    old, old_used, _ = legacy_bitmap(data, off, kind, masks)
                    self.assertEqual(new, old, (hex(kind), masks, i, width, height))
                    self.assertEqual(used, old_used)
                    self.assertEqual(pixels(new), ((width, height), expected))
                    self.assertEqual((meta["versatz_x"], meta["versatz_y"]),
                                     (str(dx), str(dy)) if kind in KINDS[:3] else ("0", "0"))
                    checks += 1
        self.assertEqual(checks, 120)
        print("R1 Matrix: 120/120 PNG-bytegleich und exakte RGBA-Pixel/Offsets")

    def test_all_groups_both_rgb_masks_match_legacy_bytes_and_pixels(self):
        for masks in ((0xf800, 0x7e0, 0x1f), (0x7c00, 0x3e0, 0x1f)):
            data = graphics(masks)
            end, rows, _, files = self.invoke("siedler3", data)
            self.assertEqual(end["status"], "fertig")
            images = [r for r in rows if r["typ"] == "bild"]
            self.assertEqual(len(images), 5)
            expected = [v for v in oracle_records(data) if v[4] == "image/png"]
            self.assertEqual(len(expected), len(images))
            for actual, old in zip(images, expected):
                blob = files[actual["datei"]["pfad"]]
                self.assertEqual(blob, old[1])
                self.assertEqual(pixels(blob), pixels(old[1]))
                self.assertEqual((int(actual["quelle"]["offset"]), int(actual["quelle"]["laenge"])),
                                 (old[2], old[3]))
                self.assertEqual(actual["metadaten"]["versatz_x"], str(old[5]["versatz_x"]))
                self.assertEqual(actual["metadaten"]["darstellung"], old[5]["darstellung"])
                raw = next(r for r in rows if r["member_id"] == actual["metadaten"]["roh_member"])
                off, n = int(raw["quelle"]["offset"]), int(raw["quelle"]["laenge"])
                self.assertEqual(files[raw["datei"]["pfad"]], data[off:off+n])
                size, rgba = pixels(blob)
                self.assertEqual(rgba[:4], b"\0\0\0\0")  # skip -> transparent

    def test_synthetic_reference_counts_and_no_aggregate_cap(self):
        for count in (235, 448, 1430):
            end, rows, _, _ = self.invoke("siedler3", graphics(many=count),
                limits={"dateien": "10000", "bytes": "16777216", "datei_bytes": "8388608"})
            self.assertEqual(end["status"], "fertig")
            self.assertEqual(sum(r["typ"] == "bild" for r in rows), count)
            self.assertEqual(sum(r["typ"] == "frames" for r in rows), count)

    def test_synthetic_208_wav_45_raw_match_legacy(self):
        data = sounds()
        end, rows, _, files = self.invoke("siedler3", data, limits={"dateien": "1024"})
        self.assertEqual(end["status"], "fertig")
        expected = {(off, "sound" if mime == "audio/wav" else "binaer"): blob
                    for _, blob, off, _, mime, _ in oracle_records(data, True)}
        artifacts = [r for r in rows if r["datei"] is not None]
        self.assertEqual(sum(r["typ"] == "sound" for r in artifacts), 208)
        self.assertEqual(sum(r["typ"] == "binaer" for r in artifacts), 45)
        for row in artifacts:
            self.assertEqual(files[row["datei"]["pfad"]],
                             expected[int(row["quelle"]["offset"]), row["typ"]])

    def test_png_pair_budget_boundary_and_resume(self):
        data = graphics()
        expected = self.invoke("siedler3", data)[1]
        cursor, seen = None, []
        for _ in range(20):
            end, rows, cursor, _ = self.invoke("siedler3", data, cursor=cursor, limits={"dateien": "3"})
            seen.extend(rows)
            if end["status"] == "fertig":
                break
        else:
            self.fail("recordcursor_stillstand")
        self.assertEqual(seen, expected)
        ids = {r["member_id"] for r in seen}
        self.assertEqual(len(ids), len(seen))
        for r in seen:
            if r["typ"] == "bild":
                self.assertIn(r["metadaten"]["roh_member"], ids)

    def test_pair_cannot_partially_publish_with_two_file_budget(self):
        data = graphics()
        first = self.invoke("siedler3", data, limits={"dateien": "3"})[2]
        # Resume until the first image record; a two-file step cannot fit raw+PNG+segment.
        for _ in range(10):
            end, rows, nxt, files = self.invoke("siedler3", data, cursor=first, limits={"dateien": "2"})
            if checkpoint(nxt)["position"] == checkpoint(first)["position"]:
                self.assertEqual(end["status"], "teilweise")
                self.assertFalse(any(n.endswith((".png", ".bin")) for n in files))
                self.assertFalse(any(r["typ"] in ("bild", "frames") for r in rows))
                break
            first = nxt
        else:
            self.fail("fehlende_atomare_grenze")

    def test_byte_limit_reserves_raw_png_and_metadata_together(self):
        data = graphics()
        full_end, full, _, blobs = self.invoke("siedler3", data)
        self.assertEqual(full_end["status"], "fertig")
        pair = [r for r in full if r["typ"] == "bild"][0]
        raw = next(r for r in full if r["member_id"] == pair["metadaten"]["roh_member"])
        size = sum(int(r["datei"]["bytes"]) + len(json.dumps(
            r, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()) + 1
                   for r in (raw, pair))
        cursor = self.invoke("siedler3", data, limits={"dateien": "3"})[2]
        for _ in range(10):
            end, rows, nxt, _ = self.invoke("siedler3", data, cursor=cursor, limits={"dateien": "2"})
            if checkpoint(nxt)["position"] == checkpoint(cursor)["position"]:
                break
            cursor = nxt
        else:
            self.fail("first_frame_cursor_fehlt")
        before = checkpoint(cursor)["position"]
        end, rows, same, files = self.invoke("siedler3", data, cursor=cursor,
                                           limits={"bytes": str(size - 1)})
        self.assertEqual(end["status"], "teilweise")
        self.assertEqual(checkpoint(same)["position"], before)
        self.assertFalse(any(n.endswith((".bin", ".png")) for n in files))
        self.assertTrue(rows[0]["metadaten"]["original_erhalten"])
        end, rows, _, _ = self.invoke("siedler3", data, cursor=cursor)
        self.assertEqual(end["status"], "fertig")
        self.assertEqual(sum(r["typ"] == "bild" for r in rows), 5)

    def test_malformed_rle_is_error_not_fake_png(self):
        end, rows, _, files = self.invoke("siedler3", graphics(broken=True))
        self.assertEqual(end["status"], "fehler")
        self.assertIn("rle_", end["grund"])
        self.assertFalse(any(n.endswith(".png") for n in files))

    def test_memory_and_png_file_limits_keep_cursor(self):
        data = bytearray(graphics())
        # Huge first frame dimensions, tiny actual body -> memory guard before pixel allocation.
        table = struct.unpack_from("<I", data, 56)[0]
        seq = struct.unpack_from("<I", data, table + 8)[0]
        frame = seq + struct.unpack_from("<I", data, seq + 8)[0]
        struct.pack_into("<HH", data, frame + 4, 65535, 65535)
        end, _, cursor, _ = self.invoke("siedler3", bytes(data), limits={"ram_mib": "1"})
        self.assertEqual(end["status"], "teilweise")
        self.assertIn("speicherlimit", end["grund"])
        self.assertIsNotNone(cursor)

    def test_pak_cross_format_and_original_member_bytes(self):
        inner = pak([])
        end, rows, _, files = self.invoke("pak", pak([("a/b.dat", b"abc"), ("leer", b""), ("inner.pak", inner)]))
        self.assertEqual(end["status"], "fertig")
        members = [r for r in rows if r["datei"] is not None]
        self.assertEqual([files[r["datei"]["pfad"]] for r in members], [b"abc", b"", inner])
        self.assertEqual(self.invoke("pak", graphics())[0]["status"], "nicht_unterstuetzt")
        self.assertEqual(self.invoke("siedler3", pak([]))[0]["status"], "nicht_unterstuetzt")


if __name__ == "__main__":
    unittest.main(verbosity=2)
