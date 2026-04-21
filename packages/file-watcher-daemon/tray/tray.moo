# tray.moo — Synapse FileWatcher Tray (moo UI-Modul, incremental)
#
# Nutzt das neue moo_ui + moo_tray API (Branch feat/moo-tray-linux):
#   - Submenus pro Projekt (1 Zeile im Haupt-Menue)
#   - Check-Items fuer Toggle (statt ●○-Hack)
#   - Native ui_frage/ui_info Dialoge (ersetzt Zenity)
#   - ui_fenster mit Tabs fuer Details/Agenten/Status/Aktionen
#   - ui_laufen() als gemeinsamer Event-Loop
#
# PERFORMANCE: Inkrementelles Update. Menu wird nur einmal beim Start
# gebaut. Der 3-s-Liveness-Tick updatet per Handle NUR was sich geaendert
# hat (Status-Label, Check-State). Voller Rebuild nur wenn Projekte
# hinzukommen oder wegfallen. Kein Flimmern mehr.

importiere ui

konstante DAEMON_URL auf "http://127.0.0.1:7878"
konstante START_TRIGGER auf "/home/blacky/.synapse/file-watcher/start-requested"
konstante STOP_TRIGGER  auf "/home/blacky/.synapse/file-watcher/stop-requested"

# Tray-Handle
setze tray auf tray_erstelle("Synapse FileWatcher", "applications-accessories")

# --- Persistente State-Handles (nach aktualisiere_menu gesetzt) ---
# Status-Zeile oben ("Daemon: online" / "Daemon: OFFLINE")
setze status_item auf nichts
setze status_text auf ""
# Projekt-Handles: name -> { sub, check, enabled }
setze projekt_handles auf {}
# Letzter bekannter Projekt-Satz (sortierte Namen als String) — fuer Diff
setze letzte_projekt_signatur auf ""
# Letzter bekannter Online-Status
setze war_online auf falsch

# Geoeffnete Detail-Fenster: name -> { fenster, liste_agents, ... }
setze offene_fenster auf {}

# --------------------------------------------------------------
# HTTP-Helfer
# --------------------------------------------------------------
funktion safe_get(url):
    versuche:
        setze r auf http_hole(url)
        wenn typ_von(r) == "Fehler":
            gib_zurück ""
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

# --------------------------------------------------------------
# Projekt-Toggle (Check-Item-Callback)
# --------------------------------------------------------------
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
    # State im lokalen Handle-Dict sofort aktualisieren — dann flippt der
    # naechste Liveness-Tick nicht nochmal.
    wenn projekt_handles.hat(name):
        projekt_handles[name]["enabled"] = nicht akt

funktion toggle_factory(name):
    gib_zurück () => toggle_projekt(name)

# --------------------------------------------------------------
# Detail-Fenster oeffnen (Tab-basiert)
# --------------------------------------------------------------
funktion oeffne_detail(name):
    wenn offene_fenster.hat(name):
        setze g auf offene_fenster[name]
        wenn nicht g.hat("closed"):
            ui_zeige(g["fenster"])
            agents_laden(name)
            events_laden(name)
            status_laden(name)
            gib_zurück nichts
        # Sonst: altes Fenster wurde geschlossen → komplett neu aufbauen

    setze g auf {}
    offene_fenster[name] = g
    g["name"] = name

    setze fenster auf ui_fenster("Projekt: " + name, 780, 560, 1, nichts)
    g["fenster"] = fenster
    # Beim Close: Eintrag entfernen — GTK zerstoert das Widget, der
    # gecachte Pointer wird sonst beim naechsten Oeffnen zum Segfault.
    ui_fenster_on_close(fenster, close_factory(name))

    setze tabs auf ui_tabs(fenster, 10, 10, 760, 500)
    g["tabs"] = tabs

    # --- Tab 1: Agenten ---
    setze tab_a auf ui_tab_hinzu(tabs, "Agenten")
    setze liste_a auf ui_liste(tab_a, ["Name", "Modell", "Status", "Tokens", "Letzte Aktivitaet"], 10, 10, 730, 400)
    g["liste_agents"] = liste_a
    ui_knopf(tab_a, "Stoppen",        10, 420, 120, 32, stop_agent_factory(name))
    ui_knopf(tab_a, "Aktualisieren", 140, 420, 140, 32, refresh_agents_factory(name))

    # --- Tab 2: Events ---
    setze tab_e auf ui_tab_hinzu(tabs, "Events")
    setze liste_e auf ui_liste(tab_e, ["Typ", "Datei", "Zeit"], 10, 10, 730, 400)
    g["liste_events"] = liste_e
    ui_knopf(tab_e, "Aktualisieren", 10, 420, 140, 32, refresh_events_factory(name))
    ui_knopf(tab_e, "Oeffnen",      160, 420, 120, 32, open_event_factory(name))

    # --- Tab 3: Status ---
    setze tab_s auf ui_tab_hinzu(tabs, "Status")
    ui_label(tab_s, "Pfad:",     10, 10, 100, 20)
    setze lbl_pfad auf ui_label(tab_s, "-", 110, 10, 620, 20)
    g["lbl_pfad"] = lbl_pfad
    ui_label(tab_s, "Aktiv:",    10, 40, 100, 20)
    setze lbl_aktiv auf ui_label(tab_s, "-", 110, 40, 620, 20)
    g["lbl_aktiv"] = lbl_aktiv
    ui_label(tab_s, "Chunks:",   10, 70, 100, 20)
    setze lbl_chunks auf ui_label(tab_s, "-", 110, 70, 620, 20)
    g["lbl_chunks"] = lbl_chunks
    ui_label(tab_s, "Dateien:",  10, 100, 100, 20)
    setze lbl_files auf ui_label(tab_s, "-", 110, 100, 620, 20)
    g["lbl_files"] = lbl_files
    ui_knopf(tab_s, "Aktualisieren", 10, 140, 140, 32, refresh_status_factory(name))

    # --- Tab 4: Aktionen ---
    setze tab_ak auf ui_tab_hinzu(tabs, "Aktionen")
    ui_knopf(tab_ak, "Neu indexieren", 10, 10,   200, 36, reindex_factory(name))
    ui_knopf(tab_ak, "Projekt loeschen", 10, 60, 200, 36, delete_factory(name))

    ui_zeige(fenster)
    agents_laden(name)
    events_laden(name)
    status_laden(name)

