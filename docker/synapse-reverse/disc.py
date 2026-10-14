#!/usr/bin/env python3
"""P18-T49/RV34: Disc-Images auf EIN gemeinsames Modell.

Jeder Image-Parser liefert NUR die Spurtabelle (versioniert, JSON). EIN gemeinsamer Extraktor macht daraus
Datenspuren -> ISO (je Session ein Abbild mit Verweis), Audiospuren -> WAV (16 bit Stereo 44,1 kHz LE) und
MODE2 Form2/formless -> Rohspur mit Hinweis. Neue Formate = neuer Parser in der Registry, kein Sonderweg.

Aufteilung:
  * erkenne(...)        billig im Runner-Prozess (Magic/Footer/Begleitdateien), laedt KEINE Parser-Bibliothek.
  * main(<auftrag.json>) eigener Prozess (Zeit-/RAM-/Dateigroessen-Grenzen setzt der Runner): Parser ausfuehren,
                        Spurtabelle pruefen, optional extrahieren, Ergebnis als JSON-Datei schreiben.
Die TS-Typen in packages/core/src/services/reverse-spurtabelle.ts spiegeln dieses Modell (SPURTABELLE_VERSION).
"""
from __future__ import annotations

import array
import json
import os
import re
import struct
import sys
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple

SPURTABELLE_VERSION = 1
# Aendert sich ein Parser oder kommt einer dazu, steigt die Registry-Version -> Nachzug (RV29) fuer
# Medien mit format_nicht_unterstuetzt bzw. aelterem Stand.
REGISTRY_VERSION = "2"  # 2: eigener CloneCD-Parser (P18-T46)
SYNC = b"\x00" + b"\xff" * 10 + b"\x00"
MODI = ("MODE0", "AUDIO", "MODE1", "MODE2_FORM1", "MODE2_FORM2", "MODE2_FORMLESS", "MODE2_MIXED")
ISO_MODI = ("MODE1", "MODE2_FORM1", "MODE2_MIXED")
ROH_MODI = ("MODE2_FORM2", "MODE2_FORMLESS", "MODE2_MIXED")
ERLAUBTE_GROESSEN = {
    "MODE0": (2048, 2336, 2352), "AUDIO": (2352,), "MODE1": (2048, 2352),
    "MODE2_FORM1": (2048, 2336, 2352), "MODE2_FORM2": (2324, 2336, 2352),
    "MODE2_FORMLESS": (2336, 2352), "MODE2_MIXED": (2336, 2352),
}
SUBCHANNEL_GROESSEN = (16, 96)
MAX_SPUREN = 99
MAX_ABSCHNITTE = 1000
MAX_SESSIONS = 99
LBA_MIN = -45150  # weiteste Lead-in-Adresse (-10:00:00)
LBA_MAX = 10_000_000
WAV_MAX_DATEN = 0xFFFFFFFF - 36
PUFFER_SEKTOREN = 256
# Gefilterte/komprimierte Container (libmirage liest sie ueber Filter-Streams); der dateibasierte
# Extraktor kann sie nicht direkt lesen -> format_nicht_unterstuetzt:<filter> (Nachzug, sobald ein Leser da ist).
FILTER_MAGIC = ((b"ECM\x00", "ecm"), (b"DAA", "daa"), (b"IsZ!", "isz"), (b"CISO", "cso"), (b"\x1f\x8b", "gzip"),
                (b"\xfd7zXZ\x00", "xz"), (b"RIFF", "sndfile"), (b"fLaC", "sndfile"), (b"OggS", "sndfile"),
                (b"FORM", "sndfile"), (b"ID3", "sndfile"))


class DiscFehler(ValueError):
    """Fachlicher Fehler mit deterministischem Code (beschaedigt | nicht_unterstuetzt | format_nicht_unterstuetzt |
    nicht_gefunden | zu_gross). detail: z. B. erkannter Formatname."""

    def __init__(self, code: str, meldung: str, detail: str | None = None) -> None:
        super().__init__(meldung)
        self.code = code
        self.detail = detail


# ---------------------------------------------------------------------------------------------------------------
# Erkennung + Registry (Plugin-Prinzip wie die Leser RV26)

class Erkennung(NamedTuple):
    format: str
    steuer: str            # Name der Steuerdatei (cue/ccd/mds/...) bzw. der Bilddatei bei Formaten ohne Steuerdatei
    parser: str | None     # registrierter, verfuegbarer Parser oder None (= format_nicht_unterstuetzt)


class ImageParser(NamedTuple):
    id: str
    formate: tuple[str, ...]
    # kann(format, namen) -> True, wenn der Parser dieses Medium (inkl. Begleitdateien) lesen kann
    kann: Callable[[str, list[str]], bool]
    verfuegbar: Callable[[], bool]
    # spurtabelle(format, steuer_pfad, namen_je_pfad) -> Spurtabelle (dict)
    spurtabelle: Callable[[str, Path, dict[str, str]], dict[str, Any]]
    version: Callable[[], str]


REGISTRY: list[ImageParser] = []


def registriere(parser: ImageParser, vorne: bool = False) -> None:
    """Parser anmelden; vorne=True hat Vorrang vor bereits registrierten (eigene Parser vor libmirage)."""
    if any(p.id == parser.id for p in REGISTRY):
        raise ValueError("Parser bereits registriert: " + parser.id)
    if vorne:
        REGISTRY.insert(0, parser)
    else:
        REGISTRY.append(parser)


def parser_nach_id(parser_id: str) -> ImageParser:
    for parser in REGISTRY:
        if parser.id == parser_id:
            return parser
    raise DiscFehler("nicht_unterstuetzt", "Parser nicht registriert: " + parser_id)


def _kopf(path: Path, n: int = 65536) -> bytes:
    with path.open("rb") as stream:
        return stream.read(n)


def _fuss(path: Path, n: int = 16) -> bytes:
    with path.open("rb") as stream:
        size = stream.seek(0, os.SEEK_END)
        stream.seek(max(0, size - n))
        return stream.read(n)


def _text(head: bytes) -> bool:
    return b"\x00" not in head[:65536]


