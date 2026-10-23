"""P18-T92: reine Python-Prozesse, ausschließlich selbst erzeugte Fixturebytes."""
from __future__ import annotations

import hashlib
import json
import runpy
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LIMITS = {"version": 1, "cpu": "1", "eingabe_bytes": "65536", "poll_ms": "10", "wait_ms": "1000", "zeit_ms": "10000", "ram_mib": "64", "dateien": "64",
          "bytes": "1048576", "datei_bytes": "262144", "protokoll_bytes": "65536",
          "zeile_bytes": "16384", "lese_bytes": "4096", "tiefe": "8"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checkpoint(cursor):
    if not isinstance(cursor, str):
        raise AssertionError("bestaetigter_cursor_fehlt")
    return json.loads(cursor)


def pak(members):
    payload = bytearray()
    entries = bytearray()
    for name, data in members:
        name = name.encode("ascii")
        if len(name) > 56:
            raise ValueError("fixture_name")
        entries += struct.pack("<56sii", name, 12 + len(payload), len(data))
        payload += data
    return struct.pack("<4sii", b"PACK", 12 + len(payload), len(entries)) + payload + entries


def gfx(empty=False):
    data = bytearray(96)
    data[:8] = b"\x04\x13\x04\0\x0c\0\0\0"
    struct.pack_into("<III", data, 32, 0xf800, 0x7e0, 0x1f)
    tables = []
    for slot in range(6):
        tables.append(len(data))
        count = int(not empty and slot < 2)
        data += struct.pack("<IHH", 0x106 if slot == 0 else 0x21702 if slot == 1 else 0x2412,
                            8 + 4 * count, count) + b"\0" * (4 * count)
    if not empty:
        pointer = len(data)
        data += b"\x02\x14\0\0\x08\0\0\x02" + struct.pack("<II", 16, 28)
        data += struct.pack("<IHHhh", 12, 0, 0, -32, 0)
        data += struct.pack("<IHHhhHHH", 12, 2, 1, -2, 3, 0x8002, 0xffff, 0)
        struct.pack_into("<I", data, tables[0] + 8, pointer)
        struct.pack_into("<I", data, tables[1] + 8, len(data))
        data += b"roh!"
    struct.pack_into("<I", data, 52, len(data))
    data += b"meta"
    struct.pack_into("<I", data, 80, len(data))
    data += b"farb"
    struct.pack_into("<6I", data, 56, *tables)
    struct.pack_into("<I", data, 48, len(data))
    return bytes(data)


def snd(empty=False):
    data = bytearray(36 if empty else 40)
    data[:8] = b"\x44\x15\x01\0\x02\0\0\0"
    struct.pack_into("<I", data, 24, 28)
    struct.pack_into("<IHH", data, 28, 0x11f74, 8 if empty else 12, 0 if empty else 1)
    if not empty:
        struct.pack_into("<I", data, 36, 40)
        data += struct.pack("<I", 3) + b"\0" * 12
        for variant, (codec, channels, bits, pcm) in enumerate(
                [(1, 2, 16, b"\x01\x02\x03\x04\x05"), (1, 1, 8, b"\x01\x02\x03"),
                 (2, 1, 8, b"xyz")]):
            offset = len(data)
            struct.pack_into("<I", data, 44 + variant * 4, offset)
            align = channels * bits // 8
            data += struct.pack("<IHHIIHH", 20 + len(pcm), codec, channels, 8000,
                                8000 * align, align, bits) + pcm
    struct.pack_into("<I", data, 16, len(data))
    return bytes(data)


class LeserTests(unittest.TestCase):
    def invoke(self, reader, data, cursor=None, limits=None, changes=None, adapter=False):
        with tempfile.TemporaryDirectory(prefix="p18-t92-fixture-") as folder:
            root = Path(folder)
            original, output = root / "original.bin", root / "ausgabe"
            original.write_bytes(data)
            output.mkdir()
            request = {"schnittstelle_version": 1, "eintrag_id": "rev-eigene-fixture",
                       "datei_id": "1", "quell_sha256": sha(data), "groesse": str(len(data)),
                       "leser_revision": "fixture-revision", "code_sha256": "1" * 64,
                       "generation": "fixture-generation", "einstellungen_revision": "fixture-policy",
                       "eingabe": str(original), "ausgabe": str(output), "cursor": cursor,
                       "grenzen": {**LIMITS, **(limits or {})}}
            request.update(changes or {})
            if adapter:
                project = runpy.run_path(str(ROOT.parent / "docker/synapse-reverse/leser.py"))["leser_stdin"]
                host_limits = dict(request["grenzen"])
                host_limits.pop("version")
                wire = project({"leser_eingabe": {**request, "grenzen": {"bytes": "9223372036854775807"}},
                                "leser_grenzen": host_limits})
                projected = json.loads(wire)
                self.assertEqual(projected["grenzen"], request["grenzen"])
                request = projected
                (output / ".leser-protokoll.jsonl").write_bytes(b"nur-parent-spool")
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-u", "-c",
                 "import runpy,sys;sys.path.insert(0,sys.argv[1]);"
                 "runpy.run_path(sys.argv[1]+'/leser.py',run_name='__main__')",
                 str(ROOT / reader)],
                input=json.dumps(request) + "\n", capture_output=True, text=True, timeout=15,
                cwd=output, env={"PATH": str(Path(sys.executable).parent), "LANG": "C.UTF-8"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            events = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(events[-1]["art"], "ende")
            self.assertEqual(sum(v["art"] == "ende" for v in events), 1)
            if adapter:
                self.assertEqual((output / ".leser-protokoll.jsonl").read_bytes(), b"nur-parent-spool")
            files = {p.name: p.read_bytes() for p in output.iterdir()
                     if not (adapter and p.name == ".leser-protokoll.jsonl")}
            objects = []
            next_cursor = None
            declared = set()
            for item in events:
                if item["art"] != "schritt":
                    continue
                next_cursor = item["cursor"]
                ref = item["segment"]
                content = files[ref["pfad"]]
                declared.add(ref["pfad"])
                self.assertEqual(sha(content), ref["sha256"])
                self.assertEqual(len(content), int(ref["bytes"]))
                rows = [json.loads(line) for line in content.splitlines()]
                self.assertEqual(len(rows), int(ref["zeilen"]))
                objects.extend(rows)
            for item in objects:
                self.assertLessEqual(int(item["quelle"]["offset"]) + int(item["quelle"]["laenge"]), len(data))
                ref = item["datei"]
                if ref is not None:
                    declared.add(ref["pfad"])
                    self.assertEqual(sha(files[ref["pfad"]]), ref["sha256"])
                    self.assertEqual(len(files[ref["pfad"]]), int(ref["bytes"]))
            self.assertEqual(declared, set(files))
            self.assertEqual(original.read_bytes(), data)
            if events[-1]["status"] in ("fertig", "teilweise"):
                self.assertEqual(int(events[-1]["objekte"]), len(objects))
                self.assertGreater(len(objects), 0)
                self.assertLessEqual(len(objects), int(request["grenzen"]["dateien"]))
                self.assertLessEqual(len(files), int(request["grenzen"]["dateien"]))
                self.assertLessEqual(sum(map(len, files.values())), int(request["grenzen"]["bytes"]))
                self.assertTrue(all(len(v) <= int(request["grenzen"]["datei_bytes"]) for v in files.values()))
            return events[-1], objects, next_cursor, files

    def test_pak_nested_empty_and_embedded_archive(self):
        inner = pak([])
        end, objects, _, files = self.invoke("pak", pak([("a/b/c.txt", b"abc"), ("leer", b""), ("inner.pak", inner)]))
        self.assertEqual(end["status"], "fertig")
        members = [v for v in objects if v["datei"] is not None]
        self.assertEqual([v["metadaten"]["name"] for v in members], ["a/b/c.txt", "leer", "inner.pak"])
        self.assertEqual(files[members[1]["datei"]["pfad"]], b"")
        self.assertEqual(files[members[2]["datei"]["pfad"]], inner)

    def test_real_adapter_projection_matches_both_author_packages(self):
        for reader, data in (("pak", pak([])), ("siedler3", gfx())):
            self.assertEqual(self.invoke(reader, data, adapter=True)[0]["status"], "fertig")

    def test_pak_empty_directory_is_proven(self):
        end, objects, _, _ = self.invoke("pak", pak([]))
        self.assertEqual(end["status"], "fertig")
        self.assertTrue(objects[0]["metadaten"]["leeres_verzeichnis"])

    def test_pak_member_outside_input(self):
        data = bytearray(pak([("x", b"x")]))
        struct.pack_into("<i", data, len(data) - 8, 999999)
        end, _, _, _ = self.invoke("pak", bytes(data))
        self.assertEqual(end["status"], "fehler")
        self.assertIn("memberbereich", end["grund"])

    def test_pak_member_overlaps_directory(self):
        data = bytearray(pak([("x", b"x")]))
        struct.pack_into("<i", data, len(data) - 8, 13)
        end, _, _, _ = self.invoke("pak", bytes(data))
        self.assertEqual(end["status"], "fehler")

    def test_pak_negative_and_misaligned_directory(self):
        for offset, length in [(-1, 64), (12, 63)]:
            end, _, _, _ = self.invoke("pak", struct.pack("<4sii", b"PACK", offset, length))
            self.assertEqual(end["status"], "fehler")

    def test_magic_is_not_extension(self):
        for reader in ("pak", "siedler3"):
            end, _, _, _ = self.invoke(reader, b"MZ" + b"\0" * 94)
            self.assertEqual(end["status"], "nicht_unterstuetzt")
        end, _, _, _ = self.invoke("siedler3", b"fremde DAT Bytes" + b"\0" * 100)
        self.assertEqual(end["status"], "nicht_unterstuetzt")

    def test_pak_paths_never_become_filesystem_paths(self):
        end, objects, _, files = self.invoke("pak", pak([("../ausbruch", b"x"), ("/absolut", b"y")]))
        self.assertEqual(end["status"], "fertig")
        self.assertTrue(all("/" not in name for name in files))
        self.assertTrue(all(not v["metadaten"]["originalpfad_sicher"] for v in objects[1:]))

    def test_pak_step_resume_has_no_total_cap_or_duplicates(self):
        data = pak([("datei-" + str(i), bytes([i])) for i in range(9)])
        complete = self.invoke("pak", data)[1]
        cursor, seen, rounds = None, [], 0
        while True:
            end, objects, cursor, _ = self.invoke("pak", data, cursor=cursor, limits={"dateien": "3"})
            seen.extend(objects)
            rounds += 1
            if end["status"] == "fertig":
                break
            self.assertEqual(end["status"], "teilweise")
            self.assertLess(rounds, 10)
        self.assertGreater(rounds, 1)
        self.assertEqual(seen, complete)
        self.assertEqual(len({v["member_id"] for v in seen}), len(seen))

    def test_cursor_is_bound_to_all_provenance(self):
        data = pak([("x", b"x"), ("y", b"y"), ("z", b"z")])
        cursor = self.invoke("pak", data, limits={"dateien": "3"})[2]
        for field in ("eintrag_id", "datei_id", "leser_revision", "code_sha256", "generation", "einstellungen_revision"):
            end, _, _, _ = self.invoke("pak", data, cursor=cursor, changes={field: "anders"})
            self.assertEqual(end["status"], "fehler")
            self.assertEqual(end["grund"], "cursor_quellstand_abweichend")

    def test_terminal_or_forged_cursor_cannot_claim_empty_success(self):
        data = pak([])
        cursor = self.invoke("pak", data)[2]
        end, _, _, _ = self.invoke("pak", data, cursor=cursor)
        self.assertEqual(end["status"], "fehler")
        bad = checkpoint(cursor)
        bad["position"] = 999
        self.assertEqual(self.invoke("pak", data, cursor=json.dumps(bad))[0]["status"], "fehler")

    def test_missing_limits_and_wrong_source_hash_fail_closed(self):
        data = pak([])
        end = self.invoke("pak", data, changes={"grenzen": None})[0]
        self.assertEqual(end["grund"], "pg_grenzen_fehlen")
        end = self.invoke("pak", data, changes={"quell_sha256": "0" * 64})[0]
        self.assertEqual(end["grund"], "quelle_hash_ungueltig")

    def test_limits_version_and_complete_projection_required(self):
        for changes, reason in [({"version": 2}, "pg_grenzen_version"),
                                ({"cpu": None}, "pg_grenze_ungueltig:cpu"),
                                ({"wait_ms": "0"}, "pg_grenze_ungueltig:wait_ms")]:
            end = self.invoke("pak", pak([]), limits=changes)[0]
            self.assertEqual(end["status"], "fehler")
            self.assertEqual(end["grund"], reason)

    def test_byte_budget_stops_before_record_and_keeps_cursor(self):
        data = pak([("gross", b"x" * 5000)])
        end, objects, cursor, _ = self.invoke("pak", data, limits={"bytes": "2000"})
        self.assertEqual(end["status"], "teilweise")
        self.assertEqual(checkpoint(cursor)["position"], 1)
        self.assertEqual(len(objects), 1)

    def test_too_small_file_count_is_visible_without_skipping(self):
        data = pak([("x", b"x")])
        cursor = self.invoke("pak", data, limits={"dateien": "1"})[2]
        end, objects, next_cursor, _ = self.invoke("pak", data, cursor=cursor, limits={"dateien": "1"})
        self.assertEqual(end["status"], "teilweise")
        self.assertEqual(checkpoint(next_cursor)["position"], 1)
        self.assertTrue(objects[0]["metadaten"]["original_erhalten"])

    def test_gfx_nullframe_raw_and_later_frame_survive(self):
        end, objects, _, files = self.invoke("siedler3", gfx())
        self.assertEqual(end["status"], "fertig")
        frames = [v for v in objects if v["typ"] == "frames"]
        self.assertEqual(len(frames), 2)
        self.assertTrue(frames[0]["metadaten"]["nullframe"])
        self.assertEqual(frames[0]["metadaten"]["versatz_x"], "-32")
        self.assertEqual(len(files[frames[0]["datei"]["pfad"]]), 12)
        self.assertEqual(frames[1]["metadaten"]["breite"], "2")
        self.assertTrue(any(v["metadaten"].get("grund") == "variante_unbekannt" for v in objects))
        images = [v for v in objects if v["typ"] == "bild"]
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["metadaten"]["roh_member"], frames[1]["member_id"])
        self.assertEqual(files[images[0]["datei"]["pfad"]][:8], b"\x89PNG\r\n\x1a\n")
        self.assertFalse(any(name.endswith(".gif") for name in files))

    def test_gfx_empty_tables_and_resume(self):
        end, objects, _, _ = self.invoke("siedler3", gfx(empty=True))
        self.assertEqual(end["status"], "fertig")
        self.assertEqual(sum(v["metadaten"].get("leere_tabelle", False) for v in objects), 6)
        data = gfx()
        expected = self.invoke("siedler3", data)[1]
        cursor, seen = None, []
        for _ in range(12):
            end, rows, cursor, _ = self.invoke("siedler3", data, cursor=cursor, limits={"dateien": "3"})
            seen.extend(rows)
            if end["status"] == "fertig":
                break
        else:
            self.fail("GFX-Cursor macht keinen Fortschritt")
        self.assertEqual(seen, expected)

    def test_unknown_rgb_variant_stays_raw_with_reason(self):
        data = bytearray(gfx())
        struct.pack_into("<III", data, 32, 1, 2, 4)
        end, objects, _, _ = self.invoke("siedler3", bytes(data))
        self.assertEqual(end["status"], "fertig")
        self.assertTrue(any(v["metadaten"].get("grund") == "rgb_masken_unbekannt_roh_erhalten" for v in objects))

    def test_gfx_corrupt_pointer_is_not_success(self):
        data = bytearray(gfx())
        struct.pack_into("<I", data, 56, len(data) + 1)
        self.assertEqual(self.invoke("siedler3", bytes(data))[0]["status"], "fehler")

    def test_snd_pcm_remainder_unknown_codec_and_wav(self):
        end, objects, _, files = self.invoke("siedler3", snd())
        self.assertEqual(end["status"], "fertig")
        sounds = [v for v in objects if v["typ"] == "sound"]
        raw = [v for v in objects if v["typ"] == "binaer"]
        self.assertEqual(len(sounds), 2)
        self.assertEqual(len(raw), 2)
        first = files[sounds[0]["datei"]["pfad"]]
        self.assertEqual(first[:4], b"RIFF")
        self.assertEqual(first[44:], b"\x01\x02\x03\x04")
        self.assertEqual(sounds[0]["metadaten"]["restbytes"], "1")
        self.assertTrue(any(v["metadaten"]["grund"] == "pcm_variante_unbekannt" for v in raw))
        self.assertTrue(any(v["metadaten"]["grund"] == "pcm_rest_erhalten" for v in raw))

    def test_snd_empty_and_recordwise_resume(self):
        self.assertEqual(self.invoke("siedler3", snd(empty=True))[0]["status"], "fertig")
        data = snd()
        expected = self.invoke("siedler3", data)[1]
        cursor, seen = None, []
        for _ in range(10):
            end, rows, cursor, _ = self.invoke("siedler3", data, cursor=cursor, limits={"dateien": "2"})
            seen.extend(rows)
            if end["status"] == "fertig":
                break
        else:
            self.fail("SND-Cursor macht keinen Fortschritt")
        self.assertEqual(seen, expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
