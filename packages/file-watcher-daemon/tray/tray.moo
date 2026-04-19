# tray.moo — Synapse FileWatcher Tray
#
# Design-Prinzip: event-getrieben, NICHT polling-basiert.
# Das Menue wird nur aufgebaut wenn sich wirklich etwas aendert:
#   - einmal beim Start
#   - nach einem Toggle-Click (User hat bewusst eine Aktion ausgeloest)
#   - wenn der User "Neu laden" klickt (Stand extern veraendert)
# Im Idle macht der Tray NICHTS — kein HTTP-Traffic, kein Menue-Rebuild,
# kein UI-Zucken.

konstante DAEMON_URL auf "http://127.0.0.1:7878"

setze tray auf tray_erstelle("Synapse FileWatcher", "applications-accessories")

# --- HTTP-Helfer (versuche/fange verhindert Freeze bei totem Daemon) ---
funktion safe_get(url):
    versuche:
        setze r auf http_hole(url)
        # http_hole liefert {body, status, ok} — Body extrahieren
        wenn typ_von(r) == "Woerterbuch":
            wenn r.hat("body"):
                gib_zurück r["body"]
            gib_zurück ""
        gib_zurück r
    fange e:
        gib_zurück ""

funktion safe_post(url, body):
    versuche:
        http_sende(url, body)
    fange e:
        setze ignore auf 0

# --- Projekt-Toggle ---
funktion toggle_factory(name):
    gib_zurück () => toggle_projekt(name)

funktion toggle_projekt(name):
    setze status_resp auf safe_get(DAEMON_URL + "/projects/" + name + "/status")
    setze info auf json_lesen(status_resp)
    setze akt auf falsch
    wenn typ_von(info) == "Woerterbuch":
        wenn info.hat("enabled"):
            setze akt auf info["enabled"]
    setze pfad_aktion auf "/enable"
    wenn akt:
        setze pfad_aktion auf "/disable"
    safe_post(DAEMON_URL + "/projects/" + name + pfad_aktion, "")
    # Menue NACH User-Aktion neu bauen — kein Zucken, weil vom User ausgeloest
    aktualisiere_menu()

funktion quit_app():
    beende(0)

funktion noop():
    setze ignore auf 0

# --- Menue-Aufbau (wird selten gerufen) ---
funktion aktualisiere_menu():
    setze resp auf safe_get(DAEMON_URL + "/projects")
    tray_menu_clear(tray)

    wenn resp == "":
        tray_menu_add(tray, "Daemon: OFFLINE", noop)
        tray_menu_add(tray, "Neu laden", aktualisiere_menu)
        tray_menu_add(tray, "Beenden", quit_app)
        gib_zurück nichts

    setze root auf json_lesen(resp)
    setze projekte auf []
    wenn typ_von(root) == "Woerterbuch":
        wenn root.hat("projekte"):
            setze projekte auf root["projekte"]

    tray_menu_add(tray, "Daemon: online", noop)

    wenn länge(projekte) == 0:
        tray_menu_add(tray, "(keine Projekte)", noop)
    sonst:
        für p in projekte:
            setze name auf p["name"]
            setze enabled auf p["enabled"]
            setze symbol auf "○"
            wenn enabled:
                setze symbol auf "●"
            setze label auf symbol + "  " + name
            tray_menu_add(tray, label, toggle_factory(name))

    tray_menu_add(tray, "Neu laden", aktualisiere_menu)
    tray_menu_add(tray, "Beenden", quit_app)

# --- Init + Event-Loop ---
aktualisiere_menu()
tray_run()
