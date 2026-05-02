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

Du bist mit einem Synapse-Projekt verbunden. 17 Tools + dieses guide-Tool.

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
4. memory(action: "list")             — welches Projekt-Wissen existiert?
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

**Shell & Runtime** (braucht aktiven Watcher + shell-Worker auf dem Ziel-PC):
  shell — Befehle laufen ueber PG-Queue, der lokale Worker fuehrt sie aus. Ist der Watcher aus, bleiben Jobs pending.

**Agenten-Koordination** (PostgreSQL-basiert, ueberall verfuegbar):
  chat, channel, event — REST und lokaler MCP gleichermassen.
  specialist — REST UND lokal: spawn / wake / stop / purge / update_skill funktionieren ueberall, solange auf dem Ziel-PC der Watcher laeuft. Einzige Einschraenkung: Live-Wrapper-Status (status / capabilities) nur via lokalem MCP.
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
    summary: 'Fuehrt Shell-Kommandos auf dem Ziel-PC aus (via PostgreSQL-Queue + lokalem shell-Worker im FileWatcher-Daemon). Funktioniert sowohl ueber lokalen MCP als auch ueber REST/Web-KI — solange auf dem Ziel-PC der Watcher laeuft. Voller Output in PG persistiert — Logs koennen Stunden spaeter abgerufen werden. Fehlerinterpretation: error="project_inactive" → Projekt im Tray aktivieren. Status bleibt "pending" und ueberschreitet den timeout_ms ohne dass irgendetwas passiert → Watcher laeuft nicht (Daemon down auf dem Ziel-PC). Sofortige Validierungs-Fehler (Syntax/Pfad) → eigene Eingabe pruefen.',
    when_to_use: [
      'Ein-Zeilen-Commands fuer Status-Checks (git log, ls, pwd).',
      'Build-/Test-Ausfuehrung (pnpm build, pytest).',
      'Wenn code_intel/files nicht reichen (z.B. find, ripgrep-Flags).',
      'Vergangene Job-Ausgabe nachschlagen — auch wenn die MCP-Connection in der Zwischenzeit weg war: history → get → log.',
    ].join(' '),
    when_not_to_use: [
      'Datei lesen/schreiben — nutze files.',
      'Code suchen — nutze code_intel oder search.',
      'Langlaufende Prozesse (>60s) — timeout kommt dir in die Quere.',
      'Shell-Pipelines mit Interaktion (stdin) — nicht unterstuetzt.',
    ].join(' '),
    param_tips: [
      'project: Pflicht fuer exec, muss auf dem Daemon aktiv sein. Bei nicht-aktivem Projekt: status=rejected, error=project_inactive, message="Projekt ist inaktiv. Bitte im Tray aktivieren."',
      'timeout_ms: Default 30000. Bei langen Commands hoeher, aber max 90s sinnvoll.',
      'cwd_relative: Pfad RELATIV zum Projekt-Root (z.B. "packages/core"), kein absoluter Pfad.',
      'tail_lines: Default 5. Auf 20-50 erhoehen wenn du im exec-Result direkt mehr sehen willst — fuer den vollen Output ist aber action:"get" oder "log" besser.',
      'response: success(true|false) + status + tail; bei history zusaetzlich output_line_count + source ("mcp_local" | "daemon-<host>-<pid>"); bei error: actionable message.',
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
        description: 'Kommando synchron ausfuehren, Ergebnis in Response. Voller Output wird automatisch in PG gespeichert (gecappt 1MB).',
        params: 'project (req), command (req), timeout_ms, tail_lines, cwd_relative',
        example: 'shell({ action: "exec", project: "synapse", command: "echo hallo" })',
        tips: 'Default action — wenn du kein action angibst, ist es "exec". Bei project_inactive bekommst du klare message statt stillem Hangen.',
      },
      get_stream: {
        description: 'Live-Tail eines laufenden Jobs (nur via lokalem MCP, REST gibt 501).',
        tips: 'Fuer long-running Commands ueber REST: timeout_ms hoch + spaeter via "get" oder "log" abholen.',
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
    },
    workflow_examples: [
      'Workflow: Long-running Build im Hintergrund starten + spaeter Status pruefen.\\n  1) shell({ action: "exec", project: "synapse", command: "pnpm -r build", timeout_ms: 5000 }) → status=timeout, stream_id zurueck\\n  2) ... beliebig spaeter ...\\n  3) shell({ action: "history", project: "synapse", limit: 5 }) → letzten Job finden\\n  4) shell({ action: "get", id: "<uuid>" }) → status=done/failed, voller output',
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
      'Code durchsuchen: search (PG-Volltext + Qdrant-Fallback).',
    ].join(' '),
    when_not_to_use: [
      'Konzeptuelle Fragen ("wie funktioniert X?") — nutze search(action: "code") (semantisch).',
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
        tips: 'with_values: true fuer Config-/Konstanten-Inspektion.',
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
        description: 'PG-Volltextsuche auf Code mit Qdrant-Fallback.',
        params: 'query (req), file_type, limit',
        example: 'code_intel({ action: "search", project: "synapse", query: "enqueueShellJob", file_type: "ts", limit: 5 })',
        tips: 'Fuer fuzzy/konzeptuelle Suche besser search(action: "code") — das ist semantisch (Embeddings).',
      },
      file: {
        description: 'Datei-Inhalt lesen. Liefert immer total_lines und returned_range: { from, to, eof }.',
        params: 'file_path (req); optional: from_line (1-basiert, Standard 1), to_line (inklusiv, Standard Ende), truncate_long_lines (Zeilen > N kuerzen + Marker, 0 = aus)',
        example: 'code_intel({ action: "file", project: "synapse", file_path: "README.md", from_line: 1, to_line: 100 })',
        tips: [
          'Auto-Reduce: Range > 80k Zeichen wird automatisch reduziert — returned_range.eof=false zeigt das an.',
          'Workflow grosse Datei: 1. Ersten Call ohne from/to → total_lines pruefen. 2. Paginieren mit from_line=returned_range.to+1.',
          'Beispiel: returned_range: { from:1, to:50, eof:false }, total_lines:102 → naechster Call mit from_line:51.',
          'Sehr lange Zeilen: truncate_long_lines=200 setzen.',
        ].join(' '),
      },
    },
  },

  // -------------------------------------------------------------------------
  // files — Datei-Manipulation
  // -------------------------------------------------------------------------
  files: {
    summary: 'Dateien erstellen/bearbeiten/lesen. FileWatcher synct auf Dateisystem. Auto-Versionierung (versions/restore). Multi-File Plan/Commit fuer atomare Aenderungen ueber mehrere Dateien (plan/commit/cancel). Audit-Log mit Begruendungen via "history" — fuer Crash-Recovery.',
    when_to_use: [
      'Neue Datei anlegen: create.',
      'Gezielte Aenderung in bestehender Datei: search_replace oder replace_lines.',
      'Einzelne Zeilen einfuegen: insert_after.',
      'Datei lesen (kleine): read — fuer grosse nutze code_intel(file) mit Zeilenbereich.',
      'Datei verschieben/kopieren: move/copy.',
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
      'agent_id angeben bei writes — aktiviert Error-Pattern-Check (warnt vor bekannten Fehlern).',
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
      'create auf existierende Datei — ueberschreibt ohne Warnung!',
    ],
    actions: {
      create: {
        description: 'Neue Datei erstellen. Ueberschreibt falls schon da.',
        params: 'file_path, content',
        example: 'files({ action: "create", project: "synapse", file_path: "test.txt", content: "hi" })',
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
        description: 'Phase A eines Multi-File-Edits: nimmt ops[] (1..100, mehrere Dateien), liest betroffene Dateien, dry-runs jede Op, erfasst expected_hashes und Previews. Liefert plan_id zurueck. Kein Schreiben in dieser Phase!',
        params: 'project (req), ops (req, Array von { file_path, action, ...op-spezifische Felder }), agent_id, open_for_coedit',
        example: 'files({ action: "plan", project: "synapse", agent_id: "ich", ops: [{ file_path: "neu.ts", action: "create", content: "export const x = 1;" }, { file_path: "a.ts", action: "search_replace", search: "old", replace: "new" }] })',
        tips: 'Plan laeuft nach 5 Minuten ab. Bei Op-Fehler im Trockenlauf wird der Plan NICHT angelegt — sofortige Fehlermeldung. Op-Actions: create (neue Datei, content erforderlich, nur als erste Op auf einer Datei), update, search_replace, search_replace_batch, replace_lines, insert_after, delete_lines.',
      },
      commit: {
        description: 'Phase B: wendet alle Ops eines Plans atomar an (PG-TX). Pruefung gegen expected_hashes — wenn eine Datei seit dem Plan extern geaendert wurde, kommt status="stale" mit Konflikt-Details. Bei Erfolg tragen alle file_versions-Snapshots die batch_id=plan_id (-> restore_batch).',
        params: 'plan_id (req), agent_id',
        example: 'files({ action: "commit", project: "synapse", plan_id: "42", agent_id: "ich" })',
        tips: 'Bei stale: neu plannen mit aktuellem Stand. Bei Erfolg: batch_id merken fuer evtl. Rollback via files(action: "restore_batch", batch_id).',
      },
      cancel: {
        description: 'Plan abbrechen (Soft-Delete: status="cancelled"). Nur moeglich solange status=open.',
        params: 'plan_id (req)',
        example: 'files({ action: "cancel", project: "synapse", plan_id: "42" })',
      },
      plan_status: {
        description: 'Plan-Details abfragen (Status, Previews, Files, reason). Fuer Status-Polling oder Diff-Inspektion vor commit.',
        params: 'plan_id (req)',
        example: 'files({ action: "plan_status", project: "synapse", plan_id: "42" })',
      },
      history: {
        description: 'Audit-Log: chronologische Liste aller Datei-Aenderungen mit Begruendung. Crash-Recovery: nach Session-Crash kann eine neue Session sehen "wer hat wann was warum geaendert" und gegebenenfalls Versionen wiederherstellen.',
        params: 'project (req); optional: agent_id (Filter), file_path (Praefix-Match), since (ISO-Timestamp), limit (Standard 50, Max 500)',
        example: 'files({ action: "history", project: "synapse", agent_id: "ich", since: "2026-05-02T10:00:00Z", limit: 20 })',
        tips: 'reason wird beim Schreiben mitgegeben (files write-actions + plan/commit). Eintraege haben file_path, edit_action, agent_id, batch_id, reason, created_at. Voller Inhalt einer Version: files(action: "get_version", version_id).',
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
        description: 'Alle Memories auflisten (optional nach category filtern).',
        params: 'project (req), category',
        example: 'memory({ action: "list", project: "synapse", category: "rules" })',
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
        description: 'Neuen Thought speichern.',
        params: 'project (req), source (req, deine agent_id), content (req), tags',
        example: 'thought({ action: "add", project: "synapse", source: "mein-agent", content: "Analyse abgeschlossen", tags: ["status", "done"] })',
        tips: 'source = deine agent_id. NIEMALS "claude-code".',
      },
      add_batch: {
        description: 'Mehrere Thoughts atomar speichern (1..50 Items in einem Call).',
        params: 'project (req), source (req, gilt fuer alle Items), items (req, Array von { content, tags? })',
        example: 'thought({ action: "add_batch", project: "synapse", source: "mein-agent", items: [{ content: "Erkenntnis 1", tags: ["analyse"] }, { content: "Erkenntnis 2" }] })',
        tips: 'Bei >5 Thoughts IMMER add_batch statt parallele add-Calls — atomar, ein Embedding-Call, kein Cloudflare-Stress.',
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
    summary: 'Projekt-Plan und Tasks verwalten: abrufen, aktualisieren und neue Tasks hinzufuegen.',
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
        description: 'Wissens-Airbag: Relevante Warnings/Docs fuer eine Datei abrufen.',
        params: 'file_path (req, String oder Array), agent_id (req), project (req)',
        example: 'docs({ action: "get_for_file", file_path: "src/api.ts", agent_id: "mein-agent", project: "synapse" })',
        tips: 'VOR jeder Datei-Bearbeitung aufrufen. Array fuer Multi-File. Warnings NICHT ignorieren.',
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
        description: 'Neues Projekt initialisieren (einmalig). Legt Collections an, startet FileWatcher.',
        params: 'path (req, absolut), name, index_docs (Standard: true), agent_id',
        example: 'project({ action: "init", path: "/home/user/dev/myproject", index_docs: true })',
        tips: 'Einmalig aufrufen. index_docs: true empfohlen fuer Wissens-Airbag.',
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
    summary: 'Steuersignale fuer Agenten (WORK_STOP, NEW_TASK, ANNOUNCEMENT, …). Verfuegbar lokal UND via REST (PostgreSQL). Pflicht-Reaktion: ack innerhalb weniger Tool-Calls, sonst Eskalation an Koordinator. emit akzeptiert optional events[] (1..50) fuer Bulk-Emit; ack akzeptiert event_id als Array (Batch-Ack).',
    when_to_use: 'Koordinator emittiert Event an Agent(en): emit (mit scope: "all" oder "agent:<id>"). Agent quittiert empfangenes Event: ack. Agent prueft offene Events: pending.',
    when_not_to_use: 'Lockere Updates ohne Pflicht → thought oder channel. Direkte 1:1 Frage → chat DM. Langlebige Anweisung → memory.',
    actions: {
      emit: { description: 'Event senden (event_type, priority: critical|high|normal, scope, source_id, payload).' },
      ack: { description: 'Event quittieren (event_id einzeln oder als Array fuer Batch-Ack).' },
      pending: { description: 'Eigene unacked Events abrufen (project + agent_id Pflicht).' },
    },
    anti_patterns: [
      'critical-Event 3+ Tool-Calls ignorieren — Eskalation an Koordinator.',
      'emit ohne source_id — Agent weiss nicht wer das Signal geschickt hat.',
      'Batch-ack mit gemischten Event-Typen ohne Reaktion — quittieren ohne tatsaechlich zu reagieren.',
    ],
  },

  specialist: {
    summary: 'Persistente Claude-CLI Spezialisten auf dem Ziel-PC spawnen, stoppen, ansprechen. Funktioniert sowohl lokal als auch ueber REST/Web-KI — Voraussetzung in beiden Faellen: auf dem Ziel-PC laeuft der FileWatcher-Daemon (er hostet PG-Queue → Claude-CLI). Fehlerinterpretation: spawn timeoutet ohne PID/Socket in der Antwort → Watcher down ODER Claude-CLI fehlt auf dem Ziel-PC. Spezifischer Fehler wie "name contains illegal characters" / "project not found" → Eingabe pruefen. wake antwortet nie / Inbox-Fallback → Spezialist gestorben oder Watcher-Heartbeat haengt.',
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
      'model: opus / sonnet / haiku (200k Context). opus[1m] / sonnet[1m] = 1M Context.',
      'keep_alive: true fuer langlaufende Spezialisten (Auto-Respawn bei Crash). Default false fuer One-Shot.',
      'Voraussetzung: FileWatcher-Daemon laeuft auf dem User-PC + Claude-CLI installiert + Projekt im Tray aktiv.',
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
        description: 'Einen neuen Spezialisten starten (Claude-CLI-Subprozess auf dem User-PC).',
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
        description: 'Pruefen ob Claude CLI auf dem Ziel-PC verfuegbar ist. Lokaler MCP: liest direkt vom Filesystem. Web-KI/REST: Stub. In der Praxis nicht noetig — wer Spezialisten nutzt, hat Claude installiert. Wenn spawn fehlschlaegt: error_code interpretieren (siehe summary).',
        params: '—',
        example: 'specialist({ action: "capabilities" })',
      },
    },
  },

  watcher: {
    summary: 'FileWatcher-Daemon-Steuerung (start/stop/status) — der Watcher laeuft lokal auf dem Ziel-PC und synct PG <-> Filesystem. Nur ueber lokalen MCP-Server steuerbar (REST hat keine FS-Zugriffe, kann den Daemon nicht erreichen). Sind Watcher und shell-Worker auf dem Ziel-PC NICHT aktiv, kommen Datei-Edits und shell-Jobs aus REST nicht durch.',
    when_to_use: 'Daemon-Status pruefen / starten / stoppen, wenn man auf dem Ziel-PC sitzt. Sync-Probleme debuggen. Indirekt geht status auch ueber project(action: "status").',
    when_not_to_use: 'Aus REST/Web-KI — wird mit Fehler abgewiesen. Fuer normale Datei-Edits → files (Watcher synct automatisch wenn er laeuft).',
  },

};
