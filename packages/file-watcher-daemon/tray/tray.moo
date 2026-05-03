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
importiere pg_client

konstante DAEMON_URL auf "http://127.0.0.1:7878"
konstante PG_HOST auf "192.168.50.65"
konstante PG_PORT auf 5432
konstante PG_USER auf "synapse"
konstante PG_DB   auf "synapse"

# Globaler PG-Client. Liste-Lese-Pfade gehen direkt auf Postgres
# (specialist_channel_messages, agent_sessions, file_versions, wrapper_status),
# kein HTTP+JSON-Daemon-Roundtrip mehr. Schreib-Pfade (chat_senden) bleiben
# HTTP — Daemon hat NOTIFY-Trigger fuer Live-Subscriptions.
setze pg_db auf nichts
setze pg_letzte_fehler auf ""

funktion pg_init():
    versuche:
        setze pg_db auf neu PgClient(PG_HOST, PG_PORT, PG_USER, PG_DB)
        pg_db.verbinde()
        wenn nicht pg_db.ready:
            setze pg_letzte_fehler auf "PG nicht ready: " + text(pg_db.letzte_fehler)
            setze pg_db auf nichts
    fange e:
        setze pg_letzte_fehler auf "PG verbinde Exception"
        setze pg_db auf nichts

# SQL-Literal-Escape fuer simple-query (Postgres '): doppeltes Apostroph.
# Inputs: projekt-name, channel-name — keine User-Eingabe, aber defensiv.
funktion sql_quote(s):
    gib_zurück "'" + s.ersetzen("'", "''") + "'"

# Wrapper: queryt PG, reconnect bei Verbindungsabbruch. Gibt Result-Dict
# zurueck oder nichts bei Fehler. Caller sollte auf nichts pruefen.
funktion pg_query(sql):
    wenn pg_db == nichts:
        pg_init()
        wenn pg_db == nichts:
            gib_zurück nichts
    versuche:
        setze r auf pg_db.frage(sql)
        wenn r["fehler"] != nichts:
            setze pg_letzte_fehler auf text(r["fehler"])
        gib_zurück r
    fange e:
        # Connection lost. Reset + reconnect on next call.
        setze pg_db auf nichts
        gib_zurück nichts
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
# Filter-Eingabe-Handle → projekt-name. Number-Capture-Workaround:
# on_change feuert pro Tastendruck, String-Capture-Closure crasht
# (moo Closure-Multi-Call-Refcount-Bug, Memory bug-closure-segfault).
setze filter_zu_name auf {}
# Aktives Projekt-Detail-Fenster (fuer Knopf-Callbacks ohne Capture).
# Wird in oeffne_detail gesetzt. Edge-Case: mehrere Detail-Fenster
# parallel — Knoepfe wirken auf das zuletzt geoeffnete.
setze aktiv_projekt auf { "v": "" }
# Aktiver Chat-Schluessel fuer den globalen Tastenbindungs-Handler.
# Als Dict damit Schreiben aus Funktionen die globale Variable trifft
# (setze in funktion = lokal!). Schluessel "v" haelt den aktiven Wert.
setze aktiv_chat auf { "v": "" }

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

