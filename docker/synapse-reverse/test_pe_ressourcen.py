"""P18-T76 fixture and E-runner tests. All files live in TemporaryDirectory, no DB/Docker."""
import hashlib
import importlib.util
import json
import struct
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pe = load("pe_test_module", HERE / "pe_ressourcen.py")
runner = load("pe_runner_test", HERE / "runner.py")


def text(s):
    return s.encode("utf-16-le") + b"\0\0"


def align(data):
    return data + b"\0" * (-len(data) % 4)


def block(key, value=b"", children=(), kind=1):
    data = align(b"\0" * 6 + text(key)) + value
    for child in children:
        data = align(data) + child
    data = bytearray(data)
    struct.pack_into("<HHH", data, 0, len(data), len(value) // 2 if kind == 1 else len(value), kind)
    return bytes(data)


def fixture(plus=False):
    icon = struct.pack("<IiiHHIIiiII", 40, 2, 4, 1, 32, 0, 16, 0, 0, 0, 0) + b"\xff" * 16 + b"\0" * 8
    bitmap = struct.pack("<IiiHHIIiiII", 40, 2, 2, 1, 32, 0, 16, 0, 0, 0, 0) + b"\x55" * 16
    strings = struct.pack("<H", 5) + "Hallo".encode("utf-16-le") + b"\0\0" * 15
    dialog = struct.pack("<IIHhhhh", 0, 0, 1, 0, 0, 100, 50) + b"\0\0" * 2 + text("Start")
    dialog = align(dialog) + struct.pack("<IIhhhhH", 0, 0, 2, 3, 50, 20, 42) + b"\xff\xff\x82\0" + text("Beenden") + b"\0\0"
    version = block("VS_VERSION_INFO", struct.pack("<13I", 0xfeef04bd, 0x10000, 0x10002, 0x30004, 0, 0, 0, 0, 0, 0, 0, 0, 0),
                    [block("StringFileInfo", children=[block("040904B0", children=[block("ProductName", text("Fixture Spiel"))])])], kind=0)
    tree = {2: {1: {1033: bitmap}}, 3: {7: {1033: icon}},
            5: {1: {1033: dialog}}, 6: {1: {1033: strings, 1031: strings}},
            16: {1: {1033: version}}, "CUSTOM": {"../escape": {0: b"custom"}}}
    data = bytearray()
    records = []
    def alloc(n):
        while len(data) % 4:
            data.append(0)
        pos = len(data)
        data.extend(b"\0" * n)
        return pos
    def directory(node, labels=()):
        pos = alloc(16 + 8 * len(node))
        struct.pack_into("<HH", data, pos + 12, sum(isinstance(k, str) for k in node), sum(isinstance(k, int) for k in node))
        for i, (key, value) in enumerate(node.items()):
            if isinstance(key, str):
                label = key.encode("utf-16-le")
                lab = alloc(2 + len(label))
                struct.pack_into("<H", data, lab, len(label) // 2)
                data[lab + 2:lab + 2 + len(label)] = label
                ident = 0x80000000 | lab
            else:
                ident = key
            if isinstance(value, dict):
                target = 0x80000000 | directory(value, labels + (key,))
            else:
                target = alloc(16)
                raw = alloc(len(value))
                data[raw:raw + len(value)] = value
                struct.pack_into("<IIII", data, target, 0x1000 + raw, len(value), 1200, 0)
                records.append({"labels": labels + (key,), "record": target, "offset": 0x200 + raw, "data": value})
            struct.pack_into("<II", data, pos + 16 + i * 8, ident, target)
        return pos
    assert directory(tree) == 0
    raw_size = (len(data) + 511) // 512 * 512
    image = bytearray(0x200 + raw_size)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 60, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    optional = 0xf0 if plus else 0xe0
    struct.pack_into("<HHIIIHH", image, 0x84, 0x8664 if plus else 0x14c, 1, 0, 0, 0, optional, 2)
    opt = 0x98
    struct.pack_into("<H", image, opt, 0x20b if plus else 0x10b)
    dirs = 112 if plus else 96
    struct.pack_into("<I", image, opt + dirs - 4, 16)
    struct.pack_into("<II", image, opt + dirs + 16, 0x1000, len(data))
    section = opt + optional
    image[section:section + 8] = b".rsrc\0\0\0"
    struct.pack_into("<IIII", image, section + 8, len(data), 0x1000, raw_size, 0x200)
    image[0x200:0x200 + len(data)] = data
    return bytes(image), records


class ResourceTests(unittest.TestCase):
    def extract(self, image, **limits):
        root = Path(self.temp.name)
        source = root / "fixture.exe"
        source.write_bytes(image)
        out = root / ("out" + str(len(list(root.iterdir()))))
        out.mkdir()
        cap = runner.limits({"grenzen": limits})
        result = pe.extract(source, out, "fixture.exe", cap, len(image),
                            time.monotonic() + cap["zeitlimit_s"], runner.limit_violation)
        return result, out, source

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def test_pe32_and_pe32plus_all_leaves_hashes_views_and_origin(self):
        for plus in (False, True):
            image, records = fixture(plus)
            result, out, source = self.extract(image)
            self.assertEqual(result["status"], "fertig", result)
            raw = {m["pe_ressource"]["offset"]: (p, m) for p, m in result["metadaten"].items() if p.endswith(".bin")}
            self.assertEqual(len(raw), 7)
            for record in records:
                path, m = raw[record["offset"]]
                r = m["pe_ressource"]
                self.assertEqual((r["typ"], r["name"], r["sprache"]), record["labels"])
                self.assertEqual(r["laenge"], len(record["data"]))
                self.assertEqual(r["sha256"], hashlib.sha256(record["data"]).hexdigest())
                self.assertEqual((out / path).read_bytes(), record["data"])
                self.assertEqual(m["herkunft"]["archiv"], "fixture.exe")
                self.assertNotIn("..", Path(path).parts)
            for suffix, magic in ((".ico", b"\0\0\1\0"), (".bmp", b"BM")):
                p = next(p for p in result["metadaten"] if p.endswith(suffix))
                self.assertTrue((out / p).read_bytes().startswith(magic))
            alltext = "\n".join((out / p).read_text() for p in result["metadaten"] if p.endswith(".txt"))
            for value in ("Hallo", "Start", "Beenden", "Fixture Spiel", "ProductName"):
                self.assertIn(value, alltext)
            self.assertIn('"file_version": "1.2.3.4"', alltext)
            self.assertEqual(source.read_bytes(), image)

    def test_corrupt_leaf_keeps_valid_siblings_and_cycle_terminates(self):
        image, records = fixture()
        broken = bytearray(image)
        struct.pack_into("<I", broken, 0x200 + records[0]["record"], 0xffffffff)
        r, out, _ = self.extract(bytes(broken))
        self.assertEqual(r["status"], "teilweise")
        self.assertEqual(r["fehlercode"], "beschaedigt")
        self.assertEqual(sum(p.endswith(".bin") for p in r["metadaten"]), 6)
        struct.pack_into("<I", broken, 0x200 + 20, 0x80000000)
        r, _, _ = self.extract(bytes(broken))
        self.assertEqual(r["status"], "teilweise")
        self.assertTrue(any("zyklus" in w for w in r["hinweise"]))

    def test_caps_count_bytes_depth_ratio_and_deadline(self):
        image, _ = fixture()
        for limits, code in (({"max_dateien": 1}, "zu_gross"), ({"max_bytes": 1}, "zu_gross"),
                             ({"max_tiefe": 1, "max_dateien": 1}, "zu_gross")):
            r, out, _ = self.extract(image, **limits)
            self.assertEqual(r["status"], "teilweise")
            self.assertEqual(r["fehlercode"], code)
            self.assertLessEqual(sum(p.is_file() for p in out.rglob("*")), limits.get("max_dateien", 20000))
            self.assertLessEqual(sum(p.stat().st_size for p in out.rglob("*") if p.is_file()), limits.get("max_bytes", 2_000_000_000))
        root = Path(self.temp.name)
        src = root / "deadline.exe"; src.write_bytes(image)
        out = root / "deadline"; out.mkdir()
        cap = runner.limits({})
        r = pe.extract(src, out, "deadline.exe", cap, 1, time.monotonic() - 1, runner.limit_violation)
        self.assertEqual(r["fehlercode"], "zeitlimit")
        r = pe.extract(src, out, "deadline.exe", cap, 1, time.monotonic() + 5, runner.limit_violation)
        self.assertEqual(r["fehlercode"], "bombe_verdacht")

    def test_extended_dialog_and_truncated_data(self):
        d = struct.pack("<HHIIIHhhhh", 1, 0xffff, 0, 0, 0, 0, 0, 0, 10, 10) + b"\0\0" * 2 + text("Erweitert")
        self.assertEqual(json.loads(pe.dialog(d))["title"], "Erweitert")
        with self.assertRaises(pe.ResourceError):
            pe.strings(b"\xff\xff", 1)
        self.assertEqual(pe.view(99, 1, b"anything"), None)

    def test_runner_direct_and_nested_switch_off_on(self):
        root = Path(self.temp.name)
        bib, work, tmp = root / "bib", root / "arbeit", root / "tmp"
        bib.mkdir(); work.mkdir(); tmp.mkdir()
        source = bib / "probe.exe"; image, _ = fixture(); source.write_bytes(image)
        with patch.object(runner, "BIB", bib), patch.object(runner, "WORK", work), patch.object(runner, "TMP_ROOT", tmp):
            r = runner.run_request({"kommando": "extrahieren", "eingabe": str(source), "auftrag_id": "pe-on",
                                    "eingabe_name": "probe.exe", "optionen": {"pe_ressourcen": True}})[-1]
            self.assertEqual(r["status"], "fertig", r)
            self.assertEqual(len(r["manifest"]), 13)
            self.assertTrue(any(m.get("art") == "asset" for m in r["manifest"]))
            self.assertTrue(any(m.get("art") == "text" for m in r["manifest"]))
            nested = work / "nested"; nested.mkdir(); (nested / "inner.exe").write_bytes(image)
            cap = runner.limits({})
            args = (nested, cap, len(image), {}, tmp, time.monotonic())
            off, _ = runner.entpacke_verschachtelt(*args)
            self.assertFalse(any("pe_ressource" in m for m in off.values()))
            on, _ = runner.entpacke_verschachtelt(*args, pe_aktiv=True)
            self.assertEqual(sum("pe_ressource" in m for m in on.values()), 13)
            meta = {"inner.exe": {"herkunft": {"tiefe": 2}}}
            runner.pe_ressourcen(nested / "inner.exe", nested, "inner.exe", cap, len(image), time.monotonic() + 5, meta)
            self.assertTrue(all(m["herkunft"]["tiefe"] == 3 for m in meta.values() if "pe_ressource" in m))

    def test_preexisting_output_cannot_be_overwritten(self):
        image, _ = fixture()
        r, out, src = self.extract(image)
        original = {p: (out / p).read_bytes() for p in r["metadaten"]}
        again = pe.extract(src, out, "fixture.exe", runner.limits({}), len(image), time.monotonic() + 5, runner.limit_violation)
        self.assertTrue(all((out / p).read_bytes() == b for p, b in original.items()))
        self.assertTrue(all("~ressourcen2/" in p for p in again["metadaten"]))


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "--export":
        root = Path(sys.argv[2]); root.mkdir(parents=True, exist_ok=True)
        image, _ = fixture()
        source = root.parent / (root.name + ".exe"); source.write_bytes(image)
        result = pe.extract(source, root, "fixture.exe", runner.limits({}), len(image), time.monotonic() + 10, runner.limit_violation)
        manifest, _ = runner.output_manifest(root, runner.limits({}), len(image))
        runner.merge_verschachtelt(manifest, result["metadaten"])
        print(json.dumps({"manifest": manifest, "quelle_sha256": hashlib.sha256(image).hexdigest(), "status": result["status"]}))
    else:
        unittest.main()
