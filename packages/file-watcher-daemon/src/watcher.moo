# ============================================================
# watcher.moo — Polling-basierter Filesystem-Watcher-Worker
#
# Pro Projekt ein Thread. Scan via datei_mtime + dir_list rekursiv,
# Diff gegen Snapshot, Event fuer added/modified/deleted.
#
# Stop-Signal: Flag-File ~/.synapse/file-watcher/projects/<name>.active
# verschwindet → Worker beendet sich im naechsten Zyklus.
#
# Adaptives Intervall:
#   - nach Aenderung:  200 ms  (busy-mode, 10 s Abklingzeit)
#   - Default:        1000 ms
#   - Idle > 5 min:   2000 ms
# ============================================================

# -----------------------------------------------------------------
# Rekursiver Scan — baut dict pfad -> mtime auf
# -----------------------------------------------------------------
funktion scan_baum(wurzel, snap):
    setze stack auf [wurzel]
    solange länge(stack) > 0:
        setze pfad auf stack[länge(stack) - 1]
        stack.pop()
        setze eintraege auf dir_list(pfad)
        für name in eintraege:
            wenn name == ".synapse":
                weiter
            wenn name == ".git":
                weiter
            setze voll auf pfad + "/" + name
            wenn datei_ist_verzeichnis(voll):
                stack.hinzufügen(voll)
            sonst:
                snap[voll] = datei_mtime(voll)

# -----------------------------------------------------------------
# Diff zweier Snapshots -> Liste von Events
#   {"typ":"added"|"modified"|"deleted", "pfad":..., "mtime":...}
# -----------------------------------------------------------------
funktion detect_changes(jetzt, alt):
    setze events auf []
    setze neue_pfade auf jetzt.schlüssel()
    für p in neue_pfade:
        wenn alt.hat(p) == falsch:
            setze ev auf {}
            ev["typ"] = "added"
            ev["pfad"] = p
            ev["mtime"] = jetzt[p]
            events.hinzufügen(ev)
        sonst:
            wenn alt[p] != jetzt[p]:
                setze ev auf {}
                ev["typ"] = "modified"
                ev["pfad"] = p
                ev["mtime"] = jetzt[p]
                events.hinzufügen(ev)
    setze alte_pfade auf alt.schlüssel()
    für p in alte_pfade:
        wenn jetzt.hat(p) == falsch:
            setze ev auf {}
            ev["typ"] = "deleted"
            ev["pfad"] = p
            events.hinzufügen(ev)
    gib_zurück events

# -----------------------------------------------------------------
# Sendet ein Event via HTTP-POST an die Synapse-REST-API.
# No-op wenn url leer. Fehler werden nur geloggt, kein Retry-Mechanismus
# im MVP — Events sind best-effort.
# -----------------------------------------------------------------
funktion event_posten(url, projekt, ev):
    wenn url == "":
        gib_zurück nichts
    setze body auf {}
    body["projekt"] = projekt
    body["typ"] = ev["typ"]
    body["pfad"] = ev["pfad"]
    wenn ev.hat("mtime"):
        body["mtime"] = ev["mtime"]
    # http_sende_mit_headers erwartet das Roh-Dict als Body — serialisiert
    # intern via json_string. Wuerden wir hier vor-serialisieren, wuerde
    # der Body doppelt JSON-encoded.
    setze headers auf {}
    headers["Content-Type"] = "application/json"
    versuche:
        http_sende_mit_headers(url, body, headers)
    fange e:
        zeige "[" + projekt + "] WARN: event POST failed -> " + url

# -----------------------------------------------------------------
# Worker-Main — laeuft pro Projekt in eigenem Thread
#   ctx = {"name", "pfad", "flag_file", "synapse_api_url"}
# -----------------------------------------------------------------
funktion worker_main(ctx):
    setze projekt auf ctx["name"]
    setze pfad auf ctx["pfad"]
    setze flag_file auf ctx["flag_file"]
    setze api_url auf ctx["synapse_api_url"]

    setze snap auf {}
    scan_baum(pfad, snap)
    zeige "[" + projekt + "] initial: " + text(länge(snap.schlüssel())) + " Dateien"

    setze intervall_ms auf 1000
    setze letzte_aenderung_ms auf zeit_ms()

    setze laeuft auf wahr
    solange laeuft:
        schlafe(intervall_ms / 1000.0)
        wenn datei_existiert(flag_file) == falsch:
            zeige "[" + projekt + "] Flag weg — Worker beendet"
            setze laeuft auf falsch
            weiter

        setze aktuell auf {}
        scan_baum(pfad, aktuell)
        setze events auf detect_changes(aktuell, snap)
        setze snap auf aktuell

        wenn länge(events) > 0:
            setze letzte_aenderung_ms auf zeit_ms()
            setze intervall_ms auf 200   # busy mode
            für e in events:
                zeige "[" + projekt + "] " + e["typ"] + " " + e["pfad"]
                event_posten(api_url, projekt, e)
        sonst:
            setze idle_ms auf zeit_ms() - letzte_aenderung_ms
            wenn idle_ms > 300000:
                setze intervall_ms auf 2000  # long idle
            sonst:
                wenn idle_ms > 10000:
                    setze intervall_ms auf 1000  # back to normal

    gib_zurück 0