CUE_ZEILE = re.compile(rb'(?im)^[ \t]*FILE[ \t]+\S.*[ \t](?:BINARY|MOTOROLA|WAVE|AIFF|MP3)[ \t]*\r?$')
TOC_ZEILE = re.compile(rb'(?im)^[ \t]*(?:CD_DA|CD_ROM|CD_ROM_XA|CD_I)[ \t]*\r?$|^[ \t]*TRACK[ \t]+(?:AUDIO|MODE[012])')
TOC_DATEI = re.compile(rb'(?im)^[ \t]*(?:FILE|DATAFILE|AUDIOFILE)[ \t]+"')


def _steuer_format(name: str, head: bytes, fuss: bytes) -> str:
    """Steuer-/Containerformat einer einzelnen Datei am Inhalt (Endung nur zur Unterscheidung MDS/MDX)."""
    if head[:9].lower() == b"[clonecd]":
        return "clonecd"
    if head[:16] == b"MEDIA DESCRIPTOR":
        return "mdx" if name.lower().endswith(".mdx") else "mds"
    if head[:16] == b"BWT5 STREAM SIGN":
        return "b6t"
    if head.startswith(b"Adaptec CeQuadrat VirtualCD File"):
        return "c2d"
    if head[:4] == b"RIFF" and head[8:12] == b"imag":
        return "cif"
    if _text(head) and CUE_ZEILE.search(head):
        return "cue"
    if _text(head) and TOC_ZEILE.search(head) and TOC_DATEI.search(head):
        return "toc"
    if len(fuss) >= 12 and (fuss[-12:-8] == b"NER5" or fuss[-8:-4] == b"NERO"):
        return "nrg"
    if len(fuss) >= 8 and struct.unpack("<I", fuss[-8:-4])[0] in (0x80000004, 0x80000005, 0x80000006):
        return "cdi"
    return ""


def erkenne(dateien: list[tuple[str, Path]]) -> Erkennung | None:
    """Disc-Image-Format eines Mediums (Hauptdatei zuerst, dann Begleitdateien). None = kein Disc-Image dieser
    Registry (der Runner nimmt dann den bisherigen Weg, z. B. ISO/UDF direkt oder Archive)."""
    gefunden: tuple[str, str] | None = None
    for name, path in dateien:
        try:
            head, fuss = _kopf(path), _fuss(path)
        except OSError:
            continue
        fmt = _steuer_format(name, head, fuss)
        if fmt:
            gefunden = (fmt, name)
            break
    if gefunden is None and dateien:
        name, path = dateien[0]
        try:
            head = _kopf(path, 16)
        except OSError:
            return None
        for magic, fmt in FILTER_MAGIC[:4]:
            if head.startswith(magic):
                gefunden = (fmt, name)
                break
        if gefunden is None and head[:12] == SYNC:
            gefunden = ("raw2352", name)
    if gefunden is None:
        return None
    fmt, steuer = gefunden
    namen = [name for name, _ in dateien]
    for parser in REGISTRY:
        if fmt in parser.formate and parser.verfuegbar() and parser.kann(fmt, namen):
            return Erkennung(fmt, steuer, parser.id)
    return Erkennung(fmt, steuer, None)


# ---------------------------------------------------------------------------------------------------------------
# Spurtabelle: Hilfen + Pruefung (Punkt 4)

def schritt(abschnitt: dict[str, Any]) -> int:
    """Bytes je Sektor in der Datei: Hauptdaten + verschachtelter Subchannel."""
    sub = abschnitt.get("subchannel")
    extra = int(sub["groesse"]) if sub and sub.get("art") == "verschachtelt" else 0
    return int(abschnitt["sektorgroesse"]) + extra


def spur_ende(spur: dict[str, Any]) -> int:
    return int(spur["start_lba"]) + int(spur["laenge_sektoren"])


def alle_spuren(tabelle: dict[str, Any]) -> list[dict[str, Any]]:
    return [spur for session in tabelle["sessions"] for spur in session["spuren"]]


def _ganz(wert: Any, feld: str, lo: int, hi: int) -> int:
    if isinstance(wert, bool) or not isinstance(wert, int) or not lo <= wert <= hi:
        raise DiscFehler("beschaedigt", f"Spurtabelle: {feld} ungueltig ({wert!r})")
    return wert


