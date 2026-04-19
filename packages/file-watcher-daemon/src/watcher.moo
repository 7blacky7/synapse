# ============================================================
# watcher.moo — Polling-basierter Filesystem-Watcher-Worker
#
# Feature-Parity-Status ggue. altem TS-Watcher
# (packages/core/src/watcher/index.ts, ignore.ts):
#   ✓ Ignore: DEFAULT_IGNORES + .gitignore + .synapseignore
#   ✓ Event-Typen: add / change / unlink  (wie TS, NICHT "added/modified/deleted")
#   ✓ Relative Pfade im Event (Bug-Prevention commit 62a8b13)
#   ✓ Ignore Dual-Check (File + Directory Variante)
#   ✓ .synapse und .git immer ignoriert (hart zusaetzlich zu ignore.moo)
#   ✓ Stability-Check (awaitWriteFinish-artig) — 1 Zyklus Wartezeit fuer add/change
#   ✓ Adaptives Intervall: 200 ms busy / 1000 ms normal / 2000 ms idle >5 min
#   ✓ Flag-File-Signaling fuer Start/Stop
#   ✓ HTTP-POST an REST-API mit Content-Type Header
#   – TODO Phase-2: watcher_events PG-Logging + 7-Tage-TTL
#   – TODO Phase-2: Move-Detection per inode+hash (braucht sha256-Builtin)
#   – TODO Phase-2: UNLINK 1500 ms Debounce fuer Rename-Erkennung
#   – TODO Phase-2: Binary-Detection + Multimodal-Klassifikation
#   – TODO Phase-2: PG->Disk Dual-Direction-Sync
# ============================================================

importiere ignore

# -----------------------------------------------------------------
# Berechne relativen Pfad zum Projekt-Root.
#   voll   = "/home/x/proj/src/foo.ts"
#   root   = "/home/x/proj"
#   -> "src/foo.ts"
# -----------------------------------------------------------------
funktion relativ_zu(voll, root):
    wenn voll == root:
        gib_zurück ""
    setze rl auf länge(root)
    # Stelle sicher, dass voll mit root+"/" startet
    wenn länge(voll) <= rl:
        gib_zurück voll
    # Skip Root plus einzelnem "/"
    gib_zurück voll.teilstring(rl + 1, länge(voll))

# -----------------------------------------------------------------
# Rekursiver Scan mit Ignore-Respekt.
#   wurzel -> Projekt-Root (absolut)
#   snap   -> dict{absolut_pfad -> mtime} wird gefuellt
#   ig     -> Rueckgabe von ignore_laden()
# -----------------------------------------------------------------
funktion scan_baum(wurzel, snap, ig):
    setze stack auf [wurzel]
    solange länge(stack) > 0:
        setze pfad auf stack[länge(stack) - 1]
        stack.pop()
        setze eintraege auf dir_list(pfad)
        für name in eintraege:
            # Hard-Ignores die immer gelten (Fail-Safe ueber ignore.moo hinaus)
            wenn name == ".git":
                weiter
            wenn name == ".synapse":
                weiter
            setze voll auf pfad + "/" + name
            setze ist_dir auf datei_ist_verzeichnis(voll)
            setze rel auf relativ_zu(voll, wurzel)
            wenn soll_ignorieren(ig, rel, ist_dir):
                weiter
            wenn ist_dir:
                stack.hinzufügen(voll)
            sonst:
                snap[voll] = datei_mtime(voll)

# -----------------------------------------------------------------
# Diff zweier Snapshots -> Liste von Events
#   Event-Typ wie TS-Watcher: add / change / unlink
#   jetzt  -> aktueller Snapshot {abs -> mtime}
#   alt    -> vorheriger Snapshot {abs -> mtime}
# -----------------------------------------------------------------
funktion detect_changes(jetzt, alt):
    setze events auf []
    setze neue_pfade auf jetzt.schlüssel()
    für p in neue_pfade:
        wenn alt.hat(p) == falsch:
            setze ev auf {}
            ev["typ"] = "add"
            ev["pfad"] = p
            ev["mtime"] = jetzt[p]
            events.hinzufügen(ev)
        sonst:
            wenn alt[p] != jetzt[p]:
                setze ev auf {}
                ev["typ"] = "change"
                ev["pfad"] = p
                ev["mtime"] = jetzt[p]
                events.hinzufügen(ev)
    setze alte_pfade auf alt.schlüssel()
    für p in alte_pfade:
        wenn jetzt.hat(p) == falsch:
            setze ev auf {}
            ev["typ"] = "unlink"
            ev["pfad"] = p
            events.hinzufügen(ev)
    gib_zurück events