funktion detail_factory(name):
    gib_zurück () => oeffne_detail(name)

funktion fenster_wirklich_schliessen(name):
    # moo Dict hat kein .entferne() als Methode — Flag setzen,
    # beim naechsten oeffne_detail wird das als "muss neu gebaut"
    # interpretiert.
    wenn offene_fenster.hat(name):
        setze g auf offene_fenster[name]
        g["closed"] = wahr
    gib_zurück wahr

funktion close_factory(name):
    gib_zurück () => fenster_wirklich_schliessen(name)

# --------------------------------------------------------------
# Agenten-Tab: laden + Stop
# --------------------------------------------------------------
funktion agents_laden(name):
    wenn nicht offene_fenster.hat(name):
        gib_zurück nichts
    setze g auf offene_fenster[name]
    setze liste auf g["liste_agents"]
    ui_liste_leeren(liste)
    setze resp auf safe_get(DAEMON_URL + "/projects/" + name + "/specialists")
    wenn resp == "":
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        gib_zurück nichts
    wenn nicht info.hat("specialists"):
        gib_zurück nichts
    setze specs auf info["specialists"]
    setze keys auf specs.schlüssel()
    setze i auf 0
    solange i < länge(keys):
        setze agent auf keys[i]
        setze sp auf specs[agent]
        setze modell auf ""
        wenn sp.hat("model"):
            setze modell auf sp["model"]
        setze stat auf ""
        wenn sp.hat("status"):
            setze stat auf sp["status"]
        setze tok auf "0%"
        wenn sp.hat("tokens"):
            setze t auf sp["tokens"]
            wenn typ_von(t) == "Woerterbuch":
                wenn t.hat("percent"):
                    setze tok auf text(t["percent"]) + "%"
        setze letzte auf ""
        wenn sp.hat("lastActivity"):
            setze letzte auf sp["lastActivity"]
        ui_liste_zeile_hinzu(liste, [agent, modell, stat, tok, letzte])
        setze i auf i + 1

funktion refresh_agents_factory(name):
    gib_zurück () => agents_laden(name)

funktion stoppe_ausgewaehlten(name):
    wenn nicht offene_fenster.hat(name):
        gib_zurück nichts
    setze g auf offene_fenster[name]
    setze idx auf ui_liste_auswahl(g["liste_agents"])
    wenn idx < 0:
        ui_info(g["fenster"], "Stoppen", "Kein Spezialist ausgewaehlt.")
        gib_zurück nichts
    setze zeile auf ui_liste_zeile(g["liste_agents"], idx)
    setze agent auf zeile[0]
    wenn ui_frage(g["fenster"], "Stoppen?", "Spezialist '" + agent + "' stoppen?\nSIGTERM geht an den Wrapper."):
        safe_post(DAEMON_URL + "/projects/" + name + "/specialists/" + agent + "/stop", "")
        agents_laden(name)

funktion stop_agent_factory(name):
    gib_zurück () => stoppe_ausgewaehlten(name)

