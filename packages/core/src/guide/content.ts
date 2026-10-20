/**
 * guide-content.ts
 *
 * Dokumentations-Content fuer das REST-API `guide`-Tool.
 *
 * Zielgruppe: Web-KIs (ChatGPT, Claude.ai, Gemini etc.) die ueber den
 * Synapse-Connector arbeiten und die Tools oft naiv/ineffizient nutzen.
 *
 * Struktur:
 *   - GUIDE_OVERVIEW         — Quick-Start-Text bei guide() ohne Parameter
 *   - TOOL_GUIDES[tool]      — Pro-Tool-Doku bei guide({ tool_name })
 *   - TOOL_GUIDES[tool].actions[action] — Action-Details bei guide({ tool_name, action_name })
 *
 * Editierrichtlinie:
 *   - Kurz, konkret, mit Beispielen
 *   - Fokus auf Anti-Patterns die Web-KIs typisch machen
 *   - Kein Markdown-Overkill; Plaintext mit minimalen Struktur-Markern
 */

export interface ActionGuide {
  description: string;
  params?: string;
  example?: string;
  tips?: string;
}

export interface ToolGuide {
  summary: string;
  when_to_use: string;
  when_not_to_use?: string;
  param_tips?: string;
  examples?: string[];
  anti_patterns?: string[];
  actions?: Record<string, ActionGuide>;
  /** Mehrschritt-Workflows die mehrere Actions kombinieren — fuer komplexe Tools wie shell. */
  workflow_examples?: string[];
}

// ===========================================================================
// OVERVIEW — bei guide() ohne Parameter
// ===========================================================================

export const GUIDE_OVERVIEW = `
# Synapse REST-API — Quick-Start fuer Web-KIs

Du bist mit einem Synapse-Projekt verbunden. Diese REST-Schnittstelle bietet 24 Tools,
eines davon ist dieses guide-Tool.

⚠️ Der lokale MCP-Server (stdio) bietet NICHT dieselbe Menge, sondern 21: ihm fehlen
files_batch, skills, workspace und artefakt. Wer eine Anleitung von der einen Oberflaeche auf die
andere uebertraegt, sucht sonst ein Tool, das es dort nicht gibt. Umgekehrt ist fast nichts
exklusiv lokal (nur free_models) — 20 Tools sind auf beiden Oberflaechen gleich.

## Scope (wichtig fuer Web-KI-Connectors)

Diese REST-API steuert ein lokales User-Workspace-Tooling auf dem Projekt-PC.
Alle Operationen sind sandboxed im eigenen Projekt-Verzeichnis und dessen
zugehoeriger lokaler Datenbank des Users — vergleichbar mit einem persoenlichen
Notizbuch + Code-Editor + Sub-Hilfsagenten.

- Lese-/Schreib-Aktionen betreffen ausschliesslich eigene Notizen, eigenen
  Projekt-Code, eigene Hilfsagenten-Konfigurationen.
- Keine Verbindung zu fremden Systemen, keine Daten verlassen die User-Umgebung.
- Lifecycle-Aktionen wie Anlegen / Aufraeumen / Pausieren betreffen nur
  diese persoenliche Sandbox.
- Specialist-Tools spawnen lokale Hilfsagenten via Claude-CLI auf dem User-PC,
  vom User explizit konfiguriert.



## Goldene Regeln (vermeide die haeufigsten Fehler)

1. **JEDER Tool-Call braucht "project"** — i.d.R. der Synapse-Projektname (vom Setup).
2. **Lies NIEMALS ganze Dateien blind** — bei grossen Files sprengt das dein Context.
   → Nutze code_intel(functions/symbols/tree) um gezielt zu lesen, file-Action NUR mit line_start/line_end.
3. **Schreibe NIE die ganze Datei neu** — das ist fast immer falsch.
   → files(search_replace) oder files(replace_lines) fuer gezielte Aenderungen.
4. **Code-Suche: code_intel ZUERST, search danach** — code_intel ist strukturiert + schnell.
   search(action: "code") nur fuer fuzzy/konzeptuelle Suchen.
5. **Keine Shell-Commands ohne Grund** — files/code_intel sind meist besser/sicherer.

## Einstieg (empfohlener Workflow)

1. admin(action: "index_stats")       — Projekt-Regeln + Statistik
2. guide()                            — diese Uebersicht
3. guide({ tool_name: "code_intel" }) — Deep-Dive fuer jedes Tool bei Bedarf
4. search(action: "memory", query: "<thema>") — Projekt-Wissen gezielt finden
   (memory(list) liefert max. limit Eintraege, Standard 100 — names_only: true
    oder category-Filter machen es noch kompakter; total/truncated zeigen den Rest)
5. code_intel(action: "tree", depth: 1) — Projektstruktur in einem Call

## Tool-Kategorien

**Code-Exploration (lesen):**
  code_intel, search, files(read), docs

**Assets / Nicht-Quellcode (lesen):**
  asset_intel — Bilder, 3D, Audio, Archive, Executables, Unreal, DCC: Metadaten, Objekte,
  Verweise, wer benutzt was, Abhaengigkeitsgraph. Auf REST und lokal (stdio) identisch.

**Code-Aenderung (schreiben):**
  files(create/update/search_replace/replace_lines/insert_after), code_check

**Wissen / Kommunikation:**
  thought, memory, proposal, plan

**Projekt-Management:**
  admin, project

**Shell & Runtime** (Auto-Routing local/workspace):
  shell — laeuft auf dem Ziel-PC ein FileWatcher-Daemon (Heartbeat <30s), geht
  exec via PG-Queue lokal (echtes FS, native Tools); sonst automatisch im
  Docker-Workspace-Container der synapse-api (isoliert, Source read-only).
  executed_via in der Antwort zeigt den Pfad; isolated:true erzwingt den
  Container, target:"local" erzwingt den Daemon.

**Sandbox & Multi-File:**
  workspace — Docker-Test-Container-Lifecycle (bis zu 3 benannte pro Projekt,
  lazy erzeugt, Idle-Stop 10 Min, LRU-Cap). files_batch — atomare Multi-File-
  Edits (Alias fuer files plan/commit). skills — Skill-Bibliothek (Best Practices).

**Agenten-Koordination** (PostgreSQL-basiert, ueberall verfuegbar):
  chat, channel, event — REST und lokaler MCP gleichermassen.
  specialist — REST UND lokal: spawn / wake / stop / purge / update_skill / status / capabilities funktionieren ueberall, solange auf dem Ziel-PC der Watcher laeuft (status + capabilities lesen jetzt aus PG, kein lokaler-MCP-Bonus mehr). Modelle: Claude (opus/sonnet/haiku/fable, [1m]-Varianten, versionierte Aliase wie opus-4.7 — Liste aus model_registry) ODER Google (gemini-flash-lite/gemini-flash/gemini-pro), je nachdem welche Provider-Runtime auf dem Ziel-PC installiert ist.
  watcher — nur lokal (REST kann den Daemon nicht erreichen, weist Calls ab).

## Tiefere Doku pro Tool

Rufe \`guide({ tool_name: "<name>" })\` auf fuer:
- Wann nutzen / wann nicht
- Parameter-Tipps + typische Fehler
- Beispiele
- Action-spezifische Hinweise (bei Multi-Action-Tools)

## Wichtige Hinweise

- **Context-Effizienz:** Filtere IMMER. Ein unfokussierter Call kann dir 50k+ Tokens kosten.
- **Konventionen:** Deutsch bei Commits/Memories, kurze Namen, konsistente Tags.
- **Sicherheit:** Nichts in main-Branch committen ohne User-Review.
`;

// ===========================================================================
// TOOL GUIDES — bei guide({ tool_name })
// ===========================================================================