# Tray-Submenu Aktiv-Checkbox: Capture-frei via menue_eintrag_data.
funktion toggle_aktiv_via_menu():
    setze item auf ui_menue_eintrag_aktiv()
    setze name auf ui_menue_eintrag_lookup(item)
    wenn name == nichts:
        gib_zurück nichts
    toggle_projekt(name)

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
    aktiv_projekt["v"] = name

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
    setze btn_stop auf ui_knopf(tab_a, "Stoppen",        10, 760, 120, 32, stoppe_ausgewaehlten_global)
    setze btn_ref_a auf ui_knopf(tab_a, "Aktualisieren", 140, 760, 140, 32, agents_laden_global)
    g["btn_stop_a"] = btn_stop
    g["btn_ref_a"]  = btn_ref_a

    # --- Tab 2: Events (Synapse file_versions History) ---
    setze tab_e auf ui_tab_hinzu(tabs, "Events")
    # Filter-Eingabe oben — leer = alles, sonst Substring-Filter
    # ueber Datei/Agent/Reason/Feature. Live-Update on_change.
    setze lbl_filter_e auf ui_label(tab_e, "Filter:", 10, 12, 60, 24)
    setze filter_e auf ui_eingabe(tab_e, 70, 10, 1380, 28, "Substring in Datei/Agent/Reason/Feature...", falsch)
    # Capture-frei: top-level Handler liest aktiv_projekt[v].
    ui_eingabe_on_change(filter_e, events_laden_global)
    ui_eingabe_on_enter(filter_e, events_laden_global)
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
    setze btn_ref_e auf ui_knopf(tab_e, "Aktualisieren", 10, 760, 140, 32, events_laden_global)
    setze btn_open_e auf ui_knopf(tab_e, "Oeffnen",      160, 760, 120, 32, oeffne_event_global)
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
    ui_knopf(tab_s, "Aktualisieren", 10, 140, 140, 32, status_laden_global)

    # --- Tab 4: Aktionen ---
    setze tab_ak auf ui_tab_hinzu(tabs, "Aktionen")
    ui_knopf(tab_ak, "Neu indexieren", 10, 10,   200, 36, reindex_projekt_global)
    ui_knopf(tab_ak, "Projekt loeschen", 10, 60, 200, 36, loesche_projekt_global)

    # Resize-Layout: Number-Handle-Capture-Pattern (moo-runtime-dev).
    # Closure capturet NUR den Fenster-Handle (Number, kein Refcount).
    # Der eigentliche String 'name' wird via Dict-Lookup geholt; das Dict
    # retain-t den Wert selbst, kein Closure-Refcount-Bug mehr.
    fenster_zu_name[text(fenster)] = name
    ui_fenster_on_resize(fenster, (b, h) => layout_projekt(aktiv_projekt["v"], b, h))
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

# Tray-Submenu Oeffnen: Capture-frei via menue_eintrag_data.
funktion oeffne_detail_via_menu():
    setze item auf ui_menue_eintrag_aktiv()
    setze name auf ui_menue_eintrag_lookup(item)
    wenn name == nichts:
        gib_zurück nichts
    oeffne_detail(name)

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
    wenn g.hat("busy_agents"):
        wenn g["busy_agents"]:
            gib_zurück nichts
    g["busy_agents"] = wahr
    setze first_load auf nicht g.hat("agents_init_done")
    setze liste auf g["liste_agents"]
    # PG-Direkt: wrapper_status (Specialists-Live-State)
    setze sql auf "SELECT agent_name, COALESCE(model, '') AS model, status, COALESCE(tokens_percent::text, '0') AS tok, COALESCE(last_activity::text, '') AS letzte FROM wrapper_status WHERE project = " + sql_quote(name) + " ORDER BY last_activity DESC NULLS LAST"
    setze r auf pg_query(sql)
    wenn r == nichts:
        g["busy_agents"] = falsch
        gib_zurück nichts
    wenn r["fehler"] != nichts:
        g["busy_agents"] = falsch
        gib_zurück nichts
    ui_liste_leeren(liste)
    setze rows auf []
    setze msgs auf r["rows"]
    setze i auf 0
    solange i < länge(msgs):
        setze sp auf msgs[i]
        rows.hinzufügen([sp["agent_name"], sp["model"], sp["status"], sp["tok"] + "%", sp["letzte"]])
        setze i auf i + 1
    ui_liste_zeilen_hinzu_bulk(liste, rows)
    wenn first_load:
        ui_liste_spalten_autosize(liste)
    g["agents_init_done"] = wahr
    g["busy_agents"] = falsch

funktion refresh_agents_factory(name):
    gib_zurück () => agents_laden(name)

# Globale Top-Level-Handler ohne Capture (vermeidet Closure-Multi-Call-
# Refcount-Bug). Lesen aktiv_projekt["v"] beim Aufruf.
funktion agents_laden_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    agents_laden(name)

