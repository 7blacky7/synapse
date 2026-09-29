---
name: synapse-nutzung
description: >
  Koordinator-Regeln fuer Synapse MCP-Tools. Session-Management, Agenten-Dispatching,
  Suche, Wissens-Speicherung, Context-Handoff. Triggers: "synapse", "semantische suche",
  "projekt wissen speichern", "memory anlegen", "context handoff", "session wechsel".
---

# synapse-nutzung

> Synchronisiert aus Qdrant Skill-DB am 2026-06-15. Quelle der Wahrheit: skill-db.mjs (QDRANT_URL).

## session-start

<!-- tags: koordinator, onboarding, session -->
Koordinator Session-Start (PFLICHT):
1. project(action: 'status', project) → FileWatcher aktiv? Chunk-Count ok?
2. Falls nicht initialisiert → project(action: 'init', name, agent_id: 'koordinator'). OHNE path = Self-Service: Daemon legt unter ~/dev/<name> an (SYNAPSE_WORKSPACE_ROOT). Status via project(init_status, job_id).
3. chat(action: 'register', id: 'koordinator', project, model: 'claude-opus-4-8')
4. admin(action: 'index_stats', project, agent_id: 'koordinator', role: 'koordinator') → rollenspezifische Regeln + Chunk-Check
5. chat(action: 'get', limit: 10) → letzte Nachrichten
6. thought(action: 'search', query: 'session-uebergabe') → Handoff vorhanden?

WISSENS-AIRBAG: guide(tool_name) liefert Deep-Dive-Doku zu jedem Tool (nur via REST-API, kostet KEINEN MCP-Kontext). Bei Unsicherheit zu einem Tool: erst guide() fragen.

## suchreihenfolge-tools

<!-- tags: suche, code-intel, pflicht -->
Suchreihenfolge (PFLICHT):
1. code_intel — IMMER ZUERST fuer Code-Fragen:
   - tree: Projektstruktur + Datei-/Funktions-/Variablen-Counts
   - functions (exported_only!), variables (with_values), symbols (symbol_type-Filter)
   - references: Cross-File — wo wird ein Symbol importiert/benutzt
   - statements/calls/flow/entrypoints: Ablauf-Ebene (Execution-Flow, Call-Kanten, Einstiegspunkte)
   - search: action='search' hat ZWEI Modi — default=PG-Volltext (exakt/lexikalisch), semantic:true=Qdrant-Embedding (konzeptuell). Antwort zeigt mode-Feld.
   - search_batch + queries[] (1..10): mehrere semantische Queries in EINEM Call (Embeddings gebatcht). Ideal fuer breite Discovery.
   - file: Dateiinhalt aus PG (statt Read-Tool)
2. code_intel search liefert Trefferzeilen (matches[].line) → file(from_line,to_line). KEIN Glob/Grep/Read fuer Projektcode; Luecke in code_intel = Befund melden
3. NUR wenn alles scheitert → Read

WICHTIG: code_intel deckt exakte UND konzeptuelle Suche selbst ab — das alte search(action:'code') wird NICHT mehr gebraucht. file_type nutzt Extensions (ts, js, py, rs), NICHT Langnamen. Wildcard im file_path geht nicht — exakte Pfade oder via tree navigieren.

## tool-uebersicht

<!-- tags: tools, workspace, shell, files, uebersicht -->
Synapse Tool-Landschaft (aktuell):

CODE LESEN: code_intel (tree/functions/symbols/references/flow/search/file), search (semantische Eigen-Daten: memory/thoughts/proposals/tech_docs).

CODE SCHREIBEN: files (single + plan/commit Multi-File, Versionierung). files_batch = identisch, eigenes Tool fuer Clients die action-Enum cachen (atomare Multi-File-Edits, auto_commit, anchor_text Drift-Schutz). NIE direkt im Container schreiben — files schreibt nach PG, Auto-Sync schiebt in den Workspace.

SHELL/AUSFUEHRUNG: shell-Tool — Auto-Routing (lokaler Daemon vs Workspace-Container). isolated:true erzwingt Container. NICHT mehr workspace(exec).

WORKSPACES: workspace-Tool nur fuer Lifecycle — list/start/stop/pin/unpin/materialize. Container = synapse-workspace:latest, Source read-only (0444), node_modules/dist writable. Idle-Stop 10min, LRU-Eviction. Jede Response liefert dns_name (synapse-ws-<project>) fuer proxynet-Cross-Container. exec/commit DEPRECATED → shell bzw. files.

