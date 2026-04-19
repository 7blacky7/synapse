# ============================================================
# daemon.moo — Synapse FileWatcher Daemon (Hauptprogramm)
#
# Eigenstaendiger Hintergrund-Prozess. Laeuft unabhaengig vom
# MCP-Server: MCP-Shutdown toetet den Daemon NICHT.
#
# HTTP-API (localhost):
#   GET  /health
#   GET  /projects
#   GET  /projects/<name>/status
#   POST /projects                        {"name":..,"pfad":..}
#   POST /projects/<name>/enable
#   POST /projects/<name>/disable
#   DELETE /projects/<name>
#
# Pro enabled Projekt: 1 Worker-Thread (siehe watcher.moo).
# Stop-Signal Worker: Flag-File verschwindet.
# ============================================================

importiere config
importiere watcher

# Pfad fuer projekt-spezifische Flag-Files
funktion projects_dir():
    setze d auf config_pfad() + "/projects"
    wenn datei_ist_verzeichnis(d) == falsch:
        datei_mkdir(d)
    gib_zurück d

funktion flag_file_for(name):
    gib_zurück projects_dir() + "/" + name + ".active"

funktion worker_spawn(projekt):
    setze name auf projekt["name"]
    setze pfad auf projekt["pfad"]
    setze flag auf flag_file_for(name)
    datei_schreiben(flag, text(zeit_ms()))

    setze ctx auf {}
    ctx["name"] = name
    ctx["pfad"] = pfad
    ctx["flag_file"] = flag
    starte(worker_main, ctx)
    zeige "[daemon] gestartet: " + name + " @ " + pfad

funktion worker_stop(name):
    setze flag auf flag_file_for(name)
    wenn datei_existiert(flag):
        datei_löschen(flag)
    zeige "[daemon] stop-Signal an " + name

# ============================================================
# HTTP-Handler
# ============================================================

funktion query_param(query, key):
    wenn query == nichts:
        gib_zurück nichts
    setze teile auf query.teilen("&")
    für t in teile:
        setze kv auf t.teilen("=")
        wenn länge(kv) == 2:
            wenn kv[0] == key:
                gib_zurück kv[1]
    gib_zurück nichts

funktion pfad_segmente(pfad):
    setze segs auf []
    setze rohe auf pfad.teilen("/")
    für s in rohe:
        wenn länge(s) > 0:
            segs.hinzufügen(s)
    gib_zurück segs

funktion handle_health(req):
    setze body auf {}
    body["status"] = "ok"
    body["uptime_ms"] = zeit_ms()
    web_json(req, body)

funktion handle_projects_list(req, cfg):
    setze body auf {}
    body["projekte"] = cfg["projekte"]
    body["port"] = cfg["port"]
    web_json(req, body)

funktion handle_host_status(req):
    setze body auf {}
    body["online"] = wahr
    body["hostname"] = umgebung("HOSTNAME")
    wenn body["hostname"] == nichts:
        body["hostname"] = "unknown"
    body["time_ms"] = zeit_ms()
    web_json(req, body)

funktion handle_project_status(req, cfg, name):
    setze idx auf projekt_finde(cfg, name)
    wenn idx < 0:
        web_antworten(req, "{\"error\":\"unknown project\"}", 404)
        gib_zurück nichts
    setze p auf cfg["projekte"][idx]
    setze body auf {}
    body["name"] = p["name"]
    body["pfad"] = p["pfad"]
    body["enabled"] = p["enabled"]
    body["watcher_running"] = datei_existiert(flag_file_for(name))
    web_json(req, body)

funktion handle_project_add(req, cfg):
    setze body auf req["body"]
    # json_lesen ist defensiv heterogen:
    #   "" (leer)           -> nichts
    #   "{nope"  (Parse-Err)-> {} (leeres Dict)
    #   "[1,2]"  (kein Obj) -> Liste
    #   nichts              -> Fehler-String
    # Wir akzeptieren nur ein richtiges Dict. typ_von fuehrt durch.
    setze j auf json_lesen(body)
    wenn typ_von(j) != "Woerterbuch":
        web_antworten(req, "{\"error\":\"expected JSON object body\"}", 400)
        gib_zurück nichts
    wenn j.hat("name") == falsch:
        web_antworten(req, "{\"error\":\"missing field: name\"}", 400)
        gib_zurück nichts
    wenn j.hat("pfad") == falsch:
        web_antworten(req, "{\"error\":\"missing field: pfad\"}", 400)
        gib_zurück nichts
    setze name auf j["name"]
    setze pfad auf j["pfad"]
    wenn name == nichts oder pfad == nichts:
        web_antworten(req, "{\"error\":\"name/pfad darf nicht null sein\"}", 400)
        gib_zurück nichts
    wenn projekt_finde(cfg, name) >= 0:
        web_antworten(req, "{\"error\":\"project exists\"}", 409)
        gib_zurück nichts
    wenn datei_ist_verzeichnis(pfad) == falsch:
        web_antworten(req, "{\"error\":\"path is not a directory\"}", 400)
        gib_zurück nichts
    setze eintrag auf {}
    eintrag["name"] = name
    eintrag["pfad"] = pfad
    eintrag["enabled"] = wahr
    cfg["projekte"].hinzufügen(eintrag)
    config_speichern(cfg)
    worker_spawn(eintrag)
    setze resp auf {}
    resp["ok"] = wahr
    resp["projekt"] = eintrag
    web_json(req, resp)

