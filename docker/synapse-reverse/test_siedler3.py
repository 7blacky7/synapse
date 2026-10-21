"""P18-T72 synthetic container tests; no original files, DB or Docker."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave
import zlib

HERE = Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


s3 = load("siedler3_test", HERE / "siedler3.py")
runner = load("siedler3_runner_test", HERE / "runner.py")


def gfx():
    data = bytearray(96)
    data[:8] = s3.GFX
    struct.pack_into("<III", data, 32, 0xf800, 0x7e0, 0x1f)
    struct.pack_into("<I", data, 52, 84)
    data[84:96] = bytes.fromhex("041900000c00000000000000")
    kinds = [0x2412, 0x11306, 0x106, 0x3112, 0x5982, 0x21702]
    tables = []
    for kind in kinds:
        tables.append(len(data))
        data.extend(struct.pack("<IHHI", kind, 12, 1, 0))
    offsets = {}
    for kind, table in zip(kinds, tables):
        start = len(data)
        struct.pack_into("<I", data, table + 8, start)
        if kind in (0x106, 0x3112, 0x5982):
            data.extend(bytes.fromhex("0214000008000001") + struct.pack("<I", 12))
            start = len(data)
            data.extend(struct.pack("<IHHhh", 12, 3, 1, -2, 4))
        elif kind == 0x2412:
            data.extend(struct.pack("<HHH", 3, 1, 0x101))
        elif kind == 0x11306:
            data.extend(struct.pack("<HHHH", 3, 1, 0, 0))
        else:
            data.extend(b"opaque")
            continue
        if len(data) % 2:
            data.append(0)
        offsets[kind] = (start, len(data))
        data.extend(struct.pack("<H", 0x8102))  # skip transparent pixel, draw two, newline
        if kind == 0x3112:
            data.extend(bytes([31, 0]))
        elif kind != 0x5982:
            data.extend(struct.pack("<HH", 0xf800, 0x7e0))
    struct.pack_into("<I", data, 80, len(data))
    data.extend(bytes.fromhex("072600000c00000000010000"))
    struct.pack_into("<6I", data, 56, *tables)
    struct.pack_into("<I", data, 48, len(data))
    return bytes(data), offsets


def snd(samples=None):
    data = bytearray(44)
    data[:8] = s3.SND
    struct.pack_into("<I", data, 12, 28)
    struct.pack_into("<I", data, 24, 28)
    struct.pack_into("<IHH", data, 28, 0x11f74, 16, 2)
    records = []
    for index, (channels, bits, pcm) in enumerate(samples or [(1, 8, b"\x00\x80\xff"), (2, 16, b"\0\0\xff\x7f\0\x80\0\0")]):
        seq = len(data)
        data.extend(struct.pack("<II", 1, seq + 8))
        struct.pack_into("<I", data, 36 + index * 4, seq)
        at = len(data)
        align = channels * bits // 8
        fmt = struct.pack("<HHIIHH", 1, channels, 22050, 22050 * align, align, bits)
        data.extend(struct.pack("<I", 20 + len(pcm)) + fmt + pcm)
        records.append((at, channels, bits, pcm))
    struct.pack_into("<I", data, 16, len(data))
    return bytes(data), records


def map_bytes():
    return struct.pack("<II", 12345, 11) + struct.pack("<II", 0x0d5a0613, 12) + b"\x8f\x21\x00\xfe" + struct.pack("<II", 0x42, 10) + b"\x91\x32" + struct.pack("<II", 0, 8)


def decode_png(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    at, packed, dimensions = 8, b"", None
    while at < len(data):
        n = struct.unpack_from(">I", data, at)[0]
        kind, body = data[at + 4:at + 8], data[at + 8:at + 8 + n]
        assert zlib.crc32(kind + body) == struct.unpack_from(">I", data, at + 8 + n)[0]
        if kind == b"IHDR":
            dimensions = struct.unpack(">IIBBBBB", body)
        if kind == b"IDAT":
            packed += body
        at += 12 + n
    return dimensions, zlib.decompress(packed)


class SiedlerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.counter = 0

    def tearDown(self):
        self.temp.cleanup()

    def extract(self, payload, name="fixture.dat", **override):
        self.counter += 1
        source = self.root / ("source" + str(self.counter))
        source.write_bytes(payload)
        out = self.root / ("out" + str(self.counter))
        out.mkdir()
        cap = runner.limits({})
        cap.update(override)
        result = s3.extract(source, out, name, cap, len(payload), time.monotonic() + cap["zeitlimit_s"], runner.limit_violation, (0, 0, 0))
        self.assertEqual(source.read_bytes(), payload)
        for rel, meta in result["metadaten"].items():
            info = meta["siedler3"]
            span = payload[info["offset"]:info["offset"] + info["laenge"]]
            self.assertEqual(info["quellbereich_sha256"], hashlib.sha256(span).hexdigest())
            self.assertTrue((out / rel).is_file())
            self.assertEqual(meta["herkunft"]["archiv"], name)
        return result, out

    def test_gfx_all_types_and_actual_pixels(self):
        result, out = self.extract(gfx()[0])
        self.assertEqual(result["status"], "entpackt", result)
        self.assertEqual(result["dateien"], 9)
        images = {m["siedler3"]["typ"]: (out / p).read_bytes() for p, m in result["metadaten"].items() if p.endswith(".png")}
        self.assertEqual(set(images), {"landscape", "gui", "sprite", "torso", "shadow"})
        for kind, data in images.items():
            dims, raw = decode_png(data)
            self.assertEqual(dims, (3, 1, 8, 6, 0, 0, 0))
            self.assertEqual(raw[:5], b"\0" * 5)
            if kind in ("landscape", "gui", "sprite"):
                self.assertEqual(raw[5:], bytes([255, 0, 0, 255, 0, 255, 0, 255]))
            elif kind == "torso":
                self.assertEqual(raw[5:], bytes([255, 255, 255, 255, 0, 0, 0, 255]))
            else:
                self.assertEqual(raw[5:], bytes([0, 0, 0, 128]) * 2)

    def test_snd_samples_and_odd_riff_padding(self):
        payload, records = snd()
        result, out = self.extract(payload)
        self.assertEqual(result["status"], "entpackt", result)
        self.assertEqual(result["dateien"], 2)
        for path, (_, channels, bits, pcm) in zip(sorted(result["metadaten"]), records):
            data = (out / path).read_bytes()
            self.assertEqual(struct.unpack_from("<I", data, 4)[0], len(data) - 8)
            with wave.open(io.BytesIO(data), "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (channels, bits // 8, 22050))
                self.assertEqual(w.readframes(w.getnframes()), pcm)

    def test_snd_incomplete_sample_preserves_raw_and_continues(self):
        payload, records = snd([(1, 16, b"\xfa\xff\xf8"), (1, 16, b"\x01\0")])
        result, out = self.extract(payload)
        self.assertEqual((result["status"], result["grund"]), ("teilweise", "beschaedigt"))
        self.assertEqual(result["dateien"], 3)
        raw = next(p for p in result["metadaten"] if p.endswith(".bin"))
        at = records[0][0]
        self.assertEqual((out / raw).read_bytes(), payload[at:at + 23])
        for path, expected in zip(sorted(p for p in result["metadaten"] if p.endswith(".wav")), [b"\xfa\xff", b"\x01\0"]):
            with wave.open(str(out / path), "rb") as w:
                self.assertEqual(w.readframes(w.getnframes()), expected)

    def test_map_is_structure_only_even_with_hashed_source_name(self):
        result, out = self.extract(map_bytes(), "map.MAP")
        self.assertEqual((result["status"], result["grund"], result["dateien"]), ("teilweise", "verschluesselt", 1))
        doc = json.loads((out / next(iter(result["metadaten"]))).read_text())
        self.assertEqual([b["offset"] for b in doc["bloecke"]], [16, 28])
        self.assertTrue(all(b["verschluesselt"] for b in doc["bloecke"]))
        self.assertEqual(s3.identify(map_bytes(), ".bin"), None)

    def test_corrupt_image_does_not_hide_later_images(self):
        payload, offsets = gfx()
        data = bytearray(payload)
        struct.pack_into("<H", data, offsets[0x2412][1], 0x8004)
        result, out = self.extract(bytes(data))
        self.assertEqual((result["status"], result["grund"]), ("teilweise", "beschaedigt"))
        self.assertEqual(sum(p.endswith(".png") for p in result["metadaten"]), 4)
        bad = [(p, m) for p, m in result["metadaten"].items() if m["siedler3"].get("fehler")]
        self.assertEqual(len(bad), 1)
        self.assertTrue((out / bad[0][0]).read_bytes())

    def test_invalid_headers_and_sound_lengths(self):
        payload = bytearray(gfx()[0])
        struct.pack_into("<I", payload, 48, 0)
        self.assertEqual(self.extract(bytes(payload))[0]["grund"], "beschaedigt")
        payload, records = snd()
        data = bytearray(payload)
        struct.pack_into("<I", data, records[0][0], len(data) * 2)
        result, _ = self.extract(bytes(data))
        self.assertEqual(result["grund"], "beschaedigt")
        self.assertEqual(result["dateien"], 0)
        data = bytearray(map_bytes())
        struct.pack_into("<I", data, 12, 0)
        self.assertEqual(self.extract(bytes(data), "bad.map")[0]["grund"], "beschaedigt")

    def test_limits_fail_without_overwriting_original(self):
        for caps in ({"max_dateien": 1}, {"max_bytes": 30}, {"max_tiefe": 1}, {"zeitlimit_s": -1}):
            result, _ = self.extract(gfx()[0], "nested/gfx.dat", **caps)
            self.assertEqual(result["status"], "teilweise", (caps, result))
            self.assertIn(result["grund"], {"zu_gross", "bombe_verdacht", "zeitlimit"})
        data, offsets = gfx()
        data = bytearray(data)
        struct.pack_into("<HH", data, offsets[0x2412][0], 65535, 65535)
        self.assertEqual(self.extract(bytes(data))[0]["grund"], "speicherlimit")

    def test_nested_switch_and_manifest_origin(self):
        for enabled in (False, True):
            out = self.root / str(enabled)
            out.mkdir()
            original = gfx()[0]
            (out / "a.dat").write_bytes(original)
            meta, stopped = runner.entpacke_verschachtelt(out, runner.limits({}), len(original), {}, self.root / "tmp", time.monotonic(), siedler_aktiv=enabled)
            self.assertFalse(stopped)
            self.assertEqual((out / "a.dat").read_bytes(), original)
            if not enabled:
                self.assertEqual(len(list(out.iterdir())), 1)
                self.assertEqual(meta["a.dat"]["verschachtelt"]["status"], "vorgemerkt")
            else:
                manifest, _ = runner.output_manifest(out, runner.limits({}), len(original))
                runner.merge_verschachtelt(manifest, meta)
                self.assertEqual(sum(e["art"] == "asset" for e in manifest if "art" in e), 5)
                self.assertTrue(all(e["metadaten"]["herkunft"]["tiefe"] == 1 for e in manifest if e["pfad"].endswith(".png")))

    def test_direct_request_and_disabled(self):
        bib, work = self.root / "bib", self.root / "work"
        bib.mkdir()
        (bib / "hashed").write_bytes(map_bytes())
        with patch.object(runner, "BIB", bib), patch.object(runner, "WORK", work), patch.object(runner, "TMP_ROOT", self.root / "tmp"), patch.object(runner, "disc_modul", return_value=SimpleNamespace(erkenne=lambda _: None)):
            req = {"kommando": "extrahieren", "eingabe": str(bib / "hashed"), "eingabe_name": "original.MAP", "auftrag_id": "fixture-72", "optionen": {"siedler3": False}}
            self.assertEqual(runner.run_request(req)[-1]["fehlercode"], "nicht_unterstuetzt")
            req["optionen"]["siedler3"] = True
            result = runner.run_request(req)[-1]
            self.assertEqual(result["fehlercode"], "verschluesselt", result)
            self.assertEqual(len(result["manifest"]), 1)
            self.assertTrue(result["manifest"][0]["pfad"].startswith("original.MAP~inhalt/"))


def export_fixture(out):
    out.mkdir(parents=True)
    (out / "gfx.dat").write_bytes(gfx()[0])
    (out / "snd.dat").write_bytes(snd()[0])
    (out / "karte.map").write_bytes(map_bytes())
    cap = runner.limits({})
    size = sum(p.stat().st_size for p in out.iterdir())
    meta, _ = runner.entpacke_verschachtelt(out, cap, size, {}, out.parent / "tmp", time.monotonic(), siedler_aktiv=True)
    manifest, _ = runner.output_manifest(out, cap, size)
    runner.merge_verschachtelt(manifest, meta)
    print(json.dumps({"manifest": manifest, "status": runner.siedler3_status(meta)}))



def probe_original(source, out):
    """Coordinator only: original :ro, outputs on existing probe tmpfs; no deploy."""
    def digest(path):
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
        return h.hexdigest()
    before = digest(source)
    started = time.monotonic()
    with patch.object(runner, "BIB", source.parent), patch.object(runner, "WORK", out.parent), patch.object(runner, "TMP_ROOT", out.parent / "tmp"):
        result = runner.run_request({"kommando": "extrahieren", "eingabe": str(source),
            "eingabe_name": source.name, "auftrag_id": out.name, "optionen": {"siedler3": True}})[-1]
    types, samples, images, sounds = {}, [], 0, 0
    for entry in result.get("manifest", []):
        p = out / entry["pfad"]
        meta = entry.get("metadaten", {}).get("siedler3", {})
        kind = meta.get("typ", entry["pfad"].rsplit(".", 1)[-1])
        types[kind] = types.get(kind, 0) + 1
        if p.suffix == ".png":
            dims, _ = decode_png(p.read_bytes())
            assert dims and dims[0] == meta["breite"] and dims[1] == meta["hoehe"]
            images += 1
        elif p.suffix == ".wav":
            with wave.open(str(p), "rb") as sound:
                assert sound.getnchannels() == meta["kanaele"]
                assert sound.getframerate() == meta["samplerate"]
            sounds += 1
        if len(samples) < 12:
            samples.append(entry)
    report = {"original": source.name, "original_sha256": before, "original_unveraendert": digest(source) == before,
              "status": result.get("status"), "fehlercode": result.get("fehlercode"),
              "siedler3": result.get("siedler3"), "dateien": len(result.get("manifest", [])), "typen": types,
              "png_validiert": images, "wav_validiert": sounds, "ausgabe_bytes": result.get("ausgabe_bytes"),
              "dauer_s": round(time.monotonic() - started, 3), "beispiele": samples}
    assert report["original_unveraendert"]
    with source.open("rb") as stream:
        if stream.read(8) == s3.SND:
            def number(at, size=4):
                stream.seek(at)
                return int.from_bytes(stream.read(size), "little")
            groups = number(34, 2)
            expected, partial, remainders = set(), set(), {}
            for group in range(groups):
                pointer = number(36 + group * 4)
                for variant in range(number(pointer)):
                    at = number(pointer + 4 + variant * 4)
                    total, align = number(at), number(at + 16, 2)
                    expected.add((group, variant))
                    rest = (total - 20) % align if align else -1
                    if rest:
                        partial.add((group, variant))
                        remainders[str(rest)] = remainders.get(str(rest), 0) + 1
            observed = {".wav": set(), ".bin": set()}
            errors = {}
            for entry in result["manifest"]:
                meta = entry["metadaten"]["siedler3"]
                suffix = Path(entry["pfad"]).suffix
                if suffix in observed:
                    observed[suffix].add((meta["gruppe"], meta["variante"]))
                if meta.get("fehler"):
                    errors[meta["fehler"]] = errors.get(meta["fehler"], 0) + 1
            assert observed[".wav"] == expected, (len(expected), len(observed[".wav"]))
            assert observed[".bin"] == partial, (len(partial), len(observed[".bin"]))
            report["snd_abdeckung"] = {"gruppen": groups, "varianten_original": len(expected),
                "wav_varianten": len(observed[".wav"]), "roh_varianten": len(observed[".bin"]),
                "restbytes_original": remainders, "fehler": errors, "vollstaendig": True}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--probe-original":
        probe_original(Path(sys.argv[2]), Path(sys.argv[3]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--export":
        export_fixture(Path(sys.argv[2]))
    else:
        unittest.main()
