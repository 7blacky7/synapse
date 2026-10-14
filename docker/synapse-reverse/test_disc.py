"""P18-T49/RV34: Spurtabelle, Pruefung, gemeinsamer Extraktor, Parser-Registry und libmirage-Adapter.

Nur SYNTHETISCHE Fixtures (selbst erzeugt), nie echte Spieldaten. libmirage-Faelle laufen nur, wenn
PyGObject + Mirage-3.2 verfuegbar sind (Container bzw. GI_TYPELIB_PATH/LD_LIBRARY_PATH auf eine entpackte
libmirage11/gir1.2-mirage-3.2), sonst werden sie uebersprungen.
"""
import hashlib
import importlib.util
import json
import math
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HIER = Path(__file__).parent


def lade(name, datei):
    spec = importlib.util.spec_from_file_location(name, HIER / datei)
    modul = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modul)
    return modul


disc = lade("reverse_disc_test", "disc.py")
runner = lade("reverse_runner_disc_test", "runner.py")
SYNC = disc.SYNC



class LibmirageFileReferenceSecurity(unittest.TestCase):
    def test_cue_rejects_paths_and_missing_media_before_libmirage_load(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cue = root / "test.cue"
            image = root / "test.bin"
            image.write_bytes(b"fixture")
            namen = {str(cue): "test.cue", str(image): "test.bin"}
            for reference, code in (("../test.bin", "beschaedigt"),
                                    ("/tmp/test.bin", "beschaedigt"),
                                    ("missing.bin", "nicht_gefunden")):
                with self.subTest(reference=reference):
                    cue.write_text(f'FILE "{reference}" BINARY\n')
                    with patch.object(disc, "_mirage") as mirage:
                        with self.assertRaises(disc.DiscFehler) as ctx:
                            disc.libmirage_spurtabelle("cue", cue, namen)
                        self.assertEqual(ctx.exception.code, code)
                        mirage.assert_not_called()


def bcd(n):
    return ((n // 10) << 4) | (n % 10)


def msf(lba):
    l = lba + 150
    return l // 4500, (l // 75) % 60, l % 75


def raw_mode1(data, lba):
    m, s, f = msf(lba)
    return SYNC + bytes([bcd(m), bcd(s), bcd(f), 1]) + data + b"\x00" * 288


def raw_mode2_form1(data, lba, form2=False):
    m, s, f = msf(lba)
    sub = bytes([0, 0, 0x20 if form2 else 0x08, 0]) * 2
    # Form 2: 2324 Byte Nutzdaten + 4 Byte EDC, Form 1: 2048 + 4 EDC + 276 ECC -> immer 2352 Byte je Sektor
    nutz = data + b"\x00" * (2328 - len(data)) if form2 else data + b"\x00" * 280
    return SYNC + bytes([bcd(m), bcd(s), bcd(f), 2]) + sub + nutz


def sinus(sektoren, freq):
    out = bytearray()
    for i in range(sektoren * 588):
        v = int(12000 * math.sin(2 * math.pi * freq * i / 44100))
        out += struct.pack("<hh", v, -v)
    return bytes(out)


def mini_iso(root):
    """Kleine ISO9660 (xorriso) oder, ohne xorriso, ein Pseudo-Abbild mit PVD-Magic."""
    quelle = root / "iso_src"
    quelle.mkdir()
    (quelle / "LIES.TXT").write_text("hallo\n")
    (quelle / "daten.bin").write_bytes(bytes(range(256)) * 400)
    ziel = root / "daten.iso"
    if shutil.which("xorriso"):
        subprocess.run(["xorriso", "-as", "mkisofs", "-quiet", "-o", str(ziel), str(quelle)], check=True,
                       capture_output=True)
    else:
        data = bytearray(64 * 2048)
        data[16 * 2048:16 * 2048 + 6] = b"\x01CD001"
        data[17 * 2048:17 * 2048 + 6] = b"\xffCD001"
        ziel.write_bytes(bytes(data))
    return ziel


def spur(nr, session, mode, start, laenge, datei, offset, groesse, pregap=0, pregap_datei=None, pregap_offset=0):
    abschnitte = []
    if pregap:
        abschnitte.append({"lba": start - pregap, "sektoren": pregap, "datei": pregap_datei,
                           "byte_offset": pregap_offset if pregap_datei else 0, "sektorgroesse": groesse,
                           "subchannel": None})
    abschnitte.append({"lba": start, "sektoren": laenge, "datei": datei, "byte_offset": offset,
                       "sektorgroesse": groesse, "subchannel": None})
    return disc.fasse_spur({"nummer": nr, "session": session, "art": "audio" if mode == "AUDIO" else "daten",
                            "mode": mode, "sektorgroesse": groesse, "start_lba": start, "laenge_sektoren": laenge,
                            "pregap": pregap, "postgap": 0, "indizes": [{"nummer": 1, "lba": start}],
                            "isrc": None, "titel": None, "audio_byte_reihenfolge": "le" if mode == "AUDIO" else None,
                            "abschnitte": abschnitte})


def tabelle(*sessions):
    return {"version": 1, "medium": "cd", "format": "test", "katalognummer": None, "lead_out_lba": None,
            "layer_break": None, "parser": {"id": "test", "version": "1", "registry_version": "1"},
            "sessions": [{"nummer": i + 1, "lead_out_lba": None, "spuren": s} for i, s in enumerate(sessions)]}


class Fixture:
    """Mixed-Mode-Medium: Spur 1 MODE1/2352 (ISO), Spur 2/3 Audio mit je 150 Sektoren Pregap im Image."""

    def __init__(self, root):
        self.root = root
        self.iso = mini_iso(root).read_bytes()
        self.n1 = len(self.iso) // 2048
        img = bytearray()
        for i in range(self.n1):
            img += raw_mode1(self.iso[i * 2048:(i + 1) * 2048], i)
        self.t2 = (self.n1, self.n1 + 150)
        self.audio2 = sinus(100, 440)
        img += b"\x00" * (150 * 2352) + self.audio2
        self.t3 = (self.t2[1] + 100, self.t2[1] + 250)
        self.audio3 = sinus(80, 880)
        img += b"\x00" * (150 * 2352) + self.audio3
        self.lead_out = self.t3[1] + 80
        (root / "test.bin").write_bytes(img)
        (root / "test.sub").write_bytes(b"\x00" * (96 * self.lead_out))

    def cue(self):
        def m(l):
            return f"{l // 4500:02d}:{(l // 75) % 60:02d}:{l % 75:02d}"
        (self.root / "test.cue").write_text(
            'FILE "test.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'
            f'  TRACK 02 AUDIO\n    INDEX 00 {m(self.t2[0])}\n    INDEX 01 {m(self.t2[1])}\n'
            f'  TRACK 03 AUDIO\n    INDEX 00 {m(self.t3[0])}\n    INDEX 01 {m(self.t3[1])}\n')
        return self.root / "test.cue"

    def tabelle(self):
        return tabelle([spur(1, 1, "MODE1", 0, self.n1, "test.bin", 0, 2352),
                        spur(2, 1, "AUDIO", self.t2[1], 100, "test.bin", self.t2[1] * 2352, 2352, 150, "test.bin",
                             self.t2[0] * 2352),
                        spur(3, 1, "AUDIO", self.t3[1], 80, "test.bin", self.t3[1] * 2352, 2352, 150, "test.bin",
                             self.t3[0] * 2352)])


class SpurtabellePruefung(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fx = Fixture(self.root)
        self.groessen = {"test.bin": (self.root / "test.bin").stat().st_size}

    def tearDown(self):
        self.temp.cleanup()

    def test_gueltige_tabelle_und_abgeleitete_felder(self):
        t = self.fx.tabelle()
        disc.pruefe_spurtabelle(t, self.groessen)
        s2 = t["sessions"][0]["spuren"][1]
        self.assertEqual(s2["byte_offset"], self.fx.t2[1] * 2352)
        self.assertTrue(s2["pregap_in_datei"])
        json.dumps(t)  # JSON-serialisierbar

    def test_spur_ausserhalb_der_datei_ist_beschaedigt(self):
        t = self.fx.tabelle()
        t["sessions"][0]["spuren"][2]["abschnitte"][-1]["sektoren"] += 1
        t["sessions"][0]["spuren"][2]["laenge_sektoren"] += 1
        with self.assertRaises(disc.DiscFehler) as ctx:
            disc.pruefe_spurtabelle(t, self.groessen)
        self.assertEqual(ctx.exception.code, "beschaedigt")

    def test_ueberlappende_spuren_und_sektorgroessen(self):
        t = self.fx.tabelle()
        t["sessions"][0]["spuren"][0]["laenge_sektoren"] += 10
        t["sessions"][0]["spuren"][0]["abschnitte"][0]["sektoren"] += 10
        with self.assertRaises(disc.DiscFehler):
            disc.pruefe_spurtabelle(t, self.groessen)
        t = self.fx.tabelle()
        t["sessions"][0]["spuren"][1]["sektorgroesse"] = 2048
        with self.assertRaises(disc.DiscFehler) as ctx:
            disc.pruefe_spurtabelle(t, self.groessen)
        self.assertEqual(ctx.exception.code, "nicht_unterstuetzt")


class Extraktor(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fx = Fixture(self.root)
        self.out = self.root / "out"
        self.out.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_mixed_mode_iso_bytegleich_wav_dauer_und_pruefsumme(self):
        erg = disc.extrahiere(self.fx.tabelle(), {"test.bin": self.root / "test.bin"}, self.out)
        self.assertEqual((self.out / "daten/session1.iso").read_bytes(), self.fx.iso)
        wav = (self.out / "audio/spur02.wav").read_bytes()
        self.assertEqual(wav[:44], disc.wav_kopf(100 * 2352))
        self.assertEqual(hashlib.sha256(wav[44:]).hexdigest(), hashlib.sha256(self.fx.audio2).hexdigest())
        meta = {d["pfad"]: d for d in erg["dateien"]}
        self.assertEqual(meta["audio/spur03.wav"]["metadaten"]["asset_art"], "musik")
        self.assertAlmostEqual(meta["audio/spur03.wav"]["metadaten"]["sekunden"], 80 / 75, places=3)

    def test_pregap_regel(self):
        disc.extrahiere(self.fx.tabelle(), {"test.bin": self.root / "test.bin"}, self.out, {"wav_pregap": True})
        wav = (self.out / "audio/spur02.wav").read_bytes()
        self.assertEqual(len(wav) - 44, 250 * 2352)
        self.assertEqual(wav[44:44 + 150 * 2352], b"\x00" * (150 * 2352))

    def test_mode2_form1_2336_und_reine_2048_iso(self):
        roh = b"".join(raw_mode2_form1(self.fx.iso[i * 2048:(i + 1) * 2048], i)[16:] for i in range(self.fx.n1))
        (self.root / "m2.bin").write_bytes(roh)
        (self.root / "plain.iso").write_bytes(self.fx.iso)
        for name, mode, groesse in (("m2.bin", "MODE2_FORM1", 2336), ("plain.iso", "MODE1", 2048)):
            out = self.root / ("o-" + name)
            out.mkdir()
            t = tabelle([spur(1, 1, mode, 0, self.fx.n1, name, 0, groesse)])
            disc.pruefe_spurtabelle(t, {name: (self.root / name).stat().st_size})
            disc.extrahiere(t, {name: self.root / name}, out)
            self.assertEqual((out / "daten/session1.iso").read_bytes(), self.fx.iso, name)

    def test_mode2_mixed_schreibt_rohspur_mit_hinweis(self):
        sektoren = [raw_mode2_form1(self.fx.iso[i * 2048:(i + 1) * 2048], i, form2=(i == 20)) for i in range(self.fx.n1)]
        (self.root / "mix.bin").write_bytes(b"".join(sektoren))
        t = tabelle([spur(1, 1, "MODE2_MIXED", 0, self.fx.n1, "mix.bin", 0, 2352)])
        erg = disc.extrahiere(t, {"mix.bin": self.root / "mix.bin"}, self.out)
        self.assertEqual((self.out / "rohspuren/spur01.raw").stat().st_size, self.fx.n1 * 2336)
        self.assertIn("form2_im_iso", [h["code"] for h in erg["hinweise"]])

    def test_multisession_je_session_ein_abbild_mit_verweis(self):
        start2 = self.fx.n1 + 11400
        iso2 = self.fx.iso
        if shutil.which("xorriso"):
            # echte Multisession-Session 2 mit absoluten LBAs ab start2
            quelle = self.root / "s2"
            quelle.mkdir()
            (quelle / "ZWEI.TXT").write_text("zweite Session\n")
            ziel = self.root / "s2.iso"
            subprocess.run(["xorriso", "-as", "mkisofs", "-quiet", "-C", f"0,{start2}", "-o", str(ziel), str(quelle)],
                           check=True, capture_output=True)
            iso2 = ziel.read_bytes()
        n2 = len(iso2) // 2048
        (self.root / "s2.bin").write_bytes(b"".join(raw_mode1(iso2[i * 2048:(i + 1) * 2048], start2 + i) for i in range(n2)))
        t = tabelle([spur(1, 1, "MODE1", 0, self.fx.n1, "test.bin", 0, 2352)],
                    [spur(2, 2, "MODE1", start2, n2, "s2.bin", 0, 2352)])
        erg = disc.extrahiere(t, {"test.bin": self.root / "test.bin", "s2.bin": self.root / "s2.bin"}, self.out)
        meta = {d["pfad"]: d["metadaten"] for d in erg["dateien"]}
        self.assertEqual((self.out / "daten/session1.iso").read_bytes(), self.fx.iso)
        self.assertEqual(meta["daten/session2.iso"]["start_lba"], start2)
        self.assertTrue(meta["daten/session2.iso"]["vd_kopiert"])
        self.assertEqual((self.out / "daten/session2.iso").stat().st_size, (start2 + n2) * 2048)

    def test_abgeschnittenes_image_ist_beschaedigt(self):
        (self.root / "kurz.bin").write_bytes((self.root / "test.bin").read_bytes()[:100 * 2352])
        t = tabelle([spur(1, 1, "MODE1", 0, self.fx.n1, "kurz.bin", 0, 2352)])
        with self.assertRaises(disc.DiscFehler) as ctx:
            disc.extrahiere(t, {"kurz.bin": self.root / "kurz.bin"}, self.out)
        self.assertEqual(ctx.exception.code, "beschaedigt")


class Registry(unittest.TestCase):

    def test_erkennung_und_nachzug_bei_neuem_parser(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "x.ccd").write_text("[CloneCD]\nVersion=3\n")
            (root / "x.img").write_bytes(SYNC + b"\x00" * 2340)
            (root / "z.bin").write_bytes(b"\x01\x02" * 4000)
            medium = [("x.img", root / "x.img"), ("x.ccd", root / "x.ccd")]
            with patch.object(disc, "REGISTRY", [p for p in disc.REGISTRY if p.id != "eigen-clonecd"]):
                e = disc.erkenne(medium)
                self.assertEqual((e.format, e.steuer), ("clonecd", "x.ccd"))
                self.assertIsNone(e.parser)  # libmirage braucht .sub -> format_nicht_unterstuetzt
                neu = disc.ImageParser(id="test-ccd", formate=("clonecd",), kann=lambda f, n: True,
                                       verfuegbar=lambda: True, spurtabelle=lambda *a: {}, version=lambda: "1")
                disc.REGISTRY.insert(0, neu)
                self.assertEqual(disc.erkenne(medium).parser, "test-ccd")  # Nachzug: jetzt mit Parser
            self.assertIsNone(disc.erkenne([("z.bin", root / "z.bin")]))

    def test_runner_meldet_unbekanntes_disc_format_ohne_parser(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bib, work = root / "bib", root / "arbeit"
            (bib / "a").mkdir(parents=True)
            (bib / "a" / "x").write_bytes(b"ECM\x00" + b"\x00" * 100)
            with patch.object(runner, "BIB", bib), patch.object(runner, "WORK", work):
                ev = runner.run_request({"kommando": "extrahieren", "eingabe": f"{bib}/a/x", "eingabe_name": "spiel.ecm",
                                         "ausgabe": "/arbeit/job1"})[-1]
            self.assertEqual((ev["fehlercode"], ev["format_detail"]), ("format_nicht_unterstuetzt", "ecm"))


def ccd_text(eintraege, tracks, sessions=1):
    """eintraege: (session, point, control, plba|None); tracks: (nummer, mode, index0|None, index1)."""
    zeilen = ["[CloneCD]", "Version=3", "[Disc]", f"TocEntries={len(eintraege)}", f"Sessions={sessions}",
              "DataTracksScrambled=0", "CDTextLength=0"]
    for i, (session, point, control, plba) in enumerate(eintraege):
        if point in (0xA0, 0xA1):
            pmin, psec, pframe = plba, 0, 0
            plba = (pmin * 60 + psec) * 75 + pframe - 150
        else:
            pmin, psec, pframe = msf(plba)
        zeilen += [f"[Entry {i}]", f"Session={session}", f"Point=0x{point:02x}", "ADR=0x01", f"Control=0x{control:02x}",
                   "TrackNo=0", "AMin=0", "ASec=0", "AFrame=0", "ALBA=-150", "Zero=0", f"PMin={pmin}", f"PSec={psec}",
                   f"PFrame={pframe}", f"PLBA={plba}"]
    for nummer, mode, index0, index1 in tracks:
        zeilen += [f"[TRACK {nummer}]", f"MODE={mode}"] + ([f"INDEX 0={index0}"] if index0 is not None else []) + [
            f"INDEX 1={index1}"]
    return "\r\n".join(zeilen) + "\r\n"


def clonecd_medium(root, fx, name="Spiel", sub=False, lead_out=None, ohne_a2=False):
    """Mixed-Mode-CloneCD aus der Fixture: Spur 1 MODE1, Spuren 2/3 Audio mit INDEX 0 (Pregap im IMG)."""
    shutil.copy(root / "test.bin", root / f"{name}.img")
    if sub:
        shutil.copy(root / "test.sub", root / f"{name}.sub")
    eintraege = [(1, 0xA0, 4, 1), (1, 0xA1, 0, 3)]
    if not ohne_a2:
        eintraege.append((1, 0xA2, 0, lead_out if lead_out is not None else fx.lead_out))
    eintraege += [(1, 1, 4, 0), (1, 2, 0, fx.t2[1]), (1, 3, 0, fx.t3[1])]
    tracks = [(1, 1, None, 0), (2, 0, fx.t2[0], fx.t2[1]), (3, 0, fx.t3[0], fx.t3[1])]
    (root / f"{name}.ccd").write_text(ccd_text(eintraege, tracks), newline="")
    namen = [f"{name}.ccd", f"{name}.img"] + ([f"{name}.sub"] if sub else [])
    return [(n, root / n) for n in namen]


class CloneCD(unittest.TestCase):
    """P18-T46/RV32: eigener CloneCD-Parser auf dem Spurtabellen-Modell."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fx = Fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def lauf(self, medium, kommando="extrahieren"):
        out = self.root / ("out-" + medium[0][0])
        out.mkdir()
        e = disc.erkenne(medium)
        self.assertEqual((e.format, e.parser), ("clonecd", "eigen-clonecd"))
        auftrag = self.root / "auftrag.json"
        ergebnis = self.root / "ergebnis.json"
        auftrag.write_text(json.dumps({"kommando": kommando, "parser": e.parser, "format": e.format, "steuer": e.steuer,
                                       "dateien": [{"name": n, "pfad": str(p)} for n, p in medium],
                                       "ausgabe": str(out), "ergebnis": str(ergebnis)}))
        disc.main(["disc.py", str(auftrag)])
        return json.loads(ergebnis.read_text()), out

    def test_mixed_mode_ohne_sub(self):
        erg, out = self.lauf(clonecd_medium(self.root, self.fx))
        self.assertEqual(erg["status"], "fertig", erg)
        spuren = erg["spurtabelle"]["sessions"][0]["spuren"]
        self.assertEqual([(s["nummer"], s["art"], s["mode"], s["start_lba"], s["laenge_sektoren"], s["pregap"])
                          for s in spuren],
                         [(1, "daten", "MODE1", 0, self.fx.n1, 150), (2, "audio", "AUDIO", self.fx.t2[1], 100, 150),
                          (3, "audio", "AUDIO", self.fx.t3[1], 80, 150)])
        self.assertTrue(all(s["subchannel"] is None for s in spuren))
        self.assertEqual(erg["spurtabelle"]["parser"]["id"], "eigen-clonecd")
        self.assertEqual((out / "daten/session1.iso").read_bytes(), self.fx.iso)
        self.assertEqual((out / "audio/spur02.wav").read_bytes()[44:], self.fx.audio2)
        self.assertEqual((out / "audio/spur03.wav").read_bytes()[44:], self.fx.audio3)

    def test_mit_sub_als_subchannel_quelle(self):
        erg, _ = self.lauf(clonecd_medium(self.root, self.fx, sub=True))
        s2 = erg["spurtabelle"]["sessions"][0]["spuren"][1]
        self.assertEqual(s2["subchannel"], {"art": "getrennt", "groesse": 96, "datei": "Spiel.sub",
                                            "byte_offset": self.fx.t2[0] * 96})

    def test_mode2_variante(self):
        sektoren = b"".join(raw_mode2_form1(self.fx.iso[i * 2048:(i + 1) * 2048], i) for i in range(self.fx.n1))
        (self.root / "m2.img").write_bytes(sektoren)
        (self.root / "m2.ccd").write_text(ccd_text([(1, 0xA0, 4, 1), (1, 0xA1, 4, 1), (1, 0xA2, 4, self.fx.n1),
                                                     (1, 1, 4, 0)], [(1, 2, None, 0)]), newline="")
        erg, out = self.lauf([("m2.ccd", self.root / "m2.ccd"), ("m2.img", self.root / "m2.img")])
        self.assertEqual(erg["spurtabelle"]["sessions"][0]["spuren"][0]["mode"], "MODE2_MIXED")
        self.assertEqual((out / "daten/session1.iso").read_bytes(), self.fx.iso)
        self.assertTrue((out / "rohspuren/spur01.raw").exists())

    def test_spur_ausserhalb_der_datei_ist_beschaedigt(self):
        erg, out = self.lauf(clonecd_medium(self.root, self.fx, lead_out=self.fx.lead_out + 500))
        self.assertEqual((erg["status"], erg["fehlercode"]), ("fehler", "beschaedigt"))

    def test_lead_out_aus_dateigroesse(self):
        erg, _ = self.lauf(clonecd_medium(self.root, self.fx, ohne_a2=True), kommando="spurtabelle")
        self.assertEqual(erg["spurtabelle"]["lead_out_lba"], self.fx.lead_out)
        self.assertIn("leadout_aus_dateigroesse", [h["code"] for h in erg["spurtabelle"]["hinweise"]])

    def test_multisession_ohne_gespeicherte_luecke(self):
        n1 = self.fx.n1
        lo1, s2 = 100, 100 + 11400
        img = bytearray(sinus(100, 330))
        for i in range(n1):
            img += raw_mode1(self.fx.iso[i * 2048:(i + 1) * 2048], s2 + i)
        (self.root / "ms.img").write_bytes(img)
        (self.root / "ms.ccd").write_text(ccd_text(
            [(1, 0xA0, 0, 1), (1, 0xA1, 0, 1), (1, 0xA2, 0, lo1), (1, 1, 0, 0),
             (2, 0xA0, 4, 2), (2, 0xA1, 4, 2), (2, 0xA2, 4, s2 + n1), (2, 2, 4, s2)],
            [(1, 0, None, 0), (2, 1, None, s2)], sessions=2), newline="")
        erg, out = self.lauf([("ms.ccd", self.root / "ms.ccd"), ("ms.img", self.root / "ms.img")])
        s = erg["spurtabelle"]["sessions"]
        self.assertEqual([x["nummer"] for x in s], [1, 2])
        self.assertEqual(s[1]["spuren"][0]["byte_offset"], 100 * 2352)  # Luecke nicht im IMG (wie libmirage)
        self.assertEqual((out / "audio/spur01.wav").stat().st_size, 44 + 100 * 2352)
        self.assertTrue((out / "daten/session2.iso").exists())

    def test_runner_ende_zu_ende_mit_originalnamen(self):
        medium = clonecd_medium(self.root, self.fx, name="Die_Spiel_CD1")
        bib, work = self.root / "bib", self.root / "arbeit"
        for i, (name, pfad) in enumerate(medium):
            (bib / f"sha{i}").mkdir(parents=True)
            shutil.copy(pfad, bib / f"sha{i}" / "daten")
        req = {"kommando": "extrahieren", "eingabe": f"{bib}/sha1/daten", "eingabe_name": medium[1][0],
               "begleitdateien": [{"pfad": f"{bib}/sha0/daten", "name": medium[0][0]}],
               "ausgabe": "/arbeit/job-ccd", "grenzen": {"zeitlimit_s": 60}}
        with patch.object(runner, "BIB", bib), patch.object(runner, "WORK", work):
            ev = runner.run_request(req)[-1]
        self.assertIn(ev["status"], ("fertig", "teilweise"), ev)  # teilweise nur ohne 7-Zip (ISO nicht entpackt)
        pfade = {m["pfad"]: m for m in ev["manifest"]}
        self.assertEqual(pfade["audio/spur02.wav"]["art"], "asset")
        self.assertEqual(pfade["audio/spur02.wav"]["metadaten"]["asset_art"], "musik")
        self.assertEqual(pfade["daten/session1.iso"]["sha256"], hashlib.sha256(self.fx.iso).hexdigest())
        self.assertEqual(ev["spurtabelle"]["parser"]["id"], "eigen-clonecd")


@unittest.skipUnless(disc.libmirage_verfuegbar(), "libmirage (Mirage-3.2) nicht verfuegbar")
class LibmirageAdapter(unittest.TestCase):

    def test_cue_liefert_erwartete_spurtabelle_und_extraktion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fx = Fixture(root)
            cue = fx.cue()
            namen = {str(root / "test.bin"): "test.bin", str(cue): "test.cue"}
            t = disc.libmirage_spurtabelle("cue", cue, namen)
            disc.pruefe_spurtabelle(t, {"test.bin": (root / "test.bin").stat().st_size, "test.cue": cue.stat().st_size})
            spuren = t["sessions"][0]["spuren"]
            self.assertEqual([(s["nummer"], s["mode"], s["start_lba"], s["laenge_sektoren"]) for s in spuren],
                             [(1, "MODE1", 0, fx.n1), (2, "AUDIO", fx.t2[1], 100), (3, "AUDIO", fx.t3[1], 80)])
            self.assertEqual(t["parser"]["id"], "libmirage")
            out = root / "out"
            out.mkdir()
            disc.extrahiere(t, {"test.bin": root / "test.bin", "test.cue": cue}, out)
            self.assertEqual((out / "daten/session1.iso").read_bytes(), fx.iso)
            self.assertEqual((out / "audio/spur02.wav").read_bytes()[44:], fx.audio2)

    def test_defektes_image_ist_beschaedigt_ohne_absturz(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fx = Fixture(root)
            cue = fx.cue()
            (root / "test.bin").write_bytes((root / "test.bin").read_bytes()[:50 * 2352])
            with self.assertRaises(disc.DiscFehler) as ctx:
                disc.libmirage_spurtabelle("cue", cue, {str(root / "test.bin"): "test.bin", str(cue): "test.cue"})
            self.assertEqual(ctx.exception.code, "beschaedigt")

    def test_clonecd_mit_sub_gegenprobe_zum_eigenen_parser(self):
        """P18-T46 Werkzeugwahl: libmirage (nur mit .sub) und der eigene Parser liefern dieselben Spuren und Daten."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fx = Fixture(root)
            medium = clonecd_medium(root, fx, sub=True)
            namen = {str(p): n for n, p in medium}
            pfade = dict(medium)
            self.assertTrue(disc.parser_nach_id("libmirage").kann("clonecd", list(pfade)))
            eigen = disc.parser_nach_id("eigen-clonecd").spurtabelle("clonecd", pfade["Spiel.ccd"], namen)
            mirage = disc.libmirage_spurtabelle("clonecd", pfade["Spiel.ccd"], namen)
            groessen = {n: p.stat().st_size for n, p in pfade.items()}
            disc.pruefe_spurtabelle(eigen, groessen)
            disc.pruefe_spurtabelle(mirage, groessen)

            def kern(t):
                return [(s["session"], s["nummer"], s["art"], s["mode"], s["start_lba"], s["laenge_sektoren"], s["datei"],
                         s["byte_offset"]) for s in disc.alle_spuren(t)]
            self.assertEqual(kern(mirage), kern(eigen))
            self.assertEqual(mirage["parser"]["id"], "libmirage")
            for name, t in (("eigen", eigen), ("mirage", mirage)):
                out = root / ("out-" + name)
                out.mkdir()
                disc.extrahiere(t, pfade, out)
                self.assertEqual((out / "daten/session1.iso").read_bytes(), fx.iso, name)
                self.assertEqual((out / "audio/spur02.wav").read_bytes()[44:], fx.audio2, name)
                self.assertEqual((out / "audio/spur03.wav").read_bytes()[44:], fx.audio3, name)

    def test_cue_multisession_zwei_sessions(self):
        """CUE mit REM SESSION: Session 1 Audio, Session 2 Daten ab LBA 100 + 11250 + 150 (Lead-out/Lead-in-Abstand)."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fx = Fixture(root)
            (root / "ms1.bin").write_bytes(fx.audio2)
            (root / "ms2.bin").write_bytes(b"".join(raw_mode1(fx.iso[i * 2048:(i + 1) * 2048], i) for i in range(fx.n1)))
            (root / "ms.cue").write_text('REM SESSION 01\nFILE "ms1.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'
                                         'REM SESSION 02\nFILE "ms2.bin" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n')
            pfade = {n: root / n for n in ("ms.cue", "ms1.bin", "ms2.bin")}
            e = disc.erkenne(list(pfade.items()))
            self.assertEqual((e.format, e.steuer, e.parser), ("cue", "ms.cue", "libmirage"))
            t = disc.libmirage_spurtabelle("cue", pfade["ms.cue"], {str(p): n for n, p in pfade.items()})
            disc.pruefe_spurtabelle(t, {n: p.stat().st_size for n, p in pfade.items()})
            self.assertEqual([s["nummer"] for s in t["sessions"]], [1, 2])
            s1, s2 = t["sessions"][0]["spuren"][0], t["sessions"][1]["spuren"][0]
            self.assertEqual((s1["art"], s1["start_lba"], s1["laenge_sektoren"]), ("audio", 0, 100))
            self.assertEqual((s2["art"], s2["mode"], s2["start_lba"], s2["laenge_sektoren"]), ("daten", "MODE1", 11500, fx.n1))
            out = root / "out"
            out.mkdir()
            erg = disc.extrahiere(t, pfade, out)
            meta = {d["pfad"]: d["metadaten"] for d in erg["dateien"]}
            self.assertEqual((out / "audio/spur01.wav").read_bytes()[44:], fx.audio2)
            self.assertEqual(meta["daten/session2.iso"]["start_lba"], 11500)
            self.assertNotIn("daten/session1.iso", meta)  # Session 1 hat keine Datenspur

    def test_raw2352_ohne_steuerdatei_eine_mode1_spur(self):
        """Raw-BIN ohne CUE/CCD: Registry erkennt raw2352 am Sync, libmirage liest eine MODE1-Spur, ISO bytegleich."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fx = Fixture(root)
            # libmirage 3.2.10 nimmt Raw-Images ohne Steuerdatei erst ab ca. 600 KB an (gemessen: 256 Sektoren nein,
            # 280 ja) -> ISO mit Nullsektoren auf 300 Sektoren auffuellen.
            n = max(fx.n1, 300)
            iso = fx.iso + b"\x00" * ((n - fx.n1) * 2048)
            roh = root / "roh.bin"
            roh.write_bytes(b"".join(raw_mode1(iso[i * 2048:(i + 1) * 2048], i) for i in range(n)))
            e = disc.erkenne([("roh.bin", roh)])
            self.assertEqual((e.format, e.parser), ("raw2352", "libmirage"))
            t = disc.libmirage_spurtabelle("raw2352", roh, {str(roh): "roh.bin"})
            disc.pruefe_spurtabelle(t, {"roh.bin": roh.stat().st_size})
            self.assertEqual([(s["mode"], s["start_lba"], s["laenge_sektoren"]) for s in disc.alle_spuren(t)],
                             [("MODE1", 0, n)])
            out = root / "out"
            out.mkdir()
            disc.extrahiere(t, {"roh.bin": roh}, out)
            self.assertEqual((out / "daten/session1.iso").read_bytes(), iso)


if __name__ == "__main__":
    unittest.main()