WEITERE: guide (Tool-Doku, REST-only, kontextfrei), code_check (Fehler-Pattern-Bibliothek add/list), admin (index_stats/detailed_stats/index_media/save_idea), skills (Skill-DB lesen: search/list/get_section/get_full).

## projekt-regeln-pitfalls

<!-- tags: pitfalls, init, home, dev, regeln -->
Projekt-Regeln & harte Pitfalls:

(1) NIEMALS das Home-Verzeichnis ($HOME) oder System-/Tool-Ordner (.local, .cargo, .config, .claude, .cache, ...) als Projekt-Root initialisieren! Sonst landen globale Caches (pnpm-store, uv-tools, .claude/.credentials.json) im Index und gehen an die Embedding-API. init lehnt das seit dem koordinator-Incident (2026-05-29) ab und verweist auf ~/dev/<name>.

(2) Projekte gehoeren nach ~/dev/<name>. Self-Service: project(init, name) OHNE path → Daemon legt dort an.

(3) Parser-Worker (rest-api) verarbeitet NUR Projekte, die in der projects-Registry stehen. Verwaiste code_files-Leichen (entferntes Projekt) werden nie wieder geparst/embedded. Aus der Registry entfernen != Daten geloescht — DB-Leichen separat raeumen.

(4) Synapse-DB (postgresql16, Port 5432) ist NUR fuer Synapse. Projekt-DBs gehoeren auf Port 5433. Nie mischen.

## agent-typen-kommunikation

<!-- tags: agenten, kommunikation, channel -->
Zwei Agent-Typen — unterschiedliche Erreichbarkeit:

SPEZIALISTEN (specialist-Tool): Persistent (Wrapper-Prozess), Channel wird automatisch gepollt. Channel-Post REICHT — Wrapper liefert die Nachricht. Events optional fuer Dringendes.

SUBAGENTEN (Agent-Tool): Nicht persistent, endet nach Task. Channel-Posts nur per PostToolUse-Hook sichtbar. Event als TRIGGER NOETIG (CHECK_CHANNEL, NEW_TASK), damit der Agent den Channel liest.

KOORDINATOR sieht Channel-Nachrichten per PostToolUse-Hook ('📢 Channel: team-test:3') — kein manuelles Pollen, einfach irgendein Tool benutzen.

FLOW: 1) Channel erstellen, 2) Aufgabe posten, 3) Agent spawnen mit {CHANNEL} im Prompt, 4) Steuerung per Events, 5) Channel-Feed fuer Ergebnisse, 6) 'Du darfst dich abmelden' im Channel.

## event-system

<!-- tags: events, steuerung -->
Event-System (Agenten-Steuerung):

Events sind verbindliche Steuersignale. PAYLOAD-REGEL: Bei scope='all' immer Agenten-Namen voranstellen ('test-spezialist: Loesche X', 'ALLE: Arbeit anhalten'). Bei scope='agent:<id>' Anweisung direkt.

Event-Typen:
- WORK_STOP (critical): sofort stoppen
- CRITICAL_REVIEW (critical): nicht abschliessen
- ARCH_DECISION (high): Plan pruefen, Ack mit Bewertung
- TEAM_DISCUSSION (high): alle stoppen, Status posten, gemeinsam evaluieren, auf Entscheidung warten
- ANNOUNCEMENT (normal): Ack, befolgen, weiterarbeiten
- NEW_TASK (normal): Channel + Aufgabe im Payload
- CHECK_CHANNEL (normal): Channel-Feed lesen

Scope: 'all' = alle Agents, 'agent:<id>' = nur einer.

## prompt-baustein

<!-- tags: spawn, prompt, agenten -->
Agent-Prompt-Baustein (PFLICHT in jedem Spawn-Prompt):

Variablen: {AGENT_ID}, {PROJEKT}, {CHANNEL}

Kern-Elemente:
- Onboarding: admin(index_stats, project, agent_id, role) + channel(join) + channel(feed)
- AGENT_ID an JEDEN Synapse-Call. NIEMALS source:'claude-code'.
- Suchen/Lesen NUR mit code_intel (search liefert Trefferzeilen → file mit from_line/to_line). Kein grep/sed/cat per shell; Luecke = Befund melden
- Code schreiben: files-Tool (nie direkt im Container). Ausfuehren: shell-Tool (isolated:true fuer Container).
- Events: alle Typen, sofort ack(), Payload befolgen
- Warten: kein sleep-Loop (gemessen: kehrt sofort zurueck). Angemeldet bleiben und stillstehen; auf Plaene per files(plan_status|shared_plan_status, wait_seconds:50) warten
- Abmeldung: NUR wenn Koordinator 'Du darfst dich abmelden' sagt
- Wissensluecken: guide(tool_name) fuer Tool-Doku, docs(search) fuer Framework-Wissen → wenn fehlt: im Channel melden
- Vor Datei-Edit: docs(get_for_file) — Wissens-Airbag

