# ============================================================
# config.moo — Config-Persistenz fuer den Synapse FileWatcher
#
# Config-Layout:
#   {
#     "port": 7878,
#     "projekte": [
#       {"name": "synapse", "pfad": "/home/.../synapse", "enabled": true,
#        "last_scan_ms": 0, "file_count": 0}
#     ]
#   }
# ============================================================

konstante DEFAULT_PORT auf 7878

funktion config_pfad():
    setze home auf umgebung("HOME")
    wenn home == nichts:
        gib_zurück "/tmp/synapse-file-watcher"
    gib_zurück home + "/.synapse/file-watcher"

funktion ensure_config_dir():
    setze dir auf config_pfad()
    wenn datei_ist_verzeichnis(dir) == falsch:
        datei_mkdir(dir)
    gib_zurück dir

funktion config_file():
    gib_zurück ensure_config_dir() + "/config.json"

funktion pid_file():
    gib_zurück ensure_config_dir() + "/daemon.pid"

funktion port_file():
    gib_zurück ensure_config_dir() + "/daemon.port"

# Laedt Config. Liefert leere Default-Config wenn File fehlt oder korrupt.
funktion config_laden():
    setze p auf config_file()
    wenn datei_existiert(p) == falsch:
        setze leer auf {}
        leer["port"] = DEFAULT_PORT
        leer["projekte"] = []
        gib_zurück leer
    setze inhalt auf datei_lesen(p)
    versuche:
        setze c auf json_lesen(inhalt)
        # Minimal-Validierung
        wenn c.hat("port") == falsch:
            c["port"] = DEFAULT_PORT
        wenn c.hat("projekte") == falsch:
            c["projekte"] = []
        gib_zurück c
    fange e:
        zeige "[config] WARN: korrupt, starte leer"
        setze leer auf {}
        leer["port"] = DEFAULT_PORT
        leer["projekte"] = []
        gib_zurück leer

# Schreibt Config atomar (temp-file + rename)
funktion config_speichern(cfg):
    setze j auf json_text(cfg)
    setze p auf config_file()
    setze tmp auf p + ".tmp"
    datei_schreiben(tmp, j)
    # moo hat kein rename-Builtin → delete+write als Fallback
    # (echtes atomic rename als Builtin spaeter ergaenzen)
    wenn datei_existiert(p):
        datei_löschen(p)
    datei_schreiben(p, j)
    datei_löschen(tmp)

# Sucht ein Projekt in der config.projekte-Liste. Liefert Index oder -1.
funktion projekt_finde(cfg, name):
    setze i auf 0
    solange i < länge(cfg["projekte"]):
        wenn cfg["projekte"][i]["name"] == name:
            gib_zurück i
        setze i auf i + 1
    gib_zurück -1