funktion stoppe_ausgewaehlten_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    stoppe_ausgewaehlten(name)

funktion events_laden_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    events_laden(name)

funktion oeffne_event_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    oeffne_event(name)

funktion status_laden_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    status_laden(name)

funktion reindex_projekt_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    reindex_projekt(name)

funktion loesche_projekt_global():
    setze name auf aktiv_projekt["v"]
    wenn name == "":
        gib_zurück nichts
    loesche_projekt(name)

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
    setze first_load auf nicht g.hat("events_init_done")
    setze liste auf g["liste_events"]
    # PG-Direkt: file_versions
    setze sql auf "SELECT id::text, COALESCE(file_path, '') AS file_path, COALESCE(edit_action, '') AS edit_action, COALESCE(agent_id, '<unbekannt>') AS agent_id, COALESCE(reason, '') AS reason, COALESCE(feature_tag, '') AS feature_tag, to_char(created_at, 'DD.MM. HH24:MI:SS') AS zeit FROM file_versions WHERE project = " + sql_quote(name) + " ORDER BY id DESC LIMIT 50"
    setze r auf pg_query(sql)
    wenn r == nichts:
        g["busy_events"] = falsch
        gib_zurück nichts
    wenn r["fehler"] != nichts:
        g["busy_events"] = falsch
        gib_zurück nichts
    setze versions auf r["rows"]
    ui_liste_leeren(liste)
    setze rows auf []
    setze filter_text auf ""
    wenn g.hat("filter_events"):
        setze filter_text auf ui_eingabe_text(g["filter_events"])
    setze i auf 0
    solange i < länge(versions):
        setze v auf versions[i]
        setze zeit auf v["zeit"]
        setze agent auf v["agent_id"]
        wenn agent == "":
            setze agent auf "<unbekannt>"
        setze pfad auf v["file_path"]
        setze aktion auf v["edit_action"]
        setze reason auf v["reason"]
        setze feature auf v["feature_tag"]
        setze passt auf wahr
        wenn filter_text != "":
            setze haystack auf agent + " " + pfad + " " + reason + " " + feature
            wenn nicht haystack.enthält(filter_text):
                setze passt auf falsch
        wenn passt:
            rows.hinzufügen([zeit, agent, pfad, aktion, reason, feature])
        setze i auf i + 1
    ui_liste_zeilen_hinzu_bulk(liste, rows)
    wenn first_load:
        ui_liste_spalten_autosize(liste)
    g["events_init_done"] = wahr
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
        g["busy_status"] = falsch
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

# Tray-Submenu Loeschen: Capture-frei via menue_eintrag_data.
funktion loesche_projekt_via_menu():
    setze item auf ui_menue_eintrag_aktiv()
    setze name auf ui_menue_eintrag_lookup(item)
    wenn name == nichts:
        gib_zurück nichts
    loesche_projekt(name)

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
        setze it_ch auf tray_menu_add_to(parent_submenu, "# " + ch_name, oeffne_chat_via_menu)
        ui_menue_eintrag_data(it_ch, projekt + "::" + ch_name)
        setze i auf i + 1