## context-handoff

<!-- tags: handoff, session, uebergabe, compact, cc-send -->
Context-Handoff Protokoll (Stand 2026-09-29):

SCHWELLEN (berechneKontextSchwellen, core/services/kontext-korridor.ts): 200k-Fenster -> Handoff 73% (146k), Rotation 88% (176k). 1M-Fenster -> Handoff 80%, Rotation 95%. Der PostToolUse-Hook warnt entsprechend.

1. IMMER ZUERST Thought speichern: thought(add, source: 'koordinator', tags: ['session-uebergabe'], content: 'SESSION-HANDOFF: <Auftrag> | OFFEN: <was fehlt> | NEXT: <Schritt> | BRANCH: <branch> | CHAT-SEIT: <timestamp>') im RICHTIGEN Projekt. Volle UUID notieren — thought(get) findet KEINE Kurz-ID (8 Zeichen); sonst thought(search, query:'session-uebergabe').

2. Neue Session: bash ~/.claude/skills/synapse-nutzung/scripts/context-handoff.sh '<pfad>' '<projekt>' '<aufgabe>'
   NUR diese Kopie unter ~/.claude verwenden (Repo-Kopien koennen veraltet sein).

ALTERNATIVE (nur wenn der User es so will): Selbst-Compact per cc-send an die EIGENE PID (steht im SessionStart-Hook '[cc-wrap] ... cc-send <PID>'). Dann ZWEI Nachrichten, sonst bleibt die Session nach dem Compact idle (compact startet keine neue Runde):
   cc-send <PID> '/compact Fokus: <Rolle/Projekt>. Uebergabe in Thought <UUID>. <Kernregeln>'
   cc-send <PID> 'weiter: Thought <UUID> lesen, dann Channel <name> ab Nachricht <ID>'

⚠️ BEIDES (context-handoff.sh und cc-send) NUR MIT DEM EIGENEN BASH-TOOL, NIEMALS ueber shell(action:'exec') der Synapse-API bzw. des Daemons. context-handoff.sh beendet den Claude-Prozess ueber die Prozesskette — ueber die Synapse-Shell haengt es an der Daemon-Kette und reisst die Desktop-Sitzung des Users mit (PC-Absturz, passiert).

Nach dem Wiedereinstieg: Thought per search/UUID lesen -> SOFORT die neue cc-send-PID (SessionStart-Hook '[cc-wrap] ... cc-send <PID>') in jedem Channel mit laufenden Spezialisten posten, damit sie den Koordinator wecken koennen (cc-send <PID> '<id>: bitte Channel <name> lesen (Nachricht <N>)', nur bei Fertig/Rueckfrage/Blocker) -> chat(get)/channel(feed) seit Uebergabe -> verarbeiteten Thought loeschen -> weiterarbeiten.

## multi-agenten-aufsicht

<!-- tags: aufsicht, activity, tool_calls, agenten, monitoring -->
Multi-Agenten-Aufsicht via shell(action:'activity'):

Der zentrale Activity-Store (tool_calls) protokolliert ALLE Tool-Aufrufe aller Agenten. shell(action:'activity') liest ihn interleaved nach Zeit (neueste zuerst) — Shell-Jobs als tool='shell'-Metazeile zwischen allen anderen Tools. So siehst du den Gesamtverlauf eines Agenten in EINEM Call (vs. shell(history) = nur Shell-Jobs).

FILTER (alle kombinierbar, AND): agent_ids[] (Namen ODER IDs), tools[] (z.B. ['files','memory'], ohne = alle interleaved), detail (meta=Default|summary|full), mutations_only, errors_only, since (ISO), limit (Default 50, Max 500). agent_ids/tools werden robust geparst (Array ODER JSON-String ODER Komma-String — claude.ai-Connector-Quirk).

DETAIL-STUFEN (Context-Schutz): meta = Tool+Action+Args+Status+Dauer OHNE result (Default, kein Overflow); summary = +result-Vorschau (~200 Zeichen); full = gespeichertes result bis Cap (32KB).

AGENT_ID PFLICHT: Ein Eintrag wird nur mit agent_id attribuiert, wenn der Agent agent_id bei JEDEM Call mitschickt. Fehlt es (z.B. claude.ai-Connector ohne Anmeldung), ist agent_id=null und der Eintrag nicht zuordenbar. Wer Agenten beaufsichtigen will, muss agent_id konsequent durchreichen — im Spawn-Prompt-Baustein verankert.

