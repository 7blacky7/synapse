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
# Mapping fenster-Handle (als text(num)) -> name. Wird vom Resize-Closure
# genutzt, damit dieser nur Number-Handle capturen muss (umgeht moo
# Closure-Refcount-Bug — String-Capture triggert Use-After-Free).
setze fenster_zu_name auf {}
setze fenster_zu_chatkey auf {}

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

    setze fenster auf ui_fenster("Projekt: " + name, 1500, 900, 1, nichts)
    g["fenster"] = fenster
    # Beim Close: Eintrag entfernen — GTK zerstoert das Widget, der
    # gecachte Pointer wird sonst beim naechsten Oeffnen zum Segfault.
    ui_fenster_on_close(fenster, close_factory(name))

    setze tabs auf ui_tabs(fenster, 10, 10, 1480, 840)
    g["tabs"] = tabs

    # --- Tab 1: Agenten ---
    setze tab_a auf ui_tab_hinzu(tabs, "Agenten")
    setze liste_a auf ui_liste(tab_a, ["Name", "Modell", "Status", "Tokens", "Letzte Aktivitaet"], 10, 10, 1450, 740)
    ui_liste_spalte_min_breite(liste_a, 0, 120)
    ui_liste_spalte_min_breite(liste_a, 1, 80)
    ui_liste_spalte_min_breite(liste_a, 2, 80)
    ui_liste_spalte_min_breite(liste_a, 3, 60)
    ui_liste_spalte_min_breite(liste_a, 4, 160)
    ui_liste_sortierbar(liste_a, 0, wahr)
    ui_liste_sortierbar(liste_a, 1, wahr)
    ui_liste_sortierbar(liste_a, 2, wahr)
    ui_liste_sortierbar(liste_a, 3, wahr)
    ui_liste_sortierbar(liste_a, 4, wahr)
    g["liste_agents"] = liste_a
    setze btn_stop auf ui_knopf(tab_a, "Stoppen",        10, 760, 120, 32, stop_agent_factory(name))
    setze btn_ref_a auf ui_knopf(tab_a, "Aktualisieren", 140, 760, 140, 32, refresh_agents_factory(name))
    g["btn_stop_a"] = btn_stop
    g["btn_ref_a"]  = btn_ref_a

    # --- Tab 2: Events (Synapse file_versions History) ---
    setze tab_e auf ui_tab_hinzu(tabs, "Events")
    # Filter-Eingabe oben — leer = alles, sonst Substring-Filter
    # ueber Datei/Agent/Reason/Feature. Live-Update on_change.
    setze lbl_filter_e auf ui_label(tab_e, "Filter:", 10, 12, 60, 24)
    setze filter_e auf ui_eingabe(tab_e, 70, 10, 1380, 28, "Substring in Datei/Agent/Reason/Feature...", falsch)
    ui_eingabe_on_change(filter_e, refresh_events_factory(name))
    ui_eingabe_on_enter(filter_e, refresh_events_factory(name))
    g["filter_events"] = filter_e
    g["lbl_filter_e"] = lbl_filter_e
    setze liste_e auf ui_liste(tab_e, ["Zeit", "Agent", "Datei", "Aktion", "Reason", "Feature"], 10, 50, 1450, 700)
    ui_liste_spalte_min_breite(liste_e, 0, 130)
    ui_liste_spalte_min_breite(liste_e, 1, 100)
    ui_liste_spalte_min_breite(liste_e, 2, 200)
    ui_liste_spalte_min_breite(liste_e, 3, 70)
    ui_liste_spalte_min_breite(liste_e, 4, 250)
    ui_liste_spalte_min_breite(liste_e, 5, 120)
    ui_liste_sortierbar(liste_e, 0, wahr)
    ui_liste_sortierbar(liste_e, 1, wahr)
    ui_liste_sortierbar(liste_e, 2, wahr)
    ui_liste_sortierbar(liste_e, 3, wahr)
    ui_liste_sortierbar(liste_e, 4, wahr)
    ui_liste_sortierbar(liste_e, 5, wahr)
    g["liste_events"] = liste_e
    setze btn_ref_e auf ui_knopf(tab_e, "Aktualisieren", 10, 760, 140, 32, refresh_events_factory(name))
    setze btn_open_e auf ui_knopf(tab_e, "Oeffnen",      160, 760, 120, 32, open_event_factory(name))
    g["btn_ref_e"]  = btn_ref_e
    g["btn_open_e"] = btn_open_e

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

    # Resize-Layout: Number-Handle-Capture-Pattern (moo-runtime-dev).
    # Closure capturet NUR den Fenster-Handle (Number, kein Refcount).
    # Der eigentliche String 'name' wird via Dict-Lookup geholt; das Dict
    # retain-t den Wert selbst, kein Closure-Refcount-Bug mehr.
    fenster_zu_name[text(fenster)] = name
    # A/B-TEST: Resize-Hook AUS — Drag im isolierten Test-Programm geht.
    # Verdacht: on_resize size-allocate ueberschreibt Drag-Grip-Layout.
    # ui_fenster_on_resize(fenster, (b, h) => layout_projekt_via_handle(fenster, b, h))
    ui_zeige(fenster)
    agents_laden(name)
    events_laden(name)
    status_laden(name)