def pruefe_spurtabelle(tabelle: dict[str, Any], dateigroessen: dict[str, int]) -> None:
    """Validierung gegen Dateigroessen, Ueberlappung und Sektorgroessen. Wirft DiscFehler('beschaedigt'|...)."""
    if not isinstance(tabelle, dict) or tabelle.get("version") != SPURTABELLE_VERSION:
        raise DiscFehler("beschaedigt", "Spurtabelle: unbekannte Version")
    sessions = tabelle.get("sessions")
    if not isinstance(sessions, list) or not 1 <= len(sessions) <= MAX_SESSIONS:
        raise DiscFehler("beschaedigt", "Spurtabelle: keine oder zu viele Sessions")
    nummern: set[int] = set()
    vorher_ende: int | None = None
    vorher_session = 0
    for session in sessions:
        sn = _ganz(session.get("nummer"), "session.nummer", 1, MAX_SESSIONS)
        if sn <= vorher_session:
            raise DiscFehler("beschaedigt", "Spurtabelle: Sessions nicht aufsteigend")
        vorher_session = sn
        spuren = session.get("spuren")
        if not isinstance(spuren, list) or not spuren:
            raise DiscFehler("beschaedigt", f"Spurtabelle: Session {sn} ohne Spuren")
        for spur in spuren:
            nr = _ganz(spur.get("nummer"), "spur.nummer", 1, MAX_SPUREN)
            if nr in nummern:
                raise DiscFehler("beschaedigt", f"Spurtabelle: Spur {nr} doppelt")
            nummern.add(nr)
            if spur.get("session") != sn:
                raise DiscFehler("beschaedigt", f"Spur {nr}: falsche Session")
            mode = spur.get("mode")
            if mode not in MODI:
                raise DiscFehler("nicht_unterstuetzt", f"Spur {nr}: Modus {mode!r} unbekannt")
            if spur.get("art") != ("audio" if mode == "AUDIO" else "daten"):
                raise DiscFehler("beschaedigt", f"Spur {nr}: Art passt nicht zum Modus {mode}")
            if spur.get("sektorgroesse") not in ERLAUBTE_GROESSEN[mode]:
                raise DiscFehler("nicht_unterstuetzt", f"Spur {nr}: Sektorgroesse {spur.get('sektorgroesse')} fuer {mode}")
            start = _ganz(spur.get("start_lba"), "start_lba", LBA_MIN, LBA_MAX)
            laenge = _ganz(spur.get("laenge_sektoren"), "laenge_sektoren", 1, LBA_MAX)
            pregap = _ganz(spur.get("pregap", 0), "pregap", 0, LBA_MAX)
            _ganz(spur.get("postgap", 0), "postgap", 0, LBA_MAX)
            anfang = start - pregap
            if vorher_ende is not None and anfang < vorher_ende:
                raise DiscFehler("beschaedigt", f"Spur {nr} ueberlappt die vorherige Spur")
            vorher_ende = start + laenge
            abschnitte = spur.get("abschnitte")
            if not isinstance(abschnitte, list) or not 1 <= len(abschnitte) <= MAX_ABSCHNITTE:
                raise DiscFehler("beschaedigt", f"Spur {nr}: Abschnitte fehlen")
            cursor = anfang
            for ab in abschnitte:
                lba = _ganz(ab.get("lba"), "abschnitt.lba", LBA_MIN, LBA_MAX)
                n = _ganz(ab.get("sektoren"), "abschnitt.sektoren", 1, LBA_MAX)
                if lba != cursor:
                    raise DiscFehler("beschaedigt", f"Spur {nr}: Abschnitte nicht lueckenlos")
                cursor = lba + n
                groesse = ab.get("sektorgroesse")
                datei = ab.get("datei")
                if datei is None:
                    continue
                if groesse != spur["sektorgroesse"]:
                    raise DiscFehler("nicht_unterstuetzt", f"Spur {nr}: wechselnde Sektorgroesse")
                if datei not in dateigroessen:
                    raise DiscFehler("nicht_gefunden", f"Spur {nr}: Bilddatei {datei!r} fehlt im Medium")
                offset = _ganz(ab.get("byte_offset"), "byte_offset", 0, 1 << 62)
                sub = ab.get("subchannel")
                if sub is not None:
                    if sub.get("art") not in ("getrennt", "verschachtelt") or sub.get("groesse") not in SUBCHANNEL_GROESSEN:
                        raise DiscFehler("nicht_unterstuetzt", f"Spur {nr}: Subchannel-Format")
                    if sub["art"] == "getrennt":
                        sub_datei = sub.get("datei")
                        if sub_datei not in dateigroessen:
                            raise DiscFehler("nicht_gefunden", f"Spur {nr}: Subchannel-Datei {sub_datei!r} fehlt")
                        sub_off = _ganz(sub.get("byte_offset"), "subchannel.byte_offset", 0, 1 << 62)
                        if sub_off + n * int(sub["groesse"]) > dateigroessen[sub_datei]:
                            raise DiscFehler("beschaedigt", f"Spur {nr}: Subchannel ausserhalb der Datei {sub_datei}")
                if offset + n * schritt(ab) > dateigroessen[datei]:
                    raise DiscFehler("beschaedigt", f"Spur {nr} liegt ausserhalb der Datei {datei}")
            if cursor != start + laenge:
                raise DiscFehler("beschaedigt", f"Spur {nr}: Abschnitte decken die Spur nicht ab")
        lead = session.get("lead_out_lba")
        if lead is not None and _ganz(lead, "session.lead_out_lba", LBA_MIN, LBA_MAX) < (vorher_ende or 0):
            raise DiscFehler("beschaedigt", f"Session {sn}: Lead-out vor dem Spurende")
    lead_out = tabelle.get("lead_out_lba")
    if lead_out is not None and _ganz(lead_out, "lead_out_lba", LBA_MIN, LBA_MAX) < (vorher_ende or 0):
        raise DiscFehler("beschaedigt", "Lead-out liegt vor dem Ende der letzten Spur")


def fasse_spur(spur: dict[str, Any]) -> dict[str, Any]:
    """Abgeleitete Felder einer Spur (datei/byte_offset/pregap_in_datei/subchannel) aus den Abschnitten setzen."""
    start = int(spur["start_lba"])
    spur["datei"] = None
    spur["byte_offset"] = None
    spur["subchannel"] = None
    for ab in spur["abschnitte"]:
        if ab["datei"] is None:
            continue
        if spur["subchannel"] is None and ab.get("subchannel"):
            spur["subchannel"] = dict(ab["subchannel"])
        if ab["lba"] <= start < ab["lba"] + ab["sektoren"]:
            spur["datei"] = ab["datei"]
            spur["byte_offset"] = int(ab["byte_offset"]) + (start - int(ab["lba"])) * schritt(ab)
        if spur["datei"] is None and spur["byte_offset"] is None and ab["lba"] >= start:
            spur["datei"] = ab["datei"]
    pregap = int(spur.get("pregap") or 0)
    in_datei = 0
    for ab in spur["abschnitte"]:
        if ab["datei"] is None:
            continue
        lo, hi = max(ab["lba"], start - pregap), min(ab["lba"] + ab["sektoren"], start)
        in_datei += max(0, hi - lo)
    spur["pregap_in_datei"] = pregap > 0 and in_datei == pregap
    return spur


# ---------------------------------------------------------------------------------------------------------------
# Gemeinsamer Extraktor (Punkt 2)

class _Dateien:
    def __init__(self, pfade: dict[str, Path]) -> None:
        self.pfade = pfade
        self.offen: dict[str, Any] = {}

    def __call__(self, name: str):
        if name not in self.offen:
            self.offen[name] = self.pfade[name].open("rb")
        return self.offen[name]

    def schliessen(self) -> None:
        for stream in self.offen.values():
            stream.close()


