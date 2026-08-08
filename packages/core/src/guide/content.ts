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

Du bist mit einem Synapse-Projekt verbunden. Diese REST-Schnittstelle bietet 21 Tools,
eines davon ist dieses guide-Tool.

⚠️ Der lokale MCP-Server (stdio) bietet NICHT dieselbe Menge, sondern 18: ihm fehlen
files_batch, skills und workspace. Wer eine Anleitung von der einen Oberflaeche auf die
andere uebertraegt, sucht sonst ein Tool, das es dort nicht gibt. Umgekehrt ist nichts
exklusiv lokal — die 18 sind eine echte Teilmenge der 21.

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
  specialist — REST UND lokal: spawn / wake / stop / purge / update_skill / status / capabilities funktionieren ueberall, solange auf dem Ziel-PC der Watcher laeuft (status + capabilities lesen jetzt aus PG, kein lokaler-MCP-Bonus mehr). Modelle: Claude (opus/sonnet/haiku/[1m]) ODER Google (gemini-flash-lite/gemini-flash/gemini-pro), je nachdem welche Provider-Runtime auf dem Ziel-PC installiert ist.
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
      'Destruktive Commands ohne Dry-Run (rm -rf, DROP TABLE) — IMMER erst echo + confirm.',
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
        description: 'Liste vergangener Jobs eines Projekts (oder global). Sortiert nach created_at DESC. Liefert Metadata mit output_line_count + source — KEIN voller Output (zu gross fuer Liste).',
        params: 'project (optional Filter), limit (Default 20, Max 200), offset, status (pending|running|done|failed|rejected|timeout)',
        example: 'shell({ action: "history", project: "synapse", limit: 10, status: "failed" })',
        tips: 'Wenn du einen alten Build oder Test-Lauf nachschauen willst — IMMER zuerst history um die UUID zu finden, dann get/log fuer Details.',
      },
      get: {
        description: 'Einzelnen Job per ID inkl. vollem Output (gecappt 1MB). Liefert auch claimed_by, completed_at, output_truncated.',
        params: 'id (req)',
        example: 'shell({ action: "get", id: "750a83b6-2c8e-483f-baee-7d8e6d323717" })',
        tips: 'output_truncated:true bedeutet der Output war groesser als 1MB — nutze action:"log" mit query/range fuer gezielten Zugriff statt alles zu laden.',
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
      'Nicht-Code-Dateien wie Images/Binaerdateien.',
    ].join(' '),
    param_tips: [
      'IMMER filter setzen (file_path, name, symbol_type) um Output klein zu halten.',
      'file_type: Extension ohne Punkt ("ts", "py") — NICHT "typescript" oder "python".',
      'tree: depth: 1-2 reicht meist, show_functions: true wenn du Funktionen sehen willst.',
      'file: line_start + line_end setzen bei Dateien > 500 Zeilen, sonst sprengst du Context.',
      'search: limit: 5-10 sinnvoll, nicht 100.',
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
        params: 'path (prefix filter), depth, recursive, show_lines, show_functions, show_imports',
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
        tips: 'symbol_type muss gesetzt sein. Werte: function, variable, interface, class, enum, const_object, table, ...',
      },
      references: {
        description: 'Wo wird ein Symbol referenziert (cross-file imports + calls).',
        params: 'name (req)',
        example: 'code_intel({ action: "references", project: "synapse", name: "enqueueShellJob" })',
        tips: 'Perfekt fuer Impact-Analyse: "wenn ich das aendere, was muss ich nachziehen?"',
      },
      search: {
        description: 'Code-Suche mit ZWEI Modi: Default = PG-Volltext (lexikalisch, exakte Identifier, <b>-Headlines), semantic: true = Qdrant-Embeddings (konzeptuell/fuzzy, ~30-Zeilen-Chunks). Antwort enthaelt mode ("fulltext"|"semantic") zur Selbstkontrolle.',
        params: 'query (req), semantic (bool, Default false), file_type (Extension ohne Punkt), limit',
        example: 'code_intel({ action: "search", project: "synapse", query: "DNS-Name fuer Container generieren", semantic: true, limit: 3 })',
        tips: 'Faustregel: Identifier/exakter String → Default (fulltext). Konzept/"wo passiert X" → semantic: true. Semantic-Treffer sind grosse Chunks — limit 3-5 setzen, mehr sprengt Context.',
      },
      search_batch: {
        description: 'Mehrere SEMANTISCHE Queries in EINEM Call — Embeddings gebatched (1 API-Roundtrip statt N), parallel gegen Qdrant. Antwort: results[] mit { query, count, hits } pro Query.',
        params: 'queries (req, Array 1..10), limit_per_query (Default 5)',
        example: 'code_intel({ action: "search_batch", project: "synapse", queries: ["wo wird der plan gespeichert", "wie laeuft das embedding"], limit_per_query: 3 })',
        tips: 'DER Discovery-Einstieg: beim Erkunden eines unbekannten Bereichs 3-5 Aspekte gleichzeitig abklopfen statt 5 einzelne search-Calls. limit_per_query: 3 reicht fast immer.',
      },
      file: {
        description: 'Datei-Inhalt lesen. Liefert immer total_lines und returned_range: { from, to, eof }.',
        params: 'file_path (req; path wird als Alias akzeptiert); optional: from_line (1-basiert, Standard 1), to_line (inklusiv, Standard Ende), truncate_long_lines (Zeilen > N kuerzen + Marker, 0 = aus)',
        example: 'code_intel({ action: "file", project: "synapse", file_path: "README.md", from_line: 1, to_line: 100 })',
        tips: [
          'Auto-Reduce: Range > 80k Zeichen wird automatisch reduziert — returned_range.eof=false zeigt das an.',
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
        description: 'Gezielter String-Replace. search muss exakt matchen.',
        params: 'search, replace',
        example: 'files({ action: "search_replace", project: "synapse", file_path: "x.ts", search: "const x = 1", replace: "const x = 2" })',
        tips: 'Bei mehrdeutigem Match: nimm mehr Umgebungs-Kontext in search.',
      },
      search_replace_batch: {
        description: 'Mehrere Search-Replace-Edits in einem Aufruf. Datei wird 1× gelesen und 1× geschrieben. Continue-with-warnings: 0-match und multi-match (ohne replace_all) werden uebersprungen, Rest wird angewendet.',
        params: 'edits (Array, 1..50 Elemente: { search, replace, replace_all? })',
        example: 'files({ action: "search_replace_batch", project: "synapse", file_path: "src/x.ts", edits: [{ search: "const x = 1", replace: "const x = 2" }, { search: "foo", replace: "bar", replace_all: true }] })',
        tips: [
          'Jedes Edit wird sequenziell auf dem aktuellen Content angewendet — spaetere Edits sehen Aenderungen frueherer.',
          'replace_all: true wenn der String mehrfach vorkommt und alle Vorkommen ersetzt werden sollen.',
          'Response enthaelt applied, skipped, total und warnings[{ index, search_preview, reason }].',
          'reason: "no_match" oder "multiple_matches (N occurrences)".',
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
        tips: 'Vor dem Planen alle beabsichtigten Zieldateien reservieren. Eine Reservierung ist ein Koordinationssignal und Planungsvorrang, kein Besitzanspruch oder Schreib-Lock: andere Agenten duerfen reservieren und direkte Writes bleiben moeglich. Retry desselben Agenten/Pfads behaelt reserved_at und Content-Baseline. Activity und offene dateibezogene Plaene erneuern; Takeover folgt erst nach Grace und vier atomaren Sicherheitspruefungen.',
      },
      reservation_release: {
        description: 'Eigene aktive Reservierungen fuer einzelne Pfade freigeben — nach Commit, Cancel, Abbruch oder sobald die Datei nicht mehr zum eigenen Scope gehoert.',
        params: 'project, agent_id, file_path (String oder Array)',
        example: 'files({ action: "reservation_release", project: "synapse", agent_id: "agent-x", file_path: "src/a.ts" })',
        tips: 'So frueh wie moeglich freigeben, damit andere Agenten nicht unnoetig warten. Die Freigabe beendet nur das Koordinationssignal; sie rollt weder Plan noch Datei-Aenderungen zurueck.',
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
        tips: 'Jede Aenderung erzeugt automatisch einen Snapshot. edit_action zeigt was geaendert hat (update / search_replace / restore:<id> / etc.). batch_id ist gesetzt wenn die Aenderung Teil eines Multi-File-Edits war.',
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
        tips: 'Greift bei Multi-File-Plans (Schritt 2): commit setzt batch_id=plan_id in jedem file_versions-Snapshot. Auch fuer manuelle Bulk-Rollbacks nutzbar wenn batch_id manuell vergeben wurde.',
      },
      plan: {
        description: 'Phase A eines Multi-File-Edits: dry-runt ops[], erfasst Hashes/Previews und trennt Pfade mit fremder primaerer nicht freigegebener Reservierung als persistente, nach primary_agent gruppierte coedit_waits ab. move/copy prueft auch new_path; Ablauf allein gibt den Vorrang nicht frei. auto_commit schreibt ausschliesslich den konfliktfreien Teilplan. Ohne Ueberlappung bleibt die Antwort unveraendert.',
        params: 'project (req), ops (req, Array von { file_path, action, new_path?, content?, search?, replace?, edits?, line_start?, line_end?, after_line?, shift_mode?, reason? }), agent_id, open_for_coedit, reason (Top-Level)',
        example: 'files({ action: "plan", project: "synapse", reason: "Refactor Modul X", ops: [{ file_path: "src/x.ts", action: "replace_lines", line_start: 10, line_end: 15, content: "neu" }, { file_path: "src/x.ts", action: "insert_after", after_line: 50, content: "// log" }, { file_path: "src/x.ts", action: "delete_lines", line_start: 80, line_end: 85 }] })',
        tips: 'Der Wait folgt der skalierten Primaerreservierungs-TTL. Polling hoechstens einmal pro Minute und nur mit konkretem wait_token; Activity ist Lebenssignal, aber kein Takeover-Beweis. open_for_coedit=false sperrt coedit_add. Op-Actions: create, update, search_replace, search_replace_batch, replace_lines, insert_after, delete_lines, delete, move, copy. Mehrere Ops auf gleicher Datei sind moeglich; line-Ops nutzen standardmaessig shift_mode="auto". Shared Ops werden ueber wait_token und CE-3-Actions direkt in genau einen gemeinsamen Primaerplan integriert.',
      },
      coedit_add: {
        description: 'Haengt die noch offene deferred Operation des konkreten waiting_agent genau einmal an den offenen Primaerplan. Die Herkunft agent_id wird serverseitig gesetzt; Input-Herkunft ist nicht vertrauenswuerdig.',
        params: 'project, plan_id, agent_id, ops',
        example: 'files({ action: "coedit_add", project: "synapse", plan_id: "42", agent_id: "agent-b", ops: [{ file_path: "src/x.ts", action: "search_replace", search: "alt", replace: "neu" }] })',
        tips: 'Nur der waiting_agent des konkreten Waits ist berechtigt. Cross-Wait-Dedup nutzt source_plan_id + deferred_op_index. open_for_coedit=false lehnt ohne Mutation ab. Danach alle gemeinsamen Dateien entweder mit coedit_add beitragen oder mit coedit_no_changes abschliessen und erst dann coedit_ready senden.',
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
        tips: 'Erst senden, wenn jede shared_file durch coedit_add oder coedit_no_changes abgedeckt ist. Der Primaeragent kann erst committen, wenn alle Waits ready/no_changes sind; conflict ist terminal und verlangt Cancel/Replan.',
      },
      shared_plan_status: {
        description: 'Liest nur den einen konkreten Wartezustand des opaken wait_token, nicht den ganzen Planbestand.',
        params: 'project, wait_token, agent_id',
        example: 'files({ action: "shared_plan_status", project: "synapse", wait_token: "uuid", agent_id: "agent-b" })',
        tips: 'Primaer pending_events in normalen Tool-Antworten beachten und PLAN_READY quittieren; nicht aktiv eng pollen. Nur wenn ein Statusabruf noetig ist: hoechstens einmal pro Minute und ausschliesslich mit dem konkreten wait_token. Terminale/abgelaufene Waits verschwinden aus pending_events.',
      },
      commit: {
        description: 'Phase B: Legacy-Plaene behalten ihren bisherigen Pfad. Co-Edit-Plaene werden in genau einer Server-TX gegated (alle Waits ready/no_changes), per FOR UPDATE plus Wait-Tabellenlock gegen Gate/Commit-Races geschuetzt, gegen expected_hashes, Anchors und Cross-Agent-Ranges validiert und gemeinsam committed. Ueberlappung setzt terminal status="conflict" ohne Datei-/Versionswrites. Jede Op erzeugt einen Snapshot mit ihrer serverseitigen agent_id und derselben batch_id.',
        params: 'plan_id (req), agent_id, agent_note (optional: KI-Notiz fuer Audit/Crash-Recovery)',
        example: 'files({ action: "commit", project: "synapse", plan_id: "42", agent_id: "ich" })',
        tips: 'Bei stale: neu planen. Bei conflict: cancel + replan; der Konfliktstatus ist terminal. Bei Erfolg: batch_id fuer restore_batch merken.',
      },
      cancel: {
        description: 'Plan abbrechen (Soft-Delete: status="cancelled"). Moeglich bei status=open oder terminal conflict; danach neu planen.',
        params: 'plan_id (req)',
        example: 'files({ action: "cancel", project: "synapse", plan_id: "42" })',
      },
      plan_status: {
        description: 'Plan-Details abfragen (Status, Previews, Files, reason). Fuer Status-Polling oder Diff-Inspektion vor commit.',
        params: 'plan_id (req)',
        example: 'files({ action: "plan_status", project: "synapse", plan_id: "42" })',
      },
      history: {
        description: 'Audit-Log: chronologische Liste aller Datei-Aenderungen mit Begruendung. Crash-Recovery: nach Session-Crash kann eine neue Session sehen "wer hat wann was warum geaendert" und gegebenenfalls Versionen wiederherstellen. Filter nach feature_tag (exakter Match) oder version_id (rekursive parent-chain via parent_version_id).',
        params: 'project (req); optional: agent_id (Filter), file_path (Praefix-Match), since (ISO-Timestamp), limit (Standard 50, Max 500), feature_tag (, exakter Match), version_id (, BIGINT als String — liefert die Korrektur-Chain ab dieser Version rekursiv).',
        example: 'files({ action: "history", project: "synapse", feature_tag: "idea-thought-task-link", limit: 20 })',
        tips: 'reason wird beim Schreiben mitgegeben (files write-actions + plan/commit). Eintraege enthalten file_path, edit_action, agent_id, batch_id, reason, created_at und feature_tag, parent_version_id, git_commit_sha. Voller Inhalt einer Version: files(action: "get_version", version_id). version_id-Filter ist projektgebunden (Cross-Project-Schutz). FALLE: agent_id wirkt hier als EXAKTER Read-Filter, NICHT als Attribution — fuer die volle Projekt-History weglassen. Expliziter Filter: agent_filter. 0 Treffer mit gesetztem Filter liefern jetzt einen erklaerenden tip statt stillem count=0.',
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
        params: 'project (req), agent_id (empfohlen fuer Onboarding)',
        example: 'admin({ action: "index_stats", project: "synapse", agent_id: "guide-content-writer" })',
        tips: 'IMMER als erste Aktion aufrufen. agent_id = deine ID → Regeln werden geladen.',
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
    },
  },

  search: {
    summary: 'Semantische Suche (Embeddings) in Code, Paths, Memories, Thoughts, Proposals, Tech-Docs und Media.',
    when_to_use: [
      'Konzeptuelle/fuzzy Code-Suche (action: "code"): "wie wird Authentifizierung gehandhabt?"',
      'Datei-Pfad-Suche (action: "path") mit Glob-Pattern.',
      'Projekt-Wissen durchsuchen (action: "memory").',
      'Gedanken/Updates suchen (action: "thoughts").',
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
      'Score-Cutoffs: 0.65+ = verlaesslich, 0.60-0.65 = validieren, <0.60 = Fallback nutzen.',
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
      thoughts: {
        description: 'Gedanken/Team-Updates durchsuchen.',
        params: 'query (req), project (req), limit',
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
      'get mit id: Einzelner oder Array von IDs gezielt laden.',
      'search: Semantisch, Englisch-Query bevorzugen.',
      'delete nach Verarbeitung: Halte die DB sauber, loese verarbeitete Thoughts.',
    ].join('\\n'),
    examples: [
      'thought({ action: "add", project: "synapse", source: "guide-content-writer", content: "Tool X fertig.", tags: ["status"] })',
      'thought({ action: "get", project: "synapse", limit: 20 })',
      'thought({ action: "search", project: "synapse", query: "auto-handoff guide-content-writer" })',
      'thought({ action: "delete", project: "synapse", id: "abc123" })',
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
        params: 'project (req), source (req, deine agent_id), content (req), tags, task_id (optional, Plan-Task-ID), task_status (optional: todo|in_progress|done|blocked — setzt Status der via task_id verlinkten Task).',
        example: 'thought({ action: "add", project: "synapse", source: "mein-agent", content: "Task abgeschlossen.", tags: ["status"], task_id: "task-uuid", task_status: "done" })',
        tips: 'source = deine agent_id. NIEMALS "claude-code". task_id allein verlinkt nur; mit task_status zusaetzlich wird gleich der Plan-Task-Status gesetzt. Findet "alle Thoughts zu Task X" via thought(search) oder Plan-Lookups via Spalte task_id.',
      },
      add_batch: {
        description: 'Mehrere Thoughts atomar speichern (1..50 Items in einem Call). items[].task_id pro Item moeglich; top-level task_status setzt einmalig den Status fuer alle in den Items verlinkten Tasks.',
        params: 'project (req), source (req, gilt fuer alle Items), items (req, Array von { content, tags?, task_id? }), task_status (optional, top-level: todo|in_progress|done|blocked — setzt den Status fuer alle in den Items verlinkten Tasks).',
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
        description: 'Thoughts semantisch durchsuchen.',
        params: 'query (req), project, limit',
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
      'Neue Task zum Plan hinzufuegen: add_task.',
      'Task-Status tracken fuer langfristige Projekte.',
    ].join(' '),
    when_not_to_use: [
      'Ad-hoc Notizen/To-Dos → thought mit Tag "task".',
      'Session-spezifische Aufgaben → thought.',
      'Komplette Plan-Neuanlage → project(action: "init") macht das automatisch.',
    ].join(' '),
    param_tips: [
      'project: Pflicht fuer alle Actions.',
      'add_task: title + description beide Pflicht. priority: low|medium|high (Standard: medium).',
      'update: Felder die nicht gesetzt werden, bleiben unveraendert.',
      'goals: Array von Strings — Ziele des Projekts.',
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
      get: {
        description: 'Aktuellen Projekt-Plan + Tasks abrufen.',
        params: 'project (req)',
        example: 'plan({ action: "get", project: "synapse" })',
        tips: 'Zeigt Plan-Metadaten + alle Tasks mit Status.',
      },
      update: {
        description: 'Plan-Metadaten aendern (name, description, goals, architecture).',
        params: 'project (req), name, description, goals (Array), architecture',
        example: 'plan({ action: "update", project: "synapse", architecture: "PostgreSQL + Qdrant dual-write" })',
        tips: 'Nicht gesetzte Felder bleiben unveraendert.',
      },
      add_task: {
        description: 'Neue Task zum Plan hinzufuegen.',
        params: 'project (req), title (req), description (req), priority (low|medium|high)',
        example: 'plan({ action: "add_task", project: "synapse", title: "API-Rate-Limiting", description: "Implementiere Rate-Limiting fuer REST-API", priority: "medium" })',
      },
      add_tasks_batch: {
        description: 'Mehrere Tasks atomar zum Plan hinzufuegen (1..50 Items in einem Call).',
        params: 'project (req), tasks (req, Array von { title, description, priority? })',
        example: 'plan({ action: "add_tasks_batch", project: "synapse", tasks: [{ title: "Task A", description: "...", priority: "high" }, { title: "Task B", description: "..." }] })',
        tips: 'Bei >5 Tasks IMMER add_tasks_batch statt parallele add_task-Calls — ein UPDATE, ein Qdrant-Reindex.',
      },
      update_task: {
        description: 'Eine bestehende Task aendern (status, priority, title, description).',
        params: 'project (req), task_id (req), title?, description?, status (todo|in_progress|done|blocked)?, priority (low|medium|high)?',
        example: 'plan({ action: "update_task", project: "synapse", task_id: "abc-123", status: "done" })',
        tips: 'Status auf "done" setzen statt Task zu loeschen — bleibt fuer Audit erhalten.',
      },
      delete_task: {
        description: 'Eine oder mehrere Tasks aus dem Plan loeschen (atomar).',
        params: 'project (req), task_id (req, String oder Array von Strings, max 50)',
        example: 'plan({ action: "delete_task", project: "synapse", task_id: ["abc-123", "def-456"] })',
        tips: 'Bevorzuge update_task mit status: "done" wenn die Task fuer Historie/Audit erhalten bleiben soll.',
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
        tips: 'Array erlaubt fuer Batch-Abruf.',
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
      'Projekt-Wissen → memory.',
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
      'docs({ action: "get_for_file", file_path: "packages/rest-api/src/routes/mcp.ts", agent_id: "mein-agent", project: "synapse" })',
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
        params: 'file_path (req, String oder Array), agent_id (req), project (req); optional: limit (pro Framework, Standard 5), framework (Filter auf EIN Framework, z.B. "fastify")',
        example: 'docs({ action: "get_for_file", file_path: "src/api.ts", agent_id: "mein-agent", project: "synapse", framework: "fastify", limit: 3 })',
        tips: 'VOR jeder Datei-Bearbeitung aufrufen. Array fuer Multi-File. Warnings NICHT ignorieren. Framework-Zuordnung laeuft ueber die Datei-Extension (.ts matcht u.a. react UND fastify) — mit framework: "<name>" gezielt eingrenzen.',
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
    summary: 'Error-Pattern-System: Bekannte Fehler speichern und automatisch bei Write-Operationen pruefen.',
    when_to_use: [
      'Nach einem Code-Fehler: add_pattern damit zukuenftige Agenten gewarnt werden.',
      'Bekannte Patterns inspizieren: list_patterns.',
      'Veraltetes Pattern entfernen: delete_pattern.',
      'Scope-spezifische Patterns anzeigen (z.B. nur haiku-Fehler): list_patterns mit model_scope.',
    ].join(' '),
    when_not_to_use: [
      'Code ausfuehren → shell.',
      'Code lesen/schreiben → code_intel oder files.',
      'Allgemeine Notizen → thought oder memory.',
    ].join(' '),
    param_tips: [
      'add_pattern: description (was ist falsch) + fix (wie korrigieren) beide Pflicht.',
      'found_in_model: Modell-Name das den Fehler machte ("haiku", "sonnet", "opus").',
      'found_by: deine agent_id — wer hat den Fehler entdeckt.',
      'severity: error|warning|info (Standard: warning). error = blockiert bei files-writes.',
      'list_patterns model_scope: Filtert nach Modell-spezifischen Patterns.',
    ].join('\\n'),
    examples: [
      'code_check({ action: "add_pattern", description: "console.log statt console.error in MCP-Tools", fix: "Immer console.error verwenden wegen stdio", severity: "error", found_in_model: "haiku", found_by: "code-reviewer" })',
      'code_check({ action: "list_patterns", model_scope: "haiku", limit: 10 })',
      'code_check({ action: "delete_pattern", id: "abc123" })',
    ],
    anti_patterns: [
      'add_pattern fuer einmalige Fehler — nur wiederkehrende Patterns einreichen.',
      'found_in_model weglassen — Pattern wird nicht korrekt gescoped.',
      'Patterns nie loeschen — veraltete Patterns erzeugen falsche Warnungen.',
      'list_patterns ohne limit — Standard ist 20, kann Context sprengen.',
    ],
    actions: {
      add_pattern: {
        description: 'Fehler-Pattern speichern fuer automatische Warnung bei zukuenftigen Writes.',
        params: 'description (req), fix (req), found_in_model (req), found_by (req), severity',
        example: 'code_check({ action: "add_pattern", description: "Pfad nicht validiert", fix: "path.resolve() nutzen", found_in_model: "sonnet", found_by: "mein-agent" })',
        tips: 'Wird automatisch bei files-Writes ausgespielt wenn agent_id gesetzt ist.',
      },
      list_patterns: {
        description: 'Gespeicherte Error-Patterns anzeigen.',
        params: 'model_scope, limit (Standard: 20)',
        example: 'code_check({ action: "list_patterns", model_scope: "haiku", limit: 5 })',
        tips: 'model_scope filtert nach Modell-spezifischen Patterns.',
      },
      delete_pattern: {
        description: 'Veraltetes oder falsches Pattern entfernen.',
        params: 'id (req)',
        example: 'code_check({ action: "delete_pattern", id: "abc123" })',
      },
    },
  },

  chat: {
    summary: 'Agenten-Chat: Registrierung, Direkt-Nachrichten und Broadcasts. Verfuegbar lokal (stdio MCP) UND via REST-API (Daten in PostgreSQL, Routing ueber PG-Queue/Daemon, Erreichbarkeit unabhaengig vom Ziel-PC-Status fuer Schreib-/Lese-Ops auf der DB).',
    when_to_use: 'Agent registrieren bevor du Nachrichten sendest: register. DM/Broadcast schicken: send. Eigene Inbox abholen: get. Aktive Agenten anzeigen: list. Inbox-Routing fuer offline Spezialisten: inbox_send / inbox_check.',
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
      post: { description: 'Nachricht in Channel (channel_name, sender, content). Bulk-Mode: messages[] (1..20) fuer mehrere Posts in einem Call — sender + channel_name gelten fuer alle.' },
      feed: { description: 'Channel-Inhalt lesen (limit, since_id, optional preview-Truncation).' },
      list: { description: 'Alle Channels im Projekt.' },
    },
    anti_patterns: [
      'post ohne vorheriges join — manche Channels filtern Non-Member.',
      'feed ohne since_id im Loop — bekommst alte Nachrichten erneut.',
      'preview: false bei langen Posts — sprengt den Context.',
    ],
  },

  event: {
    summary: 'Persistente Steuersignale fuer Agenten (WORK_STOP, NEW_TASK, PLAN_READY, ANNOUNCEMENT, …). Verfuegbar lokal UND via REST (PostgreSQL). PLAN_READY ist ein zielgerichtetes Inbox-Event fuer einen wartenden Co-Editor und bleibt bis ack oder terminalem Wait-Status erhalten; Push ist keine Voraussetzung. Erweiterbare Objektantworten ausser event/guide tragen bei agent_id+project bis zu 3 kompakte pending_events (summary max. 80 Zeichen, kein Payload). emit akzeptiert optional events[] (1..50) fuer Bulk-Emit; ack akzeptiert event_id als Array (Batch-Ack).',
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
    summary: 'Persistente Spezialisten (Claude-CLI ODER Gemini) auf dem Ziel-PC spawnen, stoppen, ansprechen. Funktioniert sowohl lokal als auch ueber REST/Web-KI — Voraussetzung in beiden Faellen: auf dem Ziel-PC laeuft der FileWatcher-Daemon (er hostet PG-Queue → Provider-Runtime). Modell-Alias-Aufloesung via PG model_registry-Tabelle. Fehlerinterpretation: spawn timeoutet ohne PID/Socket in der Antwort → Watcher down ODER Provider-Runtime fehlt auf dem Ziel-PC (Claude-CLI bei opus/sonnet/haiku, GOOGLE_API_KEY bei gemini-*). Spezifischer Fehler wie "name contains illegal characters" / "project not found" → Eingabe pruefen. wake antwortet nie / Inbox-Fallback → Spezialist gestorben oder Watcher-Heartbeat haengt.',
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
      'model: CLAUDE: opus / sonnet / haiku (200k Context). opus[1m] / sonnet[1m] = 1M Context (ABO-LIMIT: nur EIN Modell-Typ gleichzeitig auf 1M). GOOGLE: gemini-flash-lite / gemini-flash / gemini-pro = 1M Context, ~3-75x guenstiger (braucht GOOGLE_API_KEY auf dem Ziel-PC).',
      'keep_alive: true fuer langlaufende Spezialisten (Auto-Respawn bei Crash). Default false fuer One-Shot.',
      'Voraussetzung: FileWatcher-Daemon laeuft auf dem User-PC + Provider-Runtime installiert (Claude-CLI fuer opus/sonnet/haiku, GOOGLE_API_KEY fuer gemini-*) + Projekt im Tray aktiv.',
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
        description: 'Einen neuen Spezialisten starten (Subprozess auf dem User-PC: Claude-CLI fuer opus/sonnet/haiku-Modelle, Gemini-Runtime fuer gemini-*-Modelle).',
        params: 'project (req), name (req), model (req), expertise (req), task (req), project_path?, channel?, keep_alive?, allowed_tools?, cwd? — project_path wird via REST automatisch aus dem Daemon-Kontext ermittelt',
        example: 'specialist({ action: "spawn", project: "synapse", name: "doc-bot", model: "haiku", expertise: "Doku", task: "Schreibe README" })',
        tips: 'Web-KI: Job laeuft via Queue, Antwort innerhalb 60s. Bei Timeout pruefe ob Daemon laeuft.',
      },
      spawn_batch: {
        description: 'Mehrere Spezialisten atomar in einem Call starten (1..10).',
        params: 'project (req), specialists (req, Array von { name, model, expertise, task, channel?, allowed_tools?, keep_alive? }), project_path? — auto-resolved via REST',
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
        params: 'project (req), name (req, String oder Array fuer Batch-Status)',
        example: 'specialist({ action: "status", project: "synapse", name: "doc-bot" })',
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
    param_tips: 'ops[]: 1..100 Operationen, jede mit eigenem file_path + action. anchor_text/anchor_contains pro Op = Drift-Schutz. ACHTUNG: history hier hat dieselbe agent_id-FILTER-Falle wie files(history) — fuer volle Projekt-History agent_id weglassen.',
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

};
