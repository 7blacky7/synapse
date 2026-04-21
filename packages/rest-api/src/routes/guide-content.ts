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
    summary: 'Langlebiges Projekt-Wissen lesen, schreiben und verwalten (Architektur, Regeln, Entscheidungen).',
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
        description: 'Memory loeschen (einzeln oder Batch).',
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
        description: 'Thought loeschen (einzeln oder Batch).',
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
    },
  },

  proposal: {
    summary: 'Verbesserungsvorschlaege (Proposals) einreichen, verwalten und Status verfolgen.',
    when_to_use: [
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
        description: 'Proposal loeschen (einzeln oder Batch).',
        params: 'project (req), id (req, String oder Array), dry_run, max_items',
        example: 'proposal({ action: "delete", project: "synapse", id: "abc123" })',
        tips: 'Batch: id als Array + dry_run: true fuer Preview.',
      },
    },
  },

  docs: {
    summary: 'Tech-Dokumentation indexieren, durchsuchen und Datei-spezifische Warnungen abrufen (Wissens-Airbag).',
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