# Reposition aller Widgets im Projekt-Fenster bei Resize.
# (b, h) ist die neue Fenster-Innengroesse vom GTK configure-event.
funktion layout_projekt(name, b, h):
    # Defensive Guards (moo-runtime-dev Tipp C)
    wenn name == nichts:
        gib_zurück nichts
    wenn nicht offene_fenster.hat(name):
        gib_zurück nichts
    setze g auf offene_fenster[name]
    # closed-Flag check: GTK-size-allocate kann auch nach Fenster-Close
    # noch feuern. ui_groesse_setze auf zerstoertem Widget = segfault.
    wenn g.hat("closed"):
        wenn g["closed"]:
            gib_zurück nichts
    # Min-Clamp: GTK ui_groesse_setze mit Werten <= 0 oder negativ
    # fuehrt zu Segfault. Beim manuellen Verkleinern unter unsere
    # Layout-Annahmen koennen Differenzen negativ werden.
    setze tabs_b auf b - 20
    wenn tabs_b < 50:
        setze tabs_b auf 50
    setze tabs_h auf h - 60
    wenn tabs_h < 50:
        setze tabs_h auf 50
    ui_groesse_setze(g["tabs"], tabs_b, tabs_h)
    setze inner_b auf tabs_b - 30
    wenn inner_b < 30:
        setze inner_b auf 30
    setze list_h auf tabs_h - 100
    wenn list_h < 30:
        setze list_h auf 30
    setze btn_y auf list_h + 20
    ui_groesse_setze(g["liste_agents"], inner_b, list_h)
    ui_position_setze(g["btn_stop_a"], 10,  btn_y)
    ui_position_setze(g["btn_ref_a"],  140, btn_y)
    # Events-Tab: Filter-Zeile oben (y=10), Liste startet bei y=50, Buttons unten.
    setze events_list_h auf list_h - 40
    wenn events_list_h < 30:
        setze events_list_h auf 30
    setze filter_b auf inner_b - 60
    wenn filter_b < 100:
        setze filter_b auf 100
    wenn g.hat("filter_events"):
        ui_groesse_setze(g["filter_events"], filter_b, 28)
    ui_groesse_setze(g["liste_events"], inner_b, events_list_h)
    ui_position_setze(g["btn_ref_e"],  10,  btn_y)
    ui_position_setze(g["btn_open_e"], 160, btn_y)