RETENTION: tool_calls altert automatisch aus (Env SYNAPSE_TOOLCALL_RETENTION_DAYS, Default 90 Tage; Worker laeuft in der REST-API, 24/7).

BEISPIELE:
- Was hat ein Subagent geschrieben? shell(activity, agent_ids:['sub-r0'], mutations_only:true, detail:'summary')
- Fehler eines Agenten? shell(activity, agent_ids:['flow-lead'], errors_only:true)
- Gesamtverlauf zuletzt? shell(activity, project:'synapse', limit:30)

## regeln-rollenbindung

<!-- tags: regeln, rollen, tags, memory, onboarding -->
Projekt-Regeln: wem gehoert welche Regel (Stand 2026-07-26)

Regeln kommen beim Onboarding als memory mit category 'rules'. Standard: eine Regel geht an ALLE Rollen (koordinator, spezialist, subagent).

BESCHRAENKEN geht NUR ueber einen Tag mit der Endung "-only":
  koordinator-only / coordinator-only / coord-only
  spezialist-only / specialist-only
  subagent-only / sub-only
Die Erkennung ist seit 2026-07-26 tolerant: deutsche und englische Schreibweise sowie Kuerzel greifen gleichermassen. Vorher war es ein exakter Vergleich gegen die englische Form — wer "koordinator-only" schrieb, erzeugte eine Regel, die still an alle ging.

EIN ROLLENNAME OHNE "-only" BINDET NICHT, und das ist Absicht: Tags tragen meist ein THEMA. Die Regel "regel-subagenten-statt-spezialisten" traegt den Tag "subagenten", ist aber eine Anweisung AN DEN KOORDINATOR. Wer auf den Rollennamen filtert, nimmt sie genau dem weg, fuer den sie gilt.

WENN DU EINE REGEL SCHREIBST (memory write, category 'rules'):
- Gilt sie fuer alle? Dann keinen -only-Tag setzen.
- Gilt sie nur fuer eine Rolle? Dann "<rolle>-only" ergaenzen.
- Verdachtsfaelle (Rollenname ohne Bindung, oder -only mit unbekannter Rolle) werden beim Schreiben und beim Onboarding ins Log gemeldet — es ist ein Hinweis, kein Fehler.

WARUM DAS WICHTIG IST: Ein falscher Filter versteckt Wissen, und das merkt niemand. Deshalb bindet nur eine ausdrueckliche Erklaerung, alles andere wird nur gemeldet.

## agenten-sessions-lebenszeichen

<!-- tags: sessions, reaper, agenten, koordinator -->
Agenten-Sessions: Lebenszeichen und automatische Abmeldung (Stand 2026-07-26)

chat(register) legt eine Session an, die frueher NUR durch ausdrueckliches Abmelden wieder auf 'inactive' ging. Gepurgte, abgestuerzte und verschwundene Agenten blieben dadurch ewig 'active': am 2026-07-26 standen 274 solcher Karteileichen in der Tabelle, die aelteste vom 15. Maerz.

SEIT 2026-07-26 laeuft ein Reaper in der REST-API (alle 30 min). Er setzt Sessions auf 'inactive', die seit vier Stunden kein Lebenszeichen zeigen. Als Lebenszeichen gilt:
- der letzte Tool-Aufruf des Agenten (tool_calls.ts)
- der Heartbeat seines Wrappers (wrapper_status.last_activity) — dadurch bleibt ein Spezialist verschont, der lebt und nur wartet
- die Anmeldung selbst, fuer Agenten die noch nichts getan haben

Es wird NICHTS geloescht, nur der Status gesetzt: eine neue Anmeldung holt die Session sofort zurueck, mit dem urspruenglichen registered_at.
ENV: SYNAPSE_SESSION_IDLE_HOURS (Default 4), SESSION_REAPER_INTERVAL_MS (Default 30 min), SESSION_REAPER_DISABLED=1.

WAS DAS FUER DICH HEISST:
- chat(list) zeigt jetzt weitgehend echte Agenten statt Altbestand.
- ACHTUNG bei Subagenten: sie haben keinen Wrapper und damit keinen Heartbeat. Wer ueber vier Stunden keinen einzigen Tool-Aufruf macht, verschwindet aus der Liste, obwohl er lebt — arbeiten kann er weiter, er ist nur nicht mehr gelistet.
- 'active' heisst weiterhin "angemeldet", NICHT "arbeitet gerade". Der echte Zustand (running/idle/crashed/stopped) steht in wrapper_status.