funktion handle_project_enable(req, cfg, name):
    setze idx auf projekt_finde(cfg, name)
    wenn idx < 0:
        web_antworten(req, "{\"error\":\"unknown project\"}", 404)
        gib_zurück nichts
    cfg["projekte"][idx]["enabled"] = wahr
    config_speichern(cfg)
    wenn datei_existiert(flag_file_for(name)) == falsch:
        worker_spawn(cfg["projekte"][idx])
    web_json(req, {"ok": wahr})

funktion handle_project_disable(req, cfg, name):
    setze idx auf projekt_finde(cfg, name)
    wenn idx < 0:
        web_antworten(req, "{\"error\":\"unknown project\"}", 404)
        gib_zurück nichts
    cfg["projekte"][idx]["enabled"] = falsch
    config_speichern(cfg)
    worker_stop(name)
    web_json(req, {"ok": wahr})

funktion handle_project_delete(req, cfg, name):
    setze idx auf projekt_finde(cfg, name)
    wenn idx < 0:
        web_antworten(req, "{\"error\":\"unknown project\"}", 404)
        gib_zurück nichts
    worker_stop(name)
    # Liste ohne idx neu bauen
    setze rest auf []
    setze i auf 0
    solange i < länge(cfg["projekte"]):
        wenn i != idx:
            rest.hinzufügen(cfg["projekte"][i])
        setze i auf i + 1
    cfg["projekte"] = rest
    config_speichern(cfg)
    web_json(req, {"ok": wahr})

# ============================================================
# Dispatcher
# ============================================================

funktion dispatch(req, cfg):
    setze methode auf req["methode"]
    setze pfad auf req["pfad"]
    setze segs auf pfad_segmente(pfad)

    wenn pfad == "/health":
        handle_health(req)
        gib_zurück nichts
    wenn pfad == "/projects":
        wenn methode == "GET":
            handle_projects_list(req, cfg)
            gib_zurück nichts
        wenn methode == "POST":
            handle_project_add(req, cfg)
            gib_zurück nichts
    wenn pfad == "/host/status":
        handle_host_status(req)
        gib_zurück nichts
    # /projects/:name...
    wenn länge(segs) >= 2 und segs[0] == "projects":
        setze name auf segs[1]
        wenn länge(segs) == 2 und methode == "DELETE":
            handle_project_delete(req, cfg, name)
            gib_zurück nichts
        wenn länge(segs) == 3:
            wenn segs[2] == "status" und methode == "GET":
                handle_project_status(req, cfg, name)
                gib_zurück nichts
            wenn segs[2] == "enable" und methode == "POST":
                handle_project_enable(req, cfg, name)
                gib_zurück nichts
            wenn segs[2] == "disable" und methode == "POST":
                handle_project_disable(req, cfg, name)
                gib_zurück nichts

    web_antworten(req, "Not Found", 404)

# ============================================================
# Start
# ============================================================

setze cfg auf config_laden()
setze port auf cfg["port"]

# PID + Port hinschreiben fuer Discovery
datei_schreiben(pid_file(), text(zeit_ms()))
datei_schreiben(port_file(), text(port))

zeige "================================================"
zeige "  Synapse FileWatcher Daemon"
zeige "  Port:    " + text(port)
zeige "  Projekte: " + text(länge(cfg["projekte"]))
zeige "================================================"

# Worker fuer jedes enabled Projekt spawnen
für p in cfg["projekte"]:
    wenn p["enabled"]:
        worker_spawn(p)

# HTTP-Loop
setze server auf web_server(port)
zeige "listening http://127.0.0.1:" + text(port)

solange wahr:
    setze req auf server.web_annehmen()
    wenn req == nichts:
        weiter
    versuche:
        dispatch(req, cfg)
    fange e:
        zeige "[daemon] handler error"
        web_antworten(req, "{\"error\":\"internal\"}", 500)