funktion layout_projekt_via_handle(fenster, b, h):
    # Number-Handle-Capture-Workaround: Closure capturet fenster (Number,
    # ohne Refcount), wir holen den name aus dem globalen Dict (Dict
    # retain-t Strings selbstaendig).
    setze key auf text(fenster)
    wenn nicht fenster_zu_name.hat(key):
        gib_zurück nichts
    setze name auf fenster_zu_name[key]
    layout_projekt(name, b, h)

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
    # Busy-Guard: re-entrancy bei mehrfachen Aktualisieren-Klicks blockt
    # http_hole sonst den UI-Thread und kann waehrend Specialist-Spawning
    # zum Crash fuehren.
    wenn g.hat("busy_agents"):
        wenn g["busy_agents"]:
            gib_zurück nichts
    g["busy_agents"] = wahr
    setze liste auf g["liste_agents"]
    ui_liste_leeren(liste)
    setze resp auf safe_get(DAEMON_URL + "/projects/" + name + "/specialists")
    wenn resp == "":
        g["busy_agents"] = falsch
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
    ui_liste_spalten_autosize(liste)
    g["busy_agents"] = falsch

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
    wenn g.hat("busy_events"):
        wenn g["busy_events"]:
            gib_zurück nichts
    g["busy_events"] = wahr
    setze liste auf g["liste_events"]
    ui_liste_leeren(liste)
    # Quelle: file_versions-Tabelle (Synapse-eigene "Commits" mit reason).
    setze resp auf safe_get(DAEMON_URL + "/projects/" + name + "/file_versions?limit=200")
    wenn resp == "":
        g["busy_events"] = falsch
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        g["busy_events"] = falsch
        gib_zurück nichts
    wenn nicht info.hat("versions"):
        g["busy_events"] = falsch
        gib_zurück nichts
    setze versions auf info["versions"]
    # Filter-Substring (kann leer sein -> alles)
    setze filter_text auf ""
    wenn g.hat("filter_events"):
        setze filter_text auf ui_eingabe_text(g["filter_events"])
    setze i auf 0
    solange i < länge(versions):
        setze v auf versions[i]
        setze zeit auf ""
        wenn v.hat("created_at"):
            setze zeit auf v["created_at"]
        # Wenn agent_id null/leer ist: explizit "<unbekannt>" — damit der
        # Edit nicht "unsichtbar" wirkt. Heute's agent-id-auto-propagation
        # Mission sorgt dafuer dass das nie wieder vorkommt; Altdaten
        # (z.B. gemini-Iter4 Edits 15:17-15:20) bleiben so.
        setze agent auf "<unbekannt>"
        wenn v.hat("agent_id"):
            wenn typ_von(v["agent_id"]) == "Text":
                wenn v["agent_id"] != "":
                    setze agent auf v["agent_id"]
        setze pfad auf ""
        wenn v.hat("file_path"):
            setze pfad auf v["file_path"]
        setze aktion auf ""
        wenn v.hat("edit_action"):
            wenn typ_von(v["edit_action"]) == "Text":
                setze aktion auf v["edit_action"]
        setze reason auf ""
        wenn v.hat("reason"):
            wenn typ_von(v["reason"]) == "Text":
                setze reason auf v["reason"]
        setze feature auf ""
        wenn v.hat("feature_tag"):
            wenn typ_von(v["feature_tag"]) == "Text":
                setze feature auf v["feature_tag"]
        # Filter: Substring (case-insensitive nicht trivial in moo, daher
        # exakt) ueber agent/pfad/reason/feature.
        setze passt auf wahr
        wenn filter_text != "":
            setze haystack auf agent + " " + pfad + " " + reason + " " + feature
            wenn nicht haystack.enthält(filter_text):
                setze passt auf falsch
        wenn passt:
            ui_liste_zeile_hinzu(liste, [zeit, agent, pfad, aktion, reason, feature])
        setze i auf i + 1
    ui_liste_spalten_autosize(liste)
    g["busy_events"] = falsch

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
    # Liste-Spalten: [Zeit, Agent, Datei, Aktion, Reason, Feature]
    setze pfad auf zeile[2]
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
    wenn g.hat("busy_status"):
        wenn g["busy_status"]:
            gib_zurück nichts
    g["busy_status"] = wahr
    setze resp auf safe_get(DAEMON_URL + "/projects/" + name + "/status")
    wenn resp == "":
        g["busy_status"] = falsch
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
    g["busy_status"] = falsch

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
# Chat: Channel-Liste + Chat-Fenster
# --------------------------------------------------------------
# Geoeffnete Chat-Fenster: (projekt, channel) -> { fenster, liste_msgs, ... }
setze chat_fenster auf {}