def sektoren(spur: dict[str, Any], von: int, bis: int, dateien: _Dateien) -> Iterator[tuple[int, bytes | None]]:
    """Rohsektoren (Hauptdaten wie gespeichert) im LBA-Bereich [von, bis); None = Sektor nicht im Image (Nullabschnitt)."""
    for ab in spur["abschnitte"]:
        a0, a1 = max(von, ab["lba"]), min(bis, ab["lba"] + ab["sektoren"])
        if a0 >= a1:
            continue
        if ab["datei"] is None:
            for lba in range(a0, a1):
                yield lba, None
            continue
        groesse, stride = int(ab["sektorgroesse"]), schritt(ab)
        stream = dateien(ab["datei"])
        pos = int(ab["byte_offset"]) + (a0 - int(ab["lba"])) * stride
        lba = a0
        while lba < a1:
            n = min(PUFFER_SEKTOREN, a1 - lba)
            stream.seek(pos)
            block = stream.read(n * stride)
            if len(block) < n * stride:
                raise DiscFehler("beschaedigt", f"Spur {spur['nummer']}: Image endet vor LBA {lba + len(block) // stride}")
            for i in range(n):
                yield lba + i, block[i * stride:i * stride + groesse]
            lba += n
            pos += n * stride


def nutzdaten(raw: bytes | None, groesse: int, mode: str, zaehler: dict[str, int]) -> tuple[bytes | None, bytes]:
    """(2048-Byte-ISO-Daten oder None, Rohdaten ohne Sync/Header) eines Datensektors."""
    if raw is None:
        return b"\x00" * 2048, b"\x00" * (2336 if groesse >= 2336 else groesse)
    if groesse == 2048:
        return raw, raw
    if groesse == 2324:
        return None, raw
    basis = 16 if groesse == 2352 else 0          # 2336 = MODE2 ohne Sync+Header
    if groesse == 2352 and raw[:12] != SYNC:
        zaehler["ohne_sync"] = zaehler.get("ohne_sync", 0) + 1
    roh = raw[basis:]
    if mode == "MODE1":
        return raw[16:2064], roh
    if mode == "MODE0":
        return b"\x00" * 2048, roh
    if mode == "MODE2_FORM1":
        return raw[basis + 8:basis + 2056], roh
    if mode == "MODE2_FORM2":
        return None, raw[basis + 8:basis + 2332]
    if mode == "MODE2_MIXED":
        if raw[basis + 2] & 0x20:  # Subheader-Submode Bit 5 = Form 2: im ISO gekuerzt, vollstaendig in der Rohspur
            zaehler["form2_im_iso"] = zaehler.get("form2_im_iso", 0) + 1
        return raw[basis + 8:basis + 2056], roh
    return None, roh                                # MODE2_FORMLESS


def wav_kopf(datenbytes: int) -> bytes:
    return (b"RIFF" + struct.pack("<I", 36 + datenbytes) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 2, 44100, 44100 * 4, 4, 16) + b"data" + struct.pack("<I", datenbytes))


def _iso_session(tabelle: dict[str, Any], session: int, ziel: Path, dateien: _Dateien,
                 zaehler: dict[str, int]) -> dict[str, Any] | None:
    """Abbild aller ISO-faehigen Datenspuren bis einschliesslich dieser Session an ihren absoluten LBAs.
    Beginnt die Datenspur der Session nicht bei LBA 0 (Multisession), werden ihre Volume-Deskriptoren nach
    Sektor 16 kopiert (Sicht der Session, wie mount -o session=N); der Verweis steht in den Metadaten."""
    spuren = [s for s in alle_spuren(tabelle) if s["art"] == "daten" and s["mode"] in ISO_MODI and s["session"] <= session]
    eigene = [s for s in spuren if s["session"] == session]
    if not eigene:
        return None
    ende = max(spur_ende(s) for s in spuren)
    if ende <= 0:
        return None
    ziel.parent.mkdir(parents=True, exist_ok=True)
    with ziel.open("wb") as out:
        for spur in sorted(spuren, key=lambda s: s["start_lba"]):
            von = max(0, int(spur["start_lba"]))
            out.seek(von * 2048)
            for _lba, raw in sektoren(spur, von, spur_ende(spur), dateien):
                daten, _roh = nutzdaten(raw, int(spur["sektorgroesse"]), spur["mode"], zaehler)
                out.write(daten if daten is not None else b"\x00" * 2048)
        out.truncate(ende * 2048)
    start = min(int(s["start_lba"]) for s in eigene)
    kopiert = False
    if start > 0:
        with ziel.open("r+b") as datei:
            deskriptoren: list[bytes] = []
            for i in range(64):
                datei.seek((start + 16 + i) * 2048)
                sektor = datei.read(2048)
                if len(sektor) < 2048 or sektor[1:6] != b"CD001":
                    break
                deskriptoren.append(sektor)
                if sektor[0] == 0xFF:
                    break
            if deskriptoren:
                datei.seek(16 * 2048)
                datei.write(b"".join(deskriptoren))
                kopiert = True
    return {"rolle": "iso", "session": session, "spuren": [s["nummer"] for s in eigene], "start_lba": start,
            "vd_kopiert": kopiert, "verweis": f"Session {session} ab LBA {start}"}


