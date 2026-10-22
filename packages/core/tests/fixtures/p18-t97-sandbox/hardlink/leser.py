"""P18-T97: absichtlich adversariales Testmaterial, nur im freigegebenen Lesercontainer.
Kein Import darf einen Versuch starten. Der lokale PC ist kein Ausfuehrungsziel.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

GRENZEN = ("zeit_ms", "ram_mib", "dateien", "bytes", "cpu", "datei_bytes",
           "protokoll_bytes", "zeile_bytes", "eingabe_bytes", "lese_bytes",
           "tiefe", "poll_ms", "wait_ms")
QUELLEN = {
    "99ea0b61a7683f67a529f45a0a108d11d39d08376c634a19d63edf857b38051f": "A",
    "a36058941d1ab1bf34a63ceef09fa71b1cf3cf969c56310cfb87751b07dafb20": "B",
}


def vorbereiten():
    if os.getuid() != 65532 or os.getcwd() != "/arbeit":
        raise RuntimeError("fixture_nur_im_lesercontainer")
    roh = sys.stdin.buffer.readline(65537)
    if len(roh) > 65536:
        raise ValueError("fixture_eingabe_limit")
    req = json.loads(roh)
    g = req.get("grenzen")
    if not isinstance(g, dict) or set(g) != set(GRENZEN) | {"version"}:
        raise ValueError("leser_grenzen_fehlen_oder_felder")
    if g["version"] != 1 or req.get("schnittstelle_version") != 1:
        raise ValueError("leser_grenzen_version")
    for key in GRENZEN:
        value = g[key]
        if (not isinstance(value, str) or not value.isascii()
                or not value.isdecimal() or value.startswith("0")
                or int(value) > 9223372036854775807):
            raise ValueError("leser_grenze_ungueltig:" + key)
    if req.get("eingabe") != "/eingabe" or req.get("ausgabe") != "/arbeit":
        raise ValueError("fixture_mountvertrag")
    with open("/eingabe", "rb") as quelle:
        daten = quelle.read(19)
    sha = hashlib.sha256(daten).hexdigest()
    if sha not in QUELLEN or req.get("quell_sha256") != sha or req.get("groesse") != "18":
        raise ValueError("fixture_nur_synthetische_quelle")
    return req, {key: int(g[key]) for key in GRENZEN}, daten, QUELLEN[sha]


def emit(record):
    print(json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)


def speichern(name, daten):
    with open(Path("/arbeit") / name, "xb") as out:
        out.write(daten)
        out.flush()
        os.fsync(out.fileno())
    return {"pfad": name, "bytes": str(len(daten)),
            "sha256": hashlib.sha256(daten).hexdigest()}


def objekt(meta, datei=None):
    return {"art": "objekt", "member_id": "beleg", "objektpfad": "beleg",
            "typ": "struktur", "quelle": {"offset": "0", "laenge": "18"},
            "datei": datei, "metadaten": meta}


def ende(anzahl="1"):
    return {"art": "ende", "status": "fertig", "grund": None,
            "offen": "0", "objekte": anzahl}


def fertig(fall, marker, extra=None, daten=None):
    meta = {"fall": fall, "marker": marker, "grenzen_version": 1}
    meta.update(extra or {})
    datei = None if daten is None else speichern("beleg.bin", daten)
    emit(objekt(meta, datei))
    emit(ende())


def main():
    req, g, daten, marker = vorbereiten()
    datei = speichern("beleg.bin", daten)
    os.link("/arbeit/beleg.bin", "/arbeit/zweiter-name.bin")
    emit(objekt({"fall": "hardlink", "marker": marker}, datei))
    emit(ende())


if __name__ == "__main__":
    main()