# Channels eines Projekts laden und ins Submenu einhaengen
funktion channel_submenu_fuellen(parent_submenu, projekt):
    setze resp auf safe_get(DAEMON_URL + "/projects/" + projekt + "/channels")
    wenn resp == "":
        tray_menu_add_to(parent_submenu, "(Daemon offline)", noop)
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        tray_menu_add_to(parent_submenu, "(Fehler)", noop)
        gib_zurück nichts
    wenn nicht info.hat("channels"):
        tray_menu_add_to(parent_submenu, "(keine Channels)", noop)
        gib_zurück nichts
    setze chs auf info["channels"]
    wenn länge(chs) == 0:
        tray_menu_add_to(parent_submenu, "(keine Channels)", noop)
        gib_zurück nichts
    setze i auf 0
    solange i < länge(chs):
        setze ch auf chs[i]
        setze ch_name auf ch["name"]
        tray_menu_add_to(parent_submenu, "# " + ch_name, chat_oeffnen_factory(projekt, ch_name))
        setze i auf i + 1

funktion chat_oeffnen_factory(projekt, channel):
    gib_zurück () => oeffne_chat(projekt, channel)

# Chat-Fenster pro (Projekt, Channel) — Nachrichten/Agenten/Input
funktion oeffne_chat(projekt, channel):
    setze schluessel auf projekt + "::" + channel
    wenn chat_fenster.hat(schluessel):
        setze g auf chat_fenster[schluessel]
        wenn nicht g.hat("closed"):
            ui_zeige(g["fenster"])
            chat_messages_laden(schluessel)
            chat_agents_laden(schluessel)
            gib_zurück nichts

    setze g auf {}
    chat_fenster[schluessel] = g
    g["projekt"] = projekt
    g["channel"] = channel
    g["schluessel"] = schluessel

    setze fenster auf ui_fenster("Chat: " + channel + " (" + projekt + ")", 1200, 800, 1, nichts)
    g["fenster"] = fenster
    ui_fenster_on_close(fenster, chat_close_factory(schluessel))

    # Nachrichten-Liste (links-oben, breit)
    setze lbl_msgs auf ui_label(fenster, "Nachrichten:", 10, 10, 200, 20)
    setze liste_m auf ui_liste(fenster, ["Zeit", "Absender", "Nachricht"], 10, 35, 880, 670)
    ui_liste_spalte_min_breite(liste_m, 0, 80)
    ui_liste_spalte_min_breite(liste_m, 1, 100)
    ui_liste_spalte_min_breite(liste_m, 2, 300)
    ui_liste_sortierbar(liste_m, 0, wahr)
    ui_liste_sortierbar(liste_m, 1, wahr)
    ui_liste_sortierbar(liste_m, 2, wahr)
    g["liste_msgs"] = liste_m
    g["lbl_msgs"]   = lbl_msgs

    # Agenten-Liste (rechts)
    setze lbl_ag auf ui_label(fenster, "Agenten im Projekt:", 900, 10, 290, 20)
    setze liste_a auf ui_liste(fenster, ["Name", "Modell"], 900, 35, 290, 670)
    ui_liste_spalte_min_breite(liste_a, 0, 120)
    ui_liste_spalte_min_breite(liste_a, 1, 80)
    ui_liste_sortierbar(liste_a, 0, wahr)
    ui_liste_sortierbar(liste_a, 1, wahr)
    g["liste_agents"] = liste_a
    g["lbl_ag"]       = lbl_ag

    # Input + Senden
    setze lbl_in auf ui_label(fenster, "Nachricht:", 10, 715, 100, 20)
    setze eingabe auf ui_eingabe(fenster, 10, 740, 990, 32, "Hier tippen...", falsch)
    g["eingabe"] = eingabe
    g["lbl_in"]  = lbl_in
    # Enter-Taste sendet (Bind aus moo nacht-session/moo-gtk-event-hooks).
    ui_eingabe_on_enter(eingabe, chat_senden_factory(schluessel))
    setze btn_send auf ui_knopf(fenster, "Senden",        1010, 740, 80, 32, chat_senden_factory(schluessel))
    setze btn_ref auf ui_knopf(fenster, "Aktualisieren", 1095, 740, 85, 32, chat_refresh_factory(schluessel))
    g["btn_send"] = btn_send
    g["btn_ref"]  = btn_ref

    # Resize-Layout: Number-Handle-Capture-Pattern (siehe layout_projekt).
    fenster_zu_chatkey[text(fenster)] = schluessel
    # A/B-TEST: Resize-Hook AUS (siehe Projekt-Fenster)
    # ui_fenster_on_resize(fenster, (b, h) => layout_chat_via_handle(fenster, b, h))
    ui_zeige(fenster)
    chat_messages_laden(schluessel)
    chat_agents_laden(schluessel)