# --------------------------------------------------------------
# Events-Tab: laden + oeffnen
# --------------------------------------------------------------
funktion events_laden(name):
    wenn nicht offene_fenster.hat(name):
        gib_zurück nichts
    setze g auf offene_fenster[name]
    setze liste auf g["liste_events"]
    ui_liste_leeren(liste)
    setze resp auf safe_get(DAEMON_URL + "/projects/" + name + "/history?limit=50")
    wenn resp == "":
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        gib_zurück nichts
    wenn nicht info.hat("events"):
        gib_zurück nichts
    setze events auf info["events"]
    setze i auf 0
    solange i < länge(events):
        setze ev auf events[i]
        setze typ auf ""
        wenn ev.hat("event_type"):
            setze typ auf ev["event_type"]
        setze pfad auf ""
        wenn ev.hat("file_path"):
            setze pfad auf ev["file_path"]
        setze zeit auf ""
        wenn ev.hat("created_at"):
            setze zeit auf ev["created_at"]
        ui_liste_zeile_hinzu(liste, [typ, pfad, zeit])
        setze i auf i + 1

funktion refresh_events_factory(name):
    gib_zurück () => events_laden(name)

funktion oeffne_event(name):
    wenn nicht offene_fenster.hat(name):
        gib_zurück nichts
    setze g auf offene_fenster[name]
    setze idx auf ui_liste_auswahl(g["liste_events"])
    wenn idx < 0:
        gib_zurück nichts
    setze zeile auf ui_liste_zeile(g["liste_events"], idx)
    setze pfad auf zeile[1]
    versuche:
        http_sende(DAEMON_URL + "/projects/" + name + "/open-file", pfad)
    fange e:
        setze ignore auf 0

funktion open_event_factory(name):
    gib_zurück () => oeffne_event(name)

# --------------------------------------------------------------
# Status-Tab: laden
# --------------------------------------------------------------
funktion status_laden(name):
    wenn nicht offene_fenster.hat(name):
        gib_zurück nichts
    setze g auf offene_fenster[name]
    setze resp auf safe_get(DAEMON_URL + "/projects/" + name + "/status")
    wenn resp == "":
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        gib_zurück nichts
    setze pfad auf "-"
    wenn info.hat("pfad"):
        setze pfad auf info["pfad"]
    setze aktiv auf "-"
    wenn info.hat("enabled"):
        wenn info["enabled"]:
            setze aktiv auf "ja"
        sonst:
            setze aktiv auf "nein"
    setze chunks auf "-"
    wenn info.hat("chunks"):
        setze chunks auf text(info["chunks"])
    setze files auf "-"
    wenn info.hat("files"):
        setze files auf text(info["files"])
    ui_label_setze(g["lbl_pfad"],   pfad)
    ui_label_setze(g["lbl_aktiv"],  aktiv)
    ui_label_setze(g["lbl_chunks"], chunks)
    ui_label_setze(g["lbl_files"],  files)

funktion refresh_status_factory(name):
    gib_zurück () => status_laden(name)

# --------------------------------------------------------------
# Aktionen-Tab: Reindex + Delete
# --------------------------------------------------------------
funktion reindex_projekt(name):
    setze g auf offene_fenster[name]
    wenn ui_frage(g["fenster"], "Neu indexieren?", "Projekt '" + name + "' komplett neu indexieren?"):
        safe_post(DAEMON_URL + "/projects/" + name + "/reindex", "")
        ui_info(g["fenster"], "Reindex", "Reindex gestartet. Fortschritt im Daemon-Log.")

funktion reindex_factory(name):
    gib_zurück () => reindex_projekt(name)

funktion loesche_projekt(name):
    setze parent auf nichts
    wenn offene_fenster.hat(name):
        setze parent auf offene_fenster[name]["fenster"]
    wenn ui_frage(parent, "Loeschen?", "Projekt '" + name + "' wirklich loeschen?\nIndex und Watcher-Eintrag werden entfernt.\nDer Ordner auf der Platte bleibt unberuehrt."):
        safe_post(DAEMON_URL + "/projects/" + name + "/delete", "")
        # Voller Rebuild — das Projekt-Set hat sich geaendert
        rebuild_menu()

funktion delete_factory(name):
    gib_zurück () => loesche_projekt(name)

# --------------------------------------------------------------
# Daemon-Start / Quit
# --------------------------------------------------------------
funktion daemon_starten():
    datei_schreiben(START_TRIGGER, "1")

funktion quit_app():
    datei_schreiben(STOP_TRIGGER, "")
    beende(0)

funktion noop():
    setze ignore auf 0

# --------------------------------------------------------------
# Projekt-Signatur fuer Diff (sortierte name-Liste als String)
# --------------------------------------------------------------
funktion projekt_signatur(projekte):
    setze namen auf []
    setze i auf 0
    solange i < länge(projekte):
        setze namen auf namen + [projekte[i]["name"]]
        setze i auf i + 1
    # Alphabetisch sortieren — dann ist Reihenfolge-stabil
    setze namen auf namen.sortieren()
    setze s auf ""
    setze j auf 0
    solange j < länge(namen):
        setze s auf s + namen[j] + "|"
        setze j auf j + 1
    gib_zurück s