# -----------------------------------------------------------------
# Sendet ein Event via HTTP-POST an die Synapse-REST-API.
# pfad im Body ist IMMER relativ (wie TS-Watcher seit commit 62a8b13).
# -----------------------------------------------------------------
funktion event_posten(url, projekt, projekt_pfad, ev):
    wenn url == "":
        gib_zurück nichts
    setze body auf {}
    body["projekt"] = projekt
    body["typ"] = ev["typ"]
    body["pfad"] = relativ_zu(ev["pfad"], projekt_pfad)
    wenn ev.hat("mtime"):
        body["mtime"] = ev["mtime"]
    setze headers auf {}
    headers["Content-Type"] = "application/json"
    versuche:
        http_sende_mit_headers(url, body, headers)
    fange e:
        zeige "[" + projekt + "] WARN: event POST failed -> " + url

# -----------------------------------------------------------------
# Worker-Main — laeuft pro Projekt in eigenem Thread.
#   ctx = {"name", "pfad", "flag_file", "synapse_api_url"}
#
# Stability-Check (awaitWriteFinish-artig): add/change-Events werden nicht
# im selben Zyklus gefeuert, in dem sie erkannt wurden. Stattdessen merken
# wir uns "pending_stable[pfad] = mtime". Erst im naechsten Zyklus, wenn die
# mtime identisch ist, wird das Event gefeuert. Damit fangen wir kurze
# mehrfach-Writes ab (stabilityThreshold im alten TS-Watcher = 200 ms).
# Unlink-Events werden sofort gefeuert (TODO Phase-2: 1500 ms Debounce
# fuer Rename-Detection).
# -----------------------------------------------------------------
funktion worker_main(ctx):
    setze projekt auf ctx["name"]
    setze pfad auf ctx["pfad"]
    setze flag_file auf ctx["flag_file"]
    setze api_url auf ctx["synapse_api_url"]

    # Ignore-Patterns einmalig beim Start laden
    setze ig auf ignore_laden(pfad)

    setze snap auf {}
    scan_baum(pfad, snap, ig)
    zeige "[" + projekt + "] initial: " + text(länge(snap.schlüssel())) + " Dateien"

    setze intervall_ms auf 1000
    setze letzte_aenderung_ms auf zeit_ms()
    setze pending_stable auf {}

    setze laeuft auf wahr
    solange laeuft:
        schlafe(intervall_ms / 1000.0)
        wenn datei_existiert(flag_file) == falsch:
            zeige "[" + projekt + "] Flag weg — Worker beendet"
            setze laeuft auf falsch
            weiter

        setze aktuell auf {}
        scan_baum(pfad, aktuell, ig)
        setze roh_events auf detect_changes(aktuell, snap)

        # Stability-Check: add/change erst feuern wenn mtime stabil bleibt
        setze fire auf []
        setze neues_pending auf {}
        für e in roh_events:
            wenn e["typ"] == "unlink":
                fire.hinzufügen(e)
                weiter
            setze p auf e["pfad"]
            setze m auf e["mtime"]
            wenn pending_stable.hat(p):
                wenn pending_stable[p] == m:
                    fire.hinzufügen(e)
                sonst:
                    neues_pending[p] = m
            sonst:
                neues_pending[p] = m
        setze pending_stable auf neues_pending
        setze snap auf aktuell

        wenn länge(fire) > 0:
            setze letzte_aenderung_ms auf zeit_ms()
            setze intervall_ms auf 200   # busy mode
            für e in fire:
                zeige "[" + projekt + "] " + e["typ"] + " " + relativ_zu(e["pfad"], pfad)
                event_posten(api_url, projekt, pfad, e)
        sonst:
            setze idle_ms auf zeit_ms() - letzte_aenderung_ms
            wenn idle_ms > 300000:
                setze intervall_ms auf 2000  # long idle
            sonst:
                wenn idle_ms > 10000:
                    setze intervall_ms auf 1000  # back to normal

    gib_zurück 0