# Tray-Submenu Channel-Oeffnen: key = projekt + "::" + channel.
funktion oeffne_chat_via_menu():
    setze item auf ui_menue_eintrag_aktiv()
    setze key auf ui_menue_eintrag_lookup(item)
    wenn key == nichts:
        gib_zurück nichts
    setze parts auf key.teilen("::")
    wenn länge(parts) < 2:
        gib_zurück nichts
    oeffne_chat(parts[0], parts[1])

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
    setze liste_m auf ui_liste(fenster, ["Zeit", "Absender", "Nachricht"], 10, 35, 880, 620)
    ui_liste_spalte_min_breite(liste_m, 0, 130)
    ui_liste_spalte_min_breite(liste_m, 1, 100)
    ui_liste_spalte_min_breite(liste_m, 2, 300)
    ui_liste_sortierbar(liste_m, 0, wahr)
    ui_liste_sortierbar(liste_m, 1, wahr)
    ui_liste_sortierbar(liste_m, 2, wahr)
    # Rechtsklick auf Nachricht-Zeile kopiert Inhalt direkt ins Clipboard
    # (globaler Handler, vermeidet Closure-Capture-Bugs).
    ui_liste_on_rechtsklick(liste_m, chat_msg_rechtsklick_global)
    g["liste_msgs"] = liste_m
    g["lbl_msgs"]   = lbl_msgs

    # Agenten-Liste (rechts)
    setze lbl_ag auf ui_label(fenster, "Agenten im Projekt:", 900, 10, 290, 20)
    setze liste_a auf ui_liste(fenster, ["Name", "Modell"], 900, 35, 290, 620)
    ui_liste_spalte_min_breite(liste_a, 0, 120)
    ui_liste_spalte_min_breite(liste_a, 1, 80)
    ui_liste_sortierbar(liste_a, 0, wahr)
    ui_liste_sortierbar(liste_a, 1, wahr)
    g["liste_agents"] = liste_a
    g["lbl_ag"]       = lbl_ag

    # Input + Senden — Multi-Line via ui_textbereich (Shift+Enter = neue Zeile, Enter = senden).
    setze lbl_in auf ui_label(fenster, "Nachricht (Enter=Senden, Shift+Enter=neue Zeile):", 10, 665, 500, 20)
    setze eingabe auf ui_textbereich(fenster, 10, 690, 990, 80)
    g["eingabe"] = eingabe
    g["lbl_in"]  = lbl_in
    # Tastenbindung: globaler Handler, kein Closure-Capture (4-arg
    # Closures mit Capture crashen moo). Aktiven Chat ueber Dict setzen.
    aktiv_chat["v"] = schluessel
    ui_textbereich_on_key(eingabe, chat_key_handler_global)
    setze btn_send auf ui_knopf(fenster, "Senden",        1010, 690, 80, 36, chat_senden_global)
    setze btn_ref auf ui_knopf(fenster, "Aktualisieren", 1095, 690, 85, 36, chat_refresh_global)
    g["btn_send"] = btn_send
    g["btn_ref"]  = btn_ref

    # Resize-Layout: Number-Handle-Capture-Pattern (siehe layout_projekt).
    fenster_zu_chatkey[text(fenster)] = schluessel
    ui_fenster_on_resize(fenster, (b, h) => layout_chat(aktiv_chat["v"], b, h))
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
    setze listen_h auf h - 180
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
    ui_groesse_setze(g["eingabe"], in_b, 80)
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
    # Inkrementelle Liste: erstes Mal voll laden, danach nur neue
    # Nachrichten anhaengen. Verhindert Scroll-Reset bei refresh.
    setze first_load auf wahr
    wenn g.hat("init_done"):
        wenn g["init_done"]:
            setze first_load auf falsch
    setze last_id auf 0
    wenn g.hat("last_msg_id"):
        setze last_id auf g["last_msg_id"]
    # Sticky-bottom: Scroll-Position VOR dem Mutieren ermitteln.
    # Bei first_load ist Liste leer → ist_unten=wahr → wir scrollen
    # nachher bewusst ans Ende.
    setze war_unten auf ui_liste_ist_unten(liste)
    wenn first_load:
        ui_liste_leeren(liste)
    # PG-Direkt: specialist_channel_messages JOIN specialist_channels.
    # first_load: letzten 50 Messages (DESC, dann reversed). Refresh: nur
    # neue Messages > last_msg_id (incremental append, sticky-bottom-stabil).
    setze sql auf ""
    wenn first_load:
        setze sql auf "SELECT m.id::text AS id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') AS zeit FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = " + sql_quote(projekt) + " AND c.name = " + sql_quote(channel) + " ORDER BY m.id DESC LIMIT 50"
    sonst:
        setze sql auf "SELECT m.id::text AS id, m.sender, m.content, to_char(m.created_at, 'DD.MM. HH24:MI:SS') AS zeit FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = " + sql_quote(projekt) + " AND c.name = " + sql_quote(channel) + " AND m.id > " + text(last_id) + " ORDER BY m.id LIMIT 50"
    setze r auf pg_query(sql)
    wenn r == nichts:
        g["busy_msgs"] = falsch
        gib_zurück nichts
    wenn r["fehler"] != nichts:
        g["busy_msgs"] = falsch
        gib_zurück nichts
    setze msgs auf r["rows"]
    # first_load lieferte DESC — fuer chronologische Anzeige reverse.
    wenn first_load:
        setze umgedreht auf []
        setze j auf länge(msgs) - 1
        solange j >= 0:
            umgedreht.hinzufügen(msgs[j])
            setze j auf j - 1
        setze msgs auf umgedreht
    setze rows auf []
    setze i auf 0
    setze max_id auf last_id
    setze neue_zeilen auf 0
    solange i < länge(msgs):
        setze m auf msgs[i]
        setze id auf zahl(m["id"])
        rows.hinzufügen([m["zeit"], m["sender"], m["content"]])
        setze neue_zeilen auf neue_zeilen + 1
        wenn id > max_id:
            setze max_id auf id
        setze i auf i + 1
    ui_liste_zeilen_hinzu_bulk(liste, rows)
    g["last_msg_id"] = max_id
    g["init_done"] = wahr
    wenn first_load:
        ui_liste_spalten_autosize(liste)
    # Scrollen nur wenn was Neues kam UND User vorher unten war.
    # Bei first_load gilt war_unten=wahr (leere Liste), also scrollt's
    # initial ans Ende.
    wenn neue_zeilen > 0:
        wenn war_unten:
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
    setze first_load auf nicht g.hat("chat_agents_init_done")
    setze projekt auf g["projekt"]
    setze liste auf g["liste_agents"]
    # PG-Direkt: agent_sessions
    setze sql auf "SELECT id, COALESCE(model, '') AS model FROM agent_sessions WHERE project = " + sql_quote(projekt) + " AND status = 'active' ORDER BY id"
    setze r auf pg_query(sql)
    wenn r == nichts:
        g["busy_chat_agents"] = falsch
        gib_zurück nichts
    wenn r["fehler"] != nichts:
        g["busy_chat_agents"] = falsch
        gib_zurück nichts
    setze ags auf r["rows"]
    ui_liste_leeren(liste)
    setze rows auf []
    setze i auf 0
    solange i < länge(ags):
        setze a auf ags[i]
        setze id auf a["id"]
        setze modell auf a["model"]
        wenn a.hat("model"):
            wenn typ_von(a["model"]) == "Text":
                setze modell auf a["model"]
        rows.hinzufügen([id, modell])
        setze i auf i + 1
    ui_liste_zeilen_hinzu_bulk(liste, rows)
    wenn first_load:
        ui_liste_spalten_autosize(liste)
    g["chat_agents_init_done"] = wahr
    g["busy_chat_agents"] = falsch

