"""P18-T93: formatneutrales Member-Journal auf dem Reverse-Share, niemals eine PG-Queue.
Werkzeugadapter liefern Member/Bytes. Ein bestätigter Member und ein Importsegment
sind verschiedene Cursor. Unbestätigte/unterbrochene Bytes werden nie gelöscht.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
import uuid
from typing import Any, Callable, Iterable

JOURNAL = ".e-journal.sqlite"
ANTWORT = ".e-antwort.json"


def kanonisch(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sync_ordner(root: Path) -> None:
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomar(root: Path, name: str, daten: bytes) -> None:
    """Nur eigene Metadaten ersetzen; ein alter Dateischwanz bleibt als Diagnose erhalten."""
    tmp = root / (".e-schreiben-" + uuid.uuid4().hex)
    with tmp.open("xb") as f:
        f.write(daten)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, root / name)
    sync_ordner(root)


def sicher(root: Path, rel: str, tiefe: int) -> Path:
    if (not rel or rel.startswith("/") or "\\" in rel or ":" in rel
            or any(ord(c) < 32 or ord(c) == 127 for c in rel)
            or any(p in ("", ".", "..") or p.startswith(".e-") or p == ".intern" for p in rel.split("/"))
            or len(rel.split("/")) - 1 > tiefe):
        raise ValueError("e_member_pfad")
    target = root
    for part in rel.split("/"):
        target = target / part
        if target.is_symlink():
            raise ValueError("e_member_symlink")
    return target


def hash_datei(pfad: Path, chunk: int) -> tuple[str, int]:
    fd = os.open(pfad, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise ValueError("e_member_keine_datei")
        digest, size = hashlib.sha256(), 0
        with os.fdopen(fd, "rb", closefd=False) as f:
            while block := f.read(chunk):
                digest.update(block)
                size += len(block)
        after = os.fstat(fd)
        if (st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != st.st_size:
            raise ValueError("e_member_geaendert")
        return digest.hexdigest(), size
    finally:
        os.close(fd)


def ausfuehren(root: Path, source: Path, bindung: dict[str, Any], cap: dict[str, int],
               auflisten: Callable[[Path], Iterable[dict[str, Any]]],
               extrahieren: Callable[[Path, str, Path, float], None],
               erkennen: Callable[[Path], bool], bibliothek: Path | None = None,
               importiert_sha: str | None = None) -> dict[str, Any]:
    """Ein Schritt. Callbacks sind allgemeine Werkzeugadapter, keine Leserinstallation."""
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or root.resolve() != root.absolute():
        raise ValueError("e_checkpoint_pfad")
    key = hashlib.sha256(kanonisch(bindung)).hexdigest()
    dbpath = root / JOURNAL
    if not dbpath.exists() and any(root.iterdir()):
        raise ValueError("e_altarbeit_ohne_herkunft")
    if dbpath.is_symlink() or (dbpath.exists() and (not dbpath.is_file() or dbpath.stat().st_nlink != 1)):
        raise ValueError("e_checkpoint_pfad")
    conn = sqlite3.connect(dbpath)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=FULL")
    conn.executescript("""
CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archive(id INTEGER PRIMARY KEY,source TEXT UNIQUE NOT NULL,sha TEXT NOT NULL,groesse TEXT NOT NULL,prefix TEXT NOT NULL,tiefe INTEGER NOT NULL,inventar INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS member(id INTEGER PRIMARY KEY,archiv INTEGER NOT NULL,name TEXT NOT NULL,ziel TEXT UNIQUE NOT NULL,groesse TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offen',sha TEXT,zwischen TEXT,schritt INTEGER,UNIQUE(archiv,name));
""")
    deadline = time.monotonic() + cap["zeitlimit_s"] - min(cap.get("nachlauf_s", 0), cap["zeitlimit_s"] // 4)
    try:
        alt = conn.execute("SELECT value FROM meta WHERE name='bindung'").fetchone()
        if alt is not None and alt[0] != key:
            raise ValueError("e_checkpoint_herkunft_geaendert")
        if alt is None:
            sha, size = hash_datei(source, cap["lese_block_bytes"])
            conn.execute("INSERT INTO meta VALUES('bindung',?)", (key,))
            conn.execute("INSERT INTO meta VALUES('schritt','1')")
            conn.execute("INSERT INTO archive(source,sha,groesse,prefix,tiefe) VALUES(?,?,?,'',0)", (str(source), sha, str(size)))
            conn.commit()
            sync_ordner(root)
        ursprung = conn.execute("SELECT sha,groesse FROM archive WHERE id=1").fetchone()
        if hash_datei(source, cap["lese_block_bytes"]) != (ursprung["sha"], int(ursprung["groesse"])):
            raise ValueError("e_checkpoint_quelle_geaendert")
        schritt = int(conn.execute("SELECT value FROM meta WHERE name='schritt'").fetchone()[0])
        antwortpfad = root / ANTWORT
        if antwortpfad.exists():
            if antwortpfad.is_symlink():
                raise ValueError("e_checkpoint_pfad")
            with antwortpfad.open("rb") as reply:
                raw = reply.read(cap["manifest_record_bytes"] + 1)
            if len(raw) > cap["manifest_record_bytes"]:
                raise ValueError("e_checkpoint_record")
            previous = json.loads(raw)
            if previous.get("extraktion", {}).get("bindung") != key:
                raise ValueError("e_checkpoint_herkunft_geaendert")
            if int(previous["extraktion"]["schritt"]) == schritt:
                if importiert_sha != previous["manifest_datei"]["sha256"]:
                    return previous
                if previous["extraktion"]["fertig"] or not previous["extraktion"]["fortsetzbar"]:
                    return previous
                schritt += 1
                conn.execute("UPDATE meta SET value=? WHERE name='schritt'", (str(schritt),))
                conn.commit()
        dateien, size_step = 0, 0
        for zeile in conn.execute("SELECT groesse FROM member WHERE status IN('fertig','quelle') AND schritt=?", (schritt,)):
            dateien += 1
            size_step += int(zeile[0])
        grund: str | None = None

        geprueft: dict[int, Path] = {}
        archiv_summen: dict[int, int] = {}

        def archivpfad(a: sqlite3.Row) -> Path:
            if a["id"] in geprueft:
                return geprueft[a["id"]]
            p = Path(a["source"])
            if not p.is_absolute():
                p = sicher(root, a["source"], cap["max_tiefe"])
                if not p.exists() and bibliothek is not None:
                    p = sicher(bibliothek, a["source"], cap["max_tiefe"])
            sha, size = hash_datei(p, cap["lese_block_bytes"])
            if sha != a["sha"] or str(size) != a["groesse"]:
                raise ValueError("e_checkpoint_quelle_geaendert")
            geprueft[a["id"]] = p
            return p

        while True:
            if time.monotonic() >= deadline:
                grund = "deadline"
                break
            a = conn.execute("SELECT * FROM archive WHERE inventar=0 ORDER BY id LIMIT 1").fetchone()
            if a is not None:
                p = archivpfad(a)
                n = 0
                for item in auflisten(p):
                    if time.monotonic() >= deadline:
                        grund = "deadline"
                        break
                    name, size = str(item["pfad"]), int(item["groesse"])
                    if size < 0:
                        raise ValueError("e_member_groesse")
                    rel = a["prefix"] + name
                    sicher(root, rel, cap["max_tiefe"])
                    # Wiederholung einer unterbrochenen Auflistung ist nur bei identischem Member erlaubt.
                    old = conn.execute("SELECT groesse,ziel FROM member WHERE archiv=? AND name=?", (a["id"], name)).fetchone()
                    if old and (old["groesse"] != str(size) or old["ziel"] != rel):
                        raise ValueError("e_member_inventar_geaendert")
                    conn.execute("INSERT OR IGNORE INTO member(archiv,name,ziel,groesse) VALUES(?,?,?,?)", (a["id"], name, rel, str(size)))
                    n += 1
                    if n % cap["manifest_segment_zeilen"] == 0:
                        conn.commit()
                conn.commit()
                if grund:
                    break
                conn.execute("UPDATE archive SET inventar=1 WHERE id=?", (a["id"],))
                conn.commit()
            m = conn.execute("SELECT * FROM member WHERE status IN('offen','bereit') ORDER BY id LIMIT 1").fetchone()
            if m is None:
                if conn.execute("SELECT 1 FROM archive WHERE inventar=0 LIMIT 1").fetchone():
                    continue
                # Archivquellen werden erst publiziert, wenn keine Kindarbeit mehr offen ist.
                # Damit kann der Import andere fertige Dateien verschieben, ohne Resume-Quellen zu entfernen.
                for gehalten in conn.execute("SELECT id,groesse,schritt FROM member WHERE status='quelle' ORDER BY id"):
                    size = int(gehalten["groesse"])
                    if gehalten["schritt"] != schritt:
                        if dateien >= cap["max_dateien"] or size_step + size > cap["max_bytes"]:
                            grund = "schrittgrenze" if dateien else "datei_ueber_schrittbudget"
                            break
                        dateien += 1
                        size_step += size
                    conn.execute("UPDATE member SET status='fertig',schritt=? WHERE id=?", (schritt, gehalten["id"]))
                conn.commit()
                break
            size = int(m["groesse"])
            if size > cap["max_datei_bytes"]:
                grund = "datei_zu_gross"
                break
            if dateien >= cap["max_dateien"] or size_step + size > cap["max_bytes"]:
                grund = "schrittgrenze" if dateien else "datei_ueber_schrittbudget"
                break
            a = conn.execute("SELECT * FROM archive WHERE id=?", (m["archiv"],)).fetchone()
            p = archivpfad(a)
            if a["id"] not in archiv_summen:
                archiv_summen[a["id"]] = sum(int(r[0]) for r in conn.execute("SELECT groesse FROM member WHERE archiv=? AND status IN('fertig','quelle')", (a["id"],)))
            if archiv_summen[a["id"]] + size > int(a["groesse"]) * cap["max_kompressionsfaktor"]:
                grund = "bombe_verdacht"
                break
            ziel = sicher(root, m["ziel"], cap["max_tiefe"])
            ziel.parent.mkdir(parents=True, exist_ok=True)
            if m["status"] == "bereit":
                zwischen = root / m["zwischen"]
                kandidat = ziel if ziel.exists() else zwischen
                sha, actual = hash_datei(kandidat, cap["lese_block_bytes"])
                if sha != m["sha"] or actual != size:
                    raise ValueError("e_member_bereit_geaendert")
            else:
                # Jeder Wiederholungsversuch bekommt einen eigenen Namen; alte Fragmente bleiben erhalten.
                zwischen = root / (".e-member-" + uuid.uuid4().hex)
                extrahieren(p, m["name"], zwischen, deadline)
                sha, actual = hash_datei(zwischen, cap["lese_block_bytes"])
                if actual != size:
                    raise ValueError("e_member_unvollstaendig")
                with zwischen.open("rb") as f:
                    os.fsync(f.fileno())
                conn.execute("UPDATE member SET status='bereit',sha=?,zwischen=? WHERE id=?", (sha, zwischen.name, m["id"]))
                conn.commit()
            if ziel.exists():
                if hash_datei(ziel, cap["lese_block_bytes"]) != (sha, size):
                    raise ValueError("e_member_ziel_belegt")
            else:
                os.rename(zwischen, ziel)
                sync_ordner(ziel.parent)
            archiv = erkennen(ziel)
            if archiv:
                if a["tiefe"] >= cap["max_verschachtelung"]:
                    grund = "tiefenlimit"
                else:
                    conn.execute("INSERT OR IGNORE INTO archive(source,sha,groesse,prefix,tiefe) VALUES(?,?,?,?,?)",
                                 (m["ziel"], sha, str(size), m["ziel"] + "~inhalt/", a["tiefe"] + 1))
            conn.execute("UPDATE member SET status=?,schritt=? WHERE id=?", ("quelle" if archiv and grund is None else "fertig", schritt, m["id"]))
            conn.commit()
            dateien += 1
            size_step += size
            archiv_summen[a["id"]] += size
            if grund:
                break
        offen = conn.execute("SELECT count(*) FROM member WHERE status<>'fertig'").fetchone()[0]
        inventare = conn.execute("SELECT count(*) FROM archive WHERE inventar=0").fetchone()[0]
        # Ein vorzeitiger Ausstieg ist nie eine leere erfolgreiche Tabelle.
        fertig = grund is None and offen == 0 and inventare == 0
        name = ".e-manifest-" + str(schritt) + ".jsonl"
        tmp = root / (".e-segment-" + uuid.uuid4().hex)
        digest, count, total, manifest_bytes = hashlib.sha256(), 0, 0, 0
        with tmp.open("xb") as target:
            for row in conn.execute("SELECT m.*,a.source AS archivquelle FROM member m JOIN archive a ON a.id=m.archiv WHERE m.status='fertig' AND m.schritt=? ORDER BY m.id", (schritt,)):
                record = {"pfad": row["ziel"], "sha256": row["sha"], "groesse": row["groesse"],
                          "metadaten": {"herkunft": {"archiv": row["archivquelle"], "pfad": row["name"]},
                                        "e_member_id": str(row["id"]), "e_bindung": key}}
                raw = kanonisch(record) + b"\n"
                if len(raw) > cap["manifest_record_bytes"] + 1:
                    raise ValueError("e_manifest_record_zu_gross")
                target.write(raw)
                digest.update(raw)
                count += 1
                total += int(row["groesse"])
                manifest_bytes += len(raw)
            target.flush()
            os.fsync(target.fileno())
        os.replace(tmp, root / name)
        sync_ordner(root)
        result = {"status": "fertig" if fertig else "teilweise", "fehlercode": grund,
                  "manifest": [], "manifest_datei": {"version": 2, "pfad": name, "sha256": digest.hexdigest(), "bytes": str(manifest_bytes), "zeilen": str(count)},
                  "ausgabe_bytes": str(total),
                  "extraktion": {"version": 1, "bindung": key, "schritt": str(schritt), "fertig": fertig,
                                  "fortsetzbar": grund in ("deadline", "schrittgrenze") and dateien > 0,
                                  "offen": str(offen), "inventare_offen": str(inventare),
                                  "gesamt": str(conn.execute("SELECT count(*) FROM member WHERE status='fertig'").fetchone()[0]),
                                  "leertabelle_belegt": fertig and count == 0}}
        raw = kanonisch(result)
        if len(raw) > cap["manifest_record_bytes"]:
            raise ValueError("e_checkpoint_record")
        atomar(root, ANTWORT, raw)
        return result
    finally:
        conn.close()