# Reposition aller Widgets im Chat-Fenster bei Resize.
funktion layout_chat(schluessel, b, h):
    # Defensive Guards
    wenn schluessel == nichts:
        gib_zurück nichts
    wenn nicht chat_fenster.hat(schluessel):
        gib_zurück nichts
    setze g auf chat_fenster[schluessel]
    # closed-Flag check: GTK-size-allocate feuert auch nach Close,
    # ui_groesse_setze auf totem Widget = segfault.
    wenn g.hat("closed"):
        wenn g["closed"]:
            gib_zurück nichts
    # Aufteilung: Nachrichten links breit, Agenten rechts schmal.
    # Min-Clamps gegen negative Werte beim Verkleinern (= Segfault in GTK).
    setze rechts_b auf 290
    wenn b < 600:
        setze rechts_b auf b / 4
    wenn rechts_b < 60:
        setze rechts_b auf 60
    setze links_b auf b - rechts_b - 30
    wenn links_b < 100:
        setze links_b auf 100
    setze listen_h auf h - 130
    wenn listen_h < 50:
        setze listen_h auf 50
    # Nachrichten-Liste links
    ui_position_setze(g["lbl_msgs"], 10, 10)
    ui_groesse_setze(g["liste_msgs"], links_b, listen_h)
    # Agenten-Liste rechts
    setze rechts_x auf links_b + 20
    ui_position_setze(g["lbl_ag"], rechts_x, 10)
    ui_groesse_setze(g["lbl_ag"], rechts_b, 20)
    ui_position_setze(g["liste_agents"], rechts_x, 35)
    ui_groesse_setze(g["liste_agents"], rechts_b, listen_h)
    # Eingabe + Buttons unten
    setze in_y auf listen_h + 60
    setze in_b auf b - 220
    wenn in_b < 100:
        setze in_b auf 100
    ui_position_setze(g["lbl_in"], 10, in_y - 25)
    ui_position_setze(g["eingabe"], 10, in_y)
    ui_groesse_setze(g["eingabe"], in_b, 32)
    ui_position_setze(g["btn_send"], in_b + 20, in_y)
    ui_position_setze(g["btn_ref"], in_b + 105, in_y)

funktion layout_chat_via_handle(fenster, b, h):
    setze key auf text(fenster)
    wenn nicht fenster_zu_chatkey.hat(key):
        gib_zurück nichts
    setze schluessel auf fenster_zu_chatkey[key]
    layout_chat(schluessel, b, h)

funktion chat_close_factory(schluessel):
    gib_zurück () => chat_fenster_schliessen(schluessel)

funktion chat_fenster_schliessen(schluessel):
    wenn chat_fenster.hat(schluessel):
        setze g auf chat_fenster[schluessel]
        g["closed"] = wahr
    gib_zurück wahr