# --------------------------------------------------------------
# Voller Menu-Rebuild (nur bei Projekt-Set-Aenderung oder Online-Wechsel)
# --------------------------------------------------------------
funktion rebuild_menu():
    tray_menu_clear(tray)
    setze projekt_handles auf {}

    setze resp auf safe_get(DAEMON_URL + "/projects")

    wenn resp == "":
        setze war_online auf falsch
        setze status_text auf "Daemon: OFFLINE"
        setze status_item auf tray_menu_add(tray, status_text, noop)
        tray_separator_add(tray)
        tray_menu_add(tray, "Daemon starten", daemon_starten)
        tray_menu_add(tray, "Beenden", quit_app)
        setze letzte_projekt_signatur auf ""
        gib_zurück nichts

    setze war_online auf wahr
    setze root auf json_lesen(resp)
    setze projekte auf []
    wenn typ_von(root) == "Woerterbuch":
        wenn root.hat("projekte"):
            setze projekte auf root["projekte"]

    setze status_text auf "Daemon: online"
    setze status_item auf tray_menu_add(tray, status_text, noop)
    tray_separator_add(tray)

    wenn länge(projekte) == 0:
        tray_menu_add(tray, "(keine Projekte)", noop)
    sonst:
        setze i auf 0
        solange i < länge(projekte):
            setze p auf projekte[i]
            setze name auf p["name"]
            setze enabled auf p["enabled"]
            setze sm auf tray_submenu_add(tray, name)
            setze check auf tray_check_add_to(sm, "Aktiv", enabled, toggle_factory(name))
            tray_separator_add_to(sm)
            tray_menu_add_to(sm, "Oeffnen...", detail_factory(name))
            tray_separator_add_to(sm)
            tray_menu_add_to(sm, "Loeschen...", delete_factory(name))
            projekt_handles[name] = { "sub": sm, "check": check, "enabled": enabled }
            setze i auf i + 1

    tray_separator_add(tray)
    tray_menu_add(tray, "Neu laden", rebuild_menu)
    tray_menu_add(tray, "Beenden", quit_app)

    setze letzte_projekt_signatur auf projekt_signatur(projekte)

# --------------------------------------------------------------
# Inkrementeller Update-Tick (alle 3 s) — NUR was sich aendert
# --------------------------------------------------------------
funktion update_tick():
    setze health auf safe_get(DAEMON_URL + "/health")
    setze jetzt_online auf falsch
    wenn health != "":
        setze jetzt_online auf wahr

    # Fall 1: Online-Status gewechselt → voller Rebuild
    wenn jetzt_online != war_online:
        rebuild_menu()
        gib_zurück nichts

    # Fall 2: Offline geblieben → nichts zu tun
    wenn nicht jetzt_online:
        gib_zurück nichts

    # Online: Projekt-Liste holen und diffen
    setze resp auf safe_get(DAEMON_URL + "/projects")
    wenn resp == "":
        gib_zurück nichts
    setze root auf json_lesen(resp)
    setze projekte auf []
    wenn typ_von(root) == "Woerterbuch":
        wenn root.hat("projekte"):
            setze projekte auf root["projekte"]

    setze sig auf projekt_signatur(projekte)

    # Fall 3: Projekt hinzugekommen/weggefallen → voller Rebuild
    wenn sig != letzte_projekt_signatur:
        rebuild_menu()
        gib_zurück nichts

    # Fall 4: Nur einzelne enabled-Flags koennten sich geaendert haben →
    # inkrementeller Update via tray_check_set. Kein Rebuild, kein Flimmern.
    setze i auf 0
    solange i < länge(projekte):
        setze p auf projekte[i]
        setze name auf p["name"]
        setze aktiv_neu auf p["enabled"]
        wenn projekt_handles.hat(name):
            setze ph auf projekt_handles[name]
            wenn ph["enabled"] != aktiv_neu:
                tray_check_set(ph["check"], aktiv_neu)
                ph["enabled"] = aktiv_neu
        setze i auf i + 1

# --------------------------------------------------------------
# Init + Event-Loop
#
# KEIN Timer. libappindicator/dbusmenu feuert bei jeder Property-
# Aenderung einen LayoutUpdated-DBus-Signal, was Plasma zu einem
# vollen Menu-Rebuild zwingt — Flackern. Der User triggert Updates
# per "Neu laden" oder implizit durch eigene Aktionen.
# --------------------------------------------------------------
rebuild_menu()
ui_laufen()