funktion chat_senden(schluessel):
    wenn nicht chat_fenster.hat(schluessel):
        gib_zurück nichts
    setze g auf chat_fenster[schluessel]
    setze projekt auf g["projekt"]
    setze channel auf g["channel"]
    setze inhalt auf ui_textbereich_text(g["eingabe"])
    wenn inhalt == "":
        gib_zurück nichts
    setze payload auf { "sender": "synapse-tray", "content": inhalt }
    setze r auf http_sende(DAEMON_URL + "/projects/" + projekt + "/channels/" + channel + "/post", payload)
    # Input leeren, Feed neu laden
    ui_textbereich_setze(g["eingabe"], "")
    chat_messages_laden(schluessel)

# Globaler Tastenbindungs-Handler — kein Closure (4-arg-Lambda+Capture
# crasht moo). Liest aktiver_chat_schluessel.
# Return-Wert: wahr = Default unterdruecken, falsch = Default zulassen.
# - Enter ohne Shift → senden, Default unterdruecken (sonst tippt GTK \n).
# - Enter mit Shift  → falsch, GTK fuegt \n ein.
# - Sonst            → falsch (normales Tippen).
# Rechtsklick auf Nachricht-Liste: aktive Zeile in Clipboard kopieren.
# Globaler Handler ohne Capture (vermeidet Closure-Bugs).
# zeile_idx: -1 = neben einer Zeile (ignorieren), >=0 = Zeilen-Index.
funktion chat_msg_rechtsklick_global(zeile_idx):
    wenn zeile_idx < 0:
        gib_zurück nichts
    setze schluessel auf aktiv_chat["v"]
    wenn schluessel == "":
        gib_zurück nichts
    wenn nicht chat_fenster.hat(schluessel):
        gib_zurück nichts
    setze g auf chat_fenster[schluessel]
    setze zeile auf ui_liste_zeile(g["liste_msgs"], zeile_idx)
    # Spalten: [Zeit, Absender, Nachricht] → Index 2
    setze inhalt auf zeile[2]
    ui_clipboard_setze(inhalt)