export const TOOL_GUIDES: Record<string, ToolGuide> = {

  // -------------------------------------------------------------------------
  // shell — Queue-basierte Shell-Ausfuehrung mit History
  // -------------------------------------------------------------------------
  shell: {
    summary: 'Fuehrt Shell-Kommandos aus — AUTO-ROUTING: laeuft auf dem Ziel-PC ein FileWatcher-Daemon (Heartbeat <30s), wird lokal via PostgreSQL-Queue ausgefuehrt (echtes FS, native Tools); sonst automatisch im Docker-Workspace-Container der synapse-api (isoliert, Source read-only). executed_via in der Antwort zeigt den Pfad; target/isolated steuern das Routing explizit, workspace waehlt den Ziel-Container (Multi-Workspace). Voller Output in PG persistiert — Logs koennen Stunden spaeter abgerufen werden. Fehlerinterpretation: error="project_inactive" → Projekt im Tray aktivieren. error="workspace_unavailable" → weder lokaler Daemon aktiv noch Docker-Workspace verfuegbar. Bei erzwungenem target:"local" bleibt ein Job auf "pending" haengen wenn der Daemon down ist. Sofortige Validierungs-Fehler (Syntax/Pfad) → eigene Eingabe pruefen.',
    when_to_use: [
      'Ein-Zeilen-Commands fuer Status-Checks (git log, ls, pwd).',
      'Build-/Test-Ausfuehrung (pnpm build, pytest).',
      'Wenn code_intel/files nicht reichen (z.B. find, ripgrep-Flags).',
      'Vergangene Job-Ausgabe nachschlagen — auch wenn die MCP-Connection in der Zwischenzeit weg war: history → get → log.',
    ].join(' '),
    when_not_to_use: [
      'Datei lesen/schreiben — nutze files.',
      'Code suchen — nutze code_intel oder search.',
      'Shell-Pipelines mit Interaktion (stdin) — nicht unterstuetzt.',
    ].join(' '),
    param_tips: [
      'project: Pflicht fuer exec, muss auf dem Daemon aktiv sein. Bei nicht-aktivem Projekt: status=rejected, error=project_inactive, message="Projekt ist inaktiv. Bitte im Tray aktivieren."',
      'timeout_ms GIBT ES NICHT MEHR (SH-1). Lange Laeufe sind der Normalfall: nach 20 s kehrt exec mit status="running_background" zurueck, der Job laeuft bis zu 3 h weiter und das vollstaendige Ergebnis landet in PG. Arbeite nach dem Rueckkehren einfach weiter — NICHT pollen. Das Ergebnis nur abrufen wenn du es wirklich brauchst: shell(get, id) bzw. shell(log, id).',
      'cwd_relative: Pfad RELATIV zum Projekt-Root (z.B. "packages/core"), kein absoluter Pfad.',
      'RUECKFRAGE (P10-T73): Gefaehrliche Befehle (Kennzeichen gefaehrlich im Shell-Katalog, Startliste: rm -r ausserhalb Scratchpad/Testordner/Build-Ordner, git reset --hard, git clean -f, git push --force, git checkout/restore ., DROP/TRUNCATE/DELETE ohne WHERE per psql, kill/pkill/killall, chmod/chown -R, Schreiben/Loeschen ausserhalb von Projekt und Scratchpad) laufen NICHT sofort: status rejected, stufe "rueckfrage", risiko, sicher, bestaetigung_id, gueltig_bis. Du selbst bestaetigst (P23-T9): shell(action:"bestaetigen", id:"<bestaetigung_id>", grund:"<mind. 10 Zeichen>") innerhalb 60 s - der Aufruf ist gespeichert, command NICHT erneut senden (alter Weg: denselben command mit bestaetigung:{id,grund}). Nur der Agent, der die Rueckfrage ausgeloest hat; Drift (anderer Befehl, Lage, Regelversion) oder Ablauf -> neue Rueckfrage. Ohne Bestaetigung verfaellt sie ohne Spur. Der Grund steht im Job-Audit (history: bestaetigt_grund). sperre (Live-DB schreibend, Selbstschaden) bleibt nicht uebergehbar.',
      'DEMASKIEREN (P10-T73, jeder Agent): maskierung:false bei exec|get|log liefert zuerst eine Rueckfrage (bestaetigung_id); shell(action:"bestaetigen", id, grund) zeigt unmaskiert (gespeicherter Aufruf; alter Weg: derselbe Aufruf mit maskierung:false + bestaetigung:{id,grund}). Bei exec wird die Ausgabe bis zur Frist unmaskiert gespeichert (Standard 3 Tage, bestaetigung.frist_stunden kuerzer) und danach automatisch nachmaskiert; frueher per shell(action:"maskieren", id). get/log zeigen nur, was noch unmaskiert gespeichert ist. tool_calls, Embeddings und Logs bleiben immer maskiert. Ist der Befehl zugleich gefaehrlich, kommt danach seine eigene Rueckfrage; deren Bestaetigung per shell(action:"bestaetigen", id, grund) genuegt dann fuer beides.',
      'unterbrochen_durch (Task b5b5304a): Kommt waehrend exec wartet eine neue Nachricht eines ANDEREN in einem Channel, in dem du Mitglied bist, kehrt exec SOFORT zurueck — status="running", id, tail (soweit vorhanden), unterbrochen_durch {project, channel, sender, message_id} und der Hinweis "Job laeuft weiter: shell(get|log, id) oder shell(cancel, id)". Der Job laeuft ungestoert weiter; unread_channels in derselben Antwort zeigt die neuen Nachrichten. Erst Channel lesen, dann bei Bedarf das Ergebnis holen. Kein Parameter noetig oder moeglich. Im MCP-stdio-Weg gibt es die Job-ID erst beim Ende (shell(history)), bis dahin shell(get_stream, stream_id).',
      'tail_lines: Default 5. Auf 20-50 erhoehen wenn du im exec-Result direkt mehr sehen willst — fuer den vollen Output ist aber action:"get" oder "log" besser.',
      'response: success(true|false) + status + tail; bei history zusaetzlich output_line_count + source ("mcp_local" | "daemon-<host>-<pid>"); bei error: actionable message.',
      'attached (SH-4): Setzt du einen Befehl ab, der GERADE SCHON LAEUFT, bekommst du keinen zweiten Prozess, sondern denselben Job zurueck — Antwort traegt attached:true und attached_to (wer ihn gestartet hat). DAS IST KEIN FEHLER: zwei gleichzeitige "pnpm -r build" schreiben in dasselbe dist/, zwei git-Befehle kollidieren auf .git/index.lock. Du bekommst dasselbe Ergebnis wie der Startende. Brauchst du wirklich einen unabhaengigen Lauf: force:true. Das Anhaengen greift NUR bei nebenwirkungsfreien Befehlen (build, test, git status, ls, grep, ...) — git commit, docker build, rm oder alles mit &&, |, > laeuft IMMER ein zweites Mal, weil ein Commit nicht "schon erledigt" sein kann, nur weil ein anderer committet hat.',
      'shell_activity (SH-3): Normale Tool-Antworten ANDERER Tools tragen bei project + agent_id bis zu 3 Eintraege dieses Feldes — laufende und frisch beendete Shell-Jobs DES GANZEN PROJEKTS, nicht nur deine eigenen. Jeder Eintrag kommt GENAU EINMAL und danach nie wieder. ZWECK IST KOORDINATION: bei kind="start" eines anderen Agenten fuehrst du denselben Befehl NICHT nochmal aus, sondern wartest auf sein Ergebnis. Bei kind="done" liegt ein Ergebnis bereit — abholen NUR wenn du es brauchst: shell(get, id) bzw. shell(log, id). Die Fertigmeldung sagt bei teilbaren Befehlen ausserdem, OB DAS ERGEBNIS NOCH GILT: "noch gueltig" heisst, seit dem Lauf wurde am Projekt nichts geaendert — dann fuehr den Befehl NICHT erneut aus, sondern hol das Ergebnis. "ueberholt" heisst, seitdem wurde etwas geaendert — ein neuer Lauf ist gerechtfertigt. Bei nicht teilbaren Befehlen (git commit, rm, alles mit &&) steht dort nichts, weil ein zweiter Lauf ohnehin ein anderer Vorgang waere. STOERT EIN HINWEIS: shell(action:"hide", id) nimmt ihn aus den Antworten. Ohne for_agents sieht ihn niemand mehr, mit for_agents:["a","b"] nur noch diese. In den ersten 3 Minuten NACH DEM ABSCHLUSS darf das nur der Starter des Jobs, danach jeder — und wer nicht selbst der Starter ist, kann diesen nicht entfernen: niemand soll dem Verursacher die Meldung ueber seinen eigenen fehlgeschlagenen Build wegnehmen koennen. Der Hinweis traegt NIE Ausgabe, nur Job-ID, Befehl, Status, Exit-Code. Fertigmeldungen laufen 8 Minuten nach; das Ergebnis selbst bleibt dauerhaft abrufbar.',
    ].join('\\n'),
    examples: [
      'shell({ action: "exec", project: "synapse", command: "git status --short" })',
      'shell({ action: "history", project: "synapse", limit: 10 })',
      'shell({ action: "get", id: "<uuid aus history>" })',
      'shell({ action: "log", id: "<uuid>", from_line: 50, to_line: 100 })',
      'shell({ action: "log", id: "<uuid>", query: "ERROR" })',
      'shell({ action: "log", id: "<uuid>", query: "ERROR=\\\\d+", regex: true })',
    ],
    anti_patterns: [
      'command: "sudo ..." — Daemon laeuft als User, sudo wird nicht funktionieren.',
      'command: "vim file.ts" — interaktive Tools hangen.',
      'Sensible Daten in command (Passwords, API-Keys) — werden in shell_jobs-Tabelle gespeichert + bleiben in der History.',
      'Destruktive Commands ohne Dry-Run (rm -rf, DROP TABLE) — IMMER erst echo + confirm. Gefaehrliche Befehle stellen ohnehin eine Rueckfrage (bestaetigung:{id,grund}); die Bestaetigung nicht reflexhaft, sondern erst nach Pruefung von risiko und sicher geben.',
      'Tausenden Zeilen Output direkt parsen — output ist auf 1MB gecappt, dann output_truncated=true. Nutze action:"log" mit query um nur Treffer-Zeilen zu holen.',
      'Fuer "wie viele Zeilen kam raus?" → die history liefert output_line_count direkt mit, keine zweite Anfrage noetig.',
    ],
    actions: {
      exec: {
        description: 'Kommando ausfuehren. Kurze Laeufe liefern das Ergebnis direkt. Dauert es laenger als 20 s, kehrt der Call mit status="running_background" zurueck — der Prozess laeuft ungestoert weiter (bis 3 h) und das vollstaendige Ergebnis inkl. exit_code landet in PG. Voller Output gecappt auf 1MB.',
        params: 'project (req), command (req), tail_lines, cwd_relative, target (auto|local|workspace, Default auto), isolated (bool = Kurzform target:workspace), workspace (Ziel-Container bei Multi-Workspace, Default main), agent_id (Attribution fuer history/activity)',
        example: 'shell({ action: "exec", project: "synapse", command: "echo hallo" })',
        tips: 'Default action — wenn du kein action angibst, ist es "exec". Bei project_inactive bekommst du klare message statt stillem Hangen. Die exec-Antwort enthaelt id (= Job-UUID fuer get/log) UND stream_id. Falsche/verwechselte ID liefert jetzt einen klaren invalid_job_id-Fehler statt einer rohen PG-Meldung. tail_lines Default ist 5 — bei mehrzeiligem Output direkt hoeher setzen, sonst kostet dich das einen zweiten Call.',
      },
      cancel: {
        description: 'Bricht einen laufenden oder wartenden Job ab (SIGTERM, nach 10 s SIGKILL).',
        params: 'id (req), agent_id (wird serverseitig aus dem Header abgeleitet)',
        example: 'shell({ action: "cancel", id: "<uuid>" })',
        tips: 'ZEITGESTAFFELTE BERECHTIGUNG: in den ersten 10 Minuten (ab Ausfuehrungsbeginn) darf NUR der Agent abbrechen, der den Job gestartet hat — er arbeitet in dieser Phase am Ergebnis. Danach darf jeder Agent im Projekt. Diese Oeffnung ist Absicht: Subagenten enden mit ihrer Task, ihr Job liefe sonst bis zu 3 h weiter, ohne dass ihn jemand stoppen darf. Jeder Abbruch wird mit Verursacher festgehalten (cancelled_by).',
      },
      maskieren: {
        description: 'P10-T73: Maskiert einen bestaetigt demaskierten Job sofort wieder (vor Ablauf der Frist) und nimmt ihn aus der Liste shell_demaskierungen.',
        params: 'id (req, Job-UUID)',
        example: 'shell({ action: "maskieren", id: "<uuid>" })',
        tips: 'Jeder darf nachmaskieren (sichere Richtung). Ohne Eintrag in der Liste: nachmaskiert 0 + hinweis. Der Worker der REST-API erledigt faellige Eintraege von selbst (SYNAPSE_SHELL_DEMASKIERT_STUNDEN, Standard 72).',
      },
      hide: {
        description: 'Nimmt die shell_activity-Hinweise zu einem Job aus den Tool-Antworten.',
        params: 'id (req), for_agents (optional: wer ihn DANACH NOCH bekommt), agent_id (serverseitig aus dem Header abgeleitet)',
        example: 'shell({ action: "hide", id: "<uuid>", for_agents: ["kollege-b"] })',
        tips: 'Ohne for_agents sieht den Hinweis NIEMAND mehr, mit Namen nur noch diese. ZEITGESTAFFELTE BERECHTIGUNG wie beim Abbruch, aber ab dem ABSCHLUSS des Jobs gerechnet: drei Minuten lang darf nur sein Starter ausblenden, danach jeder — vorher gibt es nichts, was stoeren koennte, die Fertigmeldung ist ja der Punkt. WER NICHT SELBST DER STARTER IST, KANN DIESEN NICHT ENTFERNEN: er bleibt immer Empfaenger, sonst koennte ein Dritter dafuer sorgen, dass der Verursacher nie erfaehrt, dass sein Build fehlgeschlagen ist. Nur er selbst darf darauf verzichten. Gedacht fuer Laerm — zehn kurze Pruefbefehle, die alle anderen nichts angehen —, nicht um unbequeme Ergebnisse verschwinden zu lassen: jeder Aufruf steht mit Verursacher in shell(activity).',
      },
      get_stream: {
        description: 'Live-Tail eines laufenden Jobs (nur via lokalem MCP, REST gibt 501).',
        tips: 'Fuer lange Commands ueber REST braucht es das nicht: exec loest sich nach 20 s selbst ab, und das Endergebnis holst du spaeter via "get" oder "log".',
      },
      history: {
        description: 'Liste vergangener Jobs eines Projekts (oder global), sortiert nach created_at DESC. Liefert Metadaten mit output_line_count + source, Kommando-/Meldungsvorschau bis 300 Zeichen und maximal drei Tail-Zeilen à 160 Zeichen. *_truncated markiert gekürzte Vorschauen; volle Details per get mit Job-ID.',
        params: 'project (optional Filter), limit (Default 20, Max 200), offset, status (pending|running|done|failed|rejected|timeout)',
        example: 'shell({ action: "history", project: "synapse", limit: 10, status: "failed" })',
        tips: 'Wenn du einen alten Build oder Test-Lauf nachschauen willst — IMMER zuerst history um die UUID zu finden, dann get/log fuer Details.',
      },
      get: {
        description: 'Einzelnen Job per ID inkl. vollem Output (gecappt 1MB). Sicherungsanalyse standardmäßig ohne doppelte Lage/Skripttexte; detail:full liefert die vollständige maskierte Analyse.',
        params: 'id (req), detail (full = volle Sicherungsanalyse und job_env)',
        example: 'shell({ action: "get", id: "750a83b6-2c8e-483f-baee-7d8e6d323717" })',
        tips: 'output_truncated:true bedeutet der Output war groesser als 1MB — nutze action:"log" mit query/range. Bei vollem output entfällt tail. Text-Verweise enthalten Länge und SHA-256; detail:"full" zeigt die vollständige Analyse. Interne exec_key-Werte werden nicht ausgeliefert.',
      },
      log: {
        description: 'Zeilengenauer Zugriff auf den Output eines Jobs. ZWEI Modi: (a) Zeilenrange via from_line/to_line, (b) Such-Treffer mit Zeilennummern via query (Substring oder Regex).',
        params: 'id (req); fuer Range: from_line, to_line (1-basiert, beide inkl., Default 1-100); fuer Suche: query, regex (Default false), case_sensitive (Default false), max_matches (Default 200, Max 2000)',
        example: 'shell({ action: "log", id: "<uuid>", query: "fehler|error|warning", regex: true })',
        tips: 'Substring-Suche ist case-insensitive default. Fuer Zahlen einfach query: "42" (substring) statt regex. Treffer kommen mit line_number + content; truncated:true wenn mehr als max_matches.',
      },
      activity: {
        description: 'Multi-Agenten-Aufsicht: liest den zentralen Activity-Store (tool_calls) — ALLE Tool-Aufrufe aller Agenten, interleaved nach Zeit (neueste zuerst). Shell-Jobs erscheinen als tool="shell"-Metazeile zwischen allen anderen Tools, so dass du den Gesamtverlauf eines Agenten in EINEM Call siehst. Anders als history, das NUR Shell-Jobs zeigt.',
        params: 'project; agent_ids[] (Agenten-Namen ODER IDs); tools[] (z.B. ["files","memory"], ohne = alle Tools interleaved); detail (meta=Default | summary | full); mutations_only (bool); errors_only (bool); since (ISO-Timestamp); limit (Default 50, Max 500). Alle Filter sind kombinierbar (AND-verknuepft).',
        example: 'shell({ action: "activity", project: "synapse", agent_ids: ["sub-r0"], mutations_only: true, detail: "summary" })',
        tips: 'detail steuert NUR die Rueckgabe-Tiefe (Context-Schutz, nicht den Speicher): meta=Tool+Action+Args+Status+Dauer OHNE result (Default); summary=+result-Vorschau (~200 Zeichen); full=gespeichertes result bis Cap (32KB). agent_ids/tools akzeptieren auch JSON-String oder Komma-Form (Connector-Quirk wird robust geparst). WICHTIG: Ein Eintrag wird nur dann mit agent_id attribuiert, wenn der Agent bei seinen Calls agent_id mitschickt — sonst agent_id=null (z.B. claude.ai-Connector ohne Anmeldung). Wer Aufsicht will, muss agent_id konsequent durchreichen.',
      },
    },
    workflow_examples: [
      'Workflow: Langer Build. Es braucht KEINEN Trick mehr — das passiert von selbst.\\n  1) shell({ action: "exec", project: "synapse", command: "pnpm -r build" })\\n     → dauert es laenger als 20 s: status="running_background" + id zurueck\\n  2) WEITERARBEITEN. Nicht pollen, nicht warten, nicht nochmal starten.\\n  3) Erst wenn du das Ergebnis wirklich brauchst: shell({ action: "get", id: "<uuid>" })\\n     → status=done/failed, exit_code, voller output',
      'Workflow: Nach Fehler-Pattern in altem Build suchen.\\n  1) shell({ action: "history", project: "synapse", status: "failed", limit: 5 })\\n  2) shell({ action: "log", id: "<uuid>", query: "Error|FAIL|✗", regex: true })\\n  → Zeilennummern mit Fehlern, dann shell({ action: "log", id, from_line: <treffer-1>, to_line: <treffer+10> }) fuer Kontext',
    ],
  },

  // -------------------------------------------------------------------------
  // code_intel — DER Exploration-Hub
  // -------------------------------------------------------------------------
  code_intel: {
    summary: 'Strukturierte Code-Abfragen aus PostgreSQL. ERSTE WAHL fuer alles was mit Code zu tun hat.',
    when_to_use: [
      'Projektstruktur verstehen: tree.',
      'Typfehler jederzeit aus PG prüfen: typen:true bei file/functions/symbols/references/search/tree. TS (.ts/.tsx/.mts/.cts), JS nur mit checkJs im Paket-tsconfig. Mit schatten werden typbefunde automatisch ergänzt (typen:false schaltet ab); nur neue Diagnosen gegen die Basis, samt betroffene_aufrufer und op_index. Fehlende Abhängigkeitstypen: vollstaendig:false, fehlende_module. Zeitdeckel FEHLERPRUEFUNG_TYPEN_MS und Schalter FEHLERPRUEFUNG_TYPEN=0; files(plan) verwendet denselben Prüfer.',
      'Funktionen finden: functions (gefiltert nach Datei/Name).',
      'Wo wird X verwendet: references.',
      'Interfaces/Klassen/Enums: symbols.',
      'Datei-Content lesen: file (mit Zeilenbereich bei grossen Files!).',
      'Code durchsuchen: search (lexikalisch ODER semantic: true) / search_batch (mehrere semantische Queries in einem Call).',
      'Ablauf verstehen: flow (Funktion Schritt fuer Schritt), statements (top_level_only fuer Modul-Seiteneffekte), calls (wer ruft X).',
      'Verdacht auf ein Parser-Problem ("0 functions?!"): health mit file_path — sagt dir, ob der Parser versagt hat oder die Datei wirklich nichts enthaelt.',
    ].join(' '),
    when_not_to_use: [
      'Konzeptuelle Fragen ("wie funktioniert X?") — bleib im Tool: search mit semantic: true, oder search_batch fuer mehrere Fragen in einem Call.',
      'Nicht-Code-Dateien wie Images/Binaerdateien — dafuer asset_intel (code_intel file auf einen Asset-Pfad antwortet selbst mit beantwortet_von asset_intel).',
    ].join(' '),
    param_tips: [
      'IMMER filter setzen (file_path, name, symbol_type) um Output klein zu halten.',
      'file_type: Extension ohne Punkt ("ts", "py") — NICHT "typescript" oder "python".',
      'tree: depth: 1-2 reicht meist, show_functions: true wenn du Funktionen sehen willst; show_assets: false blendet die Asset-Zeilen (Marker [asset ...]) aus.',
      'file: line_start + line_end setzen bei Dateien > 500 Zeilen, sonst sprengst du Context.',
      'search: limit: 5-10 sinnvoll, nicht 100.',
      'search: jeder Volltext-Treffer nennt die Zeilen (matches[].line/text) — danach file mit from_line/to_line um diese Zeile lesen. Kein grep -n noetig.',
    ].join('\\n'),
    examples: [
      'code_intel({ action: "tree", project: "synapse", path: "packages", depth: 1 })',
      'code_intel({ action: "functions", project: "synapse", file_path: "packages/core/src/services/shell-queue.ts" })',
      'code_intel({ action: "references", project: "synapse", name: "enqueueShellJob" })',
      'code_intel({ action: "file", project: "synapse", file_path: "README.md", from_line: 1, to_line: 50 })',
    ],
    anti_patterns: [
      'file-Action auf sehr grossen Dateien ohne from_line/to_line — Auto-Reduce greift, aber besser gezielt paginieren.',
      'functions() ohne file_path-Filter im ganzen Projekt — Hunderte Ergebnisse.',
      'search mit limit nicht gesetzt — bekommst 20 Ergebnisse, meist zu viel.',
      'tree mit depth: 5+ — riesige Ausgabe, die meiste Info irrelevant.',
      'Bei unerwartet 0 Treffern sofort den Parser-Quelltext lesen — erst health(file_path) fragen, das beantwortet in einem Call, ob ueberhaupt ein Parser zustaendig war.',
    ],
    actions: {
      tree: {
        description: 'Verzeichnisbaum mit Dateien + optional Funktions-Counts/Importen.',
        params: 'path (prefix filter), depth, recursive, show_lines, show_functions, show_imports, show_assets (Standard true)',
        example: 'code_intel({ action: "tree", project: "synapse", path: "packages/core/src", depth: 2 })',
        tips: 'Perfekt fuer "wie ist das Projekt organisiert" — mit depth: 1 erst mal Overview.',
      },
      functions: {
        description: 'Alle Funktionen einer Datei oder mit einem Namen.',
        params: 'file_path (empfohlen!), name, exported_only',
        example: 'code_intel({ action: "functions", project: "synapse", file_path: "packages/core/src/services/shell-queue.ts" })',
        tips: 'Liefert Signatur + Zeilennummern, kein Body. Perfekt fuer Ueberblick ohne Token-Overhead.',
      },
      variables: {
        description: 'Variablen/Konstanten einer Datei oder nach Name.',
        params: 'file_path, name, with_values',
        example: 'code_intel({ action: "variables", project: "synapse", file_path: "packages/core/src/config.ts", with_values: true })',
        tips: 'with_values: true fuer Config-/Konstanten-Inspektion. ACHTUNG: value kommt UNGEKUERZT — grosse Konstanten (Template-Literals, const-Objekte) bedeuten mehrere KB pro Treffer. Vorher mit name/file_path eng filtern.',
      },
      symbols: {
        description: 'Klassen, Interfaces, Enums, Types, Tables (fuer SQL).',
        params: 'symbol_type (req!), file_path, name',
        example: 'code_intel({ action: "symbols", project: "synapse", symbol_type: "interface" })',
        tips: 'symbol_type muss gesetzt sein. Werte: function, variable, interface, class, enum, const_object, field, table, ... field = Feld eines Interface, Type-Alias-Objekttyps oder einer Klasse (TypeScript/JavaScript), parent_symbol = Container. string enthaelt auch Literale ueber 64 Zeichen (Beschreibungen, Meldungen): name ist dort NULL, die Laenge steht in params — finden mit value_contains.',
      },
      references: {
        description: 'Wo wird ein Symbol referenziert (cross-file imports + calls).',
        params: 'name (req)',
        example: 'code_intel({ action: "references", project: "synapse", name: "enqueueShellJob" })',
        tips: 'Perfekt fuer Impact-Analyse: "wenn ich das aendere, was muss ich nachziehen?" FELDER (symbol_type field): nur Zugriffe in DERSELBEN Datei (obj.x, { x }, { x: .. }, const { x } =) — datei-uebergreifende Zugriffe fehlen, dafuer braeuchte es Typinformation; dort mit search nachsehen. Hat ein Name ausser dem Feld noch eine andere Definition (Funktion, Variable ...), liefert references wie bisher nur diese.',
      },
      search: {
        description: 'Code-Suche mit ZWEI Modi: Default = PG-Volltext (lexikalisch, exakte Identifier, <b>-Headlines), semantic: true = Qdrant-Embeddings (konzeptuell/fuzzy, ~30-Zeilen-Chunks). Antwort enthaelt mode ("fulltext"|"semantic") zur Selbstkontrolle. ZEILEN: jeder Volltext-Treffer traegt matches: [{ line, text }] (1-basiert, die Zeilen mit dem Suchwort, Standard 20 je Datei), total_matches und matches_gekappt; Semantik-Treffer tragen line_start/line_end.',
        params: 'query (req), semantic (bool, Default false), file_type (Extension ohne Punkt), file_path, limit; Volltext zusaetzlich match_limit (Trefferzeilen je Datei, Standard 20, max 1000, 0 = nur zaehlen) und match_skip (blaettern)',
        example: 'code_intel({ action: "search", project: "synapse", query: "registerAgent", limit: 5 }) → results[0].matches[0].line = 42 → code_intel({ action: "file", project: "synapse", file_path: results[0].file_path, from_line: 30, to_line: 60 })',
        tips: 'STANDARDWEG: search → matches[].line → file(file_path, from_line, to_line) um die Zeile. Kein grep -n. Case-insensitive; bei mehreren Woertern stehen Zeilen mit ALLEN Woertern zuerst, jede Zeile nennt ihre words. Lange Zeilen (>200 Zeichen) kommen als Ausschnitt um den Treffer mit text_gekuerzt, line_length, column. matches_gekappt: true → match_skip um match_limit erhoehen. Faustregel: Identifier/exakter String → Default (fulltext). Konzept/"wo passiert X" → semantic: true. Semantic-Treffer sind grosse Chunks — limit 3-5 setzen, mehr sprengt Context.',
      },
      search_batch: {
        description: 'Mehrere SEMANTISCHE Queries in EINEM Call — Embeddings gebatched (1 API-Roundtrip statt N), parallel gegen Qdrant. Antwort: results[] mit { query, count, hits } pro Query; jeder Hit traegt file_path, line_start und line_end — weiter mit file(from_line, to_line).',
        params: 'queries (req, Array 1..10), limit_per_query (Default 5)',
        example: 'code_intel({ action: "search_batch", project: "synapse", queries: ["wo wird der plan gespeichert", "wie laeuft das embedding"], limit_per_query: 3 })',
        tips: 'DER Discovery-Einstieg: beim Erkunden eines unbekannten Bereichs 3-5 Aspekte gleichzeitig abklopfen statt 5 einzelne search-Calls. limit_per_query: 3 reicht fast immer.',
      },
      file: {
        description: 'Datei-Inhalt lesen. Liefert immer total_lines und returned_range: { from, to, eof }.',
        params: 'file_path (req; path wird als Alias akzeptiert); optional: from_line (1-basiert, Standard 1), to_line (inklusiv, Standard Ende), truncate_long_lines (Zeilen > N kuerzen + Marker, 0 = aus)',
        example: 'code_intel({ action: "file", project: "synapse", file_path: "README.md", from_line: 1, to_line: 100 })',
        tips: [
          'Suchindex (Volltext) kann bei riesigen Dateien gekuerzt sein (ueber 1 MB Index ohne Positionen, ggf. nicht bis zum Ende) — file bzw. files(read) liefern IMMER den vollen Inhalt, fensterweise per from_line/to_line. Auto-Reduce: Range > 80k Zeichen wird automatisch reduziert — returned_range.eof=false zeigt das an.',
          'Workflow grosse Datei: 1. Ersten Call ohne from/to → total_lines pruefen. 2. Paginieren mit from_line=returned_range.to+1.',
          'Beispiel: returned_range: { from:1, to:50, eof:false }, total_lines:102 → naechster Call mit from_line:51.',
          'Sehr lange Zeilen: truncate_long_lines=200 setzen.',
        ].join(' '),
      },
      statements: {
        description: 'Ablauf-Ebene: geordnete Statements (depth, parent_statement_id, condition_text, is_awaited) eines Scopes oder einer Datei. ~18 Felder pro Statement — NUR gefiltert verwenden!',
        params: 'file_path und/oder scope (Funktionsname); top_level_only (bool) fuer Modul-Ebene',
        example: 'code_intel({ action: "statements", project: "synapse", file_path: "packages/core/src/config.ts", top_level_only: true })',
        tips: 'top_level_only: true ist der saubere Weg fuer "welche Seiteneffekte hat das Modul beim Import" (Imports, Top-Level-Calls, Modul-Variablen). NIEMALS ohne file_path/scope projektweit aufrufen.',
      },
      calls: {
        description: 'Aufruf-Kanten (wer ruft was; call_kind: function|method|await|new, confidence). Killer-Use-Case: callee gesetzt = "wer ruft Funktion X" projektweit in einem Call.',
        params: 'callee (Funktions-/Methodenname) und/oder file_path',
        example: 'code_intel({ action: "calls", project: "synapse", callee: "listFileHistory" })',
        tips: 'Nur file_path ohne callee liefert ALLE Kanten der Datei inkl. Trivial-Calls (Math.min, push) — auf grossen Dateien Hunderte. Fuer Impact-Analyse: calls(callee) + references(name) kombinieren; functions(name) liefert usage_count als Soll-Gegenprobe.',
      },
      flow: {
        description: 'Execution-Flow eines Scopes in Ausfuehrungsreihenfolge. Ohne scope: Top-Level-Ausfuehrung der Datei.',
        params: 'file_path (req), scope (Funktionsname, empfohlen)',
        example: 'code_intel({ action: "flow", project: "synapse", file_path: "packages/core/src/services/file-versions.ts", scope: "restoreFileVersion" })',
        tips: 'Beantwortet "was macht diese Funktion Schritt fuer Schritt" OHNE den Code zu lesen — oft billiger als file() bei langen Funktionen.',
      },
      entrypoints: {
        description: 'Projektweite Top-Level-Ausfuehrungspunkte (echte Seiteneffekte beim Import/Start: main().catch, dotenvConfig() etc.). Reine Deklarations-/Re-Export-Statements und .sql-Dateien sind per Default ausgefiltert.',
        params: 'file_path (LIKE-Filter, empfohlen auf grossen Projekten), limit (Default 200), include_declarations (bool, Default false — true liefert auch export interface/type/Re-Exports und SQL)',
        example: 'code_intel({ action: "entrypoints", project: "synapse", file_path: "%runtime%", limit: 20 })',
        tips: 'Fuer die Seiteneffekte EINER bestimmten Datei ist statements(top_level_only: true, file_path) die praezisere Alternative (zeigt auch Imports + Modul-Variablen).',
      },
      rename_preview: {
        description: 'Plant das Umbenennen eines Symbols und schreibt NICHTS. Grundlage sind die Fundstellen, die references nach dem Aussortieren uebrig laesst, plus die Definition selbst — nicht alle Namensvorkommen.',
        params: 'name (req, der heutige Name), new_name (req)',
        example: 'code_intel({ action: "rename_preview", project: "synapse", name: "watcherRequest", new_name: "gotrayAnfrage" })',
        tips: 'ZURUECK KOMMEN FERTIGE ops FUER files(action:"plan") — erst dieser Aufruf schreibt, und dann mit Versionierung, Hash-Pruefung und restore_batch. WARUM NICHT EINFACH search_replace(replace_all): derselbe Name steht oft an unbeteiligten Stellen. Gemessen am 26.08.2026 stand "update" 14 mal im Projekt, 13 davon als crypto.createHash("sha256").update() — ein Ersetzen haette die Hashes zerlegt; rename_preview aendert dort genau 2 Zeilen. Uebersprungen wird bewusst statt geraten: steht der Name mehrfach in EINER Zeile, ist nicht entscheidbar, welches Vorkommen gemeint ist. Zeichenketten bleiben unangetastet und werden gezaehlt gemeldet. GRENZE: Es loest keine Typen auf — zwei gleichnamige Methoden auf verschiedenen Klassen sind nicht unterscheidbar. Immer erst die Vorschau lesen, besonders warnungen und uebersprungen.',
      },
      health: {
        description: 'Parser-Diagnose auf zwei Zoomstufen. MIT file_path: zustaendiger Parser, Parser-Version (gespeichert gegen aktuell), Symbolzahlen je Typ, Statements, Zeilenabdeckung, letzter Ausfall aus parse_failures. OHNE file_path: Projekt-Uebersicht mit parser_befunde[] (Befunde ueber ALLE Dateien eines Parsers) und dateien[] (auffaellige Einzelfaelle, groesste zuerst). Beide liefern "befund": Klartextsaetze, WARUM etwas auffaellt.',
        params: 'file_path (OPTIONAL — mit: Diagnose dieser Datei; ohne: Projekt-Uebersicht), limit (nur Uebersicht, Default 20, hart gedeckelt auf 100)',
        example: 'code_intel({ action: "health", project: "synapse", file_path: "packages/core/src/services/code.ts" })  //  ohne file_path: Projekt-Uebersicht',
        tips: 'DER erste Aufruf, wenn functions/symbols/statements unerwartet 0 liefern — er unterscheidet "in der Datei ist nichts" von "der Parser hat nichts erkannt", und genau diese Unterscheidung konnte der Index vorher nicht treffen. Liefert nur Kennzahlen und Befundsaetze, nie Symbol-Listen: die Antwort bleibt bei wenigen hundert Byte. WICHTIG ZUM VERSTAENDNIS: die Befunde sind bewusst ABSOLUT formuliert ("1.000 Zeilen, aber 0 functions") und nicht als Abweichung vom Durchschnitt. Ein Vergleich gegen den eigenen Mittelwert findet Ausreisser, aber NIEMALS einen flaechendeckenden Ausfall — als der HTML-Parser bei JEDER html-Datei 0 functions lieferte, war der Median selbst 0, die Abweichung 0, und nichts fiel auf. Ein leeres befund-Array heisst: nach den absoluten Regeln unauffaellig. IN DER UEBERSICHT ZUERST parser_befunde LESEN, nicht dateien: ein Eintrag mit "FLAECHENDECKEND" wiegt schwerer als jede Einzeldatei, weil dann der Parser selbst nicht greift und die Einzelfaelle nur seine Symptome sind. Genau diese Ebene existiert, weil ein flaechendeckender Ausfall den eigenen Durchschnitt mitverschiebt und datei-weise nie auffaellt.',
      },
    },
    workflow_examples: [
      'Workflow Discovery (unbekannter Bereich): 1) tree(path, depth: 1) fuer Struktur → 2) search_batch mit 3-5 Aspekt-Queries (limit_per_query: 3) fuer Kandidaten → 3) functions(file_path) fuer Signaturen statt Code → 4) file(from_line/to_line) NUR fuer die wirklich relevanten Zeilen.',
      'Workflow Impact-Analyse vor Refactoring: 1) references(name: "X") fuer alle Verwendungsstellen mit Kontext → 2) calls(callee: "X") fuer Aufruf-Kanten mit call_kind → 3) functions(name: "X") und usage_count als Gegenprobe (weicht calls ab → Index-Luecke, references glauben).',
      'Workflow "Was macht Funktion Y?": 1) flow(file_path, scope: "Y") fuer die Schritte in Reihenfolge → 2) nur bei Bedarf file() auf die exakte Zeilen-Range aus dem flow-Ergebnis.',
    ],
  },

  // -------------------------------------------------------------------------
  // files — Datei-Manipulation
  // -------------------------------------------------------------------------
  files: {
    summary: 'Dateien erstellen/bearbeiten/lesen und kooperativ reservieren (reservation_add/release/update/list). FileWatcher synct auf Dateisystem. Auto-Versionierung (versions/restore). Multi-File Plan/Commit fuer atomare Aenderungen ueber mehrere Dateien (plan/commit/cancel). Reservierungen blockieren direkte Writes nicht; bei einer aktiven fremden Primaerreservierung enthaelt die erfolgreiche Antwort additiv reservation_hint.',
    when_to_use: [
      'Neue Datei anlegen: create.',
      'Gezielte Aenderung in bestehender Datei: search_replace oder replace_lines.',
      'Einzelne Zeilen einfuegen: insert_after.',
      'Datei lesen (kleine): read — fuer grosse nutze code_intel(file) mit Zeilenbereich.',
      'Datei verschieben/kopieren: move/copy.',
      'Arbeitsabsicht fuer Co-Edit sichtbar machen: reservation_add/release/update/list.',
    ].join(' '),
    when_not_to_use: [
      'Code analysieren — nutze code_intel.',
      'Ganze Datei ersetzen obwohl nur 3 Zeilen geaendert werden — nutze search_replace!',
    ].join(' '),
    param_tips: [
      'file_path: RELATIV zum Projekt-Root.',
      'P6-T25/T26: task_id ist eine weiche Pflicht bei NEUEN Schreibaufrufen: fehlende Zuordnung blockiert nicht, warnung_task und version_ids nennen den Nachtrag. Ausgenommen: FS-Abgleich, restore und Deploy-Proben unter coedit-test/. Pläne können task_id vor commit per plan_update ergänzen.',
      'Altbestand bleibt unverändert. history/versions mit ohne_task:true und optional since:<ISO-Zeitpunkt> sowie agent_filter/file_path begrenzen die Kontrolle. Zugeordnete Einträge zeigen task_id und, falls bekannt, task_kurz_id; tasklose Einträge zeigen diese Felder nicht.',
      'task_zuordnen: task_id plus genau version_ids[] oder batch_id oder plan_id. Nur Autor oder Koordinator; bestehende Zuordnung bleibt, außer ueberschreiben:true mit grund. Änderungen werden atomar mit Autor, Zeitpunkt, vorheriger/neuer Task und Grund protokolliert. Kein automatischer Nachtrag.',
      'task_id: optional bei allen Schreibaktionen sowie history/versions; Task-UUID oder P<n>-T<m> aus DIESEM Projekt. Unbekannte Referenz = Fehler vor jeder Mutation. plan uebernimmt die Task fuer seine Ops; ops[].task_id hat Vorrang, commit kann tasklose Ops zuordnen. Bei neuen Schreibaufrufen ohne task_id ergänzen Warnung und Version-IDs die erfolgreiche Antwort. Gilt ebenso fuer files_batch.',
      'pfad_ungueltig (P15-T36): absolute Pfade (auch unter dem Root, Laufwerks- oder UNC-Pfade), ".." aus dem Projekt hinaus, Steuerzeichen oder ein leerer Pfad werden abgelehnt (Feld grund ausbruch|absolut|steuerzeichen|leer) - Pfade aus Read/Glob vorher relativ machen; ".", doppelte "/" und Backslash als Trenner werden still normalisiert.',
      'pfad_gesperrt (P15-T36): Schreiben (create/update/search_replace/Zeilen-Ops, Ziel von move/copy) auf gesperrte Pfade wie .synapse/, .env, node_modules/, dist/ wird abgelehnt; die Meldung nennt Regel und Herkunft (standard|datenbank). Lesen, delete und die Quelle von move/copy bleiben frei; .env.example/.env.sample/.env.template sind schreibbar.',
      '.env-Dateien (P15-T36): Inhalte siehst du in allen Ausgaben (read, code_intel, versions, Plan-Diffs, Fehlermeldungen) nur maskiert als NAME=[WERT]. Schreibst du die Datei mit Platzhaltern zurueck, bleibt NAME=[WERT] unveraendert (der echte Wert wird eingesetzt); ein echter neuer Wert ueberschreibt. Ueberschriebene oder entfernte Werte meldet das Feld env_hinweise (nur Namen, per files(restore) wiederherstellbar).',
      'search_replace: search muss EXAKT matchen (inkl. Whitespace). Bei mehrfach Vorkommen: nimm laengeren context.',
      'replace_lines: line_start/line_end sind 1-basiert, inklusive.',
      'insert_after: after_line=0 fuegt am Dateianfang ein.',
      'agent_id angeben bei writes — aktiviert Error-Pattern-Check und den optionalen reservation_hint bei fremder aktiver Primaerreservierung.',
      'reservation_hint blockiert den Write nie. Reserviere den Pfad selbst und nutze files(plan), um dich in die gemeinsame Koordination einzuklinken.',
    ].join('\\n'),
    examples: [
      'files({ action: "create", project: "synapse", file_path: "docs/new.md", content: "# Hallo" })',
      'files({ action: "search_replace", project: "synapse", file_path: "package.json", search: "\\"version\\": \\"0.1.0\\"", replace: "\\"version\\": \\"0.2.0\\"" })',
      'files({ action: "replace_lines", project: "synapse", file_path: "src/x.ts", line_start: 10, line_end: 15, content: "neue Zeilen" })',
    ],
    anti_patterns: [
      'update-Action um 1 Zeile zu aendern — DU SCHREIBST DIE GANZE DATEI NEU. Nutze search_replace.',
      'search_replace mit nur einem einzigen Wort als search — matcht oft mehrfach, schlaegt fehl.',
      'read OHNE line_start auf grossen Dateien — Token-Overflow.',
      'davon ausgehen dass create einen existierenden Pfad blind ueberschreibt -- seit IGN-8 (2026-07-26) geht create auf einen bereits vorhandenen Pfad stattdessen in einen Planmodus (aktueller_inhalt + plan_id statt Direktschreiben, erst commit wendet es an).',
    ],
    actions: {
      create: {
        description: 'Neue Datei erstellen. Existiert der Pfad bereits, wird NICHT ueberschrieben (seit IGN-8, 2026-07-26) -- stattdessen liefert die Antwort applied:false, aktueller_inhalt (der echte Bestand) und eine plan_id. Erst files(action:"commit", plan_id:...) wendet die Aenderung an.',
        params: 'file_path, content',
        example: 'files({ action: "create", project: "synapse", file_path: "test.txt", content: "hi" })',
        tips: 'Kommt applied:false zurueck: aktueller_inhalt zeigt was schon drinsteht, plan_id direkt committen oder erst per files(action:"plan", ops:[...]) auf demselben Pfad anpassen. Fuer eine bewusste Aenderung an bekanntem Bestand ist search_replace/replace_lines meist der direktere Weg.',
      },
      update: {
        description: '⚠️ Ueberschreibt GANZE Datei. Meistens falsch. Nutze search_replace stattdessen.',
        tips: 'Nur sinnvoll wenn du WIRKLICH alles ersetzen willst oder Datei komplett neu schreibst.',
      },
      read: {
        description: 'Datei lesen mit optionalem Zeilenbereich. Liefert immer total_lines und returned_range.',
        params: 'file_path; optional: from_line (1-basiert, Standard 1), to_line (inklusiv, Standard Ende), truncate_long_lines (Zeilen > N Zeichen kuerzen + Marker, 0 = aus)',
        example: 'files({ action: "read", project: "synapse", file_path: "src/x.ts", from_line: 1, to_line: 50 })',
        tips: [
          'Response enthaelt immer: content, total_lines, returned_range: { from, to, eof }.',
          'Auto-Reduce: Wenn Range > 80k Zeichen wird to automatisch reduziert — returned_range.eof=false zeigt das an.',
          'Workflow fuer grosse Dateien: 1. Ersten Call ohne Range → total_lines pruefen. 2. Gezielt from_line/to_line setzen. 3. Naechster Call mit from_line=returned_range.to+1.',
          'Sehr lange Zeilen (z.B. minified JS): truncate_long_lines=200 setzen — Zeile wird auf 200 Zeichen + Marker gekuerzt.',
          'Bei Code bevorzuge code_intel(file) — hat mehr Context-Info (function boundaries etc.).',
        ].join(' '),
      },
      search_replace: {
        description: 'Gezielter String-Replace. Ohne replace_all muss search GENAU EINMAL vorkommen; bei 0 oder mehreren Treffern wird nichts geschrieben (success:false mit count, lines und Handlungshinweis).',
        params: 'search, replace, replace_all? (Default false; true = alle Vorkommen ersetzen, mindestens 1 Treffer noetig)',
        example: 'files({ action: "search_replace", project: "synapse", file_path: "x.ts", search: "const x = 1", replace: "const x = 2" })',
        tips: 'Mehrdeutig (count > 1, lines nennt die Zeilen): search um umgebende Zeilen erweitern, bis er eindeutig ist — oder replace_all:true, wenn wirklich alle Stellen gemeint sind. 0 Treffer: Suchtext exakt aus dem aktuellen Inhalt kopieren (code_intel file / files read). Spaces/Tabs werden tolerant verglichen, mehrzeilige Suchtexte treffen auch CRLF-Dateien.',
      },
      search_replace_batch: {
        description: 'Mehrere Search-Replace-Edits in einem Aufruf, ATOMAR: Datei wird 1× gelesen und nur geschrieben, wenn JEDES Edit passt. Ein Edit mit 0 Treffern oder mit mehreren Treffern ohne replace_all -> success:false, nichts geschrieben, failed[] nennt jedes betroffene Edit.',
        params: 'edits (Array, 1..10.000 Elemente — praktisch unbegrenzt: { search, replace, replace_all? })',
        example: 'files({ action: "search_replace_batch", project: "synapse", file_path: "src/x.ts", edits: [{ search: "const x = 1", replace: "const x = 2" }, { search: "foo", replace: "bar", replace_all: true }] })',
        tips: [
          'Jedes Edit wird sequenziell auf dem aktuellen Content angewendet — spaetere Edits sehen Aenderungen frueherer.',
          'replace_all: true wenn der String mehrfach vorkommt und alle Vorkommen ersetzt werden sollen.',
          'Fehler: failed[{ index, search_preview, reason: "no_match" | "multiple_matches", count, lines, message }] — alle Edits werden geprueft, jeder Fehler kommt auf einmal. Korrigieren und den ganzen Batch erneut schicken.',
          'Erfolg: applied = total, skipped 0. warnings bleibt aus Kompatibilitaet (reason "no_match" bzw. "multiple_matches (N occurrences)" je fehlgeschlagenem Edit).',
          'Plan-Op search_replace_batch scheitert ebenso als Ganzes (plan_failed), wenn ein Edit nicht passt.',
        ].join(' '),
      },
      replace_lines: {
        description: 'Zeilenbereich ersetzen.',
        params: 'line_start, line_end, content',
      },
      insert_after: {
        description: 'Content nach einer Zeile einfuegen.',
        params: 'after_line, content',
        tips: 'after_line: 0 = am Anfang. content kann mehrzeilig sein.',
      },
      delete_lines: {
        description: 'Zeilenbereich loeschen.',
        params: 'line_start, line_end',
      },
      delete: {
        description: 'Ganze Datei loeschen.',
      },
      move: {
        description: 'Datei verschieben/umbenennen.',
        params: 'new_path',
      },
      copy: {
        description: 'Datei kopieren.',
        params: 'new_path',
      },
      reservation_add: {
        description: 'Eine oder mehrere Dateien kooperativ reservieren. Die TTL skaliert standardmaessig mit 20 Minuten je unterschiedlichem Beteiligtem bis maximal 120 Minuten; BASE=0 schaltet explizit auf Legacy 5 Minuten.',
        params: 'project, agent_id, file_path (String oder Array), expires_at?, plan_id?',
        example: 'files({ action: "reservation_add", project: "synapse", agent_id: "agent-x", file_path: ["src/a.ts", "src/b.ts"] })',
        tips: 'Vor dem Planen alle beabsichtigten Zieldateien reservieren. Eine Reservierung ist ein Koordinationssignal und Planungsvorrang, kein Besitzanspruch oder Schreib-Lock: andere Agenten duerfen reservieren und direkte Writes bleiben moeglich. Retry desselben Agenten/Pfads behaelt reserved_at und Content-Baseline. Nur echte EIGENE Tool-Activity erneuert (reservation_add verlaengert nur die eigene Reservierung, der plan-Aufruf eines Wartenden keine fremde; ttl_hint erklaert, warum expires_at je Datei verschieden ausfallen kann) — ein offener Plan zaehlt NICHT als Lebenszeichen (Plaene laufen nicht ab, ein abgestuerzter Agent wuerde sonst ewig sperren). Takeover folgt erst nach Grace und drei atomaren Sicherheitspruefungen (Grace, Activity seit Ablauf, Content-Hash).',
      },
      reservation_release: {
        description: 'Eigene aktive Reservierungen fuer einzelne Pfade freigeben — nach Commit, Cancel, Abbruch oder sobald die Datei nicht mehr zum eigenen Scope gehoert.',
        params: 'project, agent_id, file_path (String oder Array)',
        example: 'files({ action: "reservation_release", project: "synapse", agent_id: "agent-x", file_path: "src/a.ts" })',
        tips: 'So frueh wie moeglich freigeben, damit andere Agenten nicht unnoetig warten. Die Freigabe beendet nur das Koordinationssignal; sie rollt weder Plan noch Datei-Aenderungen zurueck. Nach einem erfolgreichen commit nicht noetig: commit gibt die Reservierungen der Plan-Pfade selbst frei. Antwort: released (jetzt freigegeben), already_released (war schon frei, mit released_at, reason commit|takeover|release und plan_id) und missing_paths (nur Pfade, die dieser Agent nie reserviert hat).',
      },
      reservation_update: {
        description: 'Reservierungen in EINER PostgreSQL-Transaktion freigeben, behalten und hinzunehmen.',
        params: 'project, agent_id, release_paths?, keep_paths?, add_paths?, expires_at?, plan_id?',
        example: 'files({ action: "reservation_update", project: "synapse", agent_id: "agent-x", release_paths: ["B.ts"], keep_paths: ["F.ts"], add_paths: ["G.ts"] })',
        tips: 'release_paths, keep_paths und add_paths muessen disjunkt sein. Nicht genannte Reservierungen bleiben unangetastet. Ohne expires_at gilt auch fuer neue/erneuerte Reservierungen die skalierte TTL: 20 Minuten je Beteiligtem, maximal 120; BASE=0 aktiviert Legacy 5 Minuten.',
      },
      reservation_list: {
        description: 'Reservierungsstand listen; standardmaessig nur nicht freigegebene Zeilen. Ablauf allein gibt den Planungsvorrang nicht frei; Takeover-Audit steht in taken_over_at/taken_over_by.',
        params: 'project; optional file_path (String oder Array), reservation_agent_id/agent_filter, include_released',
        example: 'files({ action: "reservation_list", project: "synapse", agent_id: "pruefer", file_path: "src/a.ts" })',
        tips: 'agent_id ist Attribution. Fuer den Besitzer-Filter reservation_agent_id oder agent_filter nutzen, damit ein Pruefer mehrere Agenten sehen kann. Mehrfachreservierungen sind normal: Ein Eintrag dokumentiert Koordinationsbedarf, nicht Eigentum.',
      },
      versions: {
        description: 'Versionshistorie einer Datei (neueste zuerst). Liefert Metadata ohne Inhalt — voller Inhalt via get_version.',
        params: 'file_path (req), limit? (Standard 50, Max 500)',
        example: 'files({ action: "versions", project: "synapse", file_path: "src/x.ts", limit: 20 })',
        tips: 'Jede Aenderung erzeugt automatisch einen Snapshot des Stands VOR der Aenderung: content_hash/size_bytes (und get_version.content) sind dieser Vorher-Stand, den restore zurueckholt. nachher {content_hash, size_bytes, quelle} ist der Stand NACH der Aenderung (quelle naechste_version, aktueller_stand oder geloescht). edit_action zeigt was geaendert hat (create / update / search_replace / search_replace_batch / replace_lines / insert_after / delete_lines / batch:<plan_id>:<ops> / restore:<id> / etc.). batch_id ist gesetzt wenn die Aenderung Teil eines Multi-File-Edits war.',
      },
      get_version: {
        description: 'Liefert eine konkrete Version inklusive content.',
        params: 'version_id (req, String)',
        example: 'files({ action: "get_version", project: "synapse", version_id: "1234" })',
        tips: 'version_id ist BIGSERIAL — bei sehr alten Datenbanken kann die Zahl > Number.MAX_SAFE_INTEGER werden, deshalb als String uebergeben.',
      },
      restore: {
        description: 'Stellt eine alte Version als aktuellen Stand wieder her. NICHT-DESTRUKTIV: der vorherige Stand wird automatisch als neue Version mit edit_action="restore:<id>" gesnapshottet, du kannst also jederzeit wieder zurueckrollen.',
        params: 'version_id (req, String)',
        example: 'files({ action: "restore", project: "synapse", version_id: "1234", agent_id: "mein-agent" })',
        tips: 'Workflow: 1. files(versions) → Liste, 2. files(get_version) → Inhalt pruefen, 3. files(restore) → einspielen.',
      },
      restore_batch: {
        description: 'Rollt eine ganze Multi-File-Batch zurueck — alle Files die zu dieser batch_id gehoeren werden auf ihren Pre-Batch-Stand zurueckgesetzt. Auch nicht-destruktiv (jede Restore-Operation erzeugt selbst wieder Versionen).',
        params: 'batch_id (req, String)',
        example: 'files({ action: "restore_batch", project: "synapse", batch_id: "42", agent_id: "mein-agent" })',
        tips: 'Greift bei Multi-File-Plans (Schritt 2): commit setzt batch_id=plan_id in jedem file_versions-Snapshot. vorschau:true schreibt NICHTS und zeigt je Datei batch_diff (was der Batch geaendert hat) und rueckgaengig (was restore_batch jetzt aendern wuerde). Auch fuer manuelle Bulk-Rollbacks nutzbar wenn batch_id manuell vergeben wurde.',
      },
      plan: {
        description: 'Phase A eines Multi-File-Edits: dry-runt ops[], erfasst Hashes/Previews und trennt Pfade mit fremder primaerer nicht freigegebener Reservierung als persistente, nach primary_agent gruppierte coedit_waits ab. move/copy prueft auch new_path; Ablauf allein gibt den Vorrang nicht frei. auto_commit schreibt ausschliesslich den konfliktfreien Teilplan. Ohne Ueberlappung bleibt die Antwort unveraendert.',
        params: 'project (req), ops (req, Array von { file_path, action, new_path?, content?, search?, replace?, edits?, line_start?, line_end?, after_line?, shift_mode?, reason? }), agent_id, open_for_coedit, reason (Top-Level)',
        example: 'files({ action: "plan", project: "synapse", reason: "Refactor Modul X", ops: [{ file_path: "src/x.ts", action: "replace_lines", line_start: 10, line_end: 15, content: "neu" }, { file_path: "src/x.ts", action: "insert_after", after_line: 50, content: "// log" }, { file_path: "src/x.ts", action: "delete_lines", line_start: 80, line_end: 85 }] })',
        tips: 'PRUEFUNG (P15-T17 E3): plan, plan_update und coedit_add pruefen den Plan-Schatten (Stand bei plan() + alle Ops in commit-Reihenfolge, nur im Speicher) auf Syntaxfehler und Signatur-Muster und haengen jeden Befund an die VERURSACHENDE Op (seine Zeile liegt in ihrer Spanne im Endstand; ein Kombinationsfehler haengt an der spaeteren Op mit beteiligt). '
          + 'Antwort pruefung {status, sperre, anzahl, je_op {"<op_index>": {error, warning, info, quittiert}}, op_indices_mit_befund, befunde[] (id, op_index, agent_id, datei, zeilen, quelle syntax|muster, severity, pruefer, was, warum, wie, wo), altlasten}; im diff steht "!! befund <id> op <i> <severity>: <was>" direkt unter der betroffenen Zeile. coedit_add meldet zusaetzlich eigene_befunde. '
          + 'Gespeichert werden nur die Befunde (file_batch_plans.befunde), nie der Schatten. sperre:true = der commit wird gesperrt, bis die Op korrigiert (plan_update) oder der Befund quittiert ist (siehe commit). Altlasten (Fehler in unveraenderten Zeilen) werden nur gezaehlt. '
          + 'PLANLOS RESERVIERT (P6-T31): Entsteht fuer eine lebende Reservierung noch ohne Zielplan ein Wait, erhaelt der Reservierende ein persistentes PLAN_WAITING-Event mit Datei, Wartendem und Deadline. Er kann mit eigenen Ops auf der Datei planen (dann wird der Wartende gebunden und per PLAN_READY eingeladen) oder nicht mehr benoetigte Pfade mit reservation_release freigeben. B sieht in coedit_waits[].handlungsanweisung Plan/Freigabe, den 60-Sekunden-Statusweg und den Retry nach expired. '
          + 'reused_carrier: planst du erneut auf Dateien, fuer die du schon einen offenen LEEREN Traeger mit Wait auf dasselbe Ziel hast, wird dieser wiederverwendet (gleiche plan_id, Wait erweitert, ein PLAN_READY) statt ein zweiter Traeger angelegt. '
          + 'ABGELAUFENE RESERVIERUNG (P15-T27/T31): eine fremde Reservierung zaehlt nur, solange sie lebt (expires_at in der Zukunft) und ihr Agent angemeldet ist — eine abgelaufene, nie freigegebene erzeugt keinen Wait mehr, die Op landet sofort im Plan (der reservation_ttl-Worker gibt solche Reservierungen nach der Grace-Frist frei). '
          + 'Laeuft sie WAEHREND des Wartens ab (oder gibt der Primaeragent frei, meldet sich ab), ist der Wait TOT: plan_status zeigt wait_status expired und coedit_waits_abgelaufen, shared_plan_status status expired, die Long-Polls (wait_seconds) wachen dabei auf. '
          + 'Dann dieselben Ops erneut planen: der leere Traeger wird wiederverwendet (reused_carrier, gleiche plan_id), der tote Wait geschlossen, die Ops landen direkt im Plan. Den Traeger vorher NICHT verwerfen (cancel schliesst seine Waits samt Ops). Solange der Wait lebt, haengt ein wiederholter plan identische Ops nicht doppelt an. '
          + 'NICHTS GESCHRIEBEN (P15-T31): plan mit auto_commit:true, bei dem keine Op sofort in den Plan kam (alles wartet im Co-Edit-Wait), meldet success:false, error nothing_written, nichts_geschrieben:true, grund (wartet | abgelaufen | leer), waits und was_tun — nie success. Bei auto_commit ueber mehrere Dateien gilt das, wenn keine Datei committed wurde. '
          + 'Trockenlauf fuer Pfade eines offenen fremden Plans: scheitert eine Op gegen die Platte, wird sie noch einmal gegen den Stand DES ZIELPLANS (Platte + dessen Ops) geprueft — ein Anker, den erst eine Op im Zielplan erzeugt, ist dann kein plan_failed (preview.context nennt den Plan). '
          + 'Der Wait folgt der skalierten Primaerreservierungs-TTL. PLAENE LAUFEN NACH FRIST AB (P6-T49): ein offener Plan bleibt offen, bis er committed oder per cancel verworfen wird oder laenger als files_plan_stunden (Einstellung admin ausweis_fristen, projekt > global > Standard 48 h) ohne Aktivitaet war (Anlage oder Bewegung eines gebundenen Waits) — dann schliesst ihn der REST-Worker files_plan_ablauf mit Status expired (nichts geschrieben, Ops und reason bleiben lesbar, Betroffene bekommen PLAN_CANCELLED mit abgelaufen:true; expires_at hat keine Bedeutung). Er haelt aber keine Reservierung am Leben — die lebt nur von echter Tool-Aktivitaet; gegen einen veralteten Plan schuetzt der Hash-Check beim commit (stale, nichts geschrieben). Offene Plaene des Projekts erscheinen als open_plans in normalen Tool-Antworten (max. 5, nach letzter Aktivitaet, eigene zuerst; Plaene ohne Aktivitaet seit >7 Tagen nur als \"aeltere\" gezaehlt — automatisch beendet werden sie nur ueber die Frist files_plan_stunden; offene leere Traeger als wartende_traeger; dazu gesamt; bei unveraendertem Bestand hoechstens alle 15 Minuten erneut). SCHEITERT EINE OP im Trockenlauf (z. B. Anker passt nicht), wird nichts geschrieben, aber der ganze Batch als NEUER offener Plan mit eigener plan_id gespeichert (nie ein vorhandener Plan ueberschrieben); die Antwort (error plan_failed) nennt plan_id und failed_ops (index, file_path, error). Korrigieren mit plan_update, verwerfen mit cancel; committbar ist er erst ohne gescheiterte Op. auto_commit mit MEHREREN Dateien ist per Datei atomar: erfolgreiche Dateien werden committed, alle Dateien mit gescheitertem Trockenlauf landen GEMEINSAM als ein neuer offener Plan (open_plan in der Antwort, op-Indizes beziehen sich auf diesen Plan); Commit-Fehler (stale) bleiben wie bisher nur in failed[]. Vor dem Planen reservieren. GEMEINSAMER PLAN (ein Plan je Datei): Liegt auf einem Pfad ein offener co-edit-offener Plan eines anderen Agenten — auch wenn dessen Owner verschwunden, die Reservierung abgelaufen oder die Datei von einem Dritten ohne eigenen Plan reserviert ist —, bekommst du keinen Parallelplan, sondern coedit_waits auf genau diesen Plan: Beitraege der anderen zeigt plan_status (contributors, ops_overview), eigene Ops kommen per coedit_add dazu, danach coedit_ready; committen darf jeder Beteiligte (der commit wartet nur auf aktive, noch nicht bereite Beitragende — siehe commit). EIGENER offener Plan auf denselben Dateien: deine neuen Ops werden nach gemeinsamem Trockenlauf direkt dort angehaengt (merged_into, plan_id = dieser Plan, kein zweiter Plan; nicht ueberlappende Dateien laufen normal als eigener Plan). Passt der gemeinsame Trockenlauf nicht (z. B. dieselbe Zeile), wird nichts geplant, die Meldung nennt plan_update. Voraussetzung: der Plan passt noch zum aktuellen Dateistand (sonst waere er stale). Ein wartender/gebundener Wait laeuft fuer Beitraege nicht ab, und ein Takeover der Reservierung verwirft weder den Plan noch an ihn gebundene Waits. Hash-Konflikte entstehen nur durch Aenderungen AUSSERHALB des Plans; Beitraege im Plan sind kein Konflikt (ausser echter Anker-/Zeilen-Ueberlappung). Ein gescheiterter eigener Batch auf solchen Pfaden wird ein Entwurf mit eigener ID (weder committbar noch beitretbar, nennt den Plan in shared_plans) und landet nach plan_update dort als Beitrag. Leere Traegerplaene (0 eigene Ops, alles im Wait) werden beim commit des gemeinsamen Plans geschlossen. Alle Zeitstempel sind ISO-8601 UTC mit Z. Polling hoechstens einmal pro Minute und nur mit konkretem wait_token; Activity ist Lebenssignal, aber kein Takeover-Beweis. open_for_coedit=false sperrt coedit_add. Op-Actions: create, update, search_replace, search_replace_batch, replace_lines, insert_after, delete_lines, delete, move, copy. Mehrere Ops auf gleicher Datei sind moeglich; line-Ops nutzen standardmaessig shift_mode="auto". Shared Ops werden ueber wait_token und CE-3-Actions direkt in genau einen gemeinsamen Primaerplan integriert.',
      },
      plan_update: {
        description: 'Korrigiert einen offenen Plan (typisch: nach plan_failed), ohne ihn zu ueberschreiben. Mit op_index ersetzt ops[] genau diese Op (1..n Ops), ohne op_index ersetzt ops[] alle Ops. Fuer ALLE Agenten und IM SELBEN Plan (gleiche plan_id, Waits und Beitraege bleiben gebunden): unveraenderte Ops behalten ihre agent_id, neue tragen deine; ohne op_index ersetzt ops[] alle DEINE Ops. Validiert gegen die Ausgangsbasis des Plans (Hashes muessen noch stimmen), ohne Ueberlappung mit fremden Ops, und der gemeinsame Trockenlauf muss gelingen — sonst wird nichts geaendert. Ausnahme: dein EIGENER Entwurf (gescheiterter Batch ohne fremde Ops) laeuft neu durch plan und bekommt eine eigene plan_id (superseded_plan_id), damit er ggf. als Beitrag in einem gemeinsamen Plan landet.',
        params: 'project, plan_id (req), ops (req), op_index?, agent_id, reason?, open_for_coedit?, auto_commit?',
        example: 'files({ action: "plan_update", project: "synapse", plan_id: "42", op_index: 1, agent_id: "ich", ops: [{ file_path: "src/x.ts", action: "search_replace", search: "richtiger Anker", replace: "neu" }] })',
        tips: 'Co-Edit-Beitraege eines anderen Agenten darf nur ihr Autor ersetzen; Ops des Owners und eigene darf jeder Beteiligte ersetzen. Scheitert auch der Folgeplan, ist er der neue offene Entwurf (wieder plan_failed mit eigener plan_id) — der vorige ist trotzdem verworfen. auto_commit:true committet den Folgeplan direkt, wenn alle Ops ok sind.',
      },
      coedit_add: {
        description: 'Haengt die noch offene deferred Operation des konkreten waiting_agent genau einmal an den offenen Primaerplan. Die Herkunft agent_id wird serverseitig gesetzt; Input-Herkunft ist nicht vertrauenswuerdig.',
        params: 'project, plan_id, agent_id, ops, wait_token? (genau diesen Wait), op_index? (= coedit_source_op_index: diese zurueckgestellte Op durch ops[0] ersetzen)',
        example: 'files({ action: "coedit_add", project: "synapse", plan_id: "42", agent_id: "agent-b", ops: [{ file_path: "src/x.ts", action: "search_replace", search: "alt", replace: "neu" }] })',
        tips: 'Nur der waiting_agent des konkreten Waits ist berechtigt. Cross-Wait-Dedup nutzt source_plan_id + deferred_op_index. '
          + 'coedit_source_op_index = Nummer deiner zurueckgestellten (deferred) Op im Wait — ihre Position in DEINEM urspruenglichen plan-Aufruf (bei wiederverwendetem Traeger fortlaufend), NICHT der op_index im gemeinsamen Plan; '
          + 'steht an jeder beigetragenen Op, in failed_ops und in plan_status deines Traegers (coedit_waits[].coedit_source_op_indexes). '
          + 'OP ANPASSEN (typisch nach contribution_failed): coedit_add mit op_index = coedit_source_op_index und ops:[geaenderte Op] ersetzt genau diese zurueckgestellte Op (dieselben Dateien) und traegt sie im selben Aufruf bei; ohne op_index muss die Op exakt der geplanten entsprechen. '
          + 'contribution_failed nennt verursacher (globale op_index + agent_id der Op, nach der dein Beitrag scheitert, mit Abruf-Aufruf) und anpassen (fertiger coedit_add-Aufruf). '
          + 'insert_notes (INFO, kein Fehler): zwei REINE Einfuegungen an derselben Stelle (insert_after derselben Zeile, search_replace mit replace = Anker + Text bzw. Text + Anker) sind kein Konflikt — beide bleiben genau einmal erhalten, angewendet in Beitragsreihenfolge; die spaeter angewendete steht direkt an der Einfuegestelle. Ueberlappende Ersetzungen/Loeschungen bleiben overlap_warnings. Ein Anker, den erst eine Op eines anderen Agenten einfuegt, ist ebenfalls erlaubt (insert_notes reason builds_on). '
          + ' open_for_coedit=false lehnt ohne Mutation ab. Danach alle gemeinsamen Dateien entweder mit coedit_add beitragen oder mit coedit_no_changes abschliessen und erst dann coedit_ready senden. Ueberlappen angehaengte Ops mit Ops eines anderen Agenten (gleiche Erkennung wie im commit), liefert die Antwort schon hier nicht blockierend overlap_warnings: der spaetere commit endet dann voraussichtlich terminal in coedit_conflict — frueh abstimmen statt erst nach dem Konflikt cancel + replan. Ist der Plan inzwischen committed, ist das KEIN Fehler: deine Ops landen automatisch in einem Folgeplan auf den aktuellen Dateistand (follow_up:true, neue plan_id — oder coedit_waits[].target_plan_id, wenn schon ein anderer offener gemeinsamer Plan auf den Pfaden liegt). Zeilen-Ops beziehen sich wie immer auf den Stand VOR dem commit: der Server rechnet sie ueber die beim commit gespeicherten exakten Zeilentabellen (previews[].zeilen, auch ueber mehrere commits hintereinander) auf den aktuellen Stand um, OHNE Groessengrenze; fehlt fuer ein Stueck eine Tabelle, per Zeilendiff (umgerechnete_zeilen_ops, umrechnung); trifft eine Op Zeilen, die sich seitdem geaendert haben, wird der Beitrag abgelehnt (late_line_ops_unmappable, aktueller_stand zeigt die Stelle jetzt, nichts geaendert) — nie eine falsche Zeile. Anker werden gegen den aktuellen Stand geprueft. Liegt schon ein offener gemeinsamer Plan auf den Pfaden, wird dein Beitrag dort gleich angehaengt (beigetragen_in). Ein Agent kann parallel in beliebig viele gemeinsame Plaene beitragen (je Plan eigener Wait; optional wait_token angeben). reason gehoert nicht zum Abgleich mit der geplanten Op; weicht ein anderes Feld ab, nennt die Ablehnung Feld, geplanten und gesendeten Wert. Ein Beitrag, der ZUSAMMEN mit dem Plan nicht anwendbar ist, wird sofort abgelehnt (contribution_failed, failed_ops) — der gemeinsame Plan bleibt unberuehrt und committbar. Ein Trägerplan mit Waits auf mehrere Ziele bleibt offen, bis ALLE Ziele committed/verworfen sind.',
      },
      coedit_no_changes: {
        description: 'Markiert konkrete gemeinsame Dateien als erledigt, ohne Ops an den Plan anzufuegen.',
        params: 'project, plan_id, agent_id, files (Array)',
        example: 'files({ action: "coedit_no_changes", project: "synapse", plan_id: "42", agent_id: "agent-b", files: ["src/x.ts"] })',
        tips: 'Nur fuer konkret gepruefte Dateien ohne eigenen Aenderungsbedarf verwenden. Das zaehlt fuer die Vollstaendigkeitspruefung von coedit_ready, fuegt aber keine Operation hinzu.',
      },
      coedit_ready: {
        description: 'Markiert den eigenen Beitrag als fertig. Bleiben gemeinsame Dateien ohne Beitrag oder no_changes, wird der Abschluss abgelehnt und remaining_files geliefert.',
        params: 'project, plan_id, agent_id',
        example: 'files({ action: "coedit_ready", project: "synapse", plan_id: "42", agent_id: "agent-b" })',
        tips: 'wait_status: waiting = Wait wartet noch auf sein Ziel bzw. auf deinen ersten Beitrag; linked = an den Ziel-Plan gebunden und angefangen (Beitrag oder no_changes fuer einen Teil der Dateien), aber noch nicht ready; '
          + 'ready = fertig mit Beitrag; no_changes = fertig ohne Beitrag; conflict = Ziel-Plan ist in conflict; closed = zurueckgezogen/Traeger verworfen, zaehlt nicht mehr; '
          + 'expired (P15-T27, nur Anzeige, gespeichert bleibt waiting) = Wait ist TOT: kein Ziel gebunden und der Primaeragent haelt auf keiner geteilten Datei mehr eine lebende Reservierung (abgelaufen, freigegeben, abgemeldet) — sein Ziel entsteht nie mehr. Dieselben Ops erneut planen (der Traeger wird wiederverwendet). Wer nicht mehr da ist: intern(waits_tot) sichert solche Waits als thought und schliesst sie erst danach. '
          + 'Mehrere Waits eines Agenten zeigen in contributions und commit_wartet_auf DENSELBEN Gesamtstatus (der am wenigsten fortgeschrittene offene). '
          + 'Erst senden, wenn jede shared_file durch coedit_add oder coedit_no_changes abgedeckt ist. ready/no_changes sagt den anderen, dass du fertig bist: ein commit wartet auf dich nur, solange du nicht ready bist UND aktiv arbeitest (Tool-Aktivitaet in den letzten SYNAPSE_COEDIT_AKTIV_MIN Minuten, Default 5) — wer nichts beitragen will, meldet coedit_no_changes/coedit_ready oder zieht per cancel (mit agent_id) zurueck, statt andere aufzuhalten; wer selbst committet, gilt als fertig; conflict ist terminal und verlangt Cancel/Replan.',
      },
      shared_plan_status: {
        description: 'Liest nur den einen konkreten Wartezustand des opaken wait_token, nicht den ganzen Planbestand. target_plan_id nennt den Plan, in den coedit_add gehoert — schon vor dem Beitritt (primary_plan_id ist bis dahin null); dieselbe ID steht in der plan-Antwort unter coedit_waits[].target_plan_id. Entsteht der Zielplan erst spaeter, wird der Wait automatisch daran gebunden. ECHTES WARTEN: wait_seconds (max. 50) haelt die Anfrage, bis sich Status, Zielplan, erledigte Dateien oder ready aendern (Antwort: changed, waited_seconds).',
        params: 'project, wait_token, agent_id; optional ansicht (uebersicht|befunde)',
        example: 'files({ action: "shared_plan_status", project: "synapse", wait_token: "uuid", agent_id: "agent-b", ansicht: "uebersicht" })',
        tips: 'Primaer pending_events in normalen Tool-Antworten beachten: PLAN_READY (Ziel bereit), danach PLAN_COMMITTED / PLAN_CANCELLED / PLAN_CHANGED / PLAN_FOLLOWUP (was aus dem Plan wurde, mit offene_dateien und hinweis) — lesen, handeln, quittieren; nicht aktiv eng pollen. Nur wenn ein Statusabruf noetig ist: hoechstens einmal pro Minute und ausschliesslich mit dem konkreten wait_token. Ein erledigtes PLAN_READY wird nur zusammen mit seinem Nachfolge-Event quittiert — die Information geht nicht verloren.',
      },
      commit: {
        description: 'BERECHTIGUNG (P6-T35): Nur Owner, Agenten mit eigenen Ops/Waits sowie agent_id koordinator|coordinator|user duerfen committen. Unbeteiligte erhalten error fremder_plan ohne Mutation; die Antwort nennt Owner und eigene offene Plaene. Ohne agent_id wird bei fremden Ops wie bei cancel abgelehnt. Phase B: Legacy-Plaene behalten ihren bisherigen Pfad. Co-Edit-Plaene werden in genau einer Server-TX committed. READY-GATE NUR FUER AKTIVE: der commit wartet auf gebundene Beitragende/Wartende, die noch nicht ready/no_changes sind UND in den letzten SYNAPSE_COEDIT_AKTIV_MIN Minuten (Default 5) echte Tool-Aktivitaet hatten — dann status "waiting_for_contributors" mit waiting_for [{agent_id, wait_status, letzte_aktivitaet, inaktiv_ab, dateien}]: KEIN Fehler, nichts geschrieben, Plan bleibt offen; mit wait_seconds (max. 50) wartet der Server und schreibt, sobald alle ready/no_changes melden oder inaktiv werden. Inaktive blockieren nie, ihre schon beigetragenen Ops werden mitgeschrieben; der Aufrufer selbst gilt als fertig. Alle Betroffenen (Beitragende, Wartende, Owner) bekommen PLAN_COMMITTED mit ihren offene_dateien. Die Plan-Zeile ist bis zum Ende gesperrt (auch im Legacy-Pfad); ein gleichzeitiges coedit_add wartet und landet danach automatisch im Folgeplan. Der Plan wird gegen expected_hashes, Anchors und Cross-Agent-Ranges validiert und gemeinsam committed. Ueberlappung setzt terminal status="conflict" ohne Datei-/Versionswrites. Jede Op erzeugt einen Snapshot mit ihrer serverseitigen agent_id und derselben batch_id.',
        params: 'plan_id (req), agent_id, agent_note (optional: KI-Notiz fuer Audit/Crash-Recovery), wait_seconds (optional, max. 50: auf aktive Beitragende warten), wait_sync (optional: bis zum Daemon-Hashvergleich warten; Maximaldauer via SYNAPSE_COMMIT_WAIT_SYNC_MAX_SECONDS), befunde_quittieren (optional: [{id, grund}] Pruefbefunde quittieren)',
        example: 'files({ action: "commit", project: "synapse", plan_id: "42", agent_id: "ich" })',
        tips: 'PRUEFBEFUNDE (P15-T17 E3): vor dem Schreiben wird der Plan-Schatten (aktueller Stand + alle Ops) neu geprueft (Syntax mit sperrfaehigem Pruefer, Signatur-Muster aus error_patterns). Ein OFFENER Befund mit severity error an einer Op sperrt: success:false, error pruef_befunde, geschrieben:false, Plan bleibt offen, blockierende [{id, op_index, agent_id, file_path, zeilen, quelle, was, wie}], abruf (plan_status der Op), korrektur (plan_update - nur der Autor der Op), quittieren (fertiger Aufruf). warning, info und Altlasten (Fehler in unveraenderten Zeilen) sperren nie. '
          + 'QUITTIEREN: commit mit befunde_quittieren:[{id, grund}] - Grund mind. 5 Zeichen, landet mit Pruefer/Datei/Zeile in file_versions.agent_note; zu kurzer Grund oder unbekannte id -> quittierung_abgelehnt. Syntaxbefunde NUR bei absichtlich fehlerhaftem Inhalt (Test-Fixture, Negativbeispiel). Quittierungen bleiben ueber Neupruefungen (plan_update, coedit_add) erhalten. '
          + 'auto_commit mit error-Befund: nichts geschrieben, auto_committed:false, Plan offen; per_file_atomic: Dateien ohne error werden committed, die anderen stehen in failed[] mit plan_id + blockierende. FEHLERPRUEFUNG_PLAN=0 schaltet Pruefung und Sperre ab. '
          + 'NICHTS GESCHRIEBEN (P15-T31): commit auf einen Plan OHNE Op (typisch: leerer Traeger, dessen Ops im Co-Edit-Wait liegen) meldet NIE success, sondern success:false, error nothing_written, nichts_geschrieben:true, committed 0, grund, waits und was_tun; Plan und Waits bleiben offen, nichts wird committed. '
          + 'grund wartet = der Wait lebt -> files(plan_status, plan_id, wait_seconds:50) bzw. shared_plan_status mit wait_token warten, bei PLAN_READY coedit_add + coedit_ready; grund abgelaufen = der Wait ist tot -> ops_zum_neu_planen (vollstaendig in der Antwort) erneut an files(action:"plan") geben, der Traeger wird wiederverwendet; grund leer = keine Op und kein Wait -> files(action:"cancel", plan_id). '
          + 'Vorher kam hier success mit committed 0, der Traeger wurde committed und der Wait verlor seinen Traeger. Ausnahme: ist der leere Plan ZIEL gebundener Beitragender, gilt wie bisher das Ready-Gate (waiting_for_contributors). '
          + 'Bei wait_sync:true wartet der Commit nach dem PG-Commit optional auf den Hashvergleich mit dem verbundenen lokalen Daemon (SYNAPSE_COMMIT_WAIT_SYNC_MAX_SECONDS, Default 5 s, Obergrenze 30 s); ohne Daemon bleibt auf_platte unbekannt. Bei waiting_for_contributors: an anderem weiterarbeiten oder commit mit wait_seconds (plan_status zeigt commit_wartet_auf). Bei stale: neu planen (ein veralteter Plan bricht so sauber ab, ohne zu schreiben). Bei plan_has_failed_ops: erst plan_update. Bei conflict: cancel + replan; der Konfliktstatus ist terminal. Bei Erfolg: batch_id fuer restore_batch merken; released_reservations nennt die freigegebenen Reservierungen. committed zaehlt Dateien, committed_ops die geschriebenen Ops. Ein erfolgreicher commit gibt die Reservierungen aller Beteiligten (Owner, Op-Agenten, Wait-Agenten) auf den Plan-Pfaden selbst frei (released_at = Commit-Zeitpunkt, plan_id = dieser Plan) — ein reservation_release danach ist nicht noetig; falls doch aufgerufen, erscheinen die Pfade als already_released mit reason "commit", nicht als missing_paths.',
      },
      cancel: {
        description: 'Niemand zerstoert fremde Arbeit: enthaelt der Plan Ops ANDERER Agenten, zieht cancel nur DEINE Ops zurueck (mode "withdrawn"; der Plan bleibt fuer die anderen offen, ein conflict-Plan wird wieder open, deine Waits werden wieder beitrittsfaehig). Nur ohne fremde Ops wird der Plan verworfen (mode "cancelled", Soft-Delete). mode "none" = keine eigenen Ops drin, nichts passiert. OHNE agent_id (Aufrufer unbekannt) wird ein Plan mit fremden Ops NIE verworfen (mode "refused"), nur ein Plan, der allein dem Owner gehoert. Betroffene bekommen PLAN_CANCELLED bzw. beim Rueckzug PLAN_CHANGED. Moeglich bei status=open oder conflict; agent_id angeben, reason = optionaler Grund. Nach dem Rueckzug laufen die verbleibenden Ops neu trocken (keine veralteten Konflikt-/Fehlermarken). Zieht der OWNER zurueck, geht der Plan an den Autor der ersten verbleibenden Op (Waits ziehen mit). Deine Waits auf den Plan werden geschlossen (status closed), ihr leerer Traegerplan ebenso; erneut beitreten = einfach neu planen (du wirst per Wait in den gemeinsamen Plan gefuehrt). Wird ein Plan ganz verworfen, schliessen alle daran gebundenen Waits und leeren Traegerplaene. NICHTS wird geloescht: zurueckgezogene Ops bleiben samt ihren reasons als Rueckzugsprotokoll erhalten (eigener verworfener Eintrag, in plan_status.withdrawn mit wer/wann/Grund getrennt sichtbar); ein ganz verworfener Plan behaelt ops und reason, ergaenzt um den Vermerk wer/wann/warum. Beim commit stehen die reasons je Autor in file_versions. committed_at bleibt null, weil nichts geschrieben wurde (gilt auch fuer stale/conflict). KOORDINATOR/USER (P6-T49): cancel MIT grund (min. 5 Zeichen) verwirft ausdruecklich den GANZEN Plan samt fremder Ops (mode cancelled, verworfen_fremd nennt die Autoren, Vermerk im reason); andere Agenten mit grund behandeln weiter nur ihre eigenen Ops (fremd_verwerfen_abgelehnt + hinweis_fremd). Offene Plaene ohne Aktivitaet laufen zudem nach files_plan_stunden automatisch ab (Status expired).',
        params: 'plan_id (req), agent_id (wichtig: ohne sie kein Rueckzug, und fremde Ops werden nie verworfen), reason?, grund? (nur Koordinator/User: ganzer Plan inkl. fremder Ops)',
        example: 'files({ action: "cancel", project: "synapse", plan_id: "42", agent_id: "ich", reason: "doch anders" })',
        tips: 'Verwirfst du deinen eigenen (leeren) Traegerplan, werden seine offenen Waits mit geschlossen (closed_waits): sie halten den commit des Ziel-Plans nicht mehr auf, dessen Owner bekommt PLAN_CHANGED. Schon beigetragene Ops bleiben im Ziel-Plan — dort mit cancel + agent_id zurueckziehen.',
      },
      plan_status: {
        description: 'Plan-Details abfragen (Status, Previews, Files, reason, created_at/committed_at als ISO-8601 UTC mit Z; offene Plaene laufen nach files_plan_stunden ohne Aktivitaet ab -> Status expired). Committet: committed_by + batch_id (fuer restore_batch). ECHTES WARTEN: wait_seconds (max. 50) haelt die Anfrage, bis sich Status, Ops, Owner oder Wait-/Ready-Stand aendern oder die Zeit um ist (Antwort: changed, waited_seconds) — statt Polling-Schleifen. Ein Plan im Endzustand (committed/cancelled/stale) antwortet sofort (endzustand:true); ein commit waehrend des Wartens weckt sofort. Enthaelt der Plan gescheiterte Ops, stehen sie in failed_ops (+ failed_hint; an einem ersetzten Entwurf stattdessen superseded_by = Folgeplan). Gemeinsamer Plan: contributions = Wait-/Ready-Status je Beitragendem, overlap_warnings = aktuelle Cross-Agent-Ueberlappungen (nicht blockierend, auch fuer spaeter Hinzukommende sichtbar), commit_wartet_auf = auf wen ein commit gerade warten wuerde (aktive, noch nicht bereite Beitragende, mit inaktiv_ab). EINZELNE OP VOLLSTAENDIG: op_index (oder op_indices:[...]) liefert die Op ungekuerzt — agent_id, action, alle Felder (content, search/replace, edits, anchor_*, Zeilen), reason, Status (aktiv/committed/zurueckgezogen/verworfen) und ihr Unified-Diff im Gesamtbild des Plans (P15-T22 Plan-Schatten: Stand bei plan() + alle Ops in commit-Reihenfolge, nur im Speicher; Kopf je Hunk "op <index>" bzw. "op <index> (agent)"; nicht anwendbare Op: anwendbar:false, diff null, kein erfundenes nachher; drift-Hinweis, wenn die Datei seit plan() geaendert wurde; CRLF nur fuer die Anzeige normalisiert). plan_status OHNE op_index und die Antwort von plan/plan_update/auto_commit tragen diff je Datei ueber alle Ops (kompakt, FILES_DIFF_MAX_ZEILEN, nicht_anwendbar listet gescheiterte Ops); from_line/to_line schneiden bei sehr grossem content ein Fenster. Vor dem Schreiben an einer Stelle, an der ein anderer Agent aendert, diese Op ansehen. Jede Warnung/Ablehnung mit fremder Op (overlap_warnings, coedit_conflict, contribution_failed, late_line_ops_unmappable) nennt plan_id, op_index, agent_id und genau diesen Aufruf. Gekuerzt sind nur Anzeigen (previews[].context, ops_overview, open_plans) — op_vollstaendig nennt den Weg zur vollen Op. Fuer Status-Polling oder Diff-Inspektion vor commit. committed_at ist nur bei status="committed" gesetzt. Nach coedit_add ist ops_count groesser als previews_count: previews stammen aus dem plan-Trockenlauf des Primaerplans, angehaengte Co-Edit-Ops werden erst im commit gemeinsam validiert (previews_hint erklaert das; nichts wird gekappt). PRUEFBEFUNDE (P15-T17 E3): pruefung (Zaehler je Op, op_indices_mit_befund, befunde) aus der letzten Pruefung; im diff steht jeder Befund als "!! befund ..." unter seiner Zeile, op_index/op_indices liefern zusaetzlich befunde der Op (auch Kombinationsbefunde, an denen sie beteiligt ist).',
        params: 'plan_id (req); optional ansicht (uebersicht|befunde)',
        example: 'files({ action: "plan_status", project: "synapse", plan_id: "42", ansicht: "befunde" })',
        tips: 'op_indices darf auch als JSON-String ("[0,1]") oder Komma-Liste ("0,1") kommen. Traeger/Quellplan: coedit_waits zeigt je eigenem Wait target_plan_id (auch wenn das Ziel erst nach deinem plan entstanden ist), wait_status und coedit_source_op_indexes. '
          + 'insert_notes: reine Einfuegungen verschiedener Agenten an derselben Stelle (INFO, kein Konflikt, Reihenfolge = Beitragsreihenfolge). Nach ack eines PLAN_READY kommt fuer denselben Plan keins mehr in pending_events.',
      },
      history: {
        description: 'Audit-Log: chronologische Liste aller Datei-Aenderungen mit Begruendung. Crash-Recovery: nach Session-Crash kann eine neue Session sehen "wer hat wann was warum geaendert" und gegebenenfalls Versionen wiederherstellen. Filter nach feature_tag (exakter Match) oder version_id (rekursive parent-chain via parent_version_id).',
        params: 'project (req); optional: agent_id (Filter), file_path (Praefix-Match), since (ISO-Timestamp), limit (Standard 50, Max 500), feature_tag (, exakter Match), version_id (, BIGINT als String — liefert die Korrektur-Chain ab dieser Version rekursiv).',
        example: 'files({ action: "history", project: "synapse", feature_tag: "idea-thought-task-link", limit: 20 })',
        tips: 'reason wird beim Schreiben mitgegeben (files write-actions + plan/commit). Eintraege enthalten file_path, edit_action, agent_id, batch_id, reason, created_at und feature_tag, parent_version_id, git_commit_sha. Jeder Eintrag traegt diff = Unified-Diff der Aenderung, die diese Version abgeloest hat (nach einem commit mit op-Kopf aus dem Plan, sonst beim Lesen nachberechnet; in Listen auf 30 Zeilen gekuerzt, get_version liefert es ganz). Voller Inhalt einer Version: files(action: "get_version", version_id). version_id-Filter ist projektgebunden (Cross-Project-Schutz). FALLE: agent_id wirkt hier als EXAKTER Read-Filter, NICHT als Attribution — fuer die volle Projekt-History weglassen. Expliziter Filter: agent_filter. 0 Treffer mit gesetztem Filter liefern jetzt einen erklaerenden tip statt stillem count=0.',
      },
    },
  },

  // -------------------------------------------------------------------------
  // Weitere Tools — Platzhalter, werden von Spezialist ausgefuellt
  // -------------------------------------------------------------------------

  admin: {
    summary: 'Entry-Point fuer Agenten: Projekt-Statistiken, Onboarding-Regeln, Ideen-Management und Media-Indexierung.',
    when_to_use: [
      'index_stats als ERSTE Aktion jeder Session — laedt Projekt-Regeln und Onboarding.',
      'detailed_stats fuer detaillierte Collection-Infos.',
      'save_idea + confirm_idea um Feature-Ideen strukturiert einzureichen.',
      'index_media um Bilder/Videos in Qdrant zu indexieren.',
      'migrate/restore fuer Daten-Migration (selten, nur PL-Scope).',
      'jev_status/jev_schalten/jev_kosten/jev_budget: Jev (OpenRouter-Entscheidungsmodell) global, je Projekt oder je Funktion an/aus schalten, Kosten ansehen, globale Kostengrenze setzen (P15-T33).',
    ].join(' '),
    when_not_to_use: [
      'Code lesen/schreiben → code_intel oder files.',
      'Memories/Thoughts verwalten → memory oder thought.',
      'Projekt init/stop → project.',
    ].join(' '),
    param_tips: [
      'project: Pflicht fuer fast alle Actions (Ausnahme: confirm_idea).',
      'agent_id: Setzen bei index_stats/detailed_stats fuer Onboarding-Regeln.',
      'save_idea: title + description beide Pflicht. Tags optional fuer Filterung.',
      'confirm_idea: idea_id aus save_idea-Response. custom_name optional.',
      'migrate dry_run: true zuerst pruefen bevor echter Lauf.',
      'index_media: path muss absoluter Pfad sein. recursive: true ist Standard.',
      'JEV-SCHALTER (dauerhaft in PG, Tabelle jev_schalter): ebene global|projekt, funktion alle|empfehlung (plan empfehlen)|entscheidung (jev entscheiden + Hinweise jev_modus/jev_hinweis/jev_entscheidet)|plan_einordnen (plan einordnen)|erklaerungstopf (ab E1)|tool (das Tool jev). VORRANG: global aus = ueberall aus; sonst Projekt, dann Funktion; ein "an" weiter unten hebt ein "aus" darueber nicht auf. Ohne Eintrag = an. Ist ein Kontext aus, wird Jev NICHT aufgerufen und alle Jev-Hinweise verschwinden aus den Tool-Antworten; nach dem Wiedereinschalten erscheinen sie wieder. Bei global aus (alle oder tool) fehlt das Tool jev in tools/list (REST und stdio); ein Projekt-Schalter sperrt das Tool nur mit Antwort jev_aus, weil tools/list kein Projekt kennt. MCP-Clients laden die Tool-Liste meist nur beim Verbinden. Andere Prozesse sehen eine Aenderung nach spaetestens JEV_SCHALTER_CACHE_MS (5 s).',
      'JEV-KOSTEN: jeder Jev-Aufruf steht in jev_aufrufe (Zeit, Projekt, Funktion, Agent, input/output_tokens, usd, Quelle). usd = usage.cost der Antwort; fehlt es, input_tokens x Listenpreis (Env JEV_PREIS_JE_MIO_EINGABE, Standard 0,042 USD/Mio.). Ausgabe-Tokens kosten nichts. jev_kosten liefert Summen je Tag, Monat, Projekt, Funktion.',
      'JEV-BUDGET: optionale GLOBALE Grenze in USD je Abrechnungsmonat (ab reset_tag). Ohne Grenze keine Bremse. Vor jedem Aufruf wird atomar reserviert (JEV_BUDGET_RESERVE_USD, Standard 0,001), danach die echten Kosten nachgebucht; bei Erreichen pausiert Jev automatisch (wirkt wie global aus, Hinweis im Onboarding-Feld jev_hinweis und in jev_status). Weiter mit naechstem Reset, modus zuruecksetzen, hoeherer Grenze oder entfernen. kontostand:true fragt GET /api/v1/key (limit, limit_remaining, usage ...); der Key wird nie ausgegeben.',
      'JEV-OPTIONEN (global, dauerhaft, Tabelle jev_optionen, wirken ab E1 Erklaerungstopf): erklaerung_sprachen = gepflegte Sprachen der Erklaerungen, Deutsch und Englisch unabhaengig an/aus, mindestens eine an (beide aus wird abgelehnt), Standard beide an; alle eingeschalteten sind beim Ablegen Pflicht. jev_sprache = was Jev angeboten bekommt: en (Standard) | de | mix (braucht beide). Nur aus den gepflegten Sprachen wirksam; sonst Rueckfall auf eine gepflegte (en vor de) mit hinweis, jev_sprache_wirksam zeigt den geltenden Wert.',
      'Setzen (jev_schalten, jev_budget setzen/entfernen/zuruecksetzen, jev_optionen setzen) nur agent_id koordinator|coordinator|user (Namenstreue). Lesen darf jeder.',
    ].join('\\n'),
    examples: [
      'admin({ action: "index_stats", project: "synapse", agent_id: "mein-agent" })',
      'admin({ action: "save_idea", project: "synapse", title: "Shell-Timeout konfigurierbar", description: "Timeout via env var steuerbar machen" })',
      'admin({ action: "detailed_stats", project: "synapse" })',
    ],
    anti_patterns: [
      'index_stats ohne agent_id — bekommst keine Projekt-Regeln.',
      'migrate ohne dry_run: true — kann Daten-Verlust verursachen.',
      'save_idea fuer ephemere Notizen — nutze thought fuer Kurzlebiges.',
      'index_media mit relativem Pfad — path muss absolut sein.',
    ],
    actions: {
      index_stats: {
        description: 'Projekt-Statistiken + Agenten-Onboarding (Regeln, Hinweise).',
        params: 'project (req), agent_id, role, sitzung (neu | fortsetzung), onboarding (boolean; Refresh braucht alle vier vorherigen Felder)',
        example: 'admin({ action: "index_stats", project: "synapse", agent_id: "guide-content-writer", role: "subagent", sitzung: "neu" })',
        tips: 'Zuerst project(status, path:<aktueller Arbeitsordner>, agent_id) lesen und status.project übernehmen; kein basename-/Vorsitzungs-Raten. agent_id = deine ID. '
          + 'sitzung (P15-T32, nur mit agent_id): "neu" = du bist frisch gespawnt, auch unter einem schon benutzten Namen - '
          + 'Broadcasts und gesehene Fehlermuster der Vorsitzung gelten nicht fuer dich, an dich adressierte Events bleiben, '
          + 'und die Projekt-Regeln (agentOnboarding) kommen erneut, auch wenn der Name in diesem Prozess schon bekannt war. '
          + '"fortsetzung" = Handoff/Rotation desselben Agenten - unquittierte Events bleiben, Fehlermuster gelten im neuen '
          + 'Kontext als nicht gesehen. Ohne sitzung aendert sich an der Sitzung nichts. Die Antwort traegt dann das Feld sitzung '
          + '(art, sitzung_seit, aktiv_seit, vorher_status, wirkung). Bei Kontextwechsel fortsetzung + onboarding:true: Regeln direkt in dieser Antwort erneut; Channels, ACKs, Reservierungen, Waits und Beiträge bleiben. Ohne onboarding:true keine erneuten Regeln. Keine automatische Compaction-Erkennung ohne echte Wrapper-Schnittstelle.',
      },
      detailed_stats: {
        description: 'Detaillierte Collection-Statistiken pro Typ.',
        params: 'project (req)',
        example: 'admin({ action: "detailed_stats", project: "synapse" })',
      },
      save_idea: {
        description: 'Idee speichern (pending). Dann confirm_idea zum Aktivieren.',
        params: 'project, title (req), description (req), tags',
        example: 'admin({ action: "save_idea", project: "synapse", title: "Meine Idee", description: "Details..." })',
      },
      confirm_idea: {
        description: 'Gespeicherte Idee bestaetigen und Projekt-Namen setzen.',
        params: 'idea_id (req), custom_name',
        example: 'admin({ action: "confirm_idea", idea_id: "abc123", custom_name: "my-feature" })',
        tips: 'idea_id kommt aus save_idea Response. Kein project-Parameter noetig.',
      },
      migrate: {
        description: 'Embeddings migrieren (z.B. nach Modell-Wechsel).',
        params: 'project (req), collections (optional Array), dry_run',
        example: 'admin({ action: "migrate", project: "synapse", dry_run: true })',
        tips: 'Immer zuerst dry_run: true testen.',
      },
      restore: {
        description: 'Backup wiederherstellen.',
        params: 'project (req), backup_type (thoughts|memories|plans|proposals|all)',
        example: 'admin({ action: "restore", project: "synapse", backup_type: "thoughts" })',
      },
      index_media: {
        description: 'Bilder/Videos in Qdrant indexieren fuer semantische Suche.',
        params: 'project (req), path (req, absolut), recursive',
        example: 'admin({ action: "index_media", project: "synapse", path: "/home/user/images" })',
      },
      jev_status: {
        description: 'Wirksamer Jev-Stand je Funktion fuer project (an/aus, Ebene, Grund), gesetzte Schalter, Budget, Kosten der letzten 31 Tage, ob das Tool jev in tools/list steht.',
        params: 'project (empfohlen)',
        example: 'admin({ action: "jev_status", project: "synapse", agent_id: "koordinator" })',
      },
      jev_schalten: {
        description: 'Jev an/aus: global, je Projekt, je Funktion. Nur Koordinator/User.',
        params: 'ebene (req: global|projekt), project (req bei projekt), funktion (alle|empfehlung|entscheidung|plan_einordnen|erklaerungstopf|tool, Standard alle), aktiv (req, boolean), grund',
        example: 'admin({ action: "jev_schalten", project: "synapse", ebene: "global", funktion: "alle", aktiv: false, grund: "Kosten sparen", agent_id: "koordinator" })',
        tips: 'Wiedereinschalten mit aktiv:true auf DERSELBEN Ebene/Funktion. Global aus schlaegt jedes Projekt-an.',
      },
      jev_kosten: {
        description: 'Jev-Kosten in USD: gesamt, je Tag (62 juengste), je Monat, je Projekt, je Funktion.',
        params: 'seit, bis (ISO, Standard letzte 365 Tage), nur_dieses_projekt (mit project)',
        example: 'admin({ action: "jev_kosten", project: "synapse", nur_dieses_projekt: true })',
      },
      jev_budget: {
        description: 'Globale Kostengrenze je Abrechnungsmonat: status | setzen (grenze_usd, reset_tag) | entfernen | zuruecksetzen; kontostand:true liefert den OpenRouter-Kontostand.',
        params: 'modus (status Standard), grenze_usd, reset_tag (1..28), kontostand',
        example: 'admin({ action: "jev_budget", project: "synapse", modus: "setzen", grenze_usd: 5, agent_id: "koordinator" })',
        tips: 'Ueberschreitung hoechstens um die Kosten der gerade laufenden Aufrufe minus Reservierung. Setzen/entfernen/zuruecksetzen nur Koordinator/User.',
      },
      jev_optionen: {
        description: 'Globale Jev-Optionen fuer den Erklaerungstopf (ab E1): gepflegte Erklaerungssprachen (erklaerung_de, erklaerung_en) und Jev-Sprache (en|de|mix).',
        params: 'modus (status Standard | setzen), erklaerung_de, erklaerung_en (boolean, mind. eine an), jev_sprache (en|de|mix)',
        example: 'admin({ action: "jev_optionen", project: "synapse", modus: "setzen", erklaerung_de: false, jev_sprache: "en", agent_id: "koordinator" })',
        tips: 'Nicht genannte Optionen bleiben. Antwort: erklaerung_sprachen, gepflegte_sprachen, jev_sprache (Wunsch), jev_sprache_wirksam (nach Rueckfall), hinweis bei Rueckfall. Setzen nur Koordinator/User.',
      },
      kontextprofil_liste: {
        description: 'Kontextprofile auflisten (vorbereitet, noch nicht aktiv; speichert nichts). Nur Koordinator/User.',
        params: 'ziel (optional, agent_id oder Namensmuster)',
        example: 'admin({ action: "kontextprofil_liste", ziel: "luna-*", agent_id: "koordinator" })',
      },
      kontextprofil_setzen: {
        description: 'Kontextprofil setzen (vorbereitet, noch nicht aktiv; speichert nichts). Nur Koordinator/User.',
        params: 'ziel, kontext_budget, stufe (normal|kompakt|minimal), hinweise_aus[], hinweise_nur[], grund',
        example: 'admin({ action: "kontextprofil_setzen", ziel: "luna-2", kontext_budget: 25000, stufe: "kompakt", grund: "Test" , agent_id: "koordinator" })',
      },
      kontextprofil_entfernen: {
        description: 'Kontextprofil entfernen (vorbereitet, noch nicht aktiv; speichert nichts). Nur Koordinator/User.',
        params: 'ziel, grund',
        example: 'admin({ action: "kontextprofil_entfernen", ziel: "luna-2", grund: "Ende des Tests", agent_id: "koordinator" })',
      },
      // P22-T13 Paket D: Profilverwaltung. Akteur NUR aus User-Herkunft (Web-UI) oder persoenlichem Ausweis eines Koordinators desselben Projekts; Standard je Funktion AUS (funktion_aus).
      profil_schalter_status: { description: 'Produkt-Schalter der Profilverwaltung lesen (Standard AUS): profilverwaltung, typkatalog, persona, task_bindung, agenten_ausweis (EIN Schalter fuer den Ausweis-Kern: Token-Identitaet, Anmeldung, Schattenprofile, Abruf; Einschalten nur bei agent_bezug_modus beide; Antwort enthaelt ausweis_kern mit wirksamem Stand und Quelle). Nur User/Koordinator des Projekts.', params: 'project', example: 'admin({ action: "profil_schalter_status", project: "synapse" })' },
      profil_schalter_setzen: { description: 'Produkt-Schalter setzen (PG-persistent). ebene projekt (Standard): User oder Koordinator des Projekts; ebene global: User oder Koordinator des aufrufenden Projekts (auch Legacy-Koordinator, P22-T57; Audit gesetzt_von).', params: 'project, profil_funktion (profilverwaltung|typkatalog|persona|task_bindung|agenten_ausweis|mehrprojekt|alle; mehrprojekt = P22-T44 Ausweis fuer mehrere Projekte, nur ausdruecklich, alle schaltet ihn nicht mit), aktiv, grund (min. 5 Zeichen), ebene (global|projekt)', example: 'admin({ action: "profil_schalter_setzen", project: "synapse", profil_funktion: "persona", aktiv: true, grund: "Test freigegeben" })' },
      ausweis_fristen: { description: 'P22-T45: Fristen des Agenten-Ausweises als Einstellung in PG (keine Env): schatten_stunden (Schattenprofil Weg A, Standard 24), erstnutzung_minuten (vorbereiteter Ausweis Weg B / Daemon-Start, Standard 10), visum_minuten (Standard 30, automatisches Visum fuer Agenten anderer Projekte, P22-T44) und arbeitsfreigabe_stunden (Standard 24, Arbeitsfreigabe durch Koordinator/User dieses Projekts, P22-T44); es gelten die Werte des BESUCHTEN Projekts. anmeldung_plaene_minuten (Standard 30, P22-T50) und files_plan_stunden (Standard 48, P6-T49: offene files-Plaene ohne Aktivitaet laufen danach ab, Status expired; gilt auch fuer laufende Plaene, gemessen an der letzten Aktivitaet). Dazu der PRODUKT-SCHALTER files_plan_ablauf_aktiv (Standard EIN, projekt > global): modus setzen mit true|false schaltet den Fristablauf auf der ebene an/aus, modus entfernen mit dem Parameter nimmt den Wert der ebene zurueck; die Antwort zeigt files_plan_ablauf {aktiv, quelle, global, projekt}. Rangfolge projekt > global > Standard; die Antwort zeigt je Wert wert, ms, quelle (standard|global|projekt), Projekt-/Globalwert, Bereich und gesetzt_von. Neue Werte gelten fuer neu beginnende Fristen, laufende bleiben. modus status (Standard) | setzen | entfernen (frist_namen). Setzen/Entfernen (ebene projekt Standard oder global): User oder Koordinator des Projekts, auch Legacy-Koordinator; Subagent/Spezialist nie. Web-UI: Einstellungen > Agenten-Ausweis; REST GET/PUT /api/projects/:project/agent-profile/ausweis-fristen.', params: 'project, modus (status|setzen|entfernen), ebene (global|projekt), schatten_stunden, erstnutzung_minuten, visum_minuten, arbeitsfreigabe_stunden, anmeldung_plaene_minuten, files_plan_stunden, files_plan_ablauf_aktiv (boolean), frist_namen[] (nur entfernen), grund (min. 5 Zeichen)', example: 'admin({ action: "ausweis_fristen", project: "synapse", modus: "setzen", erstnutzung_minuten: 15, grund: "Start dauert laenger" })' },
      ausweis_visa: { description: 'P22-T44: Agenten ANDERER Projekte mit Ausweis-Eintrag in diesem Projekt: zugang frei (kein Koordinator hier) | visum (nur lesen + Channels, automatisch, visum_minuten) | arbeitsfreigabe (Einwanderung, befristet) | abgelaufen; dazu Ablaufzeiten und die Fristen dieses Projekts. Nur User oder Koordinator dieses Projekts. Visa entstehen nur, wenn im HEIMATprojekt des Agenten der Produkt-Schalter mehrprojekt EIN ist (Standard AUS, von alle nicht erfasst).', params: 'project', example: 'admin({ action: "ausweis_visa", project: "synapse" })' },
      arbeitsfreigabe_erteilen: { description: 'P22-T44: Arbeitsfreigabe (Einwanderung) fuer einen Agenten eines anderen Projekts in DIESEM Projekt, befristet auf arbeitsfreigabe_stunden dieses Projekts (Standard 24). Solange darf er hier arbeiten (Rechte laut Profil/Rolle wie in seiner Heimat), danach wieder Visum. Nur User oder Koordinator DIESES Projekts; ein Koordinator aus einem anderen Projekt kann hier nicht freigeben.', params: 'project, ziel_identity_id (Identitaet aus dem anderen Projekt), grund (min. 5 Zeichen)', example: 'admin({ action: "arbeitsfreigabe_erteilen", project: "synapse", ziel_identity_id: "<id>", grund: "Hilft bei P22" })' },
      arbeitsfreigabe_entziehen: { description: 'P22-T44: Arbeitsfreigabe sofort entziehen (danach wieder Visum). Rechte wie arbeitsfreigabe_erteilen.', params: 'project, ziel_identity_id, grund (min. 5 Zeichen)', example: 'admin({ action: "arbeitsfreigabe_entziehen", project: "synapse", ziel_identity_id: "<id>", grund: "Arbeit erledigt" })' },
      profil_uebersicht: { description: 'Profil-/Teamuebersicht des Projekts, TOKENFREI (token_abrufbar ja/nein, Typ, Revision, Persona-Zuweisung).', params: 'project', example: 'admin({ action: "profil_uebersicht", project: "synapse" })' },
      schattenprofil_liste: { description: 'Schattenprofile (pending|bestaetigt|abgelaufen|abgelehnt) des Projekts.', params: 'project, zustand', example: 'admin({ action: "schattenprofil_liste", project: "synapse", zustand: "pending" })' },
      schattenprofil_korrigieren: { description: 'Korrekturentwurf am Schattenprofil (CAS ueber erwartete_revision).', params: 'project, schattenprofil_id, erwartete_revision, korrektur{}, grund', example: 'admin({ action: "schattenprofil_korrigieren", project: "synapse", schattenprofil_id: "...", erwartete_revision: 1, korrektur: { rolle: "subagent" }, grund: "Rolle korrigiert" })' },
      schattenprofil_bestaetigen: { description: 'Schattenprofil bestaetigen (atomar: Identitaet + Profil + Tokenaktivierung + Audit). Koordinator braucht user_zustimmung (Wortlaut/Freigabe); der User ueber die Web-UI darf sie weglassen.', params: 'project, schattenprofil_id, erwartete_revision, korrektur{}, typ_id, user_zustimmung, grund', example: 'admin({ action: "schattenprofil_bestaetigen", project: "synapse", schattenprofil_id: "...", erwartete_revision: 1, user_zustimmung: "User 19.10. im Chat: bestaetigen", grund: "Freigabe" })' },
      schattenprofil_ablehnen: { description: 'Schattenprofil ablehnen (Endzustand).', params: 'project, schattenprofil_id, erwartete_revision, grund', example: 'admin({ action: "schattenprofil_ablehnen", project: "synapse", schattenprofil_id: "...", erwartete_revision: 1, grund: "unbekannter Agent" })' },
      typ_liste: { description: 'Typ-Katalog (global + Projekt).', params: 'project', example: 'admin({ action: "typ_liste", project: "synapse" })' },
      typ_anlegen: { description: 'Typ anlegen (neue Revision 1). Globale Typen nur der User.', params: 'project, profil_scope (global|projekt), typ_schluessel, typ_inhalt{}, grund', example: 'admin({ action: "typ_anlegen", project: "synapse", typ_schluessel: "pruefer", typ_inhalt: { rolle: "subagent" }, grund: "Pruefer-Typ" })' },
      typ_aendern: { description: 'Typ aendern = neue Revision (CAS).', params: 'project, typ_id, erwartete_revision, typ_inhalt{}, grund', example: 'admin({ action: "typ_aendern", project: "synapse", typ_id: "...", erwartete_revision: 1, typ_inhalt: { rolle: "subagent" }, grund: "Anpassung" })' },
      typ_revision_lesen: { description: 'Typrevision lesen (Standard aktuelle).', params: 'project, typ_id, typ_revision', example: 'admin({ action: "typ_revision_lesen", project: "synapse", typ_id: "..." })' },
      profil_aendern: { description: 'Individuelles Profil aendern = neue unveraenderliche Revision (CAS ueber erwartete_revision). Eigenprofil nur durch User oder anderen Koordinator. Persona NIE hier, nur ueber persona_zuweisen.', params: 'project, ziel_identity_id, erwartete_revision, profil_patch{}, typ_id, grund, user_auftrag', example: 'admin({ action: "profil_aendern", project: "synapse", ziel_identity_id: "...", erwartete_revision: 2, profil_patch: { kontext_stufe: "kompakt" }, grund: "weniger Hinweise" })' },
      profil_historie: { description: 'Profilrevisionen mit wer/wann/Grund.', params: 'project, ziel_identity_id', example: 'admin({ action: "profil_historie", project: "synapse", ziel_identity_id: "..." })' },
      profil_rollback: { description: 'Rollback = NEUE auditierte Revision; reaktiviert nie eine entfernte Persona.', params: 'project, ziel_identity_id, ziel_revision, erwartete_revision, grund', example: 'admin({ action: "profil_rollback", project: "synapse", ziel_identity_id: "...", ziel_revision: 1, erwartete_revision: 3, grund: "Fehlkonfiguration" })' },
      persona_liste: { description: 'Persona-Bibliothek (global + Projekt); mit ziel_identity_id auch die aktuelle Zuweisung. Standard leer: Personas gibt es nur auf ausdruecklichen User-Wunsch.', params: 'project, ziel_identity_id', example: 'admin({ action: "persona_liste", project: "synapse" })' },
      persona_versionen: { description: 'Versionen einer Persona-Vorlage.', params: 'project, persona_vorlage_id', example: 'admin({ action: "persona_versionen", project: "synapse", persona_vorlage_id: "..." })' },
      persona_anlegen: { description: 'Persona-Vorlage anlegen (Version 1) - nur mit dokumentiertem User-Auftrag. Globale Vorlagen nur der User. Weist niemandem etwas zu.', params: 'project, profil_scope, persona_name, persona_inhalt{}, user_auftrag (Koordinator Pflicht)', example: 'admin({ action: "persona_anlegen", project: "synapse", persona_name: "knapp-sachlich", persona_inhalt: { stil: "knapp" }, user_auftrag: "User 19.10.: Persona knapp-sachlich anlegen" })' },
      persona_neue_version: { description: 'Neue Bibliotheksversion; laufende Zuweisungen behalten ihre Version.', params: 'project, persona_vorlage_id, persona_inhalt{}, user_auftrag', example: 'admin({ action: "persona_neue_version", project: "synapse", persona_vorlage_id: "...", persona_inhalt: { stil: "knapp" }, user_auftrag: "User: ueberarbeiten" })' },
      persona_zuweisen: { description: 'Persona einem Agenten zuweisen - NUR auf User-Wunsch (user_auftrag), auditiert mit alt/neu.', params: 'project, ziel_identity_id, persona_vorlage_id, persona_version, user_auftrag', example: 'admin({ action: "persona_zuweisen", project: "synapse", ziel_identity_id: "...", persona_vorlage_id: "...", persona_version: 1, user_auftrag: "User 19.10.: dieser Agent soll knapp antworten" })' },
      persona_entfernen: { description: 'Persona jederzeit entfernen (auch bei ausgeschaltetem Schalter), auditiert.', params: 'project, ziel_identity_id, grund', example: 'admin({ action: "persona_entfernen", project: "synapse", ziel_identity_id: "...", grund: "User: Persona nicht mehr gewuenscht" })' },
      token_abrufen: { description: 'Profil-Token (verschluesselt gespeichert) abrufen: nur User oder Koordinator DESSELBEN Projekts, nur im API-Prozess; jeder Abruf auditiert OHNE Tokenwert. Token nie in Channel/Thought/Log/Startrezept schreiben.', params: 'project, ziel_identity_id, anlass', example: 'admin({ action: "token_abrufen", project: "synapse", ziel_identity_id: "...", anlass: "Startauftrag fuer neuen Agenten" })', tips: 'Fehler token_nicht_abrufbar: Ausweis wurde vor dem Tresor ausgestellt; neuen Ausweis fuer dieselbe Identitaet ausstellen.' },
      task_bindung_lesen: { description: 'Task-Bindung lesen: offen (Standard, P7-T53 unveraendert), identitaet oder team.', params: 'project, bindung_task_id', example: 'admin({ action: \"task_bindung_lesen\", project: \"synapse\", bindung_task_id: \"P22-T13\" })' },
      task_bindung_festlegen: { description: 'Task an eine Identitaet oder ein frei gewaehltes Team (selbes Projekt) binden; nur User/Koordinator, auditiert. Gebundene Tasks nehmen nur diese Identitaeten per Token-identity_id an.', params: 'project, bindung_task_id, bindung_art (identitaet|team), bindung_identity_ids[], grund', example: 'admin({ action: \"task_bindung_festlegen\", project: \"synapse\", bindung_task_id: \"P22-T13\", bindung_art: \"team\", bindung_identity_ids: [\"...\", \"...\"], grund: \"Team fuer Paket D\" })' },
      task_bindung_aendern: { description: 'Bindung aendern (Team/Identitaet neu waehlen); Grund Pflicht.', params: 'project, bindung_task_id, bindung_art, bindung_identity_ids[], grund', example: 'admin({ action: \"task_bindung_aendern\", project: \"synapse\", bindung_task_id: \"P22-T13\", bindung_art: \"identitaet\", bindung_identity_ids: [\"...\"], grund: \"Wechsel des Bearbeiters\" })' },
      task_bindung_entblocken: { description: 'Bindung aufheben (zurueck zu offen, Historie bleibt); Grund Pflicht.', params: 'project, bindung_task_id, grund', example: 'admin({ action: \"task_bindung_entblocken\", project: \"synapse\", bindung_task_id: \"P22-T13\", grund: \"Bearbeiter nicht mehr verfuegbar\" })' },
      web_ui_koordinator_token: { description: 'Token des Web-UI-Koordinatorprofils (nur User ueber die Web-UI), fuer Uebernahme/Weitergabe.', params: 'project, ziel_identity_id (optional)', example: 'admin({ action: "web_ui_koordinator_token", project: "synapse" })' },
    },
  },

  search: {
    summary: 'Semantische Suche (Embeddings) in Code, Paths, Memories, Thoughts, Tasks, Plänen, Proposals, Tech-Docs und Media.',
    when_to_use: [
      'Konzeptuelle/fuzzy Code-Suche (action: "code"): "wie wird Authentifizierung gehandhabt?"',
      'Datei-Pfad-Suche (action: "path") mit Glob-Pattern.',
      'Projekt-Wissen durchsuchen (action: "memory").',
      'Gedanken/Updates suchen (action: "thoughts", optional task_id als UUID/Kurz-ID/Alias).',
      'Vor neuen Tasks search(tasks) und search(plans) über alle Status mit alle:true nutzen.',
      'Framework-Doku nachschlagen (action: "tech_docs").',
      'Wenn code_intel search nicht reicht (kein semantischer Kontext).',
    ].join(' '),
    when_not_to_use: [
      'Exakte Symbol-/Funktions-Suche → code_intel (schneller, strukturiert).',
      'Alle Memories lesen → memory(action: "list").',
      'Score < 0.60 → Glob/Grep stattdessen.',
    ].join(' '),
    param_tips: [
      'Englische Queries bevorzugen — 15-20% hoeherer Score als Deutsch.',
      'Spezifisch sein: Funktionsnamen, Library-Namen, Konzepte (nicht "wie funktioniert X").',
      'limit: 5-10 setzen — Standard ist 10-50, oft zu viel.',
      'Score-Skala haengt am Embedding-Modell (Nemotron liegt deutlich tiefer als qwen): keine festen Cutoffs merken - die kalibrierten Schwellen je Zweck stehen im Modellprofil (intern modellprofil).',
      'tasks/plans: status, plan_id (UUID/P<n>), priority; alle:true zeigt Zurückgestellte. Dünne PG-Treffer mit kurz_id, title, plan, status, vorschau, score, pins. mit_verknuepfungen:true liefert jüngste IDs; verwaiste Vektoren unter verworfen_ohne_pg gezählt.',
      'code_with_path: Kombiniert semantische Suche mit Pfad-Filter (best of both).',
      'tech_docs scope: "project" fuer projektspezifische, "global" fuer allgemeine, "all" fuer beide.',
    ].join('\\n'),
    examples: [
      'search({ action: "code", project: "synapse", query: "shell job queue implementation", limit: 5 })',
      'search({ action: "memory", project: "synapse", query: "architecture decisions" })',
      'search({ action: "path", project: "synapse", path_pattern: "packages/*/src/**/*.ts" })',
      'search({ action: "tech_docs", query: "breaking changes", framework: "fastify", project: "synapse" })',
    ],
    anti_patterns: [
      'Deutsche Queries verwenden — schlechtere Scores, Englisch bevorzugen.',
      'Vage Queries ("wie funktioniert das?") — Score wird niedrig sein, kaum nuetzliches Ergebnis.',
      'limit nicht setzen — bis 50 Ergebnisse ueberfluten den Context.',
      'search statt code_intel fuer exakte Symbole — code_intel ist strukturiert + schneller.',
      'Score < 0.60 akzeptieren — irrelevante Ergebnisse rauschen ins Context.',
    ],
    actions: {
      code: {
        description: 'Semantische Code-Suche via Embeddings (Qdrant).',
        params: 'query (req), project (req), file_type, limit',
        example: 'search({ action: "code", project: "synapse", query: "enqueue shell job", file_type: "ts", limit: 5 })',
        tips: 'Perfekt fuer konzeptuelle Suchen. Englisch-Query gibt deutlich bessere Scores.',
      },
      path: {
        description: 'Dateien nach Pfad-Pattern (Glob) suchen, optional mit Content-Filter.',
        params: 'project (req), path_pattern (req, Glob), content_pattern (Regex), limit',
        example: 'search({ action: "path", project: "synapse", path_pattern: "packages/rest-api/**/*.ts" })',
        tips: 'path_pattern ist Glob (z.B. "*/routes/*.ts"). content_pattern ist Regex fuer Content-Filter.',
      },
      code_with_path: {
        description: 'Semantische Suche + Pfad-Filter kombiniert.',
        params: 'query (req), project (req), path_pattern, file_type, limit',
        example: 'search({ action: "code_with_path", project: "synapse", query: "error handling", path_pattern: "packages/mcp-server/**" })',
      },
      memory: {
        description: 'Projekt-Memories semantisch durchsuchen.',
        params: 'query (req), project (req), limit',
        example: 'search({ action: "memory", project: "synapse", query: "architecture decisions" })',
        tips: 'Fuer vollstaendige Liste: memory(action: "list") nutzen.',
      },
      tasks: {
        description: 'Jede Task semantisch über Titel und Beschreibung suchen. PG liefert den aktuellen Stand; Pins zählen verknüpfte Thoughts und Dateiversionen.',
        params: 'query, project (Pflicht), limit, status, plan_id, priority low|medium|high, alle, mit_verknuepfungen',
        example: 'search({ action: "tasks", project: "synapse", query: "Embedding Nachzug", alle: true, mit_verknuepfungen: true })',
      },
      plans: {
        description: 'Pläne semantisch nach Name, Beschreibung und Zielen suchen; Pins über alle zugehörigen Tasks. Status: done wenn alle erledigt, sonst in_progress vor blocked vor todo.',
        params: 'query, project (Pflicht), limit, status, plan_id, priority hoch|mittel|niedrig, alle, mit_verknuepfungen',
        example: 'search({ action: "plans", project: "synapse", query: "Embedding", alle: true })',
      },
      thoughts: {
        description: 'Gedanken/Team-Updates durchsuchen. Je Treffer vorschau (~300 Zeichen) + content_laenge statt Volltext; Volltext per thought get oder volltext:true.',
        params: 'query (req), project (req), limit, volltext (Standard false), task_id (UUID/Kurz-ID/Alias)',
        example: 'search({ action: "thoughts", project: "synapse", query: "auto-handoff" })',
      },
      tech_docs: {
        description: 'Framework-Dokumentation durchsuchen.',
        params: 'query (req), framework, type, source, project, limit, scope (project|global|all)',
        example: 'search({ action: "tech_docs", query: "hooks lifecycle", framework: "react", project: "synapse" })',
        tips: 'scope: "global" fuer allgemeine Docs, "project" fuer kuratierte Projekt-Docs.',
      },
      proposals: {
        description: 'Proposals semantisch durchsuchen (Beschreibung + Inhalt).',
        params: 'query (req), project, limit',
        example: 'search({ action: "proposals", project: "synapse", query: "workspace routing", limit: 3 })',
      },
      media: {
        description: 'Indexierte Bilder/Videos semantisch durchsuchen (setzt admin(index_media) voraus).',
        params: 'query (req), project, media_type (image|video), limit',
        example: 'search({ action: "media", project: "synapse", query: "dashboard screenshot", media_type: "image" })',
      },
    },
  },

  memory: {
    summary: 'Langlebiges Projekt-Wissen lesen, schreiben und verwalten (Architektur, Regeln, Entscheidungen). write akzeptiert optional items[] (1..50) fuer Bulk-Inserts in einem Call.',
    when_to_use: [
      'Langlebiges Wissen speichern das ueber Sessions bestehen soll: write.',
      'Gespeichertes Wissen lesen: read (einzeln oder mehrere).',
      'Alle Memories auflisten: list.',
      'Memory mit zugehoerigem Code lesen: read_with_code.',
      'Memories fuer eine Datei finden: find_for_file.',
      'Memory aktualisieren ohne neu schreiben: update.',
    ].join(' '),
    when_not_to_use: [
      'Ephemere/kurzlebige Infos → thought.',
      'Code-Erklaerungen → Kommentare in der Datei.',
      'Schnellsuche in Memories → search(action: "memory").',
    ].join(' '),
    param_tips: [
      'name: Kurz, sprechend, eindeutig (z.B. "rest-api-architektur", "embedding-rules").',
      'category: documentation|note|architecture|decision|rules|other — konsequent setzen.',
      'tags: Sinnvolle Tags fuer spaetere Filterung setzen.',
      'read: Array von names moeglich — mehrere Memories in einem Call laden.',
      'find_for_file: Zeigt alle Memories die zu einer Datei relevant sind.',
      'delete mit Array: dry_run: true zuerst fuer Preview.',
    ].join('\\n'),
    examples: [
      'memory({ action: "write", project: "synapse", name: "shell-queue-design", content: "Queue-Architektur...", category: "architecture" })',
      'memory({ action: "read", project: "synapse", name: "shell-queue-design" })',
      'memory({ action: "list", project: "synapse", category: "rules" })',
      'memory({ action: "find_for_file", project: "synapse", file_path: "packages/rest-api/src/routes/mcp.ts" })',
    ],
    anti_patterns: [
      'Ephemere Session-Notizen als Memory schreiben — Memory ist fuer langlebiges Wissen.',
      'name ohne Kontext (z.B. "notiz1") — spaeter nicht mehr auffindbar.',
      'Ganze Datei-Inhalte als Memory speichern — verursacht Token-Overhead beim Lesen.',
      'category weglassen — macht Filterung per list unbrauchbar.',
      'delete ohne dry_run bei Arrays — sicherer Preview zuerst.',
    ],
    actions: {
      write: {
        description: 'Neues Memory schreiben (oder vorhandenes ueberschreiben).',
        params: 'project (req), name (req), content (req), category, tags',
        example: 'memory({ action: "write", project: "synapse", name: "api-design", content: "REST-API Regeln...", category: "rules" })',
        tips: 'Wenn name schon existiert, wird es ueberschrieben. Fuer Updates: action "update" nutzen.',
      },
      read: {
        description: 'Memory/Memories lesen (einzeln oder Array).',
        params: 'project (req), name (req, String oder Array)',
        example: 'memory({ action: "read", project: "synapse", name: ["api-design", "shell-queue-design"] })',
        tips: 'Array erlaubt: mehrere Memories in einem Call laden.',
      },
      read_with_code: {
        description: 'Memory lesen + semantisch verwandte Code-Snippets mitladen.',
        params: 'project (req), name (req), codeLimit, includeSemanticMatches',
        example: 'memory({ action: "read_with_code", project: "synapse", name: "api-design", codeLimit: 5 })',
        tips: 'Perfekt wenn du Wissen + Code-Kontext zusammen brauchst. codeLimit klein halten.',
      },
      list: {
        description: 'Alle Memories auflisten (optional nach category filtern). ACHTUNG: KEIN limit-Parameter — auf gewachsenen Projekten (100+ Memories) ist ein ungefiltertes list ein Context-Killer.',
        params: 'project (req), category',
        example: 'memory({ action: "list", project: "synapse", category: "rules" })',
        tips: 'IMMER mit category filtern oder gleich search(action: "memory", query) nutzen — semantische Suche liefert die 10 relevanten statt 200+ Eintraege.',
      },
      update: {
        description: 'Einzelne Felder eines Memory aendern ohne alles neu zu schreiben.',
        params: 'project (req), name (req), content, category, tags',
        example: 'memory({ action: "update", project: "synapse", name: "api-design", tags: ["rest", "api", "v2"] })',
      },
      find_for_file: {
        description: 'Alle relevanten Memories fuer eine Datei finden.',
        params: 'project (req), file_path (req, String oder Array)',
        example: 'memory({ action: "find_for_file", project: "synapse", file_path: "packages/rest-api/src/routes/mcp.ts" })',
        tips: 'Array-Support: Mehrere Dateien in einem Call. Gut fuer Wissens-Airbag vor Bearbeitung.',
      },
      delete: {
        description: 'Memory loeschen (einzeln oder Batch). WICHTIG: Single-Delete (name als String) loescht SOFORT, dry_run wird ignoriert. Nur Batch-Delete (name als Array) unterstuetzt dry_run-Preview. Connector-UIs koennen daher bei Single-Delete eine Bestaetigung verlangen.',
        params: 'project (req), name (req, String oder Array), dry_run, max_items',
        example: 'memory({ action: "delete", project: "synapse", name: "alte-notiz" })',
        tips: 'Batch: name als Array + dry_run: true fuer Preview.',
      },
    },
  },

  thought: {
    summary: 'Kurzlebige Gedanken und Team-Updates speichern, abrufen und suchen — Kommunikations-Kanal zwischen Agenten.',
    when_to_use: [
      'Kurze Beobachtungen, Zwischenergebnisse speichern: add.',
      'Session-Handoffs: Zustand sichern fuer naechste Session.',
      'Gedanken durchsuchen: search.',
      'Alle aktuellen Thoughts abrufen: get.',
      'Task-Updates und Ergebnis-Reports an Team posten.',
    ].join(' '),
    when_not_to_use: [
      'Langlebiges Wissen → memory.',
      'Code-Kommentare → direkt in die Datei.',
      'Aufgabenlisten → plan(action: "add_task").',
    ].join(' '),
    param_tips: [
      'source: IMMER deine agent_id setzen (nie "claude-code" oder leer lassen).',
      'tags: Sinnvolle Tags fuer Filterung (z.B. "auto-handoff", "status", "problem").',
      'get ohne id: Alle Thoughts — limit setzen um Context zu sparen.',
      'get mit id: Einzelner oder Array von IDs gezielt laden. id (auch bei update/delete): volle UUID oder eindeutiger Praefix, mind. 8 Zeichen (z. B. "04e14f2a"); mehrdeutig/unbekannt -> Fehler mit Kandidaten, nichts wird geaendert. Antwort nennt aufgeloeste_id.',
      'search: Semantisch, Englisch-Query bevorzugen.',
      'delete nach Verarbeitung: Halte die DB sauber, loese verarbeitete Thoughts.',
    ].join('\\n'),
    examples: [
      'thought({ action: "add", project: "synapse", source: "guide-content-writer", content: "Tool X fertig.", tags: ["status"] })',
      'thought({ action: "get", project: "synapse", limit: 20 })',
      'thought({ action: "search", project: "synapse", query: "auto-handoff guide-content-writer" })',
      'thought({ action: "get", project: "synapse", id: "04e14f2a" })',
      'thought({ action: "delete", project: "synapse", id: "abc12345" })',
    ],
    anti_patterns: [
      'source: "claude-code" verwenden — immer deine agent_id.',
      'Thoughts akkumulieren ohne zu loeschen — verursacht Rauschen fuer alle.',
      'Sehr lange Inhalte als Thought — nutze memory fuer umfangreiche Infos.',
      'get ohne limit — kann Hunderte Thoughts laden und Context sprengen.',
      'Handoff-Thought nicht nach Verarbeitung loeschen — blockiert zukuenftige Sessions.',
    ],
    actions: {
      add: {
        description: 'Neuen Thought speichern. optional task_id + task_status — verknuepft den Thought mit einer Plan-Task UND aktualisiert deren Status in einem Call (kein separater plan(update_task) noetig).',
        params: 'project (req), source (req, deine agent_id), content (req), tags, task_id (optional, Plan-Task-ID), task_status (optional: todo|in_progress|done|blocked — setzt Status der via task_id verlinkten Task), grund (optional, nur mit task_status: Pflicht fuer Agenten ohne Token auf gebundener Task bei Schalter task_bindung EIN, siehe plan update_task).',
        example: 'thought({ action: "add", project: "synapse", source: "mein-agent", content: "Task abgeschlossen.", tags: ["status"], task_id: "task-uuid", task_status: "done" })',
        tips: 'source = deine agent_id. NIEMALS "claude-code". task_id allein verlinkt nur; mit task_status zusaetzlich wird gleich der Plan-Task-Status gesetzt. Findet "alle Thoughts zu Task X" via thought(search) oder Plan-Lookups via Spalte task_id.',
      },
      add_batch: {
        description: 'Mehrere Thoughts atomar speichern (1..50 Items in einem Call). items[].task_id pro Item moeglich; top-level task_status setzt einmalig den Status fuer alle in den Items verlinkten Tasks.',
        params: 'project (req), source (req, gilt fuer alle Items), items (req, Array von { content, tags?, task_id? }), task_status (optional, top-level: todo|in_progress|done|blocked — setzt den Status fuer alle in den Items verlinkten Tasks), grund (optional, nur mit task_status: wie bei add).',
        example: 'thought({ action: "add_batch", project: "synapse", source: "mein-agent", items: [{ content: "T1 done", task_id: "t1" }, { content: "T2 done", task_id: "t2" }], task_status: "done" })',
        tips: 'Bei >5 Thoughts IMMER add_batch statt parallele add-Calls — atomar, ein Embedding-Call, kein Cloudflare-Stress. items[].task_id pro Item; task_status global fuer den ganzen Batch.',
      },
      get: {
        description: 'Thoughts abrufen (alle oder nach ID).',
        params: 'project (req), id (optional, String oder Array), limit',
        example: 'thought({ action: "get", project: "synapse", limit: 10 })',
        tips: 'Mit id: gezielter Abruf. Ohne id: limit setzen (Standard 50).',
      },
      search: {
        description: 'Thoughts semantisch durchsuchen. Je Treffer id, score, Metadaten und vorschau (~300 Zeichen) + content_laenge; Volltext per thought get mit id oder volltext:true.',
        params: 'query (req), project, limit, volltext (Standard false)',
        example: 'thought({ action: "search", project: "synapse", query: "handoff status" })',
      },
      update: {
        description: 'Thought-Inhalt oder Tags aendern.',
        params: 'project (req), id (req), content, tags',
        example: 'thought({ action: "update", project: "synapse", id: "abc123", content: "Korrigiert: ..." })',
      },
      delete: {
        description: 'Thought loeschen (einzeln oder Batch). WICHTIG: Single-Delete (id als String) loescht SOFORT, dry_run wird ignoriert. Nur Batch-Delete (id als Array) unterstuetzt dry_run-Preview. Connector-UIs koennen daher bei Single-Delete eine Bestaetigung verlangen.',
        params: 'project (req), id (req, String oder Array), dry_run, max_items',
        example: 'thought({ action: "delete", project: "synapse", id: "abc123" })',
        tips: 'Nach Verarbeitung IMMER loeschen. Batch: id als Array + dry_run: true fuer Preview.',
      },
    },
  },

  plan: {
    summary: 'Projekt-Plan und Tasks verwalten: abrufen (mit status-Filter, compact und limit gegen Context-Vollabwurf — Antwort enthaelt tasks_total/tasks_returned), aktualisieren und neue Tasks hinzufuegen.',
    when_to_use: [
      'Aktuellen Plan und Tasks anzeigen: get.',
      'Plan-Metadaten aktualisieren (Ziele, Architektur): update.',
      'Vor add_task/add_tasks_batch zuerst search(tasks), search(plans) oder plan(search) ohne Statusfilter und mit alle:true. aehnlich ist nur ein Hinweis; fehlt die tasks-Kalibrierung, aehnlich_hinweis beachten.',
      'Neue Task zum Plan hinzufuegen: add_task.',
      'Task-Status tracken fuer langfristige Projekte.',
      'EXPERIMENTELL: Modell/Effort/Kontext je Task vorschlagen lassen: empfehlen.',
    ].join(' '),
    when_not_to_use: [
      'Ad-hoc Notizen/To-Dos → thought mit Tag "task".',
      'Session-spezifische Aufgaben → thought.',
      'Komplette Plan-Neuanlage → project(action: "init") macht das automatisch.',
    ].join(' '),
    param_tips: [
      'search: query + art tasks|plans (Standard tasks), status, priority, plan_id, alle, mit_verknuepfungen. Ohne plan_id Suche über alle Pläne. Tasks haben eigene Vektoren, Plan-Vektoren bleiben erhalten. Bestand/Nachzug: intern(nachzug_jetzt, tabelle:plan_tasks); Schwelle vor Dublettenhinweisen je Modell mit intern(modellprofil_kalibrieren, zweck:tasks, project) pflegen; kein fixer Ersatzwert.',
      'project: Pflicht fuer alle Actions. plan(get) ist standardmaessig kompakt; compact:false oder task_id liefert Beschreibungen.',
      'add_task: title + description beide Pflicht. priority: low|medium|high (Standard: medium). git_branch ist optional: Ziel-Branch für den GIT-Commit, nicht Synapse files commit; Task erbt vom Plan. Ohne Branch gilt der aktuelle Arbeitsbranch.',
      'update: Felder die nicht gesetzt werden, bleiben unveraendert.',
      'goals: Array von Strings — Ziele des Projekts.',
      'plan_id (alle Aktionen, optional): Plan-UUID oder Kurz-ID "P<n>". OHNE plan_id wirkt der AKTIVE Plan des Projekts — genau das bisherige Verhalten. task_id nimmt die UUID oder die Kurz-ID "P<n>-T<m>" (daraus folgt der Plan); eine alte UUID wird ohne plan_id in allen Plaenen gefunden. Antworten nennen plan_ref {id, kurz_id, name, aktiv}; hat das Projekt mehrere Plaene, zusaetzlich hinweis_plaene.',
      'empfehlen: kandidaten = Aliase und/oder Gruppen (anthropic|abos|alle|codex|google|legacy, auch claude-abo|codex-abo|gemini-api; Standard: nur Claude-CLI-Modelle = anthropic; Codex/Gemini nachziehen, sobald deren Runtime steht), plan_id PFLICHT (UUID oder P<n>) und task_id PFLICHT (String oder Array, UUID oder P<n>-T<m>, hoechstens 50; ohne plan_id/task_id Fehler), schreiben (Standard true), confidence_tor (Standard 0.5), lage {claude_quota, codex_quota: plenty|low|exhausted, paid_api: allowed|not allowed}, max_optionen (nur Modell-Choice, Standard unbegrenzt), hinweise (String, max. 500 Zeichen, eigene Prioritaeten fuer Jev; Projektfakten aus dem Index gehen immer mit). Optionale Task-Felder stakes (normal|critical) und previous_attempt (none|failed with a smaller model) gehen in den Zustand. Braucht JEV_OPENROUTER_API_KEY in der Server-Umgebung.',
    ].join('\\n'),
    examples: [
      'plan({ action: "get", project: "synapse" })',
      'plan({ action: "add_task", project: "synapse", title: "Guide-Content erweitern", description: "9 Tools dokumentieren", priority: "high" })',
      'plan({ action: "update", project: "synapse", goals: ["REST-API stabler machen", "Docs verbessern"] })',
    ],
    anti_patterns: [
      'Dutzende Tasks auf einmal anlegen ohne Prioritaeten — Plan wird unuebersichtlich.',
      'Plan als Ersatz fuer Session-Notizen — thought ist dafuer gedacht.',
      'update mit leeren goals: [] — wuerde alle Ziele loeschen.',
    ],
    actions: {
      search: {
        description: 'Task-/Plansuche wie search(tasks|plans), gemeinsame Core-Funktion; immer PG-Text, Score aus Qdrant, Pins und Orphan-Zähler.',
        params: 'project, query (Pflicht), art tasks|plans, status, plan_id, priority, limit, alle, mit_verknuepfungen',
        example: 'plan({ action: "search", project: "synapse", query: "Task-Suche", art: "tasks", alle: true })',
      },
      get: {
        description: 'Aktuellen Projekt-Plan + Tasks abrufen.',
        params: 'project (req)',
        example: 'plan({ action: "get", project: "synapse" })',
        tips: 'Zeigt Plan-Metadaten + alle Tasks mit Status.',
      },
      update: {
        description: 'Plan-Metadaten aendern (name, description, goals, architecture).',
        params: 'project (req), name, description, goals (Array), architecture, git_branch? (Ziel-Branch für den GIT-Commit, nicht Synapse files commit)',
        example: 'plan({ action: "update", project: "synapse", architecture: "PostgreSQL + Qdrant dual-write" })',
        tips: 'Nicht gesetzte Felder bleiben unveraendert.',
      },
      add_task: {
        description: 'Neue Task zum Plan hinzufuegen.',
        params: 'project (req), title (req), description (req), priority (low|medium|high), git_branch? (Task-Branch; sonst Plan-Branch)',
        example: 'plan({ action: "add_task", project: "synapse", title: "API-Rate-Limiting", description: "Implementiere Rate-Limiting fuer REST-API", priority: "medium" })',
      },
      add_tasks_batch: {
        description: 'Mehrere Tasks atomar zum Plan hinzufuegen (1..50 Items in einem Call).',
        params: 'project (req), tasks (req, Array von { title, description, priority? })',
        example: 'plan({ action: "add_tasks_batch", project: "synapse", tasks: [{ title: "Task A", description: "...", priority: "high" }, { title: "Task B", description: "..." }] })',
        tips: 'Bei >5 Tasks IMMER add_tasks_batch statt parallele add_task-Calls — ein UPDATE, ein Qdrant-Reindex.',
      },
      update_task: {
        description: 'Eine bestehende Task aendern (status, priority, title, description). grund (optional): Pflicht fuer Agenten OHNE Token auf einer GEBUNDENEN Task, wenn der Produkt-Schalter task_bindung EIN ist (ohne Grund Abweisung grund_noetig mit Hinweis auf die Bindung; mit Grund erlaubt und in der Bindungs-Historie protokolliert, wer = legacy:<agent_id>). Koordinator, User, Token-Mitglieder der Bindung und Schalter AUS: unveraendert.',
        params: 'project (req), task_id (req), title?, description?, status (todo|in_progress|done|blocked)?, priority (low|medium|high)?, git_branch? (Task-Branch; sonst Plan-Branch)',
        example: 'plan({ action: "update_task", project: "synapse", task_id: "abc-123", status: "done" })',
        tips: 'Status auf "done" setzen statt Task zu loeschen — bleibt fuer Audit erhalten.',
      },
      delete_task: {
        description: 'Eine oder mehrere Tasks aus dem Plan loeschen (atomar).',
        params: 'project (req), task_id (req, String oder Array von Strings, max 50)',
        example: 'plan({ action: "delete_task", project: "synapse", task_id: ["abc-123", "def-456"] })',
        tips: 'Bevorzuge update_task mit status: "done" wenn die Task fuer Historie/Audit erhalten bleiben soll.',
      },
      list: {
        description: 'Alle Plaene des Projekts: Kurz-ID, Name, Ziel, aktiv, Tasks gesamt/offen/erledigt, zuletzt geaendert — ohne Tasks.',
        params: 'project (req)',
        example: 'plan({ action: "list", project: "synapse" })',
        tips: 'Genau ein Plan ist aktiv; Aufrufe ohne plan_id wirken auf ihn. Kurz-IDs (P1, P2 ...) sind stabil und werden nie neu vergeben.',
      },
      create: {
        description: 'Neuen Plan anlegen (neuer Stand = neuer Plan; der alte bleibt abrufbar und wird nie ueberschrieben). Bekommt die naechste Kurz-ID P<n>.',
        params: 'project (req), name (req), description?, goals?, architecture?, aktiv? (Standard false; der erste Plan eines Projekts ist immer aktiv), git_branch? (Ziel-Branch für den GIT-Commit, nicht Synapse files commit)',
        example: 'plan({ action: "create", project: "synapse", name: "Runde 2", description: "...", aktiv: true })',
        tips: 'update ohne plan_id wirkt auf den aktiven Plan; per plan_id sind auch inaktive offene und leere Plaene aenderbar. Abgeschlossen = mindestens eine Task und alle Tasks done: Metadaten bleiben geschuetzt, Task-Status bleibt aenderbar.',
      },
      einordnen: {
        description: 'Jev ordnet Tasks dem passenden Plan zu (je Task eine choice ueber die Plaene, criteria = Name + Beschreibung). Standard nur VORSCHLAG; mit verschieben:true werden die sicheren verschoben (confidence >= Tor UND anderer Plan als der aktuelle), gruppiert je Zielplan ueber plan(verschieben) (Alias-Kurz-IDs bleiben).',
        params: 'project (req), plan_id (req, Quellplan), task_id (req, String oder Array, max 200, intern Bloecke a 50 je Jev-Aufruf), ziele? (Array Plan-IDs; Standard alle Plaene inkl. Quellplan, damit "bleibt" moeglich ist), verschieben? (Standard false), confidence_tor? (Standard 0.5)',
        example: 'plan({ action: "einordnen", project: "synapse", plan_id: "P2", task_id: ["P2-T1", "P2-T2"], verschieben: false })',
        tips: 'Ergebnis je Task: aktueller_plan, vorschlag (Kurz-ID), vorschlag_name, confidence, unsicher (unter Tor), verschoben?; dazu zusammenfassung (je Zielplan, unsicher, bleibt, verschoben, Dauer, Kosten). Eine Jev-Antwort, die kein Plan ist, gilt als unsicher (nicht geraten). Erst ohne verschieben pruefen, dann mit verschieben:true ausfuehren. Braucht JEV_OPENROUTER_API_KEY in der Umgebung, sonst success:false; der Key wird nie ausgegeben.',
      },

      passende_tasks: {
        description: 'Offene und laufende Tasks fuer JEDEN Agenten. tasks zeigt alle inkl. Beteiligter (seit, aktiv/inaktiv) und profil_hinweis passt/passt nicht mit Grund. Profil aus wrapper_status, sonst agent_sessions.model, sonst Profil unbekannt. Empfehlung ist niemals eine Sperre. Bestehende Listen passend und offen_fuer_koordinator bleiben zusaetzlich erhalten.',
        params: 'project (req), agent_id (req, eigene Agent-ID), plan_id?',
        example: 'plan({ action: "passende_tasks", project: "synapse", agent_id: "sol-22" })',
        tips: 'Beteiligte blockieren nie, auch inaktive bleiben sichtbar. Arbeit ansehen: files(history, task_id), Thoughts mit task_id, code_intel(..., schatten:"alle"), gemeinsame Dateien per Co-Edit. Ab 3 Beteiligten nur Hinweis, keine Hoechstzahl.',
      },
      uebernehmen: {
        description: 'Meldet JEDEN Agenten atomar zur gemeinsamen Task-Beteiligung an. beteiligte [{agent_id, seit}], todo wird in_progress; erneute Anmeldung ist idempotent. Andere Beteiligte, fehlende/unsichere Empfehlungen oder Profilabweichungen verhindern keine Anmeldung. Legacy zugewiesen_an/am spiegelt den ersten Beteiligten; Altbestand wird beim Lesen uebernommen.',
        params: 'project (req), plan_id (req, UUID oder P<n>), task_id (req, UUID oder P<n>-T<m>), agent_id (req)',
        example: 'plan({ action: "uebernehmen", project: "synapse", plan_id: "P2", task_id: "P2-T12", agent_id: "sol-22" })',
      },
      abmelden: {
        description: 'Entfernt die eigene Beteiligung atomar und idempotent. Letzter Beteiligter verlaesst eine nicht erledigte Task: todo. Done bleibt done. update_task status todo leert die Beteiligten samt Legacy-Zuweisung.',
        params: 'project (req), task_id (req), agent_id (req), plan_id?',
        example: 'plan({ action: "abmelden", project: "synapse", plan_id: "P2", task_id: "P2-T12", agent_id: "sol-22" })',
      },
      aktivieren: {
        description: 'Macht einen Plan zum aktiven Plan des Projekts (EIN Update, alle anderen werden inaktiv).',
        params: 'project (req), plan_id (req, UUID oder P<n>)',
        example: 'plan({ action: "aktivieren", project: "synapse", plan_id: "P2" })',
      },
      empfehlen: {
        description: 'EXPERIMENTELL: bewertet genau die per plan_id + task_id (beide PFLICHT) genannten Tasks dieses Plans in EINEM Aufruf an das Entscheidungsmodell Jev (OpenRouter /api/v1/systemone) und schreibt je Task das Feld empfehlung: {modell, effort, kontext 200k|1m, spawn_alias, confidence, quelle cloud, kandidaten, wiederverwenden, spawnbar, stand}. Unter dem Confidence-Tor: {unsicher: true, bester_vorschlag, confidence} statt Empfehlung. Andere Task-Felder bleiben unberuehrt.',
        params: 'project (req), kandidaten? (Alias/Gruppe oder Liste; Standard: nur Claude-CLI-Modelle = anthropic; abos = Claude + Codex, codex, google, alle ausdruecklich waehlbar), plan_id (req: UUID oder P<n>), task_id (req: String oder Array, UUID oder P<n>-T<m>, hoechstens 50; Jev bewertet nur, was genannt ist; eine Task aus einem anderen Plan ist ein Fehler), schreiben? (Standard true; false = nur anzeigen), confidence_tor? (0..1, Standard 0.5), lage? ({claude_quota, codex_quota: plenty|low|exhausted, paid_api: allowed|not allowed}; Standard plenty/plenty/not allowed), max_optionen? (nur Modell-Choice, Standard unbegrenzt), hinweise? (String, max. 500 Zeichen: eigene Prioritaeten fuer Jev, geht als state.hinweise mit; Jev bekommt IMMER auch die Projektfakten aus dem Index (Dateien, tokens_ca, Sprachen; ab JEV_KONTEXT_PROJEKT_TOKENS, Standard 150000, gilt 200k nur fuer sehr kleine, direkte Tasks) — Antwort: projekt_fakten, hinweise_verwendet)',
        example: 'plan({ action: "empfehlen", project: "synapse", plan_id: "P2", task_id: ["P2-T12", "P2-T13"], schreiben: false })',
        tips: 'NUR EMPFEHLUNG, KEIN MUSS: der Spawner darf abweichen, "unsicher" ist ein zulaessiges Ergebnis, es wird nichts gespawnt. Zweistufig in EINEM Aufruf: je Task model_<i> ueber die Modelle (eine Option je Kandidat, keine Kappung) und je Modell mit mehr als einer Stufe effort_<i>_<modell>; gewertet wird die Stufe des gewaehlten Modells. Nur eine Option: keine Frage, Confidence 1.0, vermerk/effort_vermerk "einzige_option". Claude nur mit Stufen aus criteria UND model_registry.effort_stufen (haiku = ohne Effort). Das Tor wirkt auf die Modellwahl; eine unsichere Stufe traegt effort_unsicher. Ergebnis meldet jev.fragen und jev.input_tokens. Criteria = versionierte Kopie von JEV-Test daten/modellwahl_criteria.json (core services/jev-criteria-katalog.ts, Quelle + Stand im Ergebnis unter katalog). Kontingent kennt Synapse nicht: lage als Kategorien angeben; exhausted/paid_api entfernen Gruppen (vorfilter der Quelle). Standard: nur Claude-CLI-Modelle; Codex/Gemini nachziehen, sobald deren Runtime steht (bis dahin spawnbar false, nur auf ausdrueckliche Nennung). Der Zustand nennt nur das Kontingent der angefragten Familien. wiederverwenden nennt einen idle Spezialisten derselben Familie mit 1M. Env: JEV_OPENROUTER_API_KEY (Pflicht), JEV_API_URL, JEV_MODELL, JEV_TIMEOUT_MS (10000), JEV_CONFIDENCE_TOR (0.5). Fehlt der Key: success false "Jev nicht konfiguriert", nichts geschrieben.',
      },
    },
  },

  proposal: {
    summary: 'Verbesserungsvorschlaege (Proposals) erstellen, verwalten und Status verfolgen. create akzeptiert optional items[] (1..50) fuer Bulk-Insert.',
    when_to_use: [
      'Neuen Vorschlag anlegen: create (single mit file_path/suggested_content/description/author oder items[] fuer Bulk).',
      'Architektur-Aenderungen vorschlagen.',
      'Feature-Ideen strukturiert einreichen (mit content + suggested_content).',
      'Offene Proposals auflisten und filtern: list.',
      'Proposal-Status verfolgen und aktualisieren: update_status.',
    ].join(' '),
    when_not_to_use: [
      'Schnelle Ideen-Notizen → thought oder admin(save_idea).',
      'Entscheidungen die schon getroffen sind → memory(category: "decision").',
    ].join(' '),
    param_tips: [
      'list: status-Filter nutzen (pending|reviewed|accepted|rejected) um Liste klein zu halten.',
      'get: id als Array erlaubt — mehrere Proposals in einem Call laden.',
      'update_status: status Pflicht (pending|reviewed|accepted|rejected).',
      'update: Nur gesetzte Felder werden geaendert (content, suggested_content, status).',
      'delete mit Array: dry_run: true zuerst fuer Preview.',
    ].join('\\n'),
    examples: [
      'proposal({ action: "list", project: "synapse", status: "pending" })',
      'proposal({ action: "get", project: "synapse", id: "abc123" })',
      'proposal({ action: "update_status", project: "synapse", id: "abc123", status: "accepted" })',
      'proposal({ action: "update", project: "synapse", id: "abc123", content: "Ueberarbeiteter Vorschlag..." })',
    ],
    anti_patterns: [
      'list ohne status-Filter — alle Proposals inkl. alter geladen, Context-Overhead.',
      'Proposals als Task-Tracking verwenden → plan(add_task) ist dafuer.',
      'Proposals nie aktualisieren — Status-Pflege haelt die Liste sauber.',
      'update_status mit id als String statt Array fuer Batch — Array nutzen.',
    ],
    actions: {
      list: {
        description: 'Alle Proposals auflisten (optional nach Status filtern).',
        params: 'project (req), status (pending|reviewed|accepted|rejected)',
        example: 'proposal({ action: "list", project: "synapse", status: "pending" })',
        tips: 'Status-Filter setzen um Output zu begrenzen.',
      },
      get: {
        description: 'Proposal abrufen (einzeln oder mehrere).',
        params: 'project (req), id (req, String oder Array)',
        example: 'proposal({ action: "get", project: "synapse", id: ["abc123", "def456"] })',
        tips: 'Array erlaubt fuer Batch-Abruf. id (auch bei update_status/update/delete): volle UUID oder eindeutiger Praefix, mind. 8 Zeichen; mehrdeutig/unbekannt -> Fehler mit Kandidaten, nichts wird geaendert. Quelle: PostgreSQL.',
      },
      update_status: {
        description: 'Status eines Proposals aendern.',
        params: 'project (req), id (req, String oder Array), status (req)',
        example: 'proposal({ action: "update_status", project: "synapse", id: "abc123", status: "accepted" })',
        tips: 'Batch: id als Array → gleicher Status fuer alle.',
      },
      update: {
        description: 'Proposal-Inhalt oder Status aendern.',
        params: 'project (req), id (req), content, suggested_content, status',
        example: 'proposal({ action: "update", project: "synapse", id: "abc123", suggested_content: "Neuer Vorschlag..." })',
      },
      delete: {
        description: 'Proposal loeschen (einzeln oder Batch). WICHTIG: Single-Delete (id als String) loescht SOFORT, dry_run wird ignoriert. Nur Batch-Delete (id als Array) unterstuetzt dry_run-Preview. Connector-UIs koennen daher bei Single-Delete eine Bestaetigung verlangen.',
        params: 'project (req), id (req, String oder Array), dry_run, max_items',
        example: 'proposal({ action: "delete", project: "synapse", id: "abc123" })',
        tips: 'Batch: id als Array + dry_run: true fuer Preview.',
      },
    },
  },

  docs: {
    summary: 'Tech-Dokumentation indexieren, durchsuchen und Datei-spezifische Warnungen abrufen (Wissens-Airbag). add akzeptiert optional docs[] (1..50) fuer Bulk-Indexierung.',
    when_to_use: [
      'Vor jeder Datei-Bearbeitung: get_for_file — prueft Breaking Changes fuer verwendete Frameworks.',
      'Framework-API nachschlagen: search.',
      'Kuratierte Doku indexieren (vom Koordinator): add.',
      'Breaking Changes pruefen vor Lib-Update.',
      'Migration-Guides finden.',
    ].join(' '),
    when_not_to_use: [
      'Allgemeine Code-Suche → code_intel oder search(action: "code").',
      'Datei-Wissen in einem Aufruf → docs(get_for_file, memories: true); memory bleibt als separates Werkzeug verfuegbar.',
      'Ich weiss wie die API funktioniert — trotzdem get_for_file aufrufen bei Cutoff-Risiko.',
    ].join(' '),
    param_tips: [
      'get_for_file: agent_id + project beide Pflicht. file_path als Array fuer Multi-File-Check.',
      'search: framework setzen fuer gezielteren Treffer (z.B. "fastify", "react").',
      'search scope: "global" = allgemeine Docs, "project" = kuratierte, "all" = beide.',
      'add: type korrekt setzen (breaking-change, migration, gotcha) — beeinflusst Airbag-Logik.',
      'add source: "research" fuer kuratierte Docs (Koordinator-Scope), "context7" fuer Auto-Fetch.',
    ].join('\\n'),
    examples: [
      'docs({ action: "get_for_file", file_path: "packages/rest-api/src/routes/mcp.ts", agent_id: "mein-agent", project: "synapse", memories: true })',
      'docs({ action: "search", query: "breaking changes hooks", framework: "react", project: "synapse" })',
      'docs({ action: "add", framework: "fastify", version: "5.0", section: "plugin-api", content: "...", type: "breaking-change", project: "synapse" })',
    ],
    anti_patterns: [
      'get_for_file ohne agent_id — Cutoff-Ermittlung funktioniert nicht.',
      'Warnungen aus get_for_file ignorieren — sie verhindern Fehler durch veraltetes Wissen.',
      'search ohne framework-Filter — zu viele irrelevante Ergebnisse.',
      'add ohne type-Angabe — Airbag kann nicht korrekt priorisieren.',
      'Docs selbst recherchieren und speichern (Web-KIs sollten Docs-Kurator anfordern).',
    ],
    actions: {
      get_for_file: {
        description: 'Wissens-Airbag: Relevante Warnings/Docs fuer eine Datei abrufen — dedupliziert (Section + Content-Praefix) und hart limitiert pro Framework.',
        params: 'file_path (req, String oder Array), agent_id (req), project (req); optional: limit (pro Framework, Standard 5), framework (Filter auf EIN Framework, z.B. "fastify"), framework_warnungen (Standard true), memories (Standard false), steckbrief (Platzhalter Teil B, derzeit ohne Wirkung)',
        example: 'docs({ action: "get_for_file", file_path: "src/api.ts", agent_id: "mein-agent", project: "synapse", framework: "fastify", limit: 3 })',
        tips: 'VOR jeder Datei-Bearbeitung aufrufen. memories:true fuegt kompakte Projekt-Memories hinzu; ohne neue Schalter bleibt die Ausgabe wie bisher. framework_warnungen:false blendet nur Framework-Warnungen aus (Standard true). Array fuer Multi-File. Framework-Zuordnung laeuft ueber die Datei-Extension (.ts matcht u.a. react UND fastify) — mit framework: "<name>" gezielt eingrenzen.',
      },
      search: {
        description: 'Tech-Docs semantisch durchsuchen.',
        params: 'query (req), framework, type, source, project, limit, scope (project|global|all)',
        example: 'docs({ action: "search", query: "migration guide v5", framework: "fastify", project: "synapse", scope: "global" })',
      },
      add: {
        description: 'Tech-Doc-Chunk indexieren (Koordinator/Docs-Kurator Scope).',
        params: 'framework (req), version (req), section (req), content (req), type (req), category, source, project',
        example: 'docs({ action: "add", framework: "react", version: "19.0", section: "hooks", content: "...", type: "breaking-change" })',
        tips: 'type: breaking-change|migration|gotcha = hohe Prioritaet im Airbag.',
      },
    },
  },

  project: {
    summary: 'Projekt-Lifecycle verwalten: Initialisieren, Setup abschliessen, Technologien erkennen, Status pruefen.',
    when_to_use: [
      'Neues Projekt einrichten: init (einmalig).',
      'Projekt-Status pruefen: status.',
      'Alle aktiven Projekte anzeigen: list.',
      'FileWatcher stoppen: stop.',
      'Technologie-Stack eines Projekts erkennen: detect_tech.',
    ].join(' '),
    when_not_to_use: [
      'Projekt-Statistiken und Regeln → admin(action: "index_stats").',
      'Code lesen/schreiben → code_intel oder files.',
      'Memories/Thoughts verwalten → memory oder thought.',
    ].join(' '),
    param_tips: [
      'init: path muss absoluter Pfad sein. index_docs: true indexiert Framework-Doku automatisch.',
      'status: path (absolut) erforderlich — nicht project-Name.',
      'stop: project-Name erforderlich (nicht path).',
      'cleanup: path + name beide erforderlich.',
      'complete_setup: Nur nach init aufrufen, phase: "initial" dann "post-indexing".',
    ].join('\\n'),
    examples: [
      'project({ action: "list" })',
      'project({ action: "status", path: "/home/user/dev/myproject" })',
      'project({ action: "stop", project: "myproject" })',
      'project({ action: "detect_tech", path: "/home/user/dev/myproject" })',
    ],
    anti_patterns: [
      'init mehrfach aufrufen — ist einmalig, verursacht Konflikte.',
      'status mit project-Name statt path — erfordert absoluten Pfad.',
      'stop auf Projekt das noch aktiv bearbeitet wird — FileWatcher-Stop beendet Sync.',
      'cleanup ohne Backup — loescht Projekt-Daten permanent.',
      'list verwechseln mit admin(index_stats) — list zeigt nur aktive Prozesse.',
    ],
    actions: {
      init: {
        description: 'Neues Projekt initialisieren. Zwei Modi: (a) mit absolutem path → Tech-Detection + Doku-Indexierung auf bestehendem Ordner, (b) Self-Service nur mit name (kein path) → Job geht an FileWatcher-Daemon auf dem Ziel-PC, der das Verzeichnis unter SYNAPSE_WORKSPACE_ROOT (default ~/dev) anlegt, git init macht, in projects-Tabelle registriert und Watcher startet.',
        params: 'name (Pflicht wenn kein path) ODER path (absolut). Optional: index_docs (Standard: true), agent_id, hostname (Ziel-Host falls mehrere Daemons), template (informational).',
        example: 'project({ action: "init", name: "neues-projekt" })  ODER  project({ action: "init", path: "/home/user/dev/bestehend" })',
        tips: 'Self-Service: ohne path braucht der Watcher auf dem Ziel-PC einen aktiven Daemon. Antwort enthaelt resolved_path + job_id. Bei Timeout (daemon_unreachable): Status erneut pruefen via init_status mit job_id.',
      },
      init_status: {
        description: 'Status eines Self-Service Init-Jobs abrufen — fuer den Fall dass init mit "daemon_unreachable" oder "queued" zurueckkam.',
        params: 'job_id (req, aus init-Antwort)',
        example: 'project({ action: "init_status", job_id: "abc-123" })',
        tips: 'Status: pending|running|done|failed|rejected|timeout. Bei "done" enthaelt path den finalen Projekt-Pfad.',
      },
      projekt_db: {
        description: 'Projekt-DB (Spielwiese je Projekt auf 192.168.50.65:5433, Container postgresql16_2 — NICHT die Synapse-DB) anzeigen oder anlegen. Standard: anzeigen mit Host, Port, DB, User, Passwort und DATABASE_URL; gibt es keine, kommt vorhanden:false plus der fertige Aufruf. erstellen:true legt sie an, falls keine existiert (eine vorhandene wird nie angefasst). Neue Projekte bekommen sie bei init automatisch durch die API.',
        params: 'project (req). Optional: erstellen (boolean); uebernehmen ({database, user, passwort, host?, port?}, nur Koordinator/User) + vorschau (boolean, Standard true) registriert eine BESTEHENDE Projekt-DB nach Ziel- und Anmeldepruefung (nie System-DB, ueberschreibt nie).',
        example: 'project({ action: "projekt_db", project: "mein-projekt" })  ODER  project({ action: "projekt_db", project: "coedit-test", erstellen: true })',
        tips: 'Rolle <db>_user ohne Superuser/CREATEDB/CREATEROLE, Owner der eigenen DB, kein Zugriff auf andere Projekt-DBs. Laeuft der Daemon, steht DATABASE_URL zusaetzlich in <projekt>/.env (chmod 600). status zeigt nur vorhanden ja/nein, ohne Passwort.',
      },
      status: {
        description: 'Projekt-Status, FileWatcher-Status und Statistiken abrufen.',
        params: 'path (req, absoluter Pfad)',
        example: 'project({ action: "status", path: "/home/user/dev/myproject" })',
        tips: 'path = absoluter Pfad (nicht project-Name).',
      },
      list: {
        description: 'Alle aktiven Projekte in dieser MCP-Server-Session anzeigen.',
        params: '(keine)',
        example: 'project({ action: "list" })',
      },
      stop: {
        description: 'FileWatcher stoppen und Projekt deaktivieren.',
        params: 'project (req, Projekt-Name)',
        example: 'project({ action: "stop", project: "synapse" })',
        tips: 'project = Name (nicht Pfad). Stoppt FileWatcher + Agenten.',
      },
      detect_tech: {
        description: 'Technologie-Stack eines Projekts automatisch erkennen.',
        params: 'path (req, absoluter Pfad)',
        example: 'project({ action: "detect_tech", path: "/home/user/dev/myproject" })',
      },
      cleanup: {
        description: 'Projekt-Daten loeschen (Collections etc.). Destruktiv!',
        params: 'path (req), name (req)',
        example: 'project({ action: "cleanup", path: "/home/user/dev/myproject", name: "myproject" })',
        tips: 'VORSICHT: Loescht alle Projekt-Daten. Nur nach Backup.',
      },
      complete_setup: {
        description: 'Setup-Phasen nach init abschliessen.',
        params: 'project (req), phase (initial|post-indexing)',
        example: 'project({ action: "complete_setup", project: "synapse", phase: "post-indexing" })',
        tips: 'Nur nach init aufrufen. Zwei Phasen: initial → dann post-indexing.',
      },
      enable: {
        description: 'Projekt in PG aktivieren (Source of Truth) — Parser-Worker und FileWatcher-Daemon folgen.',
        params: 'project (req)',
        example: 'project({ action: "enable", project: "synapse" })',
      },
      disable: {
        description: 'Projekt deaktivieren — Indexierung/Sync pausieren ohne Daten zu loeschen (Gegenstueck: enable).',
        params: 'project (req)',
        example: 'project({ action: "disable", project: "altes-projekt" })',
      },
    },
  },

  ignore: {
    summary: 'Regelt, welche Dateien Synapse indexiert und anzeigt (Ersatz fuer die frueher genutzte Datei .synapseignore). Regeln liegen pro Projekt in der Datenbank (project_ignore_rules) und gelten fuer lokalen Daemon und API gleichermassen.',
    when_to_use: [
      'Aktive Regeln ansehen: list.',
      'Neues Muster ausschliessen, z.B. generierte Dateien oder Rauschen in der Suche: add.',
      'Regel voruebergehend abschalten OHNE sie zu verlieren: disable -- spaeter mit enable wieder aktivieren.',
      'Regel endgueltig entfernen: remove.',
      'Pruefen warum ein Pfad nicht auftaucht, und durch WELCHE Regel: test.',
    ].join(' '),
    when_not_to_use: [
      'Eine einzelne Datei nur einmalig ausblenden wollen -- Regeln gelten projektweit, es gibt keine Einmal-Ausnahme.',
      'node_modules/.git/dist/.env/.mcp.json aus dem Index nehmen wollen -- diese Regeln sind gesperrt (locked), genau dafuer.',
    ].join(' '),
    param_tips: [
      'pattern folgt gitignore-Syntax: "docs/" ein Verzeichnis, "*.txt" eine Endung, "!ausnahme.txt" eine Ausnahme von einer breiteren Regel.',
      'scope begrenzt ein Muster auf einen Teilbaum statt projektweit zu gelten.',
      'Reihenfolge zaehlt wie bei gitignore: die SPAETERE Regel gewinnt.',
      'Gesperrte Regeln (locked:true in list) lassen sich nicht abschalten oder entfernen -- Schutz gegen versehentliches Freigeben von node_modules & co.',
    ].join('\\n'),
    examples: [
      'ignore({ action: "list", project: "synapse" })',
      'ignore({ action: "add", project: "synapse", pattern: "generated/", kommentar: "Codegen-Output" })',
      'ignore({ action: "disable", project: "synapse", pattern: "docs/" })',
      'ignore({ action: "test", project: "synapse", file_path: "docs/handbuch.md" })',
    ],
    anti_patterns: [
      'Eine gesperrte Regel per remove/disable umgehen wollen -- schlaegt mit klarer Begruendung fehl, das ist Absicht.',
      'Eine Regel loeschen (remove) um sie nur kurz auszusetzen -- nutze disable, dann bleibt sie erhalten und ist mit enable sofort wieder da.',
      'Nach add erwarten dass eine schon indexierte Datei sofort aus JEDER Ansicht verschwindet, ohne zu pruefen -- Baum und Volltextsuche ziehen sofort nach, teste im Zweifel mit test oder einem erneuten tree/search.',
    ],
    actions: {
      list: {
        description: 'Alle Regeln des Projekts anzeigen, inklusive Sperr- (locked) und Aktiv-Status (enabled).',
        example: 'ignore({ action: "list", project: "synapse" })',
      },
      add: {
        description: 'Eine oder mehrere Regeln anlegen. Bereits vorhandene Muster werden uebersprungen statt zu scheitern.',
        params: 'pattern ODER patterns[] (req), scope, kommentar',
        example: 'ignore({ action: "add", project: "synapse", pattern: "*.snap" })',
        tips: 'Ohne sort_order wird ans Ende gehaengt -- neue Regeln wirken SPAETER als bestehende (gitignore-Semantik). Antwort nennt unter neuAusgeblendet/neuSichtbar, welche bereits indexierten Dateien betroffen sind.',
      },
      remove: {
        description: 'Regel endgueltig entfernen. Gesperrte Regeln werden mit Begruendung abgewiesen.',
        params: 'pattern (req)',
        example: 'ignore({ action: "remove", project: "synapse", pattern: "*.snap" })',
      },
      enable: {
        description: 'Regel wieder aktivieren.',
        params: 'pattern (req)',
        example: 'ignore({ action: "enable", project: "synapse", pattern: "docs/" })',
      },
      disable: {
        description: 'Regel abschalten OHNE sie zu verlieren -- der eigentliche Zweck der Tabelle gegenueber der frueheren Datei. Gesperrte Regeln lassen sich nicht abschalten.',
        params: 'pattern (req)',
        example: 'ignore({ action: "disable", project: "synapse", pattern: "docs/" })',
      },
      test: {
        description: 'Prueft ob ein Pfad ignoriert wird, und durch WELCHE Regel (Muster + Herkunft: standard/gitignore/datenbank).',
        params: 'file_path (req)',
        example: 'ignore({ action: "test", project: "synapse", file_path: "docs/handbuch.md" })',
      },
    },
  },

  code_check: {
    summary: 'Error-Pattern-System: Bekannte Fehler speichern und automatisch bei Write-Operationen pruefen. Mit Signatur (erkennung) erkennt ein Muster den FEHLER (Befund an der Op), ohne nur das Thema (Themenhinweis).',
    when_to_use: [
      'Nach einem wiederkehrenden Code-Fehler: add_pattern mit titel, warum, fix, erkennung (Signatur), beispiel_falsch und beispiel_richtig.',
      'Bestehendes Muster verbessern (Signatur, Beispiele, Geltung, Verweise, Status): update_pattern.',
      'Bekannte Patterns inspizieren: list_patterns (kompakt; detail:true fuer alle Felder).',
      'Veraltetes Pattern: update_pattern status "stillgelegt" mit grund (nachvollziehbar) statt delete_pattern.',
      'Scope-spezifische Patterns anzeigen (z.B. nur haiku-Fehler): list_patterns mit model_scope.',
    ].join(' '),
    when_not_to_use: [
      'Code ausfuehren → shell.',
      'Code lesen/schreiben → code_intel oder files.',
      'Allgemeine Notizen → thought oder memory.',
    ].join(' '),
    param_tips: [
      'add_pattern: description (was ist falsch) + fix (wie korrigieren) + found_in_model Pflicht; found_by Standard agent_id.',
      'found_in_model: Modell-Name das den Fehler machte ("haiku", "sonnet", "opus", "fable"). Daraus wird model_scope abgeleitet; update_pattern aendert model_scope NIE.',
      'E1-Felder (P15-T37): titel (<= 80 Zeichen, "was"), warum, erkennung {art:"regex", signatur:[...] (Liste = UND, alle muessen treffen; ODER als "A|B" in EINEM String), gegen_signatur:[...] (eine hebt auf), flags "imsu", fenster zeile|block|datei - signatur/fenster usw. gehoeren IN erkennung, nicht auf die oberste Ebene}, geltung {sprachen, dateimuster, projekte, frameworks}, verweise [{art memory|thought|doku|datei|skill, name|id|url|file_path}] oder Kurzform "memory:<name>", beispiel_falsch, beispiel_richtig, status aktiv|themenhinweis|stillgelegt.',
      'SELBSTTEST vor dem Speichern: mit erkennung muss die Signatur beispiel_falsch treffen und beispiel_richtig NICHT treffen - sonst error "selbsttest" mit Begruendung, nichts gespeichert. Mit Signatur ist der Standard-Status aktiv, ohne themenhinweis; aktiv ohne Signatur wird abgelehnt.',
      'DUBLETTEN: gleiche Signatur oder gleiche description -> error "dublette" mit ID (bestehendes Muster per update_pattern erweitern). Gleicher Titel oder ein aktives Muster erkennt beispiel_falsch schon -> ebenfalls Ablehnung mit ID, bewusst uebergehbar mit dublette_ok:true. Thematisch aehnliche Muster (Embedding) kommen nur als Hinweis (aehnlich[]).',
      'severity: neue Muster starten IMMER als warning (error beim Anlegen wird warning, mit Hinweis). error nur per update_pattern mit grund (mind. 10 Zeichen) und nur fuer aktive Signatur-Muster. Ein offener error-Befund sperrt files commit (pruef_befunde), im Einzelschreibweg wird geschrieben und deutlich gemeldet.',
      'Tab in der Signatur als \\t (in JSON "\\\\t"), im Beispiel ein echtes Tab (in JSON "\\t"); Steuerzeichen aus JSON-Escapes (Tab, Backspace statt \\b) wandelt add/update_pattern zurueck in Regex-Escapes. Einfacher: " *" bzw. \\s statt [ \\t].',
      'update_pattern: id als volle UUID oder eindeutiger Praefix (mind. 8 Zeichen, wie thought get); mehrdeutig -> error "mehrdeutig" mit kandidaten[]. Nur die angegebenen Felder werden geaendert (null bzw. "" leert ein optionales Feld). status stillgelegt braucht grund (-> stillgelegt_grund). Selbsttest/Dublettenpruefung laufen erneut, wenn Signatur, Beispiele oder Status sich aendern.',
      'Treffer kommen als Feld fehlermuster {anzahl, hinweis, treffer:[{pattern_id, severity, datei, was, wie}]} in der Antwort des Schreibaufrufs oder - falls die Pruefung laenger dauert - in deiner naechsten Tool-Antwort. Es sind THEMENHINWEISE (Embedding-Aehnlichkeit zum geaenderten Abschnitt), kein sicherer Fehlerbefund. Je Muster einmal pro Sitzung (Fenster FEHLERMUSTER_GESEHEN_STUNDEN, Standard 12 h); unbekanntes Modell sieht alle Muster (FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE=0 schaltet ab).',
      'list_patterns: kompakt (id, titel, status, severity, model_scope, Signatur-Kurzform, geltung); detail:true liefert alle Felder; Filter model_scope und status.',
    ].join('\\n'),
    examples: [
      'code_check({ action: "add_pattern", titel: "console.log im MCP-stdio-Server", description: "console.log schreibt auf stdout und zerstoert das MCP-Protokoll", warum: "stdio-MCP nutzt stdout fuer JSON-RPC", fix: "console.error verwenden", erkennung: { signatur: ["\\\\bconsole\\\\.log\\\\("] }, geltung: { dateimuster: ["packages/mcp-server/**"] }, beispiel_falsch: "console.log(x);", beispiel_richtig: "console.error(x);", found_in_model: "haiku" })',
      'code_check({ action: "update_pattern", id: "abc123", severity: "error", grund: "2 Wochen ohne Fehlalarm, 14 echte Treffer" })',
      'code_check({ action: "update_pattern", id: "abc123", status: "stillgelegt", grund: "Dublette von def456" })',
      'code_check({ action: "list_patterns", model_scope: "haiku", status: "aktiv", limit: 10 })',
      'code_check({ action: "delete_pattern", id: "abc123" })',
    ],
    anti_patterns: [
      'add_pattern fuer einmalige Fehler — nur wiederkehrende Patterns einreichen.',
      'found_in_model weglassen — Pattern wird nicht korrekt gescoped.',
      'Veraltete Patterns stehen lassen — sie erzeugen falsche Warnungen; stilllegen (update_pattern status stillgelegt + grund).',
      'Muster per SQL in error_patterns schreiben — add_pattern/update_pattern kennen alle Felder und pruefen Selbsttest und Dubletten.',
      'Signatur ohne beispiel_falsch/beispiel_richtig — der Selbsttest lehnt ab.',
      'list_patterns ohne limit — Standard ist 20, kann Context sprengen.',
    ],
    actions: {
      add_pattern: {
        description: 'Fehler-Pattern speichern (Selbsttest + Dublettenpruefung vor dem Speichern, Start immer als warning).',
        params: 'description (req), fix (req), found_in_model (req), found_by (Standard agent_id), titel, warum, erkennung, geltung, verweise, beispiel_falsch, beispiel_richtig, status (aktiv|themenhinweis|stillgelegt), severity (warning|info), grund, dublette_ok',
        example: 'code_check({ action: "add_pattern", titel: "Pfad nicht validiert", description: "Benutzerpfad ohne Pruefung an fs uebergeben", fix: "path.resolve() + Praefix-Pruefung", erkennung: { signatur: ["readFile\\\\(req\\\\."] }, beispiel_falsch: "readFile(req.query.p)", beispiel_richtig: "readFile(sicher(req.query.p))", found_in_model: "sonnet" })',
        tips: 'Antwort: id, status, severity, model_scope, selbsttest, aehnlich[] (Hinweis), hinweise[]. Fehler: ungueltig | selbsttest | dublette (mit dubletten[].id) | grund_fehlt.',
      },
      update_pattern: {
        description: 'Gezielte Feldaenderung an einem Muster; model_scope bleibt unveraendert.',
        params: 'id (req), titel, description, warum, fix, erkennung, geltung, verweise, beispiel_falsch, beispiel_richtig, status, severity, grund (Pflicht fuer severity error / status stillgelegt), dublette_ok',
        example: 'code_check({ action: "update_pattern", id: "abc123", erkennung: { signatur: ["^\\\\s*use server\\\\b(?![\'\\"])"], fenster: "zeile" }, beispiel_falsch: "use server;", beispiel_richtig: "\\"use server\\";", status: "aktiv" })',
        tips: 'Antwort nennt geaendert[]. Aenderungen stehen in statistik.letzte_aenderung (am, von, felder, grund), Hochstufung auf error in statistik.severity_error.',
      },
      list_patterns: {
        description: 'Gespeicherte Error-Patterns anzeigen (kompakt, optional detail).',
        params: 'model_scope, status, limit (Standard: 20), detail',
        example: 'code_check({ action: "list_patterns", status: "aktiv", limit: 5 })',
        tips: 'Kompakt: signatur als Kurzform "regex 2 + gegen 1, fenster block". detail:true: warum, fix, erkennung, geltung, verweise, beispiele, statistik.',
      },
      delete_pattern: {
        description: 'Veraltetes oder falsches Pattern entfernen.',
        params: 'id (req)',
        example: 'code_check({ action: "delete_pattern", id: "abc123" })',
      },
      offene_faelle: {
        description: 'P15-T33 Erklaerungs-Topf: offene Faelle (Syntaxfehler ohne passende verifizierte Erklaerung), ohne Schatten, mit Stufe (neu | verwerfen_anfragbar ab 3 Monaten | markiert ab 6 | loeschen ab 9).',
        params: 'project (optional), nur_eigene (optional: nur Faelle des aufrufenden Agenten), limit. Onboarding nennt offene Faelle als Zeile erklaerung_faelle (Koordinator: Projekt, Agent: eigene). Startbestand des Topfs: 15 generische Erklaerungen aus E0 (admin jev_erklaerungstopf, modus status | seed_laden | nachholen).',
        example: 'code_check({ action: "offene_faelle", project: "synapse", nur_eigene: true })',
      },
      fall: {
        description: 'Ein Fall mit maskiertem Schatten (Ausschnitt +-30 Zeilen nachher, vorher, Diff), Befund, Jev-Versuch und Pflichtsprachen. Die Antwort wird NICHT in tool_calls protokolliert.',
        params: 'id (req, Fall-ID)',
        example: 'code_check({ action: "fall", id: "17" })',
      },
      erklaerung_ablegen: {
        description: 'Generische Erklaerung (Lage, Wieso, Abhilfe) fuer einen Fall ablegen oder eine bestehende per erklaerung_id belegen; startet die Verifikation. Nur der betroffene Agent oder der Koordinator.',
        params: 'fall_id (req), lage_de/wieso_de/abhilfe_de und/oder lage_en/wieso_en/abhilfe_en (alle gepflegten Sprachen Pflicht, admin jev_optionen), erklaerung_id',
        example: 'code_check({ action: "erklaerung_ablegen", fall_id: "17", lage_de: "Eine schliessende runde Klammer fehlt.", wieso_de: "...", abhilfe_de: "...", lage_en: "A closing parenthesis is missing.", wieso_en: "...", abhilfe_en: "..." })',
        tips: 'Abgelehnt: sprache_fehlt, nicht_generisch (verstoesse: pfad, bezeichner, literal, zeilenangabe, hash, codeblock, geheimnis, projekt, agent, env_wert), nur_betroffener, dublette. Neue Erklaerungen starten vorgeschlagen; verifiziert erst, wenn der korrigierte Stand ohne Befund ist - dann werden Fall und Schatten geloescht.',
      },
      fall_pruefen: {
        description: 'Verifikation: Erklaerung belegt, neuer Stand (weder Fehlerstand noch Stand vorher), Syntax auf dem ganzen Stand ohne Fehler, keine Signatur-Treffer auf den Zeilen der Fehleraenderung. Erfuellt -> Fall geloescht, Erklaerung verifiziert.',
        params: 'id (req, Fall-ID)',
        example: 'code_check({ action: "fall_pruefen", id: "17" })',
      },
      fall_verwerfen: {
        description: 'Koordinator darf jederzeit verwerfen, andere Agenten ab 3 Monaten. grund (mindestens 10 Zeichen) und zustimmung_user:true sind Pflicht; Agent, Grund und Zustimmung werden protokolliert. Die 6/9-Monats-Stufen der Tagespruefung bleiben bestehen.',
        params: 'id (req), grund (req, mindestens 10 Zeichen), zustimmung_user (req, true)',
        example: 'code_check({ action: "fall_verwerfen", id: "17", grund: "User hat das Verwerfen freigegeben", zustimmung_user: true })',
      },
      erklaerungen: {
        description: 'Erklaerungen des globalen Topfs in den gepflegten Sprachen, mit Zaehlern (gewaehlt, verifiziert, passt_nicht).',
        params: 'familie, erklaerung_status (vorgeschlagen|verifiziert|stillgelegt), id, limit',
        example: 'code_check({ action: "erklaerungen", familie: "typescript", erklaerung_status: "verifiziert" })',
      },
      erklaerung_bewerten: {
        description: 'Rueckmeldung zu einer ausgelieferten Erklaerung: passt_nicht (jeder); stilllegen (Koordinator, grund >= 10 Zeichen) und reaktivieren (Koordinator).',
        params: 'id (req), bewertung (req), grund',
        example: 'code_check({ action: "erklaerung_bewerten", id: "<uuid>", bewertung: "passt_nicht", grund: "Ursache war eine andere" })',
      },
    },
  },

  chat: {
    summary: 'Agenten-Chat: Registrierung, Direkt-Nachrichten und Broadcasts. Verfuegbar lokal (stdio MCP) UND via REST-API (Daten in PostgreSQL, Routing ueber PG-Queue/Daemon, Erreichbarkeit unabhaengig vom Ziel-PC-Status fuer Schreib-/Lese-Ops auf der DB).',
    when_to_use: 'Agent registrieren bevor du Nachrichten sendest: register (Neuinstanz/Neustart mit Ausweis: chat(action:"anmelden", token), nie register). DM/Broadcast schicken: send. Eigene Inbox abholen: get. Aktive Agenten anzeigen: list. Inbox-Routing fuer offline Spezialisten: inbox_send / inbox_check.',
    when_not_to_use: 'Langlebiges Wissen → memory. Kurze Beobachtungen → thought. Strukturierte Steuersignale (WORK_STOP etc.) → event.',
    actions: {
      register: { description: 'Agent in Chat registrieren (id, project, optional model + cutoff_date).' },
      register_batch: { description: 'Mehrere Agenten in einem Call registrieren (agents: [{id, model?}, ...]).' },
      unregister: { description: 'Agent abmelden.' },
      send: { description: 'Nachricht senden — recipient_id leer = Broadcast, recipient_id als Array = Multicast.' },
      get: { description: 'Eigene Nachrichten abholen (mit since-Timestamp fuer Polling).' },
      list: { description: 'Alle aktiven Agenten anzeigen.' },
      inbox_send: { description: 'Nachricht in Spezialisten-Inbox legen (offline-faehig).' },
      inbox_check: { description: 'Eigene Inbox lesen.' },
      unregister_batch: { description: 'Mehrere Agenten in einem Call abmelden.', params: 'ids (req, Array), project' },
    },
    anti_patterns: [
      'send ohne vorheriges register — Sender-ID nicht im System bekannt.',
      'get ohne since — bekommst alte Nachrichten doppelt.',
      'sender_id verwechseln mit recipient_id — Nachrichten landen falsch.',
    ],
  },

  channel: {
    summary: 'Persistente Channels fuer Themen-/Mission-Kommunikation. Verfuegbar lokal UND via REST (PostgreSQL-basiert). Subscribe via join, posten via post, mitlesen via feed.',
    when_to_use: 'Themen-Diskussion fuer mehrere Beteiligte: post + feed. Mission-Channel von Koordinator anlegen: create. Beitritt: join (auch Array fuer Multi-Channel-Subscribe). Verlassen: leave. Alle Channels eines Projekts: list.',
    when_not_to_use: 'Direkte 1:1 Kommunikation → chat (DM). Steuersignale die Pflicht-Reaktion erzwingen → event. Langlebige Doku → memory.',
    actions: {
      create: { description: 'Channel anlegen (name, project, created_by, optional description).' },
      join: { description: 'Beitreten — channel_name als String oder Array fuer Batch-Join.' },
      leave: { description: 'Verlassen — channel_name als String oder Array.' },
      post: { description: 'Nachricht in Channel (channel_name, sender, content). Bulk-Mode: messages[] (1..20) fuer mehrere Posts in einem Call — sender + channel_name gelten fuer alle. Posts kurz halten: Ergebnisse, Befunde, Berichte zuerst als thought (per ID lesbar, 8 Zeichen reichen) oder memory (per Name lesbar) ablegen und hier nur ID/Name mit einer Zeile nennen (z. B. "T2 fertig, Ergebnis: thought ab12cd34"); ausfuehrlich nur bei Rueckfrage, Entscheidung, Blocker oder Hinweis fuer den User.' },
      feed: { description: 'Channel-Inhalt lesen (limit, since_id, before_id, order, optional preview-Truncation). order:"asc" + since_id blaettert von vorne durch — ohne das bekommst du immer nur die neuesten limit Nachrichten und erreichst den Anfang langer Channels nie.' },
      list: { description: 'Alle Channels im Projekt.' },
    },
    anti_patterns: [
      'post ohne vorheriges join — manche Channels filtern Non-Member.',
      'feed ohne since_id im Loop — bekommst alte Nachrichten erneut.',
      'Einen langen Channel mit feed ohne order:"asc" lesen wollen — du siehst nur das Ende, der Anfang bleibt unerreichbar.',
      'preview: false bei langen Posts — sprengt den Context.',
    ],
  },

  event: {
    summary: 'Persistente Steuersignale fuer Agenten (WORK_STOP, NEW_TASK, PLAN_READY, ANNOUNCEMENT, …). Verfuegbar lokal UND via REST (PostgreSQL). PLAN_READY ist ein zielgerichtetes Inbox-Event fuer einen wartenden Co-Editor und bleibt bis ack oder terminalem Wait-Status erhalten; Push ist keine Voraussetzung. Was danach aus dem gemeinsamen Plan wird, melden PLAN_COMMITTED (plan_id, batch_id, committed_by, offene_dateien), PLAN_CANCELLED, PLAN_CHANGED (Rueckzug eines Beteiligten) und PLAN_FOLLOWUP (folgeplan_id) an jeden Betroffenen — persistent bis ack; ein erledigtes PLAN_READY wird nur zusammen mit diesem Nachfolge-Event quittiert. Erweiterbare Objektantworten ausser event/guide tragen bei agent_id+project bis zu 3 kompakte pending_events (summary max. 80 Zeichen, kein Payload). emit akzeptiert optional events[] (1..50) fuer Bulk-Emit; ack akzeptiert event_id als Array (Batch-Ack).',
    when_to_use: 'Koordinator emittiert Event an Agent(en): emit (mit scope: "all" oder "agent:<id>"). PLAN_READY signalisiert dem waiting_agent einen eindeutig passenden offenen Primaerplan; Payload: plan_id, wait_token, shared_files, primary_agent. Agent quittiert empfangenes Event: ack. Agent prueft offene Events: pending.',
    when_not_to_use: 'Lockere Updates ohne Pflicht → thought oder channel. Direkte 1:1 Frage → chat DM. Langlebige Anweisung → memory.',
    actions: {
      emit: { description: 'Event senden (event_type, priority: critical|high|normal, scope, source_id, payload).' },
      ack: { description: 'Event quittieren (event_id einzeln oder als Array fuer Batch-Ack).' },
      pending: { description: 'Eigene unacked Events vollständig abrufen (project + agent_id Pflicht). Normale erweiterbare Objektantworten erinnern bis zum Ack bei jedem Aufruf mit max. 3 kompakten pending_events; event und guide sind ausgenommen. Terminale oder abgelaufene PLAN_READY-Waits werden aus der Inbox ausgeblendet, die Event-Zeile bleibt fuer Audit erhalten.' },
    },
    anti_patterns: [
      'critical-Event 3+ Tool-Calls ignorieren — Eskalation an Koordinator.',
      'emit ohne source_id — Agent weiss nicht wer das Signal geschickt hat.',
      'Batch-ack mit gemischten Event-Typen ohne Reaktion — quittieren ohne tatsaechlich zu reagieren.',
    ],
  },

  specialist: {
    summary: 'Persistente Spezialisten (Claude-CLI ODER Gemini) auf dem Ziel-PC spawnen, stoppen, ansprechen. Funktioniert sowohl lokal als auch ueber REST/Web-KI — Voraussetzung in beiden Faellen: auf dem Ziel-PC laeuft der FileWatcher-Daemon (er hostet PG-Queue → Provider-Runtime). Modell-Alias-Aufloesung via PG model_registry-Tabelle. Fehlerinterpretation: spawn timeoutet ohne PID/Socket in der Antwort → Watcher down ODER Provider-Runtime fehlt auf dem Ziel-PC (Claude-CLI bei opus/sonnet/haiku/fable, GOOGLE_API_KEY bei gemini-*). Spezifischer Fehler wie "name contains illegal characters" / "project not found" → Eingabe pruefen. wake antwortet nie / Inbox-Fallback → Spezialist gestorben oder Watcher-Heartbeat haengt.',
    when_to_use: [
      'Langlaufende Aufgabe an Sub-Agent delegieren: spawn (1) oder spawn_batch (mehrere atomar).',
      'Sub-Agent eine Nachricht / neuen Auftrag schicken: wake.',
      'Sub-Agent komplett entfernen (Auto-Respawn vermeiden, Token sparen): purge.',
      'Sub-Agent nur stoppen aber Skill+Memory behalten: stop.',
      'SKILL.md eines Spezialisten editieren: update_skill.',
    ].join(' '),
    when_not_to_use: [
      'Eigene Single-Shot-Aufgabe → einfach selbst erledigen.',
      'Live-Wrapper-Status (PID/Socket-Health) → nur lokaler MCP hat den; REST gibt Stub-Antwort. Spawn-Response enthaelt initial PID+Socket — danach Status via Channel-Posts/Chat verfolgen.',
    ].join(' '),
    param_tips: [
      'project: Pflicht fuer alle Aktionen ausser capabilities. project_path: optional via REST — wird automatisch aus dem daemon-registrierten Projekt-Pfad ermittelt (projects-Tabelle, last_access). Nur bei lokaler MCP-Direktnutzung weiterhin erforderlich.',
      'name: eindeutige ID — KEINE Sonderzeichen / / .. / Leerzeichen, sonst Sicherheits-Reject.',
      'model: Alias aus der model_registry (unbekannter Alias → Fehlermeldung mit allen gueltigen). CLAUDE, immer neueste Version: opus / haiku (200k Context), sonnet = 1M Context nativ (sonnet[1m] gleichwertig), opus[1m] = 1M Context (mehrere 1M-Modelle gleichzeitig moeglich, getestet 29.09.2026), fable = 1M nativ. Aeltere Versionen gezielt: opus-5, opus-4.8, opus-4.7, opus-4.6 (je auch mit [1m]), sonnet-5 / sonnet-5[1m], sonnet-4.6 (nur 200k), fable-5. GOOGLE: gemini-flash-lite / gemini-flash / gemini-pro = 1M Context, ~3-75x guenstiger (braucht GOOGLE_API_KEY auf dem Ziel-PC).',
      'keep_alive: true fuer langlaufende Spezialisten (Auto-Respawn bei Crash). Default false fuer One-Shot.',
      'effort: low | medium | high | xhigh | max -> claude --effort. Weglassen = default_effort des Modells (Claude: medium; capabilities zeigt es je Modell) statt still der User-Einstellung. Bleibt bei Rotation und keep_alive-Neustart gleich, specialist(status) zeigt sie. Stufen je Modell (capabilities): eine Stufe, die das Modell nicht kann, ist ein Fehler mit den Stufen dieses Modells - die CLI wuerde still ausweichen (xhigh -> high bei opus-4.6/sonnet-4.6). haiku kennt keinen Effort, Gemini/antigravity bekommen kein Flag (effortHinweis). Ungueltiger Wert -> Fehler mit den erlaubten Stufen.',
      'Voraussetzung: FileWatcher-Daemon laeuft auf dem User-PC + Provider-Runtime installiert (Claude-CLI fuer opus/sonnet/haiku/fable, GOOGLE_API_KEY fuer gemini-*) + Projekt im Tray aktiv.',
    ].join('\\n'),
    examples: [
      'specialist({ action: "spawn", project: "synapse", name: "review-bot", model: "haiku", expertise: "Code-Review", task: "Reviewe Branch X" })',
      'specialist({ action: "spawn_batch", project: "synapse", specialists: [{ name: "a", model: "haiku", expertise: "X", task: "..." }, { name: "b", model: "haiku", expertise: "Y", task: "..." }] })',
      'specialist({ action: "wake", name: "review-bot", message: "Status Update bitte" })',
      'specialist({ action: "purge", project: "synapse", name: "review-bot" })',
    ],
    anti_patterns: [
      'spawn fuer triviale One-Shot-Tasks — Overhead durch Process-Spawn + Claude-CLI.',
      'Viele Spezialisten ohne Aufgaben spawnen — sie verbrauchen Heartbeat-Token.',
      'stop statt purge wenn Spezialist nicht mehr gebraucht wird → KEEP_ALIVE-Auto-Respawn frisst Token.',
      'name mit Pfadzeichen oder .. — wird wegen Path-Traversal-Schutz abgelehnt.',
    ],
    actions: {
      spawn: {
        description: 'Einen neuen Spezialisten starten (Subprozess auf dem User-PC: Claude-CLI fuer opus/sonnet/haiku/fable-Modelle, Gemini-Runtime fuer gemini-*-Modelle).',
        params: 'project (req), name (req), model (req), expertise (req), task (req), project_path?, channel?, keep_alive?, allowed_tools?, cwd?, effort? (low|medium|high|xhigh|max) — project_path wird via REST automatisch aus dem Daemon-Kontext ermittelt',
        example: 'specialist({ action: "spawn", project: "synapse", name: "doc-bot", model: "haiku", expertise: "Doku", task: "Schreibe README" })',
        tips: 'Web-KI: Job laeuft via Queue, Antwort innerhalb 60s. Bei Timeout pruefe ob Daemon laeuft.',
      },
      spawn_batch: {
        description: 'Mehrere Spezialisten atomar in einem Call starten (1..10).',
        params: 'project (req), specialists (req, Array von { name, model, expertise, task, channel?, allowed_tools?, keep_alive?, effort? }), project_path? — auto-resolved via REST',
        example: 'specialist({ action: "spawn_batch", project: "synapse", specialists: [{ name: "a", model: "haiku", expertise: "X", task: "..." }, { name: "b", model: "haiku", expertise: "Y", task: "..." }] })',
        tips: 'Sequenziell (nicht parallel) — wegen Resource-Limits + Socket-Wait.',
      },
      stop: {
        description: 'Spezialisten anhalten (Wrapper-Prozess beenden). FS + DB-Eintraege bleiben.',
        params: 'project (req), name (req, String oder Array fuer Batch), project_path? — auto-resolved via REST',
        example: 'specialist({ action: "stop", project: "synapse", name: "doc-bot" })',
        tips: 'Bei keep_alive: true respawnt der Wrapper automatisch — fuer endgueltiges Entfernen "purge" nutzen.',
      },
      purge: {
        description: 'Spezialisten KOMPLETT entfernen: stop + Channel-Memberships + Chat-Session + status.json + FS-Verzeichnis. Auto-Respawn unmoeglich.',
        params: 'project (req), name (req, String oder Array fuer Batch), project_path? — auto-resolved via REST',
        example: 'specialist({ action: "purge", project: "synapse", name: "doc-bot" })',
        tips: 'Bevorzugt vor stop wenn der Spezialist nicht mehr gebraucht wird — sonst kostet er Heartbeat-Token.',
      },
      selbst: {
        description: 'Selbstauskunft eines Spezialisten — NUR aus DB/Registry, nichts geschaetzt: model, model_full_id, effort (tatsaechlich gestartete Stufe aus wrapper_status), effort_stufen + default_effort + context_window (model_registry), tokens {input, output, prozent, kontext_obergrenze}, schwellen {handoff_tokens, rotation_tokens, hart_tokens} (berechneKontextSchwellen), cutoff_date (model_cutoffs), channels, current_task, status. keep_alive steht nicht in der DB und kommt als null mit Hinweis.',
        params: 'agent_id (req, eigener Name), project (optional; ohne project eindeutig ueber den Namen, sonst Fehler mit den Projekten)',
        example: 'specialist({ action: "selbst", agent_id: "doc-bot", project: "synapse" })',
        tips: 'Spezialisten sollen ihre Modelldaten NICHT schaetzen, sondern hier abrufen (steht auch im Spezialisten-Prompt). Fehlt ein Wert, steht null + Eintrag in hinweise.',
      },
      wake: {
        description: 'Eine Nachricht an einen laufenden Spezialisten schicken (synchroner RPC).',
        params: 'name (req, String oder Array), message (req)',
        example: 'specialist({ action: "wake", name: "doc-bot", message: "Status?" })',
        tips: 'Wenn Spezialist busy: Auto-Fallback in seine Inbox (wird beim naechsten Heartbeat verarbeitet).',
      },
      update_skill: {
        description: 'SKILL.md eines Spezialisten editieren (regeln/fehler/patterns/context).',
        params: 'project (req), name (req), file (rules|errors|patterns|context), skill_action (add|remove), content (req), project_path? — auto-resolved via REST',
        example: 'specialist({ action: "update_skill", project: "synapse", name: "doc-bot", file: "rules", skill_action: "add", content: "Niemals .md Dateien erstellen" })',
      },
      status: {
        description: 'Live-Wrapper-Status (PID, Socket-Health, busy/idle, currentTask) — der Watcher pflegt das in status.json auf dem Ziel-PC, REST hat darauf aktuell keinen Zugriff. Lokal: voll verfuegbar. Web-KI: Stub-Antwort; Workaround = Spawn-Response (PID+Socket) merken oder Status via Channel-Post abfragen.',
        params: 'project (req), name (optional; String, Array oder "a,b" — genannte Namen werden immer gezeigt), alle (optional; ohne name: auch Leichen). Ohne name sind Eintraege mit last_activity > 24 h (Env SYNAPSE_STATUS_VERALTET_H) ausgeblendet; die Antwort nennt ausgeblendet/ausgeblendet_namen. verwaist:true + inaktiv_seit kennzeichnet Leichen. Kein purge ohne Rueckfrage des Users.',
        example: 'specialist({ action: "status", project: "synapse", name: ["doc-bot", "review-bot"] })',
      },
      capabilities: {
        description: 'Aggregat-Sicht der registrierten Daemons + aktiven Wrapper aus PG (projects + wrapper_status). REST-Antwort: { daemons, wrappers: { total, active, byProviderModel }, features.providers }. Lokaler MCP zeigt zusaetzlich die installierte Claude-CLI-Version vom Filesystem. Wenn spawn fehlschlaegt: error_code interpretieren (siehe summary).',
        params: '—',
        example: 'specialist({ action: "capabilities" })',
      },
    },
  },

  // -------------------------------------------------------------------------
  // workspace — Docker-Sandbox-Lifecycle (pro Projekt, Rollen + benannte Instanzen)
  // -------------------------------------------------------------------------
  workspace: {
    summary: 'Lifecycle der pro-Projekt Docker-Sandbox-Container auf der synapse-api. NUR Lifecycle (list/start/stop/pin/unpin/configure/materialize/reset_home) — fuer Shell-Ausfuehrung IMMER shell (Auto-Routing bzw. isolated:true). Benannte Workspaces pro Projekt (Param name, Default "main"; Cap via ENV SYNAPSE_WS_PER_PROJECT_CAP, Default 6); WS4-ROLLEN: Rolle = editierbares Template (role_set/role_list/role_delete; project weglassen = global, projekt-scoped schlaegt global), Workspace = Instanz — jede Rolle ist beliebig oft instanziierbar (start/exec mit role + frei waehlbarem name: db-1, db-2, app, qa), init_command laeuft nach JEDEM Container-Start (Dienste-Bootstrap, Fehler -> last_error); /workspace (Source, read-only) ist geteilt, Home-Volume pro Workspace. WS5-CONTAINER-BUILDS: Rolle container-builder (Image synapse-workspace-podman:latest) baut/testet Dockerfiles + docker-compose der User-Projekte mit rootless Podman (docker = podman-Alias, daemonless, Storage im HOME-Volume); devices/security_opts am Rollen-Template wirken NUR wenn die Rolle in ENV SYNAPSE_WS_PRIVILEGED_ROLES allowlisted ist — sonst verweigert der Orchestrator den Start hart. Kein --privileged, kein docker.sock — existiert bewusst nicht. Container entstehen LAZY beim ersten Bedarf — nichts manuell vorstarten. Workspaces sind reine TEST-Sandboxen.',
    when_to_use: 'Container-Status pruefen (list). Ressourcen anpassen (configure: cpu/mem/pids/tmpfs/image — greift beim naechsten Start). Vor Idle-Eviction schuetzen (pin). Kaputtes Home heilen (reset_home). Build-Pfad unter /workspace zum Schreiben freigeben: make_writable mit path (z.B. compiler/target oder build) — noetig weil der PG-Sync Source-Files als root/0444 anlegt, das /workspace-Volume selbst ist rw; fuer Build-Artefakte gedacht, Source-Edits weiter via files-Tool. Integrationstests zwischen Containern via proxynet-DNS http://synapse-ws-<projekt>[-<name>]:<port>. Rollen-Templates pflegen (role_set/role_list/role_delete) und Multi-Geraete-Setups bauen: db-1 (role db-postgres) + app (role server) + qa (role wine-qa) verhalten sich wie 3 Geraete im selben Netz — zweite DB? name db-2, gleiche Rolle.',
    when_not_to_use: 'Shell-Kommandos ausfuehren — nutze shell (die exec-Action hier ist deprecated). Dateien schreiben — nutze files (Auto-Sync in den Container). Dauerbetrieb — Idle-Stop nach 10 Min und LRU-Eviction sind gewollt.',
    param_tips: 'name: Ziel-Workspace (Default main; main behaelt den DNS-Namen ohne Suffix). configure wirkt erst beim naechsten Container-Start. Jede Antwort liefert dns_name — IMMER den DNS-Namen nutzen, NIE die Container-IP (wechselt bei Restart). role: wirkt nur bei ERST-Anlage einer Instanz (Template-Werte werden in die Row kopiert; danach configure nutzen); Template-Edits wirken ab dem naechsten Container-Start der Instanzen.',
    examples: [
      'workspace({ action: "list" })',
      'workspace({ action: "role_list" })',
      'workspace({ action: "exec", project: "synapse", name: "db-1", role: "db-postgres", command: "pg_isready -h /tmp" })',
      'workspace({ action: "configure", project: "synapse", mem_limit_mb: 2048, tmpfs_mb: 1024 })',
      'workspace({ action: "pin", project: "synapse", name: "server" })',
    ],
    anti_patterns: [
      'workspace(exec) statt shell({ isolated: true }) — gleiche Engine, aber shell hat einheitliches Antwortformat + executed_via.',
      'Container manuell vorstarten "damit er bereit ist" — Lazy-Start macht das automatisch.',
      'Container-IPs verdrahten — nach jedem Restart ungueltig, dns_name verwenden.',
      'Eine Rolle als festen Slot behandeln — Rollen sind Templates: dieselbe Rolle mehrfach instanziieren (db-1, db-2) ist der Normalfall.',
    ],
  },

  // -------------------------------------------------------------------------
  // files_batch — Alias fuer files(plan/commit/...) gegen Client-Schema-Caching
  // -------------------------------------------------------------------------
  files_batch: {
    summary: 'Identische Implementierung wie files fuer Multi-File-Edits und reservation_add/release/update/list — als eigenes Tool exponiert, weil manche MCP-Clients die action-Enum von files cachen. Funktional gilt ALLES aus guide({ tool_name: "files" }).',
    when_to_use: 'Wenn files(action: "plan") oder eine reservation_*-Action vom Client wegen Schema-Cache abgelehnt wird. Atomare Edits: plan → commit; Reservierungen sind in CE-1 reine Buchfuehrung.',
    when_not_to_use: 'Einzeldatei-Edits — direkt files(update/search_replace). Reines Lesen — files(read) oder code_intel.',
    param_tips: 'ops[]: 1..10.000 Operationen (praktisch unbegrenzt), jede mit eigenem file_path + action. anchor_text/anchor_contains pro Op = Drift-Schutz. ACHTUNG: history hier hat dieselbe agent_id-FILTER-Falle wie files(history) — fuer volle Projekt-History agent_id weglassen.',
    examples: [
      'files_batch({ action: "plan", project: "synapse", auto_commit: true, reason: "Refactor X", ops: [{ file_path: "a.ts", action: "search_replace", search: "alt", replace: "neu" }] })',
    ],
  },

  // -------------------------------------------------------------------------
  // skills — Skill-Bibliothek (Qdrant, EXPERIMENTAL)
  // -------------------------------------------------------------------------
  skills: {
    summary: 'EXPERIMENTAL: Lese-Zugriff auf die projektuebergreifende Skill-Datenbank (Best-Practice-Chunks). Actions: search (semantisch, optional skill_name-Filter), list (Skill-Namen + Section-Counts), get_section, get_full (alle Sections eines Skills). Signatur kann sich bei der geplanten Umstrukturierung aendern.',
    when_to_use: 'Session-Start: search("<projekt>-nutzung") — gibt es einen Skill zum Projekt/Workflow? Vor unbekannten Workflows: get_full("<skill>") fuer Regeln + Pitfalls.',
    when_not_to_use: 'Projektspezifisches Wissen — liegt in memory. Code-Suche — code_intel.',
    param_tips: 'search: limit Default 5 (Max 20). skill_name bei get_section/get_full Pflicht. KEIN project-Parameter — die Skill-DB ist global.',
    examples: [
      'skills({ action: "search", query: "synapse-nutzung onboarding" })',
      'skills({ action: "get_full", skill_name: "synapse-agent-regeln" })',
    ],
  },

  watcher: {
    summary: 'FileWatcher-Daemon-Steuerung (start/stop/status) — der Watcher laeuft lokal auf dem Ziel-PC und synct PG <-> Filesystem. Nur ueber lokalen MCP-Server steuerbar (REST hat keine FS-Zugriffe, kann den Daemon nicht erreichen). Sind Watcher und shell-Worker auf dem Ziel-PC NICHT aktiv, kommen Datei-Edits und shell-Jobs aus REST nicht durch.',
    when_to_use: 'Daemon-Status pruefen / starten / stoppen, wenn man auf dem Ziel-PC sitzt. Sync-Probleme debuggen. Indirekt geht status auch ueber project(action: "status").',
    when_not_to_use: 'Aus REST/Web-KI — wird mit Fehler abgewiesen. Fuer normale Datei-Edits → files (Watcher synct automatisch wenn er laeuft).',
  },

  // -------------------------------------------------------------------------
  // jev — Jev entscheidet Rueckfragen, wenn der User nicht da ist (P7-T28 / JEV-10)
  // -------------------------------------------------------------------------
  jev: {
    summary: 'Jev beantwortet ERLAUBTE Rueckfragen (ja/nein, Auswahl, Skala), wenn der User nicht da ist. Ein Schalter je Projekt (nur der Koordinator setzt ihn, auf Zuruf des Users: "ich bin weg" = an, "bin wieder da" = aus). Die Kette bleibt Agent → Koordinator → User; bei aktivem Schalter springt Jev fuer den User ein, jede Entscheidung wird protokolliert und ist mit "entschieden von Jev (Confidence x), nicht vom User" gekennzeichnet.',
    when_to_use: [
      'Du (Agent) willst den User etwas fragen — Variante A oder B, Reihenfolge, Umsetzungsweg, Formulierung — und er ist nicht da (Nacht, Loop).',
      'Erst abwesend(modus:"status") pruefen oder auf den Hinweis "User abwesend — Jev entscheidet ..." im Onboarding/plan(list) achten.',
      'Koordinator: Schalter setzen (abwesend an/aus; project "*" = alle Projekte), Protokoll zeigen (protokoll), Fehlentscheidungen markieren (ueberstimmen), autonome Entscheidungen durchsehen (durchsicht; ohne Praezedenz zuerst).',
      'ENTSCHEIDUNGS-TOPF (P15 E1): Jede Antwort des Users auf eine Rueckfrage legt der Koordinator mit entscheidung_ablegen ab (Wortlaut + Aufbereitung de/en mit gilt_wenn) — oder als thought mit Tags entscheidung+user (wird automatisch roh erfasst, dann entscheidung_aufbereiten). Global gueltig als Vorlage. Bei aktiver Jev-Funktion entscheidungstopf nutzt entscheiden diese Eintraege als Praezedenz (Tor 0.8, danach Option Tor 0.7); ohne Praezedenz waehlt Jev trotzdem (Option entscheidung_ohne_praezedenz, Standard an), markiert ohne_praezedenz. Autonome Entscheidungen werden nie selbst Praezedenz. Keine Claude-Code-Hooks.',
    ].join(' '),
    when_not_to_use: [
      'JEV ABGESCHALTET (admin jev_schalten, global/Projekt/Funktion tool oder entscheidung, oder Budget-Pause): das Tool antwortet mit error jev_aus bzw. entscheiden mit grund jev_aus, es gibt keinen Jev-Aufruf, keine Protokollzeile und keine Hinweise jev_modus/jev_hinweis/jev_entscheidet. Bei global aus fehlt das Tool ganz in der Tool-Liste. Stand: admin(action:"jev_status").',
      'Schalter aus = User ist da: dann gar nicht aufrufen (entscheiden macht keinen Jev-Aufruf, antwortet nur "User/Koordinator fragen" und schreibt keine Protokollzeile).',
      'Verbotene Kategorien: loeschen, deploy, git, secrets, aussenwirkung, kosten, regeln, live_db, schema — die entscheidet nie Jev, der Server lehnt sie ab; unbekannte Kategorien ebenso. Zusaetzlich prueft der Server den TEXT (Frage, Kontext, Optionen) auf Push, Deploy, Loeschen, Live-DB, Schema, Secrets, Kosten, Aussenwirkung, Regeln (grund sicherheit_text) und fragt Jev, ob die Antwort eine irreversible Aktion ausloest (grund sicherheit_irreversibel) — beides heisst: nie autonom.',
      'Nicht umkehrbare oder folgenreiche Entscheidungen — dort auf den User warten.',
    ].join(' '),
    param_tips: [
      'entscheiden: kategorie ist PFLICHT (erlaubt: variante, reihenfolge, umsetzungsweg, formulierung). typ noul = ja/nein, choice = Auswahl (optionen {key: Beschreibung}: IMMER genau 5 = 4 echte + Schluessel "weitere"; mit letzte_runde:true 2..5 echte ohne weitere), score = Skala (Standard 1..5).',
      'Unter Confidence 0.7 (Env JEV_ENTSCHEIDUNG_TOR, oder confidence_tor) gibt es KEINE Entscheidung — warte dann auf User/Koordinator.',
      'Ratenbremse: 30 Jev-Aufrufe je Stunde und Projekt (Env JEV_ENTSCHEIDUNG_RATE), danach Ablehnung.',
      'abwesend an/aus: nur agent_id koordinator (Namenstreue, keine Identitaetspruefung). bis oder stunden sind freiwillig; ohne beides laeuft der Schalter bis "aus". aus liefert das Protokoll seit dem Einschalten mit.',
      'FELD jev_modus: Solange der Schalter des Projekts AN ist, traegt JEDE Tool-Antwort dieses Projekts (ausser guide und jev selbst) die Zeile jev_modus. Bei AUS fehlt das Feld. Der Schalter wird je Prozess bis zu 30 s gecacht (Env JEV_MODUS_CACHE_S), Ein-/Ausschalten wirkt also mit kurzer Verzoegerung. Bedeutung der Zeile: (1) Rueckfragen und Unstimmigkeiten mit Superpowers klaeren — skills(action:get_section) auf die Superpowers-Skills brainstorming, systematic-debugging, verification-before-completion; (2) Entscheidungen ueber jev(action:entscheiden), nur erlaubte Kategorien (variante, reihenfolge, umsetzungsweg, formulierung); (3) verbotene Kategorien (loeschen, deploy, git, secrets, aussenwirkung, kosten, regeln) und jede Entscheidung unter Confidence 0.7 warten weiter auf den User/Koordinator; (4) jede Jev-Entscheidung ist als "entschieden von Jev, nicht vom User" zu kennzeichnen.',
    ].join('\n'),
    examples: [
      'jev({ action: "abwesend", project: "synapse", modus: "status" })',
      'jev({ action: "entscheiden", project: "synapse", agent_id: "plan-specht", kategorie: "variante", typ: "choice", frage: "Variante A oder B?", optionen: { a: "kleiner Umbau", b: "neuer Service" } })',
    ],
    anti_patterns: [
      'entscheiden fuer loeschen/deploy/git/secrets/kosten/regeln — wird abgelehnt und protokolliert.',
      'Bei Confidence unter 0.7 trotzdem weitermachen — dann auf den User warten.',
      'Den Schalter als Nicht-Koordinator setzen — abgelehnt.',
      'Eine Jev-Entscheidung als Wunsch des Users ausgeben — sie ist immer als "entschieden von Jev" zu kennzeichnen.',
      'Jev eine offene Frage stellen ("Wie soll ich das bauen?") — Jev BEANTWORTET KEINE FRAGEN, es waehlt nur mit Wahrscheinlichkeit zwischen vorgegebenen Optionen. Ohne gute Formulierung kommt nur "unsicher" zurueck.',
    ],
    workflow_examples: [
      'Vorgehen Schritt fuer Schritt (auf diesen Abschnitt verweist die Zeile jev_modus und jede Ablehnung von entscheiden):',
      '1. Offene Frage -> mit Superpowers (skills get_section superpowers-brainstorming bzw. superpowers-writing-plans) 4 konkrete, sich ausschliessende Optionen erarbeiten.',
      '2. Je Option in optionen {key: Beschreibung} schreiben, WANN sie richtig ist (Bedingung/Kriterium), nicht nur ihren Namen — Jev bewertet die Beschreibungen gegen den kontext. Bei choice IMMER genau 5 Optionen: die 4 echten plus die fuenfte mit dem festen Schluessel "weitere" ("keine der vier passt gut genug, es gibt bessere Moeglichkeiten"); ihre Beschreibung setzt der Server. Server lehnt leere, Ein-Wort- und nur-Key-Beschreibungen ab.',
      '3. typ waehlen: choice (Auswahl) ist der Normalfall; noul nur fuer eine klare AUSSAGE, die wahr oder falsch ist ("Die Aenderung bricht keine alten Aufrufe."), nie fuer eine W-Frage; score nur mit Ankern je Stufe (optionen {"1": Anker, ...}).',
      '4. kontext nach der Vorlage "Was Jev bekommt" (kurz, keine Frage an Jev): (i) die Task in 2-3 Saetzen; (ii) Projektfakten + Tech-Stack in einer Zeile; (iii) die Unstimmigkeit — geplant vs. gefunden, mit Beleg; (iv) geltende Randbedingungen; (v) bereits Versuchtes/Verworfenes. Kein Code, keine langen Logs.',
      '5. kategorie korrekt setzen (erlaubt: variante, reihenfolge, umsetzungsweg, formulierung; alles andere gehoert dem User).',
      '6. Ergebnis pruefen: Confidence >= 0.7 (entschieden:true) -> umsetzen und im Channel als "entschieden von Jev (Confidence x)" melden. Waehlt Jev "weitere" (weiter:true, keine Entscheidung): 4 NEUE Optionen erarbeiten (nicht aus verworfen) und erneut fragen mit runde+1, verworfen = die bisherigen 4 echten Optionen ([{key, beschreibung}]) und erste_id = protokoll_id der ersten Antwort — so haengt das Protokoll die Runden zusammen. Unter dem Tor (grund unsicher, Feld tipp): Optionen EINMAL schaerfen (Beschreibungen trennschaerfer, Kontext ergaenzen) und erneut fragen.',
      'RUNDEN: hoechstens 4 (Env JEV_MAX_RUNDEN); die Grenzrunde ist die letzte und geht nur mit letzte_runde:true, darueber lehnt der Server mit max_runden ab. Faellt dir nichts Neues ein: letzte_runde:true mit 2 bis 5 der besten bisherigen Optionen, OHNE "weitere".',
      'SCHLUSS der Kette — Jev bleibt in der letzten Runde unsicher, max_runden ist erreicht oder es erscheint keine Option plausibel (keine_plausible_option:true meldet das ohne Jev-Aufruf): KEIN Warten, die Frage steht als offen_fuer_user im Protokoll (beim "bin wieder da" oben). (a) KEIN Blocker (Standard, es gibt andere passende Tasks): Notiz an den User ist im Protokoll; Task auf todo zuruecksetzen (plan update_task) mit kurzer Notiz in der Beschreibung bzw. als Thought mit task_id; dann mit einer ANDEREN passenden Task weitermachen (plan passende_tasks). (b) KOMPLETTER Blocker (keine andere passende Task oder alle haengen an dieser Entscheidung): blocker:true beim letzten Aufruf; Einsprung ist der KOORDINATOR — Frage im Channel an den Koordinator + cc-send; er entscheidet oder sammelt es fuer den User. Die Protokollzeile traegt blocker:true.',
      'GUTES BEISPIEL (Runde 1, 4 echte Optionen + weitere): jev({ action: "entscheiden", project: "synapse", agent_id: "plan-specht", kategorie: "umsetzungsweg", typ: "choice", frage: "Wie binden wir den Hinweis ein?", kontext: "Task: Hinweis an jede Tool-Antwort. Projekt: 3000 Dateien, TypeScript/Node/PostgreSQL. Geplant: ein Hook; gefunden: zwei Einhaengestellen (REST, stdio) mit Ausnahmen. Randbedingung: keine neue Tabelle. Versucht: nichts.", optionen: { hook: "Im bestehenden Response-Hook mitgeben: richtig, wenn der Hinweis an JEDER Antwort haengen soll und keine neue Stelle entstehen darf", tool: "Als eigenes Tool abrufbar machen: richtig, wenn der Hinweis nur auf Nachfrage gelesen werden soll", header: "Als Header der Antwort: richtig, wenn Clients Zusatzfelder im Body verwerfen", regel: "Als Projekt-Regel: richtig, wenn der Hinweis nur in einem Projekt gelten soll", weitere: "(Text setzt der Server)" } })',
      'SCHLECHTES BEISPIEL: jev({ action: "entscheiden", ..., typ: "choice", frage: "Wie soll ich das machen?", optionen: { a: "so", b: "anders" } }) — offene Frage, nur 2 Optionen ohne "weitere", Beschreibungen ohne Bedingung, kein kontext: Server lehnt ab bzw. Jev bleibt unsicher.',
    ],

    actions: {
      entscheiden: {
        description: 'Beantwortet eine erlaubte Rueckfrage per Jev — nur bei aktivem Schalter. Antwort enthaelt wahl, confidence, entschieden (true/false), Kennzeichnung "entschieden von Jev (Confidence x), nicht vom User" und protokoll_id.',
        params: 'project (req), agent_id (req), frage (req, max 500 Zeichen), kategorie (req), typ (noul|choice|score), optionen ({key: Beschreibung}, choice: genau 5 inkl. weitere), kontext (max 1500 Zeichen), task_id, hinweise (max 500 Zeichen), confidence_tor (0..1, Standard 0.7); Runden: runde (Start 1), verworfen ([{key, beschreibung}]), erste_id (ab Runde 2 Pflicht), letzte_runde (bool), keine_plausible_option (bool), blocker (bool)',
        example: 'jev({ action: "entscheiden", project: "synapse", agent_id: "plan-specht", kategorie: "umsetzungsweg", typ: "noul", frage: "Test zuerst schreiben?" })',
        tips: 'VORHER den Abschnitt "Vorgehen Schritt fuer Schritt" (workflow_examples) lesen: Jev beantwortet keine Fragen, es waehlt nur zwischen Optionen; Beschreibungen muessen sagen, WANN die Option richtig ist. Unsicher-Antworten tragen das Feld tipp. Schalter aus → kein Jev-Aufruf, keine Protokollzeile, Antwort "User/Koordinator fragen". Verbotene/unbekannte Kategorie, Ratenbremse, fehlender Key und Confidence unter 0.7 werden mit entschieden:false protokolliert (bei aktivem Schalter).',
      },
      abwesend: {
        description: 'Schalter "User abwesend" je Projekt anzeigen (status, jeder) oder setzen (an/aus, nur Koordinator).',
        params: 'project (req), modus (req: an|aus|status), agent_id (req fuer an/aus: koordinator), bis (ISO-Zeitpunkt in der Zukunft, freiwillig), stunden (Alternative zu bis)',
        example: 'jev({ action: "abwesend", project: "synapse", modus: "an", agent_id: "koordinator" })',
        tips: 'Ein abgelaufenes bis gilt als aus. Bei aktivem Schalter tragen plan(list) und das Onboarding (Feld jev_hinweis) den Hinweis "User abwesend — Jev entscheidet erlaubte Rueckfragen". aus liefert das Protokoll seit dem Einschalten.',
      },
      protokoll: {
        description: 'Jev-Entscheidungen seit Schalter-Beginn (auch abgelehnte/unsichere Versuche).',
        params: 'project (req), seit (ISO, Standard = Beginn des Schalters), nur_entschieden (bool), limit (Standard 50, max 200)',
        example: 'jev({ action: "protokoll", project: "synapse", nur_entschieden: true })',
      },
      ueberstimmen: {
        description: 'Koordinator markiert eine Jev-Entscheidung als ueberstimmt (Korrektur des Users). Daraus koennen jev-erkenntnis-Memories werden.',
        params: 'project (req), id (req, Protokoll-Nummer), wahl (req, die richtige Entscheidung), agent_id (req: koordinator), notiz',
        example: 'jev({ action: "ueberstimmen", project: "synapse", id: 3, wahl: "b", notiz: "User wollte B", agent_id: "koordinator" })',
      },
      entscheidung_ablegen: {
        description: 'P15 E1: User-Entscheidung in den Entscheidungs-Topf legen (global, Vorlage fuer Jev). Mit Aufbereitung in allen gepflegten Sprachen (jev_optionen) direkt aktiv, sonst roh. Nur Koordinator/User.',
        params: 'project (req), agent_id (req: koordinator|user), frage_de|frage_en (req), antwort_wortlaut (req, Original), kategorie (req), optionen ({key: Beschreibung}), gewaehlte_option, aufbereitet ({de:{entscheidung,begruendung,gilt_wenn}, en:{decision,reason,applies_when}}), themen, kandidat',
        example: 'jev({ action: "entscheidung_ablegen", project: "synapse", agent_id: "koordinator", frage_de: "Ausgabeformat?", kategorie: "variante", antwort_wortlaut: "JSON", gewaehlte_option: "a", aufbereitet: { de: { entscheidung: "JSON", begruendung: "maschinenlesbar", gilt_wenn: "Richtig, wenn ..." }, en: { decision: "JSON", reason: "machine readable", applies_when: "Correct when ..." } } })',
        tips: 'gilt_wenn/applies_when ist das Kriterium, an dem Jev erkennt, ob die Entscheidung eine neue Frage regelt: die BEDINGUNG ausschreiben, nicht das Thema. Verbotene Kategorien werden gespeichert, sind aber nie Praezedenz.',
      },
      entscheidung_aufbereiten: {
        description: 'P15 E1: Topf-Eintrag ergaenzen und aktivieren (roh -> aktiv) oder stilllegen/ersetzen. Nur Koordinator/User.',
        params: 'project (req), agent_id (req), eintrag_id (req, UUID oder eindeutiger Praefix ab 8 Zeichen), aufbereitet, frage_de, frage_en, optionen, gewaehlte_option, kategorie, themen, kandidat, status (aktiv Standard | stillgelegt | ersetzt), status_grund, ersetzt_durch',
        example: 'jev({ action: "entscheidung_aufbereiten", project: "synapse", agent_id: "koordinator", eintrag_id: "<uuid>", kategorie: "umsetzungsweg", aufbereitet: { de: {...}, en: {...} } })',
      },
      topf: {
        description: 'Beide globalen Toepfe: Standard nur IDs, kurze Vorschau und Anzahl; Volltext per eintrag_id (UUID oder eindeutiger Praefix ab 8 Zeichen; mehrdeutig liefert Kandidaten). Nur eine ausdrueckliche frage startet den kostenpflichtigen Bedeutungsvergleich per Jev: hoechster Prozentwert bestimmt die ID des besten Treffers.',
        params: 'project (req), topf (entscheidung Standard | erklaerung), eintrag_id oder frage, schwelle (0..100, Standard 80), vollstaendig (bester Eintrag zusaetzlich), status, kategorie, herkunft',
        example: 'jev({ action: "topf", project: "synapse", herkunft: "seed" })',
      },
      durchsicht: {
        description: 'P15 E1: autonome Jev-Entscheidungen durchsehen. Ohne urteil: offene Liste (ohne Praezedenz zuerst). urteil ok = bestaetigt; korrigieren = ueberstimmt + neuer Topf-Eintrag herkunft korrektur mit dem Wortlaut des Users.',
        params: 'project (req, "*" = alle), agent_id (req fuer urteil: koordinator|user), id (Protokoll-Nummer), urteil (ok|korrigieren), wahl (bei korrigieren), wortlaut, notiz, aufbereitet, seit',
        example: 'jev({ action: "durchsicht", project: "synapse", agent_id: "koordinator", id: 12, urteil: "korrigieren", wahl: "b", wortlaut: "B war gemeint" })',
        tips: 'Folgen einer falschen Entscheidung ueber files history/restore zuruecknehmen (regel-rueckbau-ueber-files-restore).',
      },
    },
  },

  // -------------------------------------------------------------------------
  // asset_intel — Struktur-Index fuer Nicht-Quellcode-Dateien (P4-T67/T70)
  // -------------------------------------------------------------------------
  asset_intel: {
    summary: 'Struktur-Index fuer Dateien, die KEIN Quellcode sind: Bilder, Texturen, 3D-Modelle, Audio/Video, Archive, Executables, Unreal-Pakete, DCC-Dateien (blend, fbx ...). Liefert abgeleitete Daten der lokalen Inspektion — Metadaten, Objekte (Meshes, Materialien, Exporte ...) und Verweise zwischen Dateien. Nur lesend, ohne Embeddings, auf REST und lokal (stdio) mit DERSELBEN Definition und demselben Dispatcher.',
    when_to_use: 'Fragen zu Assets: Welche Texturen nutzt dieses Modell (references)? Wer benutzt diese Textur (used_by)? Was bricht, wenn ich sie verschiebe (move_preview)? Welche Verweise zeigen ins Leere (missing)? Welche Bilder sind groesser als 4096 px (search mit Filter)? Wie haengen Dateien zusammen (graph)?',
    when_not_to_use: 'Fuer Quellcode und Textdateien -> code_intel (file, functions, search). asset_intel kennt nur, was der LOKALE Watcher inspiziert hat: laeuft er nicht, ist der Index leer (health zeigt das). Verweise AUS Quellcode (z. B. "assets/x.png" in einer .ts-Datei) sind hier nicht enthalten.',
    param_tips: [
      'file_path ist projekt-relativ wie in code_intel. Mehrdeutige Kurzpfade -> Fehler pfad_mehrdeutig mit kandidaten.',
      'where (objects, search): "<asset_type|kind>.<schluessel><op><wert>", op = != > >= < <= ~ (~ = enthaelt), max 5. Zahlvergleich greift nur, wenn der Wert eine Zahl ist ("4096" als Text zaehlt nicht). Beispiele: image.width>=4096, mesh.triangles>1000.',
      'search-Kurzform in query: "format:png type:image image.width>=4096 rock".',
      'inspect: limit gilt fuer Objekte UND Verweise, offset nur fuer Objekte.',
      'Unbekannte Parameter werden abgewiesen (nicht still verworfen); Parameter, die fuer die action keine Wirkung haben, stehen in nicht_verwendet.',
      'Jede Liste traegt total + gekappt; Antworten sind auf 60.000 Zeichen begrenzt.',
    ].join('\n'),
    examples: [
      'asset_intel({ action: "health", project: "synapse" })',
      'asset_intel({ action: "used_by", project: "synapse", file_path: "textures/rock.png" })',
      'asset_intel({ action: "search", project: "synapse", query: "format:png image.width>=4096" })',
    ],
    anti_patterns: [
      'Quellcode ueber asset_intel lesen wollen — Fehler datei_nicht_im_asset_index, richtig ist code_intel(file).',
      'objects ohne object_type — Fehler object_type_fehlt; die Antwort nennt die vorhandenen Arten.',
      'graph mit depth 10 auf einem grossen Projekt ohne limit — wird gekappt; erst depth 2-3.',
      'search mit einem Begriff, der in fast jedem Pfad/Verweis steht (z. B. "Content", "/Game/") — liefert zwar (gemessen < 0,5 s bei 750.000 Verweisen), aber Tausende Treffer; mit format, asset_type oder where einengen.',
    ],
    actions: {
      tree: { description: 'Asset-Baum als Text (Format, Groesse, Objekte, Verweise, Status je Datei).', params: 'path, depth, recursive, format, asset_type, status, limit (Standard 500)', example: 'asset_intel({ action: "tree", project: "synapse", path: "Content/Props" })' },
      inspect: { description: 'Eine Datei: Metadaten, Warnungen, Objekte und Verweise seitenweise, Totale.', params: 'file_path (req), object_type, offset, limit', example: 'asset_intel({ action: "inspect", project: "synapse", file_path: "models/crate.gltf", limit: 20 })' },
      objects: { description: 'Objekte einer Art projektweit, optional gefiltert.', params: 'object_type (req), file_path, name, where, limit, offset', example: 'asset_intel({ action: "objects", project: "synapse", object_type: "mesh", where: ["mesh.triangles>1000"] })' },
      references: { description: 'Ausgehende Verweise einer Datei mit Aufloesung (datei, fehlt, intern, extern, eingebettet, ausserhalb, unbekannt).', params: 'file_path (req), kind, limit', example: 'asset_intel({ action: "references", project: "synapse", file_path: "models/crate.gltf" })' },
      used_by: { description: 'Wer verweist auf diese Datei. include_name_matches liefert zusaetzlich Verweise mit gleichem Dateinamen, anderem Pfad (getrennt).', params: 'file_path (req), kind, limit, include_name_matches', example: 'asset_intel({ action: "used_by", project: "synapse", file_path: "textures/rock.png" })' },
      missing: { description: 'Verweise ins Leere (aufloesung fehlt), projektweit oder fuer eine Datei.', params: 'file_path, kind, limit' },
      graph: { description: 'Abhaengigkeiten ab einer Datei: down = worauf sie verweist, up = wer auf sie verweist. Zyklen werden markiert.', params: 'file_path (req), direction (down|up), depth (1..10, Standard 3), limit', example: 'asset_intel({ action: "graph", project: "synapse", file_path: "scenes/level.gltf", depth: 2 })' },
      roots: { description: 'Dateien ohne eingehende, aber mit ausgehenden Verweisen.', params: 'format, asset_type, limit' },
      orphans: { description: 'Dateien ganz ohne Verweise (weder ein- noch ausgehend).', params: 'format, asset_type, limit' },
      search: { description: 'Lexikalische Suche ueber Pfad, Objektnamen und Verweisziele, mit Filtern; Treffer je Datei mit Fundstelle.', params: 'query (req), where, format, asset_type, limit', example: 'asset_intel({ action: "search", project: "synapse", query: "crate format:gltf" })' },
      search_batch: { description: 'Bis zu 10 Suchen in einem Aufruf. Eine Suche mit ungueltigem Filter liefert ihren eigenen Fehler, die anderen laufen weiter. Das Zeitlimit (10 s) gilt je Suche: eine abgebrochene liefert fuer sich zeitlimit:true, treffer:[] und einen Hinweis, die anderen laufen normal.', params: 'queries (req, 1..10), limit' },
      move_preview: { description: 'Was bricht beim Verschieben: eingehende und ausgehende Verweise mit Vorschlag fuer das neue target. Schreibt nichts.', params: 'file_path (req), new_path (req)', example: 'asset_intel({ action: "move_preview", project: "synapse", file_path: "tex/a.png", new_path: "textures/a.png" })' },
      health: { description: 'Zustand des Index: Dateien je Status/Format/Typ, Formate ohne Inspektor, veraltete Inspektor-Versionen, fehlende Quellen. Mit file_path: eine Zeile samt Warnungen.', params: 'file_path' },
    },
  },

  // -------------------------------------------------------------------------
  // intern — Debugging/Steuerung interner Ablaeufe (P14), nur bei SYNAPSE_INTERN_TOOL=1
  // -------------------------------------------------------------------------
  intern: {
    summary: 'Steuert und zeigt interne Synapse-Ablaeufe (Embedding, Parser-Worker, Context7-Automatik, Ollama) ohne SQL und ohne Neustart. Das Tool existiert NUR, wenn die API mit SYNAPSE_INTERN_TOOL=1 gestartet wurde; sonst fehlt es in der Tool-Liste und jeder Aufruf wird abgelehnt (intern_tool_aus).',
    when_to_use: 'Vor Messungen oder Eingriffen, die keine Nebenlast vertragen: Embeddings im Hintergrund anhalten, Parser-Worker oder Context7-Automatik pausieren, danach wieder freigeben.',
    when_not_to_use: 'Nicht als Dauerzustand: jeder Schalter laeuft ab (Default/Obergrenze 12 h, SYNAPSE_INTERN_MAX_STUNDEN). Nicht zum Beenden von Prozessen oder Sitzungen — das kann das Tool bewusst nicht.',
    param_tips: [
      'aktiv:true = Ablauf angehalten, aktiv:false = wieder frei.',
      'Dauer: hoechstens eines von bis (ISO), dauer_min, dauerhaft:true. Ohne Angabe gilt die Hoechstdauer; laengere Angaben werden gekappt (hinweis in der Antwort).',
      'embedding: modus hintergrund (Standard) haelt Backlog, Embedding-Claims (Server UND externe Knoten) und nebenlaeufige Nachtraege an — Eintraege bleiben mit embedded_at NULL im Backlog, nichts geht verloren. modus alle haelt zusaetzlich interaktive Embeddings an: semantische Suchen liefern dann einen klaren Fehler (EMBEDDING_ANGEHALTEN) mit Hinweis auf Volltext.',
      'parser: das Parsen im Parser-Worker ruht. context7: die Context7-Automatik ruht (ersetzt pause_bis von Hand).',
      'Worker lesen den Schalter gecacht (SYNAPSE_INTERN_CACHE_MS, Default 5 s) — die Wirkung kommt mit dieser Verzoegerung.',
      'P15-T12 worker_*: Pausen je einzelnem Worker, NUR im Speicher des API-Prozesses (Neustart beendet sie). dauer_min oder bis und grund sind Pflicht, Obergrenze SYNAPSE_WORKER_PAUSE_MAX_MIN (Standard 120). Worker der API: server_embedding, gpu_knoten, wissen_nachzug, parser, context7, retention, session_reaper, reservation_ttl, workspace_idle_stop (worker_status zeigt die Liste dieses Prozesses). Pausiert = holt nichts Neues, der laufende Stapel wird fertig. Im Log steht "[worker] X PAUSIERT ... Kein Fehler." bzw. "laeuft wieder".',
      'gpu_knoten pausiert: POST /api/embedding-nodes/:id/claims antwortet success:true, claims:[], pausiert{bis,grund} — der Knoten geht in seinen Leerlauf-Backoff; complete/release bleiben offen, laufende Claims verwaisen nicht.',
      'P15-T12 E2 prozess:"daemon" (oder "daemon:<host>"): dieselben worker_* im lokalen FileWatcher-Daemon. Der Daemon holt die Befehle per Long-Poll ueber seinen API-Zugang (config.json + Service-Token) ab, nur wenn die API mit SYNAPSE_INTERN_TOOL=1 laeuft; Antwort typisch < 1 s, sonst nach 10 s daemon_antwortet_nicht. worker_status (API) zeigt unter daemons, wer verbunden ist. Worker im Daemon: sync_pg_fs, sync_fs_pg, shell (alle drei nur ausdruecklich, nicht in "alle"), specialist_jobs, project_init. Bei pausiertem shell/specialist/project_init verfallen wartende Jobs nicht.',
    ].join('\n'),
    examples: [
      'intern({ action: "schalter_setzen", name: "embedding", aktiv: true, dauer_min: 60, grund: "Nemotron-Messung" })',
      'intern({ action: "schalter_setzen", name: "embedding", aktiv: false })',
      'intern({ action: "schalter_liste" })',
      'intern({ action: "worker_pausieren", worker: ["gpu_knoten", "server_embedding"], dauer_min: 20, grund: "Messung ohne Embedding-Last" })',
      'intern({ action: "worker_durchlauf", worker: "parser" })',
      'intern({ action: "worker_fortsetzen", worker: "alle" })',
    ],
    anti_patterns: [
      'Pausen per SQL in context7_automatik_stand oder anderen Tabellen setzen — dafuer gibt es die Schalter.',
      'dauerhaft:true "zur Sicherheit" — ein vergessener Schalter haelt den Ablauf unbemerkt an.',
      'Eine Worker-Pause fuer einen Fehler halten: worker_status zeigt zustand pausiert mit bis, grund und von.',
    ],
    actions: {
      schalter_setzen: { description: 'Schalter an/aus mit Ablauf und Grund.', params: 'name (req: embedding|parser|context7), aktiv (req), modus, bis | dauer_min | dauerhaft, grund', example: 'intern({ action: "schalter_setzen", name: "parser", aktiv: true, dauer_min: 30 })' },
      schalter_liste: { description: 'Alle Schalter mit wirksamem Zustand, Ablauf, Grund, gesetzt_von; dazu Hoechstdauer und moegliche Modi.', params: '-' },
      worker_status: { description: 'P15-T12: alle Hintergrund-Worker DIESES Prozesses: zustand laeuft|pausiert, pause {seit, bis, grund, von}, rest_min, zuletzt_aktiv (letzte Pruefung), zuletzt_arbeit, uebersprungen_seit_pause, Durchlaeufe und letzter Durchlauf; dazu pausiert[] und pg_schalter (P14-Schalter, wirken zusaetzlich).', params: '-' },
      worker_pausieren: { description: 'P15-T12: einen, mehrere oder alle Worker anhalten. Jeder prueft VOR dem Holen neuer Arbeit; was laeuft, wird fertig. Endet von selbst. "alle" laesst Worker mit in_alle:false aus.', params: 'worker (req: Name | Liste | "alle"), dauer_min | bis (req, Obergrenze SYNAPSE_WORKER_PAUSE_MAX_MIN), grund (req), prozess (api | daemon | daemon:<host>)', example: 'intern({ action: "worker_pausieren", worker: "gpu_knoten", dauer_min: 15, grund: "Server allein messen" })' },
      worker_fortsetzen: { description: 'P15-T12: Pause aufheben (fortgesetzt[] / liefen_schon[]).', params: 'worker (req: Name | Liste | "alle"), prozess' },
      worker_durchlauf: { description: 'P15-T12: genau EIN Durchlauf jetzt (auch waehrend einer Pause, die danach bestehen bleibt). Ergebnis je Worker, z. B. server_embedding {status, claims, abgeschlossen}, parser {projekte, dateien}, wissen_nachzug {geprueft, nachgetragen}. gpu_knoten hat keinen Durchlauf (der Knoten holt selbst).', params: 'worker (req, genau einer)', example: 'intern({ action: "worker_durchlauf", worker: "server_embedding" })' },
      warteschlange_liste: { description: 'P15-T12 E3: Warteschlangen einsehen. Ohne warteschlange: Uebersicht aller mit Anzahlen (PG: code_chunks je Projekt mit Stufe, Claims je Knoten, vorgezogen/ans_ende/zurueckgestellt; parser; wissen_nachzug; shell/specialist/project_init_jobs; Speicher: embedding_queue; verbundene Daemons mit index/asset/embedding_queue). Mit Name: Eintraege {id, projekt, typ, status, prioritaet, rang, alter_s, details}, paginiert (gesamt, weitere). code_chunks-Status: offen | geclaimt | lease_abgelaufen | zurueckgestellt; parser ohne project = Projekte in Abarbeitungsreihenfolge, mit project = faellige Dateien (typ = neu | embed_offen | veraltet).', params: 'warteschlange, project, eintrag_status, eintrag_typ, limit (<=200), offset, prozess (api | daemon | daemon:<host>)', example: 'intern({ action: "warteschlange_liste", warteschlange: "code_chunks", project: "synapse", eintrag_status: "geclaimt" })' },
      warteschlange_verschieben: { description: 'P15-T12 E4: umsortieren. code_chunks/parser je Projekt ueber embed_prioritaet (vorne = Stufe 1, hinten = 4, zurueckstellen = Projekt ruht bis X - keine Claims, kein Parsen, einreihen = Eintrag entfernen). Einzelne Chunks (eintrag_id) oder Dateien (project + file_path): vorne = prio 1 vor ALLEN offenen Chunks, hinten = ans Projektende, zurueckstellen = bis X nicht claimen (eigene Spalte, kein Schein-Claim), einreihen = normal; schon eingebettete Chunks werden dabei neu eingebettet. wissen_nachzug: nur vorne (sofort einbetten, eintrag_id "<tabelle>:<id>" oder alles bis limit). Daemon-index (prozess daemon): Projekt oder Ereignis vorne/hinten/zurueckstellen/einreihen, nur im Speicher. shell/specialist/project_init_jobs, embedding_queue, asset: nicht verschiebbar (Antwort sagt warum). Zurueckstellen braucht dauer_min oder bis, Obergrenze SYNAPSE_WARTESCHLANGE_ZURUECK_MAX_MIN (Standard 1440).', params: 'warteschlange (req), nach (req: vorne | hinten | zurueckstellen | einreihen), project | eintrag_id (String oder Liste, max 1000) | project + file_path, dauer_min | bis, prozess', example: 'intern({ action: "warteschlange_verschieben", warteschlange: "code_chunks", nach: "zurueckstellen", project: "parser-testkorpus", dauer_min: 60 })' },
      waits_tot: { description: 'P15-T31: tote Co-Edit-Waits (kein Ziel, Primaeragent ohne lebende Reservierung: abgelaufen, freigegeben, abgemeldet) einsehen und verlustfrei schliessen. Ohne ausfuehren:true NUR Vorschau, aendert nichts: je Wait besitzer (wartender Agent, dem die Ops gehoeren), wartet_auf, ziel_dateien, traeger_plan_id, alter_minuten/alter_text, warum_tot, ops (voller Inhalt), basis_hashes (Stand beim Entstehen des Waits) gegen aktuelle_hashes. Mit ausfuehren:true je Wait in EINER Transaktion: erneut pruefen, ob noch tot (sonst unberuehrt), dann Sicherung als thought (tags wait-sicherung + Besitzer; Ops vollstaendig zwischen <<<OPS_JSON und OPS_JSON>>>, Basis-Hash, Anleitung), Event ANNOUNCEMENT an den Besitzer mit thought-ID, ERST DANACH Wait closed und der leere Traeger cancelled. Nichts wird geloescht, kein Worker ruft das automatisch.', params: 'project?, besitzer?, wait_token? (String oder Liste: gezielt), ausfuehren? (Standard false = Vorschau)', example: 'intern({ action: "waits_tot", project: "synapse" })  // danach gezielt: intern({ action: "waits_tot", project: "synapse", wait_token: ["<uuid>"], ausfuehren: true })', tips: 'WIEDER EINSPIELEN: thought(action:"get", id:<thought_id>) lesen, den OPS_JSON-Block als ops an files(action:"plan", project, agent_id:<besitzer>, ops) geben und committen (oder auto_commit:true). Ist eine Datei seit dem Basis-Hash GEAENDERT, meldet der Trockenlauf nicht mehr passende Anker als failed_ops -> plan_update. Entfernte Co-Edit-Metadaten stehen im META_JSON darunter. Ein Wait, dessen Besitzer noch arbeitet, wird besser von ihm selbst neu geplant (Traeger wird wiederverwendet) - waits_tot ist fuer verwaiste Waits.' },

      ollama_status: { description: 'Ollama des Servers (OLLAMA_URL): Version, geladene Modelle wie "ollama ps" (Groesse, VRAM, GPU-/CPU-Anteil, Kontext, Ablauf), belegter VRAM, installierte Embedding-Modelle (capabilities, sonst Name), konfiguriertes Modell. nvidia-smi-Werte liefert die Ollama-API nicht.', params: '-' },
      ollama_entladen: { description: 'Nimmt ein GELADENES Modell aus dem Speicher (keep_alive 0) und wartet bis 5 s, bis /api/ps es nicht mehr zeigt. Der Entlade-Aufruf darf bis 120 s dauern (wartet auf laufende Anfragen); laeuft er ins Zeitlimit, zaehlt der Zustand laut /api/ps (bis 30 s): entladen -> hinweis_aufruf, noch geladen -> Fehler entladen_zeitlimit (nicht mehr faelschlich ollama_nicht_erreichbar). Nicht geladene Modelle werden nicht angefasst. Beim konfigurierten Embedding-Modell ohne Schalter embedding: hinweis_schalter (sonst laedt die naechste Anfrage es wieder).', params: 'modell (req)', example: 'intern({ action: "ollama_entladen", modell: "qwen3-embedding:8b" })' },
      status: { description: 'Gesamtbild: Embedding-Queue (inkl. preemptedBackground), DB-Pools haupt/hintergrund (gesamt/frei/wartend), offene Embeddings je Tabelle, Context7-Kontingent, Modell-Kennung, Schalter, quellen.parser_worker. Teilausfaelle stehen als { fehler } an ihrer Stelle.', params: '-' },
      db_sitzungen: { description: 'pg_stat_activity der Synapse-DB: Anzahl nach Zustand und Client, laufende Abfragen ab min_sekunden, alle idle in transaction mit gehaltenen Sperren, blockierte Sitzungen samt blockierenden PIDs. NUR anzeigen — beendet wird nichts.', params: 'min_sekunden (Standard 5)' },
      langsam: { description: 'Langsamste tool_calls der letzten Minuten plus je Tool/Action Anzahl, Median, Mittel, Max. Bewusst wartende Long-Polls (files plan_status/shared_plan_status/commit mit wait_seconds) sind ausgenommen und nur gezaehlt.', params: 'minuten (30), limit (20, max 200), project (Filter)' },
      nachzug_jetzt: { description: 'Holt N offene Embeddings (embedded_at NULL) sofort im Hintergrund-Pool nach und meldet geprueft/nachgetragen/fehlgeschlagen, Dauer und den Rueckstand danach. Bei Schalter embedding an: angehalten:true, nichts angefasst.', params: 'limit (20, max 500), tabelle (memories|thoughts|proposals|plans|error_patterns|tech_docs|skill_sections), project' },
      embed_prioritaet: { description: 'P12-T12: Prioritaetenliste fuer den Code-Nachzug. Der Parser-Worker bedient Projekte nach Stufe (1 zuerst ... 4 zuletzt, ohne Eintrag 3), innerhalb einer Stufe den groessten Rueckstand zuerst. Ohne projekte: Liste aller registrierten Projekte mit Stufe und offenen Code-Chunks in Bedien-Reihenfolge.', params: 'projekte (Liste), stufe (1-4, 0 = entfernen)', example: 'intern({ action: "embed_prioritaet", projekte: ["synapse", "moo"], stufe: 1 })' },
      neu_einbetten: { description: 'P12-T12: Qdrant-Index nach einem Modellwechsel aus PostgreSQL neu aufbauen, in-place. Vorschau (Standard): veraltete Collections (Dimension, Modell-Kennung oder Register-Quelle nicht angelegt) je Art mit PG-Zeilen, fehlende Collections, nicht angefasste (*_media, unbekannte Namen), Code-Projekte ohne Registry. Mit ausfuehren:true: veraltete Collections loeschen und sofort leer neu anlegen, embedded_at zuruecksetzen (Code ueber resetProjectEmbeddings); den Rest machen embed-backlog und Parser-Worker. ERST nach dem Umschalten der Modell-Env (P12-T14).', params: 'ausfuehren (Standard false = Vorschau), arten (code|memories|thoughts|proposals|plans|docs|tech_docs_cache|error_patterns|skills)', example: 'intern({ action: "neu_einbetten", arten: ["memories", "thoughts"] })' },
      embedding_messen: { description: 'Testmessung DIREKT gegen Ollama, nichts in PG/Qdrant: Ladezeit (falls nicht geladen), Latenz je Passage (Median/Max/Min), Passagen/s einzeln und als Batch, Dimension, ps-Auszug (VRAM, GPU-Anteil). warnungen: anderes Modell geladen, Schalter embedding aus, nicht 100 % GPU. Vorgehen fuer saubere Werte: schalter_setzen(embedding) -> ollama_entladen(altes Modell) -> embedding_messen -> ollama_entladen(Messmodell) -> Schalter aus.', params: 'modell (req), anzahl (20, 1..200), praefix (z. B. "passage: "), num_ctx / num_batch (Token; ohne Angabe EMBEDDING_NUM_CTX/EMBEDDING_NUM_BATCH der Server-Env, sonst weggelassen = Ollama-Standard des Modells; die Antwort nennt beides unter optionen samt quelle)', example: 'intern({ action: "embedding_messen", modell: "hf.co/zenmagnets/Nemotron-3-Embed-1B-Q4_K_M-GGUF:latest", anzahl: 30, praefix: "passage: ", num_ctx: 8192, num_batch: 2048 })' },
      ollama_laden: { description: 'Laedt ein INSTALLIERTES Modell vor (leere Eingabe mit keep_alive) und misst die Ladezeit. Nicht installierte -> modell_nicht_installiert, es wird nichts heruntergeladen.', params: 'modell (req), keep_alive (Standard 30m)' },
      modellprofil: { description: 'P15-T8: Kalibrierung je Embedding-Modell aus PostgreSQL (Tabelle embedding_modell_profile): Praefixe, num_ctx, num_batch, max_stueck_zeichen, Score-Schwellen je Zweck. Zeigt, welches Profil fuer das aktive Modell gilt (oder warum keins: kein_profil, digest_unbekannt ...), fehlende Zwecke und Pruefhinweise (Env uebersteuert Profil). Ohne Profilwert gibt es KEINEN Ersatz im Code: Einbetten scheitert mit modell_nicht_kalibriert, Features mit Schwelle liefern keine gefilterten Treffer und melden das.', params: 'modell (Standard alle Profile)', example: 'intern({ action: "modellprofil" })' },
      modellprofil_setzen: { description: 'Profil anlegen oder aendern - nur die genannten Felder. null = nicht kalibriert, "" bei Praefixen = bewusst keiner. score_schwellen werden gemischt (null entfernt einen Zweck), messwerte ebenso. Ohne modell gilt das aktive, ohne digest jeder Digest. Wirkt in diesem Prozess sofort, in anderen nach SYNAPSE_MODELLPROFIL_TTL_MS (60 s). dok_praefix aendern heisst neu einbetten.', params: 'modell, digest, query_praefix, dok_praefix, ziel_dimension, num_ctx, num_batch, max_stueck_zeichen, score_schwellen {zweck: zahl|null}, notiz, messwerte', example: 'intern({ action: "modellprofil_setzen", score_schwellen: { graph_code: 0.42 }, notiz: "thought ab12cd34" })' },
      modellprofil_kalibrieren: { description: 'Misst mit dem AKTIVEN Modell: passende Anfragen (mit erwartetem Treffer) gegen Rausch-Anfragen, liefert passend_min/median, rauschen_max, Vorschlag = Mitte, und was der Vorschlag durchlaesst. Schreibt nur mit schreiben:true und nur bei sauberer Trennung (passend_min > rauschen_max); Messwerte landen im Profil. Zwecke: hook, channel_skill, global_search, graph_code, code_semantic_fallback, graph_wissen (letzte drei mit project), error_patterns.', params: 'zweck (req), passend (req: ["text"] oder [{query, erwartet}]), rauschen (req: ["text"]), project, schreiben', example: 'intern({ action: "modellprofil_kalibrieren", zweck: "hook", passend: [{ query: "Dockerfile multi-stage", erwartet: "docker" }], rauschen: ["ok mach weiter", "danke"] })' },
    },
  },

};