def extrahiere(tabelle: dict[str, Any], pfade: dict[str, Path], ausgabe: Path,
               optionen: dict[str, Any] | None = None) -> dict[str, Any]:
    """Gemeinsamer Extraktor. Liefert {dateien:[{pfad, art, metadaten}], hinweise:[...]}; schreibt nur unter ausgabe."""
    optionen = optionen or {}
    mit_pregap = optionen.get("wav_pregap") is True
    dateien = _Dateien(pfade)
    zaehler: dict[str, int] = {}
    ergebnis: list[dict[str, Any]] = []
    hinweise: list[dict[str, Any]] = [dict(h) for h in tabelle.get("hinweise") or [] if isinstance(h, dict)]
    try:
        for session in tabelle["sessions"]:
            rel = f"daten/session{session['nummer']}.iso"
            meta = _iso_session(tabelle, int(session["nummer"]), ausgabe / rel, dateien, zaehler)
            if meta:
                ergebnis.append({"pfad": rel, "art": "archiv", "metadaten": meta})
        for spur in alle_spuren(tabelle):
            nr = int(spur["nummer"])
            if spur["art"] == "audio":
                von = int(spur["start_lba"]) - (int(spur.get("pregap") or 0) if mit_pregap else 0)
                n = (spur_ende(spur) - von) * 2352
                if n > WAV_MAX_DATEN:
                    raise DiscFehler("zu_gross", f"Spur {nr}: WAV groesser als 4 GiB")
                rel = f"audio/spur{nr:02d}.wav"
                ziel = ausgabe / rel
                ziel.parent.mkdir(parents=True, exist_ok=True)
                tausch = spur.get("audio_byte_reihenfolge") == "be"
                with ziel.open("wb") as out:
                    out.write(wav_kopf(n))
                    for _lba, raw in sektoren(spur, von, spur_ende(spur), dateien):
                        if raw is None:
                            out.write(b"\x00" * 2352)
                        elif tausch:
                            samples = array.array("h", raw)
                            samples.byteswap()
                            out.write(samples.tobytes())
                        else:
                            out.write(raw)
                ergebnis.append({"pfad": rel, "art": "asset", "metadaten": {
                    "rolle": "audio", "asset_art": "musik", "spur": nr, "session": spur["session"],
                    "sekunden": round((n // 2352) / 75, 3), "pregap_enthalten": mit_pregap,
                    "isrc": spur.get("isrc"), "titel": spur.get("titel")}})
            elif spur["mode"] in ROH_MODI:
                rel = f"rohspuren/spur{nr:02d}.raw"
                ziel = ausgabe / rel
                ziel.parent.mkdir(parents=True, exist_ok=True)
                with ziel.open("wb") as out:
                    for _lba, raw in sektoren(spur, int(spur["start_lba"]), spur_ende(spur), dateien):
                        _daten, roh = nutzdaten(raw, int(spur["sektorgroesse"]), spur["mode"], zaehler)
                        out.write(roh)
                ergebnis.append({"pfad": rel, "art": "binaer", "metadaten": {
                    "rolle": "rohspur", "spur": nr, "session": spur["session"], "mode": spur["mode"]}})
                hinweise.append({"code": "rohspur", "spur": nr,
                                 "meldung": f"Spur {nr} ({spur['mode']}): als Rohspur ohne Sync/Header abgelegt, "
                                            "Form-2-Inhalte werden nicht als Dateisystem ausgewertet"})
    finally:
        dateien.schliessen()
    for code, meldung in (("ohne_sync", "Sektoren ohne Sync-Muster (moeglicherweise verwuerfelt oder defekt)"),
                          ("form2_im_iso", "Form-2-Sektoren im ISO auf 2048 Bytes gekuerzt (vollstaendig in der Rohspur)")):
        if zaehler.get(code):
            hinweise.append({"code": code, "anzahl": zaehler[code], "meldung": meldung})
    return {"dateien": ergebnis, "hinweise": hinweise}


# ---------------------------------------------------------------------------------------------------------------
# Parser: libmirage-Adapter (Standard fuer alle Formate, die libmirage kann)

_MIRAGE: Any = None
_MIRAGE_FEHLER: str | None = None


def _mirage() -> Any:
    global _MIRAGE, _MIRAGE_FEHLER
    if _MIRAGE is None and _MIRAGE_FEHLER is None:
        try:
            import gi  # type: ignore[import-not-found]
            gi.require_version("Mirage", "3.2")
            from gi.repository import Mirage  # type: ignore[import-not-found]
            _MIRAGE = Mirage
        except (ImportError, ValueError) as exc:
            _MIRAGE_FEHLER = str(exc)
    return _MIRAGE


def libmirage_verfuegbar() -> bool:
    return _mirage() is not None


def libmirage_version() -> str:
    mirage = _mirage()
    return str(getattr(mirage, "VERSION_LONG", "unbekannt")) if mirage else "nicht_verfuegbar"


def _libmirage_kann(fmt: str, namen: list[str]) -> bool:
    if fmt == "clonecd":
        # libmirage 3.2 verlangt die .sub-Datei ('Could not find subchannel data file'); ohne SUB eigener Parser.
        return any(name.lower().endswith(".sub") for name in namen)
    return True


def _mirage_code(meldung: str) -> str:
    text = meldung.lower()
    if "no parser can handle" in text:
        return "nicht_unterstuetzt"
    if "could not find" in text or "failed to open" in text or "no such file" in text:
        return "nicht_gefunden"
    if "password" in text or "encrypt" in text:
        return "verschluesselt"
    return "beschaedigt"


def _enum_name(wert: Any) -> str:
    nick = getattr(wert, "value_nick", None)
    if nick:
        return str(nick)
    name = getattr(wert, "value_name", None) or str(wert)
    return name.rsplit("_", 1)[-1]


def _gefiltert(path: Path) -> str | None:
    try:
        head = _kopf(path, 8)
    except OSError:
        return None
    for magic, fmt in FILTER_MAGIC:
        if head.startswith(magic):
            return fmt
    return None


def libmirage_spurtabelle(fmt: str, steuer: Path, namen: dict[str, str]) -> dict[str, Any]:
    """Liest das Medium mit libmirage und uebersetzt Disc/Session/Track/Fragment in die Spurtabelle.
    namen: absoluter Pfad (im Medium-Ordner des Auftrags) -> Originalname."""
    mirage = _mirage()
    if mirage is None:
        raise DiscFehler("format_nicht_unterstuetzt", "libmirage nicht verfuegbar: " + str(_MIRAGE_FEHLER), fmt)
    from gi.repository import GLib  # type: ignore[import-not-found]
    mirage.initialize()
    context = mirage.Context()
    context.set_debug_mask(0)
    try:
        disc = context.load_image([str(steuer)])
    except GLib.Error as exc:
        raise DiscFehler(_mirage_code(exc.message or ""), "libmirage: " + str(exc.message), fmt) from None
    sektortyp = {mirage.SectorType.MODE0: "MODE0", mirage.SectorType.AUDIO: "AUDIO", mirage.SectorType.MODE1: "MODE1",
                 mirage.SectorType.MODE2: "MODE2_FORMLESS", mirage.SectorType.MODE2_FORM1: "MODE2_FORM1",
                 mirage.SectorType.MODE2_FORM2: "MODE2_FORM2", mirage.SectorType.MODE2_MIXED: "MODE2_MIXED"}
    sub_fmt = mirage.SubchannelDataFormat
    swap = mirage.MainDataFormat.AUDIO_SWAP

    def name_von(pfad: str | None) -> str | None:
        if not pfad:
            return None
        echt = os.path.abspath(pfad)
        if echt in namen:
            return namen[echt]
        raise DiscFehler("beschaedigt", "libmirage verweist auf eine Datei ausserhalb des Mediums", fmt)

    katalog = None
    sessions: list[dict[str, Any]] = []
    for si in range(disc.get_number_of_sessions()):
        session = disc.get_session_by_index(si)
        katalog = katalog or (session.get_mcn() or None)
        spuren: list[dict[str, Any]] = []
        for ti in range(session.get_number_of_tracks()):
            track = session.get_track_by_index(ti)
            mode = sektortyp.get(track.get_sector_type())
            if mode is None:
                raise DiscFehler("nicht_unterstuetzt", f"Spur {track.layout_get_track_number()}: Sektortyp unbekannt", fmt)
            anfang = int(track.layout_get_start_sector())
            pregap = int(track.get_track_start())
            start = anfang + pregap
            laenge = anfang + int(track.layout_get_length()) - start
            abschnitte: list[dict[str, Any]] = []
            reihenfolge = "le"
            groesse_spur = 0
            for fi in range(track.get_number_of_fragments()):
                frag = track.get_fragment_by_index(fi)
                datei = name_von(frag.main_data_get_filename()) if frag.main_data_get_size() else None
                groesse = int(frag.main_data_get_size()) or (2352 if mode == "AUDIO" else 2048)
                if datei is not None:
                    groesse_spur = groesse_spur or groesse
                    # Filter-Streams (ECM, DAA, WAV/FLAC ueber sndfile ...) beginnen bei Offset 0 mit eigener Magic.
                    gefiltert = _gefiltert(Path(frag.main_data_get_filename())) if not frag.main_data_get_offset() else None
                    if gefiltert:
                        raise DiscFehler("format_nicht_unterstuetzt",
                                         f"Spur {track.layout_get_track_number()}: gefilterte Daten ({gefiltert})", gefiltert)
                    if frag.main_data_get_format() & swap:
                        reihenfolge = "be"
                sub = None
                sf = int(frag.subchannel_data_get_format())
                if datei is not None and frag.subchannel_data_get_size():
                    if sf & int(sub_fmt.INTERNAL):
                        sub = {"art": "verschachtelt", "groesse": int(frag.subchannel_data_get_size()), "datei": None,
                               "byte_offset": None}
                    elif sf & int(sub_fmt.EXTERNAL):
                        sub = {"art": "getrennt", "groesse": int(frag.subchannel_data_get_size()),
                               "datei": name_von(frag.subchannel_data_get_filename()),
                               "byte_offset": int(frag.subchannel_data_get_offset())}
                abschnitte.append({"lba": anfang + int(frag.get_address()), "sektoren": int(frag.get_length()),
                                   "datei": datei, "byte_offset": int(frag.main_data_get_offset()) if datei else 0,
                                   "sektorgroesse": groesse, "subchannel": sub})
            for ab in abschnitte:
                if ab["datei"] is None:
                    ab["sektorgroesse"] = groesse_spur or ab["sektorgroesse"]
            indizes = ([{"nummer": 0, "lba": anfang}] if pregap else []) + [{"nummer": 1, "lba": start}]
            for nummer in range(2, 100):
                if len(indizes) >= int(track.get_number_of_indices()) + (2 if pregap else 1):
                    break
                try:
                    index = track.get_index_by_number(nummer)
                except GLib.Error:
                    break
                if index is None:
                    break
                indizes.append({"nummer": int(index.get_number()), "lba": start + int(index.get_address())})
            spur = {"nummer": int(track.layout_get_track_number()), "session": int(session.layout_get_session_number()),
                    "art": "audio" if mode == "AUDIO" else "daten", "mode": mode,
                    "sektorgroesse": groesse_spur or (2352 if mode == "AUDIO" else 2048),
                    "start_lba": start, "laenge_sektoren": laenge, "pregap": pregap, "postgap": 0,
                    "indizes": indizes, "isrc": track.get_isrc() or None, "titel": None,
                    "audio_byte_reihenfolge": reihenfolge if mode == "AUDIO" else None, "abschnitte": abschnitte}
            spuren.append(fasse_spur(spur))
        ende = max((spur_ende(s) for s in spuren), default=None)
        sessions.append({"nummer": int(session.layout_get_session_number()), "lead_out_lba": ende, "spuren": spuren})
    medium = _enum_name(disc.get_medium_type()).lower()
    return {"version": SPURTABELLE_VERSION, "medium": medium if medium in ("cd", "dvd", "bd", "hd") else "cd",
            "format": fmt, "katalognummer": katalog,
            "lead_out_lba": int(disc.layout_get_start_sector()) + int(disc.layout_get_length()),
            "layer_break": None,
            "parser": {"id": "libmirage", "version": libmirage_version(), "registry_version": REGISTRY_VERSION},
            "sessions": sessions}


registriere(ImageParser(
    id="libmirage",
    formate=("cue", "clonecd", "mds", "mdx", "b6t", "nrg", "cdi", "toc", "c2d", "cif", "raw2352"),
    kann=_libmirage_kann, verfuegbar=libmirage_verfuegbar, spurtabelle=libmirage_spurtabelle,
    version=libmirage_version))


# ---------------------------------------------------------------------------------------------------------------
# P18-T46/RV32: eigener CloneCD-Parser (CCD ist dokumentiertes INI). libmirage 3.2 verlangt die .sub-Datei; echte
# Images kommen oft ohne. Dieser Parser liefert NUR die Spurtabelle, ISO/WAV macht der gemeinsame Extraktor.

CLONECD_VERSION = "1"
CCD_MAX_BYTES = 1_048_576


def _ini(text: str) -> dict[str, dict[str, str]]:
    """Toleranter INI-Leser: Abschnitte/Schluessel klein, CRLF, ';'/'#'-Kommentare, doppelte Schluessel = letzter."""
    abschnitte: dict[str, dict[str, str]] = {}
    aktuell: dict[str, str] | None = None
    for zeile in text.splitlines():
        zeile = zeile.strip()
        if not zeile or zeile[0] in ";#":
            continue
        if zeile.startswith("[") and zeile.endswith("]"):
            aktuell = abschnitte.setdefault(" ".join(zeile[1:-1].lower().split()), {})
            continue
        if aktuell is not None and "=" in zeile:
            schluessel, _, wert = zeile.partition("=")
            aktuell[" ".join(schluessel.lower().split())] = wert.strip()
    return abschnitte


def _zahl(wert: str | None, feld: str) -> int | None:
    if wert is None or wert == "":
        return None
    try:
        return int(wert, 0)
    except ValueError:
        raise DiscFehler("beschaedigt", f"CCD: {feld}={wert!r} ist keine Zahl", "clonecd") from None


def _entry_lba(entry: dict[str, str], name: str) -> int | None:
    plba = _zahl(entry.get("plba"), name + ".PLBA")
    if plba is not None:
        return plba
    teile = [_zahl(entry.get(k), name + "." + k) for k in ("pmin", "psec", "pframe")]
    if any(t is None for t in teile):
        return None
    minuten, sekunden, frames = teile  # type: ignore[misc]
    return (minuten * 60 + sekunden) * 75 + frames - 150


def clonecd_spurtabelle(fmt: str, steuer: Path, namen: dict[str, str]) -> dict[str, Any]:
    """CCD (+ IMG, optional SUB) -> Spurtabelle. .img = alle lesbaren Sektoren ab LBA 0 als RAW 2352, Session-Luecken
    (Lead-out/Lead-in) sind nicht gespeichert; .sub = 96 Byte/Sektor in derselben Reihenfolge."""
    roh = steuer.read_bytes()
    if len(roh) > CCD_MAX_BYTES:
        raise DiscFehler("beschaedigt", "CCD-Datei zu gross", "clonecd")
    ini = _ini(roh.decode("latin-1"))
    if "clonecd" not in ini:
        raise DiscFehler("beschaedigt", "CCD ohne [CloneCD]-Abschnitt", "clonecd")
    disc_ini = ini.get("disc", {})
    if (_zahl(disc_ini.get("datatracksscrambled"), "DataTracksScrambled") or 0) != 0:
        raise DiscFehler("format_nicht_unterstuetzt", "CloneCD mit verwuerfelten Datenspuren", "clonecd_scrambled")
    steuer_name = namen.get(os.path.abspath(str(steuer)), steuer.name)
    stamm = Path(steuer_name).stem.lower()
    je_name = {name.lower(): (Path(pfad), name) for pfad, name in namen.items()}
    img = je_name.get(stamm + ".img")
    if img is None:
        kandidaten = [wert for schluessel, wert in je_name.items() if schluessel.endswith(".img")]
        if len(kandidaten) != 1:
            raise DiscFehler("nicht_gefunden", f"CloneCD: {stamm}.img fehlt im Medium", "clonecd")
        img = kandidaten[0]
    sub = je_name.get(Path(img[1]).stem.lower() + ".sub") or je_name.get(stamm + ".sub")
    img_bytes = img[0].stat().st_size
    img_sektoren = img_bytes // 2352
    hinweise: list[dict[str, Any]] = []
    if img_bytes % 2352:
        hinweise.append({"code": "img_rest", "meldung": f"{img_bytes % 2352} Bytes am Ende der IMG ergeben keinen ganzen Sektor"})
    if sub is not None and sub[0].stat().st_size != img_sektoren * 96:
        hinweise.append({"code": "sub_groesse", "meldung": "SUB-Groesse passt nicht zu IMG-Sektoren x 96"})

    # TOC-Eintraege: Point 1..99 = Spurbeginn (INDEX 01), A2 = Lead-out je Session.
    spur_toc: dict[int, tuple[int, int, int]] = {}   # nummer -> (session, control, lba)
    lead_out: dict[int, int] = {}
    katalog = disc_ini.get("catalog") or None
    for name, entry in ini.items():
        if not name.startswith("entry "):
            continue
        session = _zahl(entry.get("session"), name + ".Session") or 1
        point = _zahl(entry.get("point"), name + ".Point")
        adr = _zahl(entry.get("adr"), name + ".ADR")
        control = _zahl(entry.get("control"), name + ".Control") or 0
        if point is None or (adr is not None and adr != 1):
            continue
        lba = _entry_lba(entry, name)
        if 1 <= point <= 99 and lba is not None:
            spur_toc[point] = (session, control, lba)
        elif point == 0xA2 and lba is not None:
            lead_out[session] = lba
    if not spur_toc:
        raise DiscFehler("beschaedigt", "CCD ohne Spureintraege", "clonecd")

    spuren_roh: list[dict[str, Any]] = []
    for nummer in sorted(spur_toc):
        session, control, lba = spur_toc[nummer]
        track = ini.get(f"track {nummer}", {})
        modus = _zahl(track.get("mode"), f"TRACK {nummer}.MODE")
        daten = bool(control & 0x04)
        if modus is None:
            mode = "MODE1" if daten else "AUDIO"
        elif modus == 0:
            mode = "MODE0" if daten else "AUDIO"
        elif modus == 1:
            mode = "MODE1"
        elif modus == 2:
            mode = "MODE2_MIXED"   # Form 1/2 je Sektor am Subheader
        else:
            raise DiscFehler("nicht_unterstuetzt", f"CCD: Spur {nummer} MODE={modus}", "clonecd")
        index1 = _zahl(track.get("index 1"), f"TRACK {nummer}.INDEX 1")
        if index1 is not None and index1 != lba:
            hinweise.append({"code": "index_abweichung", "spur": nummer,
                             "meldung": f"[TRACK {nummer}] INDEX 1={index1}, TOC {lba}; TOC gilt"})
        index0 = _zahl(track.get("index 0"), f"TRACK {nummer}.INDEX 0")
        if index0 is not None and not index0 <= lba:
            raise DiscFehler("beschaedigt", f"CCD: Spur {nummer} INDEX 0 nach INDEX 1", "clonecd")
        spuren_roh.append({"nummer": nummer, "session": session, "mode": mode, "start": lba,
                           "index0": index0, "isrc": track.get("isrc") or None})

    sessions_nr = sorted({s["session"] for s in spuren_roh})
    # Abbildung LBA -> Sektor in der IMG: je Session um die nicht gespeicherte Luecke verschoben.
    verschiebung: dict[int, int] = {}
    ende_datei = 0
    for i, sn in enumerate(sessions_nr):
        eigene = [s for s in spuren_roh if s["session"] == sn]
        erster = min(s["index0"] if s["index0"] is not None else s["start"] for s in eigene)
        verschiebung[sn] = 0 if i == 0 else erster - ende_datei
        ende = lead_out.get(sn)
        if ende is None:
            if i != len(sessions_nr) - 1:
                raise DiscFehler("beschaedigt", f"CCD: Session {sn} ohne Lead-out (Point A2)", "clonecd")
            ende = img_sektoren + verschiebung[sn]  # Lead-out aus der Dateigroesse
            hinweise.append({"code": "leadout_aus_dateigroesse", "meldung": f"Lead-out LBA {ende} aus der IMG-Groesse"})
            lead_out[sn] = ende
        ende_datei = ende - verschiebung[sn]

    sessions: list[dict[str, Any]] = []
    for sn in sessions_nr:
        eigene = sorted((s for s in spuren_roh if s["session"] == sn), key=lambda s: s["start"])
        liste: list[dict[str, Any]] = []
        for j, s in enumerate(eigene):
            if j + 1 < len(eigene):
                naechste = eigene[j + 1]
                ende = naechste["index0"] if naechste["index0"] is not None else naechste["start"]
            else:
                ende = lead_out[sn]
            start = s["start"]
            abschnitte: list[dict[str, Any]] = []
            pregap = 0
            if s["index0"] is not None and s["index0"] < start:
                pregap = start - s["index0"]
                gespeichert_ab = s["index0"]
            elif start == 0 and sn == sessions_nr[0] and j == 0:
                # 2-Sekunden-Pregap der ersten Spur liegt nicht im Image (wie libmirage: Nullabschnitt ab -150).
                pregap = 150
                abschnitte.append({"lba": -150, "sektoren": 150, "datei": None, "byte_offset": 0,
                                   "sektorgroesse": 2352, "subchannel": None})
                gespeichert_ab = start
            else:
                gespeichert_ab = start
            if ende <= start:
                raise DiscFehler("beschaedigt", f"CCD: Spur {s['nummer']} ohne Sektoren", "clonecd")
            sektor = gespeichert_ab - verschiebung[sn]
            unter = None
            if sub is not None:
                unter = {"art": "getrennt", "groesse": 96, "datei": sub[1], "byte_offset": sektor * 96}
            abschnitte.append({"lba": gespeichert_ab, "sektoren": ende - gespeichert_ab, "datei": img[1],
                               "byte_offset": sektor * 2352, "sektorgroesse": 2352, "subchannel": unter})
            indizes = ([{"nummer": 0, "lba": start - pregap}] if pregap else []) + [{"nummer": 1, "lba": start}]
            liste.append(fasse_spur({
                "nummer": s["nummer"], "session": sn, "art": "audio" if s["mode"] == "AUDIO" else "daten",
                "mode": s["mode"], "sektorgroesse": 2352, "start_lba": start, "laenge_sektoren": ende - start,
                "pregap": pregap, "postgap": 0, "indizes": indizes, "isrc": s["isrc"], "titel": None,
                "audio_byte_reihenfolge": "le" if s["mode"] == "AUDIO" else None, "abschnitte": abschnitte}))
        sessions.append({"nummer": sn, "lead_out_lba": lead_out[sn], "spuren": liste})
    tabelle: dict[str, Any] = {
        "version": SPURTABELLE_VERSION, "medium": "cd", "format": "clonecd", "katalognummer": katalog,
        "lead_out_lba": lead_out[sessions_nr[-1]], "layer_break": None,
        "parser": {"id": "eigen-clonecd", "version": CLONECD_VERSION, "registry_version": REGISTRY_VERSION},
        "sessions": sessions}
    if hinweise:
        tabelle["hinweise"] = hinweise
    return tabelle


registriere(ImageParser(
    id="eigen-clonecd", formate=("clonecd",), kann=lambda fmt, namen: True, verfuegbar=lambda: True,
    spurtabelle=clonecd_spurtabelle, version=lambda: CLONECD_VERSION), vorne=True)


# ---------------------------------------------------------------------------------------------------------------
# Prozess-Einstieg (vom Runner isoliert gestartet)

def lauf(auftrag: dict[str, Any]) -> dict[str, Any]:
    parser = parser_nach_id(str(auftrag["parser"]))
    if not parser.verfuegbar():
        raise DiscFehler("format_nicht_unterstuetzt", f"Parser {parser.id} nicht verfuegbar", str(auftrag["format"]))
    pfade = {str(d["name"]): Path(str(d["pfad"])) for d in auftrag["dateien"]}
    namen = {os.path.abspath(str(path)): name for name, path in pfade.items()}
    tabelle = parser.spurtabelle(str(auftrag["format"]), pfade[str(auftrag["steuer"])], namen)
    tabelle.setdefault("herkunft", {"format": auftrag["format"], "steuerdatei": auftrag["steuer"],
                                    "dateien": sorted(pfade)})
    pruefe_spurtabelle(tabelle, {name: path.stat().st_size for name, path in pfade.items()})
    if auftrag.get("kommando") == "spurtabelle":
        return {"status": "fertig", "spurtabelle": tabelle, "dateien": [], "hinweise": []}
    ausgabe = Path(str(auftrag["ausgabe"]))
    ergebnis = extrahiere(tabelle, pfade, ausgabe, auftrag.get("optionen") or {})
    (ausgabe / "spurtabelle.json").write_text(json.dumps(tabelle, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                                              encoding="utf-8")
    ergebnis["dateien"].insert(0, {"pfad": "spurtabelle.json", "art": "text", "metadaten": {"rolle": "spurtabelle"}})
    return {"status": "fertig", "spurtabelle": tabelle, **ergebnis}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Aufruf: disc.py <auftrag.json>", file=sys.stderr)
        return 2
    auftrag = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    ziel = Path(str(auftrag["ergebnis"]))
    try:
        ergebnis = lauf(auftrag)
    except DiscFehler as exc:
        ergebnis = {"status": "fehler", "fehlercode": exc.code, "format_detail": exc.detail, "meldung": str(exc)}
    except (OSError, KeyError, TypeError, ValueError) as exc:
        ergebnis = {"status": "fehler", "fehlercode": "werkzeug_fehler", "meldung": f"{type(exc).__name__}: {exc}"[:2000]}
    zwischen = ziel.with_suffix(".tmp")
    zwischen.write_text(json.dumps(ergebnis, ensure_ascii=False), encoding="utf-8")
    zwischen.replace(ziel)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