funktion chat_key_handler_global(keyname, ctrl, shift, alt):
    setze schluessel auf aktiv_chat["v"]
    wenn schluessel == "":
        gib_zurück falsch
    wenn keyname == "Return" oder keyname == "KP_Enter":
        wenn nicht shift:
            chat_senden(schluessel)
            gib_zurück wahr
    gib_zurück falsch

funktion chat_refresh(schluessel):
    chat_messages_laden(schluessel)
    chat_agents_laden(schluessel)

# Globale Top-Level-Handler fuer Chat-Buttons (ohne Capture).
funktion chat_senden_global():
    setze schluessel auf aktiv_chat["v"]
    wenn schluessel == "":
        gib_zurück nichts
    chat_senden(schluessel)

funktion chat_refresh_global():
    setze schluessel auf aktiv_chat["v"]
    wenn schluessel == "":
        gib_zurück nichts
    chat_refresh(schluessel)

# Live-Refresh aller offenen Chat-Fenster (Timer-Tick alle 3 s).
# Globaler refresh_busy-Guard: verhindert Re-Entrancy wenn HTTP-Fetch
# laenger dauert als der Tick (key-press kann sonst waehrend safe_get
# ankommen → signal_emit Verschachtelung → tcache-Korruption).
setze refresh_busy auf { "v": falsch }
funktion chat_live_refresh_tick():
    wenn refresh_busy["v"]:
        gib_zurück nichts
    refresh_busy["v"] = wahr
    setze keys auf chat_fenster.schlüssel()
    setze i auf 0
    solange i < länge(keys):
        setze k auf keys[i]
        setze g auf chat_fenster[k]
        setze closed auf falsch
        wenn g.hat("closed"):
            setze closed auf g["closed"]
        wenn nicht closed:
            chat_messages_laden(k)
        setze i auf i + 1
    refresh_busy["v"] = falsch

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
            setze check auf tray_check_add_to(sm, "Aktiv", enabled, toggle_aktiv_via_menu)
            ui_menue_eintrag_data(check, name)
            tray_separator_add_to(sm)
            setze it_oeffnen auf tray_menu_add_to(sm, "Oeffnen...", oeffne_detail_via_menu)
            ui_menue_eintrag_data(it_oeffnen, name)
            tray_separator_add_to(sm)
            # Channels flach im Projekt-Submenu — moo kennt (noch)
            # keine nested submenus. Jeder Channel als "# name"-Eintrag.
            channel_submenu_fuellen(sm, name)
            tray_separator_add_to(sm)
            setze it_loeschen auf tray_menu_add_to(sm, "Loeschen...", loesche_projekt_via_menu)
            ui_menue_eintrag_data(it_loeschen, name)
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
pg_init()
rebuild_menu()
# Live-Refresh fuer offene Chat-Fenster: alle 3 s.
# refresh_busy-Guard verhindert Re-Entrancy.
ui_timer_hinzu(3000, chat_live_refresh_tick)
ui_laufen()
