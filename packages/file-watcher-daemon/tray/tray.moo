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
konstante START_TRIGGER   auf "/home/blacky/.synapse/file-watcher/start-requested"
konstante STOP_TRIGGER    auf "/home/blacky/.synapse/file-watcher/stop-requested"
konstante DETAILS_TRIGGER auf "/home/blacky/.synapse/file-watcher/details-requested"
konstante DELETE_TRIGGER  auf "/home/blacky/.synapse/file-watcher/delete-requested"
konstante AGENTS_TRIGGER  auf "/home/blacky/.synapse/file-watcher/agents-requested"

setze tray auf tray_erstelle("Synapse FileWatcher", "applications-accessories")

# Liveness-State: letzter bekannter Online-Status. Nur bei Wechsel wird das
# Menue neu aufgebaut — kein UI-Zucken bei stabilem Zustand.
setze daemon_war_online auf falsch

# --- HTTP-Helfer (versuche/fange verhindert Freeze bei totem Daemon) ---
funktion safe_get(url):
    versuche:
        setze r auf http_hole(url)
        # Bei Connection-Refused liefert http_hole einen Fehler-Wert (KEIN throw).
        # Typ "Fehler" explizit abfangen und als "" behandeln.
        wenn typ_von(r) == "Fehler":
            gib_zurück ""
        # http_hole liefert {body, status, ok} — nur bei ok==wahr body zurueck.
        wenn typ_von(r) == "Woerterbuch":
            setze ok auf falsch
            wenn r.hat("ok"):
                setze ok auf r["ok"]
            wenn nicht ok:
                gib_zurück ""
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

# --- Context-Actions (Details / Loeschen) ---
# moo-Tray kennt (Stand 2026-04) kein right-click, kein Submenue und keine
# shell_run-Builtin. Deshalb: inline-Menue-Eintraege pro Projekt, die ueber
# Trigger-Dateien einen externen Helper (start-watcher.sh) anstossen — gleicher
# Mechanismus wie START_TRIGGER/STOP_TRIGGER.
funktion details_factory(name):
    gib_zurück () => details_projekt(name)

funktion delete_factory(name):
    gib_zurück () => delete_projekt(name)

funktion agents_factory(name):
    gib_zurück () => agents_projekt(name)

funktion agents_projekt(name):
    datei_schreiben(AGENTS_TRIGGER, name)

funktion details_projekt(name):
    datei_schreiben(DETAILS_TRIGGER, name)

funktion delete_projekt(name):
    datei_schreiben(DELETE_TRIGGER, name)
    # Menue nach kurzer Verzoegerung aktualisieren — der Helper dialogisiert
    # asynchron; bei OK entfernt er das Projekt am Daemon, der State-Change
    # kommt ueber /events (SSE, falls abonniert) oder spaetestens beim
    # naechsten liveness_tick/manuellen Reload.

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
    # Trigger-Datei fuer den externen Watcher — der schickt dem Daemon SIGTERM.
    # Leerer Inhalt reicht; der Watcher prueft nur die Existenz.
    datei_schreiben(STOP_TRIGGER, "")
    beende(0)

# Legt eine Trigger-Datei an. Ein externer Watcher (systemd --user path-unit
# oder ein inotify-Helfer) startet den Daemon, sobald die Datei auftaucht.
# Warum so? moo besitzt (Stand 2026-04) keine shell_run/system-Builtin fuer
# User-Code, nur moo_eval (intern via system()) — nicht fuer beliebige Commands.
# Der Tray bleibt damit dependency-frei und der Start-Mechanismus ist austauschbar.
funktion daemon_starten():
    datei_schreiben(START_TRIGGER, "1")
    # Kein sofortiges aktualisiere_menu() — liveness_tick() erkennt den
    # Online-Wechsel binnen <=3s und rebuildet das Menue automatisch.

funktion noop():
    setze ignore auf 0

# --- Menue-Aufbau (wird selten gerufen) ---
funktion aktualisiere_menu():
    setze resp auf safe_get(DAEMON_URL + "/projects")
    tray_menu_clear(tray)

    wenn resp == "":
        setze daemon_war_online auf falsch
        tray_menu_add(tray, "Daemon: OFFLINE", noop)
        # Im OFFLINE-State: "Daemon starten" statt "Neu laden" — der Reload-
        # Button bringt hier nichts, solange es nichts zu reloaden gibt.
        tray_menu_add(tray, "Daemon starten", daemon_starten)
        tray_menu_add(tray, "Beenden", quit_app)
        gib_zurück nichts

    setze daemon_war_online auf wahr

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
            # Context-Aktionen als eingerueckte Eintraege (kein Submenue in moo)
            tray_menu_add(tray, "        ↳ Details", details_factory(name))
            tray_menu_add(tray, "        ↳ Agenten", agents_factory(name))
            tray_menu_add(tray, "        ↳ Loeschen", delete_factory(name))

    tray_menu_add(tray, "Neu laden", aktualisiere_menu)
    tray_menu_add(tray, "Beenden", quit_app)

# --- Liveness-Polling ---
# Leichtgewichtiger /health-Check alle 3s. KEIN Menue-Rebuild solange der
# Status stabil ist — nur bei Wechsel online<->offline wird aktualisiert.
funktion liveness_tick():
    setze resp auf safe_get(DAEMON_URL + "/health")
    setze jetzt_online auf falsch
    wenn resp != "":
        setze jetzt_online auf wahr
    wenn jetzt_online != daemon_war_online:
        aktualisiere_menu()

# --- Init + Event-Loop ---
aktualisiere_menu()
tray_timer_add(3000, liveness_tick)
tray_run()
