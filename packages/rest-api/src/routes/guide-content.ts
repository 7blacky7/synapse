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
}

// ===========================================================================
// OVERVIEW — bei guide() ohne Parameter
// ===========================================================================

export const GUIDE_OVERVIEW = `
# Synapse REST-API — Quick-Start fuer Web-KIs

Du bist mit einem Synapse-Projekt verbunden. 17 Tools + dieses guide-Tool.

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

**Shell & Runtime** (wenn Projekt-PC aktiv):
  shell

**Agenten-Koordination** (nur lokal MCP, nicht REST):
  chat, channel, event, specialist

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
  // shell — das neue Queue-basierte Tool
  // -------------------------------------------------------------------------
  shell: {
    summary: 'Fuehrt Shell-Kommandos auf dem lokalen Projekt-PC aus (via PostgreSQL-Queue + FileWatcher-Daemon).',
    when_to_use: [
      'Ein-Zeilen-Commands fuer Status-Checks (git log, ls, pwd).',
      'Build-/Test-Ausfuehrung (pnpm build, pytest).',
      'Wenn code_intel/files nicht reichen (z.B. find, ripgrep-Flags).',
    ].join(' '),
    when_not_to_use: [
      'Datei lesen/schreiben — nutze files.',
      'Code suchen — nutze code_intel oder search.',
      'Langlaufende Prozesse (>60s) — timeout kommt dir in die Quere.',
      'Shell-Pipelines mit Interaktion (stdin) — nicht unterstuetzt.',
    ].join(' '),
    param_tips: [
      'project: Pflicht, muss auf dem Daemon aktiv sein (sonst rejected).',
      'timeout_ms: Default 30000. Bei langen Commands hoeher, aber max 90s sinnvoll.',
      'cwd_relative: Pfad RELATIV zum Projekt-Root (z.B. "packages/core"), kein absoluter Pfad.',
      'tail_lines: Default 5. Auf 20-50 erhoehen wenn du mehr Output willst.',
    ].join('\\n'),
    examples: [
      'shell({ action: "exec", project: "synapse", command: "git status --short" })',
      'shell({ action: "exec", project: "synapse", command: "pnpm --filter @synapse/core build", timeout_ms: 60000 })',
      'shell({ action: "exec", project: "synapse", command: "ls -la", cwd_relative: "packages/rest-api" })',
    ],
    anti_patterns: [
      'command: "sudo ..." — Daemon laeuft als User, sudo wird nicht funktionieren.',
      'command: "vim file.ts" — interaktive Tools hingen.',
      'Sensible Daten in command (Passwords, API-Keys) — werden in shell_jobs-Tabelle gespeichert.',
      'Destruktive Commands ohne Dry-Run (rm -rf, DROP TABLE) — IMMER erst echo + confirm.',
    ],
    actions: {
      exec: {
        description: 'Kommando synchron ausfuehren, Ergebnis in Response.',
        params: 'project (req), command (req), timeout_ms, tail_lines, cwd_relative',
        example: 'shell({ action: "exec", project: "synapse", command: "echo hallo" })',
        tips: 'Default action — wenn du kein action angibst, ist es "exec".',
      },
      get_stream: {
        description: 'Noch nicht implementiert via REST — gibt 501.',
        tips: 'Fuer long-running Commands: erhoeh timeout_ms. Wenn nicht reicht, split in kleinere Commands.',
      },
    },
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
      'code_intel({ action: "file", project: "synapse", file_path: "README.md", line_start: 1, line_end: 50 })',
    ],
    anti_patterns: [
      'file-Action OHNE line_start/line_end auf grossen Dateien — TOKEN-BOMBE.',
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
        description: 'Datei-Inhalt lesen.',
        params: 'file_path (req), line_start, line_end',
        example: 'code_intel({ action: "file", project: "synapse", file_path: "README.md", line_start: 1, line_end: 100 })',
        tips: 'Bei Dateien > 500 Zeilen IMMER line_start/line_end setzen. Sonst Token-Overflow.',
      },
    },
  },

  // -------------------------------------------------------------------------
  // files — Datei-Manipulation
  // -------------------------------------------------------------------------
  files: {
    summary: 'Dateien erstellen/bearbeiten/lesen. FileWatcher synct auf Dateisystem.',
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
        description: 'Datei lesen mit Zeilenbereich.',
        params: 'file_path, line_start, line_end',
        tips: 'Bei Code bevorzuge code_intel(file) — der hat mehr Context-Info (function boundaries etc.).',
      },
      search_replace: {
        description: 'Gezielter String-Replace. search muss exakt matchen.',
        params: 'search, replace',
        example: 'files({ action: "search_replace", project: "synapse", file_path: "x.ts", search: "const x = 1", replace: "const x = 2" })',
        tips: 'Bei mehrdeutigem Match: nimm mehr Umgebungs-Kontext in search.',
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
    },
  },

  // -------------------------------------------------------------------------
  // Weitere Tools — Platzhalter, werden von Spezialist ausgefuellt
  // -------------------------------------------------------------------------

  admin: {
    summary: 'Projekt-Management: Statistiken, Ideen, Media-Indexierung. Entry-Point fuer Agenten.',
    when_to_use: 'admin(action: "index_stats") als ERSTE Aktion in neuer Session — laedt Projekt-Regeln.',
    when_not_to_use: 'Fuer Code-Operationen: nutze code_intel oder files.',
    param_tips: 'agent_id setzen fuer Onboarding-Hinweise beim index_stats-Call.',
  },

  search: {
    summary: 'Semantische Suche (Embeddings) in Code, Memories, Thoughts, Docs.',
    when_to_use: 'Konzeptuelle Suchen ("wie funktioniert Authentifizierung?"), fuzzy Queries.',
    when_not_to_use: 'Exakte Symbol-Suche → code_intel. Englisch bevorzugen (bessere Scores).',
    param_tips: 'action: code|memory|thoughts|docs|path. limit: 5-10. Score > 0.65 = verlaesslich.',
  },

  memory: {
    summary: 'Projekt-Wissen lesen/schreiben (Rules, Architektur, Entscheidungen, Notizen).',
    when_to_use: 'Langlebiges Wissen das ueber Sessions bestehen soll. category passend setzen.',
    when_not_to_use: 'Ephemer Kontext → thought. Code-Erklaerung → Kommentare in Datei.',
    param_tips: 'category: rules|architecture|decision|note|documentation. name kurz + sprechend.',
  },

  thought: {
    summary: 'Gedanken speichern/suchen — Kommunikation mit Koordinator + Team.',
    when_to_use: 'Kurze Beobachtungen, Task-Updates, Session-Handoffs, Ergebnis-Reports.',
    when_not_to_use: 'Langlebiges Wissen → memory. Code-Kommentar → files.',
    param_tips: 'tags setzen fuer spaetere Filterung. source = deine agent_id.',
  },

  plan: {
    summary: 'Projekt-Plan + Tasks verwalten.',
    when_to_use: 'Tasks hinzufuegen, Plan aktualisieren.',
    when_not_to_use: 'Ad-hoc To-Dos → thought mit Tag "task".',
  },

  proposal: {
    summary: 'Verbesserungsvorschlaege fuer das Projekt einreichen.',
    when_to_use: 'Architektur-Vorschlaege, Feature-Ideen, Refactoring-Pattern.',
  },

  docs: {
    summary: 'Framework-/Tech-Dokumentation durchsuchen (mit Context7-Fallback).',
    when_to_use: 'Library-API nachschlagen, Breaking-Changes pruefen, Migration-Guides.',
    param_tips: 'framework: z.B. "fastify", "react". get_for_file fuer Datei-spezifische Warnungen.',
  },

  project: {
    summary: 'Projekt-Lifecycle: init, stop, cleanup, status, list.',
    when_to_use: 'init beim ersten Aufruf fuer ein Projekt. status fuer Diagnose.',
    when_not_to_use: 'admin hat aehnliche Funktionen — project ist mehr fuer Setup/Teardown.',
  },

  code_check: {
    summary: 'Error-Pattern-System — bekannte Fehler speichern + bei Writes pruefen.',
    when_to_use: 'Nach einem Code-Fehler: add_pattern. Zum Inspizieren: list_patterns.',
    param_tips: 'severity: error|warning|info. found_in_model: haiku|sonnet|opus — scoped Warnungen.',
  },

  chat: {
    summary: 'NUR lokal verfuegbar (stdio MCP). Ueber REST-API nicht nutzbar.',
    when_to_use: 'NICHT in Web-KI-Sessions — nutze thought/memory fuer Kommunikation.',
    when_not_to_use: 'Immer — Web-KIs haben keinen Chat-Zugang.',
  },

  channel: {
    summary: 'NUR lokal verfuegbar. Web-KIs koennen nicht posten/lesen.',
    when_to_use: 'NICHT — nutze thought fuer Team-Updates.',
    when_not_to_use: 'Immer aus Web-KI.',
  },

  event: {
    summary: 'NUR lokal verfuegbar. Steuersignale fuer Spezialisten.',
    when_to_use: 'NICHT aus Web-KI.',
    when_not_to_use: 'Immer aus Web-KI.',
  },

  specialist: {
    summary: 'NUR lokal verfuegbar. Startet Claude-CLI-Subprozesse.',
    when_to_use: 'NICHT aus Web-KI.',
    when_not_to_use: 'Immer aus Web-KI.',
  },

  watcher: {
    summary: 'NUR lokal verfuegbar. FileWatcher-Daemon-Steuerung.',
    when_to_use: 'NICHT aus Web-KI.',
    when_not_to_use: 'Immer aus Web-KI.',
  },

};