funktion chat_messages_laden(schluessel):
    wenn nicht chat_fenster.hat(schluessel):
        gib_zurück nichts
    setze g auf chat_fenster[schluessel]
    # Busy-Guard gegen reentrancy (siehe agents_laden)
    wenn g.hat("busy_msgs"):
        wenn g["busy_msgs"]:
            gib_zurück nichts
    g["busy_msgs"] = wahr
    setze projekt auf g["projekt"]
    setze channel auf g["channel"]
    setze liste auf g["liste_msgs"]
    ui_liste_leeren(liste)
    setze resp auf safe_get(DAEMON_URL + "/projects/" + projekt + "/channels/" + channel + "/feed?limit=50")
    wenn resp == "":
        g["busy_msgs"] = falsch
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        gib_zurück nichts
    wenn nicht info.hat("messages"):
        gib_zurück nichts
    setze msgs auf info["messages"]
    setze i auf 0
    solange i < länge(msgs):
        setze m auf msgs[i]
        setze zeit auf ""
        wenn m.hat("created_at"):
            setze zeit auf m["created_at"]
        setze sender auf ""
        wenn m.hat("sender"):
            setze sender auf m["sender"]
        setze inhalt auf ""
        wenn m.hat("content"):
            setze inhalt auf m["content"]
        ui_liste_zeile_hinzu(liste, [zeit, sender, inhalt])
        setze i auf i + 1
    # Auto-Scroll zur letzten Nachricht (Open + Refresh + nach Senden).
    # Nutzt ui_liste_scroll_unten aus moo nacht-session/moo-gtk-event-hooks.
    ui_liste_spalten_autosize(liste)
    ui_liste_scroll_unten(liste)
    g["busy_msgs"] = falsch

funktion chat_agents_laden(schluessel):
    wenn nicht chat_fenster.hat(schluessel):
        gib_zurück nichts
    setze g auf chat_fenster[schluessel]
    wenn g.hat("busy_chat_agents"):
        wenn g["busy_chat_agents"]:
            gib_zurück nichts
    g["busy_chat_agents"] = wahr
    setze projekt auf g["projekt"]
    setze liste auf g["liste_agents"]
    ui_liste_leeren(liste)
    setze resp auf safe_get(DAEMON_URL + "/projects/" + projekt + "/agents")
    wenn resp == "":
        g["busy_chat_agents"] = falsch
        gib_zurück nichts
    setze info auf json_lesen(resp)
    wenn typ_von(info) != "Woerterbuch":
        gib_zurück nichts
    wenn nicht info.hat("agents"):
        gib_zurück nichts
    setze ags auf info["agents"]
    setze i auf 0
    solange i < länge(ags):
        setze a auf ags[i]
        setze id auf ""
        wenn a.hat("id"):
            setze id auf a["id"]
        setze modell auf ""
        wenn a.hat("model"):
            wenn typ_von(a["model"]) == "Text":
                setze modell auf a["model"]
        ui_liste_zeile_hinzu(liste, [id, modell])
        setze i auf i + 1
    ui_liste_spalten_autosize(liste)
    g["busy_chat_agents"] = falsch

funktion chat_senden_factory(schluessel):
    gib_zurück () => chat_senden(schluessel)

funktion chat_senden(schluessel):
    wenn nicht chat_fenster.hat(schluessel):
        gib_zurück nichts
    setze g auf chat_fenster[schluessel]
    setze projekt auf g["projekt"]
    setze channel auf g["channel"]
    setze inhalt auf ui_eingabe_text(g["eingabe"])
    wenn inhalt == "":
        gib_zurück nichts
    setze payload auf { "sender": "synapse-tray", "content": inhalt }
    setze r auf http_sende(DAEMON_URL + "/projects/" + projekt + "/channels/" + channel + "/post", payload)
    # Input leeren, Feed neu laden
    ui_eingabe_setze(g["eingabe"], "")
    chat_messages_laden(schluessel)

funktion chat_refresh_factory(schluessel):
    gib_zurück () => chat_refresh(schluessel)

funktion chat_refresh(schluessel):
    chat_messages_laden(schluessel)
    chat_agents_laden(schluessel)

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
        tray_menu_add(tray, "Neu laden", rebuild_menu)
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
            # Channels flach im Projekt-Submenu — moo kennt (noch)
            # keine nested submenus. Jeder Channel als "# name"-Eintrag.
            channel_submenu_fuellen(sm, name)
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
