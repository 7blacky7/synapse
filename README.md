# 🧠 Synapse — KI-Gedächtnis & Agenten-Orchestrierung

> Persistentes Projekt-Wissen, semantische Code-Suche und Multi-Agent-Koordination über MCP.
>
> Synapse gibt KI-Agenten ein Langzeitgedächtnis: Code wird automatisch indexiert, Wissen bleibt über Sessions erhalten, und mehrere Agenten können koordiniert an einem Projekt arbeiten — mit Chat, Events, Wissens-Airbag und automatischer Dokumentations-Recherche.

```
Du (User)
  │
  ├─ Claude Code ──── MCP Server (stdio) ────┐
  ├─ Claude Desktop ─ MCP Server (stdio) ────┤
  ├─ Gemini CLI ───── REST API (http) ───────┤
  └─ ChatGPT ──────── REST API (http) ───────┤
                                              │
                                    ┌─────────▼──────────┐
                                    │    SYNAPSE CORE     │
                                    │                     │
                                    │  FileWatcher        │
                                    │  Code-Intelligence  │
                                    │  Embeddings (Google)│
                                    │  Tech-Detection     │
                                    │  Context7 Client    │
                                    │  Agenten-Chat       │
                                    │  Event-System       │
                                    │  Wissens-Airbag     │
                                    └──┬──────────┬───────┘
                                       │          │
                              ┌────────▼──┐  ┌───▼────────┐
                              │  Qdrant   │  │ PostgreSQL  │
                              │  (Vektor) │  │ (Relational)│
                              │           │  │             │
                              │ Code      │  │ Memories    │
                              │ Memories  │  │ Thoughts    │
                              │ Thoughts  │  │ Plans       │
                              │ Proposals │  │ Proposals   │
                              │ Tech-Docs │  │ Chat        │
                              │ Media     │  │ Sessions    │
                              └───────────┘  │ Tech-Docs   │
                                             │ Events      │
                                             │ Event-Acks  │
                                             │ Channels    │
                                             │ Code-Symbols│
                                             │ Code-Refs   │
                                             │ Code-Chunks │
                                             └─────────────┘
```

---

## ✨ Features

| Feature | Beschreibung |
|---------|--------------|
| 🔍 **Semantische Code-Suche** | FileWatcher indexiert Code automatisch. Vektor-Suche über Qdrant findet konzeptuell ähnlichen Code — nicht nur String-Matches. Google Embeddings (3072d). |
| 🧠 **Persistentes Projekt-Wissen** | Memories (Architektur, Regeln), Thoughts (Erkenntnisse), Plans (Ziele, Tasks), Proposals (Code-Vorschläge), Tech-Docs — alles überlebt Session-Grenzen. |
| 💬 **Multi-Agent Chat** | Broadcast-Nachrichten an alle Agenten oder gezielte DMs. Polling-basiert mit `since`-Timestamp. Ungelesene Nachrichten werden in jeder Tool-Response eingeblendet. |
| ⚡ **Event-System** | Verbindliche Steuersignale (WORK_STOP, CRITICAL_REVIEW, ...) mit Pflicht-Ack. Eskalation nach 3 ignorierten Calls. Prioritäten: critical, high, normal. |
| 🤖 **Agenten-Koordination** | Koordinator-Muster: Opus dispatcht Sonnet/Haiku-Agenten. Batch-Registrierung, automatisches Onboarding, Coordinator-Watch für Idle-Aufwachen. |
| 🧑‍🔬 **Persistente Spezialisten** | Dauerhaft laufende Claude-Agenten (Subprozess + Unix Socket). Eigene SKILL.md pro Agent wächst mit jedem Einsatz. Auto-Wake via `wake`, Heartbeat-Polling (15s), Context-Ceiling-Tracking. |
| 🔄 **Context-Handoff** | Automatische Session-Übergabe wenn das Context-Window voll wird. Fortschritt in Synapse gespeichert, neue Session liest nahtlos weiter. |
| 📚 **Tech-Docs Auto-Fetch** | `search_tech_docs` holt automatisch Docs von [Context7](https://context7.com) wenn keine lokalen Ergebnisse. Docs-Kurator (Opus) recherchiert kuratierte Breaking Changes. |
| 🛡️ **Wissens-Airbag** | `get_docs_for_file` zeigt vor jeder Datei-Bearbeitung Breaking Changes, Migration-Warnungen und Gotchas — nur was neuer als der Agent-Cutoff ist. |
| 👁️ **FileWatcher** | Chokidar-basiert. Erkennt Änderungen in Echtzeit → Chunking → Google Embedding → Qdrant. Respektiert `.synapseignore`. |
| 🔔 **Coordinator-Watch** | Background-Daemon pollt alle 10s auf neue Chat-Nachrichten und Events. Weckt den Koordinator im Idle via Task-Notification. |
| 🖼️ **Media-Suche** | Cross-Modal Suche: Bilder und Videos per Text-Query finden (Google Gemini Embedding 2). |
| 🔧 **Tech-Detection** | Erkennt automatisch Frameworks, Libraries und Tools im Projekt. |
| 📢 **Kanäle** | Spezialistengruppen-Kommunikation - Agenten können gezielt in Kanälen kommunizieren und Fachgruppen bilden. |
| 🧩 **Code-Intelligence** | Strukturierte Code-Analyse aus PostgreSQL: Funktionen, Variablen, Symbole, Referenzen, Dateibaum, Volltext-Suche. 61 Sprach-Parser (Regex-basiert). Kein Embedding nötig — sofortige Ergebnisse. |

---

## 🏗️ Architektur

### Monorepo-Packages

| Package | Beschreibung | Läuft auf |
|---------|--------------|----------|
| `@synapse/core` | Gemeinsamer Kern — Services, DB, Embeddings, FileWatcher, Events | - |
| `@synapse/mcp-server` | MCP Server (stdio) für Claude Code, Claude Desktop, Cline | User PC |
| `@synapse/rest-api` | REST API (Fastify, HTTP) für Web-KIs (Claude.ai, ChatGPT, Gemini) | Server |
| `@synapse/web-ui` | Web-Dashboard (React, in Entwicklung) | - |
| `@synapse/agents` | Agenten-Koordination und Session-Management | - |

### Datenfluss

```
Datei gespeichert
  → FileWatcher (Chokidar) erkennt Änderung
    → .synapseignore prüfen
      → Datei lesen + in Chunks aufteilen (1000 Zeichen, 200 Overlap)
        → Google Gemini Embedding (3072 Dimensionen)
          → Qdrant Vektor-DB (Upsert mit Metadaten)
```

### Dual-Storage (Write-Primary/Read-Primary, Eventual Consistency)

- **PostgreSQL** — **Write-Primary + Source of Truth** (Schreibvorgänge: Create, Update, Delete)
- **Qdrant** — **Read-Primary** (semantische Suche via Vektor-Index)

**Konsistenz-Modell:** Eventual Consistency (best-effort, kein Rollback bei Partial-Failure)

**Schreib-Flow:** PG first → Qdrant second (Ausnahme: code.ts schreibt Qdrant first)
**Fehlertoleranz:** Beide Writes in separaten try-catch, warning-Feld bei Partial-Failure

**Read-Pfade (by Design):**
- **Semantische Suche** (fuzzy/konzeptuell) → liest **Qdrant** (Read-Primary)
- **Strukturierte Queries** (Funktionen, Variablen, Referenzen) → liest **PostgreSQL** via Code-Intelligence
- **Schreibvorgänge** → PG first, Qdrant second

Jedes Projekt bekommt eigene Qdrant-Collections: `project_{name}_code`, `project_{name}_thoughts`, etc.

---

## 🛠️ MCP-Tools (14 konsolidierte Tools)

### 📦 Admin & Projekt-Management (`admin`)

**Actions:** `index_stats`, `migrate`, `restore`, `save_idea`, `confirm_idea`, `index_media`, `detailed_stats`

| Action | Beschreibung |
|--------|--------------|
| `index_stats` | Projekt-Statistiken + Agent-Onboarding |
| `migrate` | Embedding-Modell wechseln (Backup → Re-Embed) |
| `restore` | Daten aus JSONL-Backup wiederherstellen |
| `save_idea` | Projekt-Idee als Proposal speichern |
| `confirm_idea` | Idee bestätigen und persistent speichern |
| `index_media` | Bilder und Videos indexieren (Gemini Embedding 2) |
| `detailed_stats` | Aufschlüsselung nach Dateityp, Source, Kategorie |

**Beispiel:**
```
> admin(action: "index_stats", project: "synapse")

← { collections: 7, code_chunks: 1250, memories: 12, thoughts: 45,
     plans: 2, proposals: 8, tech_docs: 34, media: 0 }
```

---

### 🔍 Suche (`search`)

**Actions:** `code`, `path`, `code_with_path`, `memory`, `thoughts`, `proposals`, `tech_docs`, `media`

| Action | Beschreibung |
|--------|--------------|
| `code` | Konzeptuelle Suche — findet ähnlichen Code |
| `path` | Exakte Pfadsuche nach Glob-Pattern (absolute und relative Pfade, z.B. `packages/agents/src/**/*.ts`) |
| `code_with_path` | Kombiniert: Semantisch + Pfad-Filter |
| `memory` | Semantische Memory-Suche |
| `thoughts` | Thought-Suche (Erkenntnisse) |
| `proposals` | Proposal-Suche (Code-Vorschläge) |
| `tech_docs` | Framework-Dokumentation (mit Context7 Auto-Fetch) |
| `media` | Cross-Modal Suche: Bilder/Videos per Text-Query |

**Beispiele:**
```
> search(action: "code", query: "file watcher implementation", project: "synapse")

← [{ score: 0.72, file: "packages/core/src/watcher/index.ts",
      content: "export class FileWatcher { ... }", line: 15 }, ...]

> search(action: "memory", query: "commit conventions", project: "synapse")

← [{ score: 0.68, name: "commit-konventionen",
      content: "Konventionelle Commits auf Deutsch..." }]
```

> **Path-Suche Glob-Pattern:** Relative Pfade (z.B. `packages/agents/**/*.ts`) werden automatisch in SQL-Regex konvertiert und matchen überall im absoluten Pfad. Marker-basierte Konvertierung: `*` → `[^/]*`, `**` → `.*`, `?` → `.` — Sonderzeichen wie `.` werden escaped.

---

### 🧠 Memories (`memory`)

**Actions:** `write`, `read`, `read_with_code`, `list`, `delete`, `update`, `find_for_file`

| Action | Beschreibung |
|--------|--------------|
| `write` | Langform-Wissen speichern (Architektur, Regeln, Docs) |
| `read` | Memory nach Name laden |
| `read_with_code` | Memory + verwandten Code laden |
| `list` | Alle Memories auflisten |
| `delete` | Memory löschen |
| `update` | Memory aktualisieren (PostgreSQL + re-embed) |
| `find_for_file` | Relevante Memories für eine Datei finden |

**Beispiele:**
```
> memory(action: "write", project: "synapse", name: "projekt-regeln",
         category: "rules", content: "TypeScript + pnpm, Commits auf Deutsch")

← { success: true, id: "a142863e-..." }

> memory(action: "read", project: "synapse", name: "projekt-regeln")

← { name: "projekt-regeln", category: "rules",
     content: "TypeScript + pnpm, Commits auf Deutsch", tags: [] }
```

---

### 💭 Gedanken (`thought`)

**Actions:** `add`, `get`, `delete`, `update`, `search`

| Action | Beschreibung |
|--------|--------------|
| `add` | Kurze Erkenntnis speichern |
| `get` | Letzte Gedanken abrufen |
| `delete` | Thought löschen |
| `update` | Thought aktualisieren |
| `search` | Semantische Thought-Suche |

**Beispiel:**
```
> thought(action: "add", project: "synapse", source: "koordinator",
          content: "FileWatcher ignoriert .map Dateien nicht", tags: ["bug"])

← { id: "f1ec65f0-...", timestamp: "2026-03-27T07:17:19Z" }

> thought(action: "search", query: "FileWatcher bug", project: "synapse")

← [{ score: 0.71, id: "f1ec65f0-...", content: "FileWatcher ignoriert..." }]
```

---

### 📋 Pläne (`plan`)

**Actions:** `get`, `update`, `add_task`

| Action | Beschreibung |
|--------|--------------|
| `get` | Plan abrufen (Ziele, Tasks, Architektur) |
| `update` | Plan aktualisieren |
| `add_task` | Task zum Plan hinzufügen |

**Beispiel:**
```
> plan(action: "get", project: "synapse")

← { name: "synapse-roadmap", goals: ["Multi-Agent Orchestrierung", "61 Parser"],
     tasks: [{ id: 1, title: "Event-System Bug fixen", status: "done" },
             { id: 2, title: "REST-API deployen", status: "in-progress" }] }

> plan(action: "add_task", project: "synapse",
       task: { title: "Reconciliation-Job", priority: "low" })

← { success: true, task_id: 3 }
```

---

### 📝 Proposals (`proposal`)

**Actions:** `list`, `get`, `update_status`, `delete`, `update`

| Action | Beschreibung |
|--------|--------------|
| `list` | Alle Proposals auflisten |
| `get` | Proposal nach ID abrufen |
| `update_status` | Status ändern (pending → reviewed → accepted) |
| `delete` | Proposal löschen |
| `update` | Proposal-Inhalt ändern |

**Beispiel:**
```
> proposal(action: "list", project: "synapse", status: "pending")

← [{ id: "abc-123", file_path: "src/server.ts", author: "analyst",
      description: "Event-Hint Fix", status: "pending" }]

> proposal(action: "update_status", project: "synapse", id: "abc-123", status: "accepted")

← { success: true }
```

---

### 💬 Chat (`chat`)

**Actions:** `register`, `unregister`, `register_batch`, `unregister_batch`, `send`, `get`, `list`, `inbox_send`, `inbox_check`

| Action | Beschreibung |
|--------|--------------|
| `register` | Agent registrieren (mit Cutoff-Erkennung) |
| `unregister` | Agent abmelden |
| `register_batch` | Mehrere Agenten auf einmal registrieren |
| `unregister_batch` | Mehrere Agenten abmelden |
| `send` | Broadcast (alle) oder DM (ein Agent) senden |
| `get` | Nachrichten abrufen (Polling via `since`) |
| `list` | Aktive Agenten auflisten |
| `inbox_send` | Nachricht in Inbox eines Agenten |
| `inbox_check` | Inbox eines Agenten prüfen |

**Beispiele:**
```
> chat(action: "register", id: "koordinator", project: "synapse", model: "claude-opus-4-6")

← { session: { id: "koordinator", model: "claude-opus-4-6", cutoffDate: "2025-05-01" } }

> chat(action: "send", project: "synapse", sender_id: "koordinator",
       content: "Bitte src/tools/ analysieren")

← { id: 42, broadcast: true, recipients: 3 }

> chat(action: "send", project: "synapse", sender_id: "koordinator",
       recipient_id: "analyst", content: "Fokus auf events.ts")

← { id: 43, dm: true }

> chat(action: "get", project: "synapse", agent_id: "koordinator", limit: 5)

← [{ sender_id: "analyst", content: "Events.ts hat 7 Findings", timestamp: "..." }]
```

---

### 📢 Kanäle (`channel`)

**Actions:** `create`, `join`, `leave`, `post`, `feed`, `list`

| Action | Beschreibung |
|--------|--------------|
| `create` | Kanal für Spezialisten-Gruppen erstellen |
| `join` | Agent zu Kanal hinzufügen |
| `leave` | Agent aus Kanal entfernen |
| `post` | Nachricht in Kanal posten |
| `feed` | Kanal-Nachrichten abrufen |
| `list` | Alle Kanäle auflisten |

**Beispiel:**
```
> channel(action: "create", project: "synapse", name: "code-review",
          description: "Code-Review Diskussionen", created_by: "koordinator")

← { success: true, channel: "code-review" }

> channel(action: "post", channel_name: "code-review", sender: "analyst",
          content: "server.ts hat Race Condition in Zeile 472")

← { id: 12 }

> channel(action: "feed", channel_name: "code-review", limit: 5)

← [{ sender: "analyst", content: "server.ts hat Race Condition...", timestamp: "..." }]
```

---

### ⚡ Events (`event`)

**Actions:** `emit`, `ack`, `pending`

| Action | Beschreibung |
|--------|--------------|
| `emit` | Steuersignal an Agenten senden |
| `ack` | Event quittieren (Pflicht bei `requires_ack`) |
| `pending` | Unbestätigte Events abrufen |

**Beispiel:**
```
> event(action: "emit", project: "synapse", event_type: "WORK_STOP",
        priority: "critical", scope: "all", source_id: "koordinator",
        payload: "Breaking Change in API — alle Arbeit pausieren")

← { id: 7, delivered_to: ["analyst", "tester"] }

> event(action: "ack", event_id: 7, agent_id: "analyst", reaction: "Verstanden, pausiere")

← { success: true }
```

---

### 🤖 Spezialisten (`specialist`)

**Actions:** `spawn`, `stop`, `status`, `wake`, `update_skill`, `capabilities`

| Action | Beschreibung |
|--------|--------------|
| `spawn` | Spezialisten-Agent mit Expertise starten |
| `stop` | Agent stoppen |
| `status` | Agent-Status prüfen |
| `wake` | Agent mit Nachricht aufwecken |
| `update_skill` | Skill des Agenten aktualisieren |
| `capabilities` | Agenten-Fähigkeiten prüfen |

**Beispiele:**
```
> specialist(action: "spawn", name: "code-analyst", model: "haiku",
             expertise: "TypeScript Code-Analyse", project: "synapse")

← { name: "code-analyst", pid: 229045, status: "running", socket: "/tmp/synapse-..." }

> specialist(action: "wake", name: "code-analyst",
             message: "Analysiere alle Funktionen in packages/core/src/services/")

← { response: "Analyse gestartet...", tokens_used: 1250 }

> specialist(action: "status", name: "code-analyst")

← { name: "code-analyst", status: "running", tokens: 45000, ceiling: 200000,
     uptime: "2h 15m", lastActivity: "2026-03-27T07:30:00Z" }

> specialist(action: "update_skill", name: "code-analyst",
             section: "patterns", content: "Dual-Write immer PG→Qdrant Reihenfolge prüfen")

← { success: true, skill_size: 2048 }
```

Spezialisten sind **persistente Claude-Agenten** die als detached Subprozesse dauerhaft aktiv bleiben:

- **SKILL.md** — Jeder Spezialist hat eine eigene Wissensdatei (Regeln, Fehler, Patterns) die sich durch jeden Einsatz verbessert
- **Heartbeat** (15s, parallel zum Initial Wake) — Wrapper pollt Inbox, Chat und Events automatisch im Hintergrund. Startet sofort nach Prozess-Launch (nicht auf First-Activity warten)
- **Token-Sync** — Liest echte Counts live aus Claude CLI Session-JSONL (`~/.claude/projects/<project>/<session>.jsonl`). Funktioniert ab Sekunde 1, nicht nur bei Activity-Events
- **Stuck-Detection** — Zeitbasiert via `lastEventTs` (nicht Token-Count). 120s ohne ProcessManager-Event → Recovery (Busy-Status zurücksetzen). Keine false positives beim ersten Turn
- **Sliding Timeout** — `writeAndCollect` Timeout resettet bei jedem Event, nicht fest 120s
- **Context-Ceiling** — Opus/Sonnet: 200k Tokens | Haiku: 200k Tokens | Activity-Events für Wrapper-Diagnostik
- **IPC** — Unix Domain Socket + JSON-RPC 2.0 zwischen MCP-Server und Wrapper-Prozess
- **Modelle** — `opus`, `sonnet`, `haiku`, `opus[1m]`, `sonnet[1m]`

---

### 📚 Tech-Docs & Wissens-Airbag (`docs`)

**Actions:** `add`, `search`, `get_for_file`

| Action | Beschreibung |
|--------|--------------|
| `add` | Kuratierte Docs indexieren (Breaking Changes, Migrations, ...) |
| `search` | Docs suchen (mit Context7 Auto-Fetch) |
| `get_for_file` | Wissens-Airbag: Relevante Docs für eine Datei |

**Beispiel:**
```
> docs(action: "search", query: "fastify v5 migration", framework: "fastify")

← [{ section: "v5 Breaking Changes", type: "breaking-change",
      content: "reply.send() is now async...", source: "context7", score: 0.78 }]

> docs(action: "get_for_file", file_path: "packages/rest-api/src/server.ts", project: "synapse")

← [{ framework: "fastify", section: "Route registration changed in v5",
      type: "migration", content: "..." }]
```

---

### 🔧 Projekt-Management (`project`)

**Actions:** `init`, `complete_setup`, `detect_tech`, `cleanup`, `stop`, `status`, `list`

| Action | Beschreibung |
|--------|--------------|
| `init` | Projekt initialisieren, FileWatcher starten |
| `complete_setup` | Setup-Phase als abgeschlossen markieren |
| `detect_tech` | Frameworks, Libraries und Tools erkennen |
| `cleanup` | Vektoren für ignorierte Dateien bereinigen |
| `stop` | FileWatcher stoppen |
| `status` | Persistenter Status aus `.synapse/status.json` |
| `list` | Alle aktiven Projekte auflisten |

**Beispiel:**
```
> project(action: "init", path: "/home/user/dev/my-project", name: "my-project")

← { project: "my-project", technologies: ["TypeScript", "React", "PostgreSQL"],
     rules: ["commit-konventionen", "projekt-regeln"],
     message: "Projekt initialisiert. FileWatcher aktiv." }
```

---

### 🧩 Code-Intelligence (`code_intel`)

**Actions:** `tree`, `functions`, `variables`, `symbols`, `references`, `search`, `file`

| Action | Beschreibung |
|--------|--------------|
| `tree` | Verzeichnisbaum mit Dateigrößen, Funktions-/Variablen-Counts |
| `functions` | Funktionen auflisten (Name, Params, Return-Type, Export-Status) |
| `variables` | Variablen und Konstanten mit Werten |
| `symbols` | Symbole nach Typ filtern (class, interface, enum, import, export, todo, ...) |
| `references` | Querverweise: Wo wird ein Symbol verwendet? |
| `search` | Volltext-Suche über indexierten Code (PostgreSQL, kein Embedding) |
| `file` | Dateiinhalt aus PostgreSQL lesen (Alternative zu Read-Tool) |

**61 Sprach-Parser** (Regex-basiert, `LanguageParser` Interface):

TypeScript, SQL, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, Kotlin, Swift, Dart,
Shell/Bash, CSS/SCSS, Lua, YAML, Dockerfile, TOML, Scala, Protobuf, GraphQL, Elixir,
HCL/Terraform, Makefile, R, Perl, Haskell, Zig, Groovy, OCaml, Clojure, Julia, Nim,
V/Vlang, Erlang, F#, Solidity, Fortran, Ada, PowerShell, Objective-C, Nix, Svelte,
Vue SFC, WGSL, GLSL, Starlark/Bazel, D, Crystal, Tcl, COBOL, CMake, Puppet,
Assembly, Racket, Vala, Meson, Lean, Smithy, Dhall, Jsonnet

Dateiname-Matching für extensionlose Dateien: `Makefile`, `Dockerfile`, `BUILD`, `WORKSPACE`, `CMakeLists`, `meson.build`, `meson_options.txt`

**Beispiele:**
```
> code_intel(action: "tree", project: "synapse", path: "packages/core/src", depth: 1)

← packages/core/src/ (125 Dateien, 94fn, 2509var)
    db/ (2 Dateien, 4fn, 68var)
    embeddings/ (5 Dateien, 14fn, 120var)
    parser/ (65 Dateien)
    services/ (8 Dateien, 42fn, 890var)
    watcher/ (3 Dateien, 12fn, 156var)

> code_intel(action: "functions", project: "synapse",
             file_path: "packages/core/src/services/events.ts", exported_only: true)

← [{ name: "emitEvent", params: ["project", "eventType", "..."],
      return_type: "Promise<Event>", line_start: 23, is_exported: true },
    { name: "acknowledgeEvent", params: ["eventId", "agentId"],
      line_start: 67, is_exported: true }, ...]

> code_intel(action: "symbols", project: "synapse", symbol_type: "interface")

← [{ name: "LanguageParser", file: "parser/types.ts", line: 39 },
    { name: "ParsedSymbol", file: "parser/types.ts", line: 6 }, ...]

> code_intel(action: "references", project: "synapse", name: "emitEvent")

← { definition: { file: "services/events.ts", line: 23 },
     references: [
       { file: "tools/consolidated/event.ts", line: 45, context: "await emitEvent(..." },
       { file: "server.ts", line: 112, context: "import { emitEvent } from..." }
     ], total_references: 2 }

> code_intel(action: "file", project: "synapse", file_path: "packages/core/src/parser/types.ts")

← { file_path: "/.../types.ts", file_type: "typescript", file_size: 1063,
     content: "export interface ParsedSymbol { ... }" }
```

**REST-API Endpunkte** (gleiche Funktionalität via HTTP):
```
GET /api/projects/:name/code-intel/tree?path=...&depth=1
GET /api/projects/:name/code-intel/functions?file_path=...&exported_only=true
GET /api/projects/:name/code-intel/variables?name=...&with_values=true
GET /api/projects/:name/code-intel/symbols?symbol_type=interface
GET /api/projects/:name/code-intel/references?name=emitEvent
GET /api/projects/:name/code-intel/search?query=...&file_type=ts
GET /api/projects/:name/code-intel/file?path=...
```

---

### 👁️ FileWatcher (`watcher`)

**Actions:** `status`, `start`, `stop`

| Action | Beschreibung |
|--------|--------------|
| `status` | FileWatcher-Status prüfen |
| `start` | FileWatcher starten |
| `stop` | FileWatcher stoppen |

**Beispiel:**
```
> watcher(action: "status")

← { running: true, project: "synapse", watched_files: 276,
     last_change: "2026-03-27T07:45:12Z", ignored_patterns: [".git", "node_modules", "dist"] }
```

---

### 🔄 Array/Batch-Parameter

Viele Actions unterstützen jetzt **Array-Input** (backward compatible). Skalare Input geben unveranderte Response, Array-Input gibt `{ results[], errors[], count }` zurück.

**Phase 1 — Read-only Batch:** `specialist.status`, `thought.get`, `memory.read`, `proposal.get`, `docs.get_for_file`, `memory.find_for_file` (Promise.allSettled)

**Phase 2 — Steuerungs Batch:** `specialist.stop/wake`, `event.ack`, `channel.join/leave`, `chat.send` (Multicast), `chat.inbox_send`, `proposal.update_status` (Promise.allSettled)

**Phase 3 — Batch-Delete mit Safeguards:** `thought.delete`, `memory.delete`, `proposal.delete` — mit `dry_run` (Preview), `max_items` (Limit, Default 10), Audit-Logging

---

## 🌐 REST API

Die REST API (Fastify) bietet HTTP-Zugang zu allen Synapse-Funktionen — für Web-KIs (Claude.ai, ChatGPT, Gemini), Dashboards oder externe Integrationen. Läuft auf Port 3456.

### Endpunkte

| Bereich | Methode | Route | Beschreibung |
|---------|---------|-------|--------------|
| **Status** | GET | `/health` | Health-Check |
| | GET | `/api/status` | Server-Status, Collections, Embedding-Provider |
| **Projekte** | GET | `/api/projects` | Alle Projekte auflisten |
| | POST | `/api/projects/init` | Projekt initialisieren |
| | GET | `/api/projects/:name/stats` | Projekt-Statistiken |
| | GET | `/api/projects/:name/stats/detailed` | Detaillierte Stats nach Typ |
| | GET | `/api/projects/:name/plan` | Plan abrufen |
| | PUT | `/api/projects/:name/plan` | Plan aktualisieren |
| | POST | `/api/projects/:name/plan/tasks` | Task hinzufügen |
| **Suche** | POST | `/api/search/code` | Semantische Code-Suche |
| | POST | `/api/search/docs` | Tech-Docs suchen |
| | POST | `/api/search/path` | Pfad-basierte Suche |
| | POST | `/api/search/code-with-path` | Kombinierte Suche |
| | POST | `/api/search/global` | Projektübergreifende Suche |
| | POST | `/api/search/documents` | Dokument-Suche |
| | POST | `/api/search/code/stream` | Code-Suche (SSE Stream) |
| | POST | `/api/search/docs/stream` | Docs-Suche (SSE Stream) |
| | POST | `/api/search/global/stream` | Global-Suche (SSE Stream) |
| **Memories** | GET | `/api/projects/:name/memories` | Alle Memories |
| | POST | `/api/projects/:name/memories` | Memory erstellen |
| | GET | `/api/projects/:name/memories/:memoryName` | Memory lesen |
| | PUT | `/api/projects/:name/memories/:memoryName` | Memory aktualisieren |
| | POST | `/api/projects/:name/memories/search` | Memory-Suche |
| | GET | `/api/projects/:name/memories/:memoryName/with-code` | Memory + Code |
| | GET | `/api/projects/:name/files/:filePath/memories` | Memories für Datei |
| **Thoughts** | GET | `/api/projects/:name/thoughts` | Thoughts auflisten |
| | POST | `/api/projects/:name/thoughts` | Thought erstellen |
| | DELETE | `/api/projects/:name/thoughts/:id` | Thought löschen |
| | POST | `/api/projects/:name/thoughts/search` | Thought-Suche |
| **Proposals** | GET | `/api/projects/:name/proposals` | Proposals auflisten |
| | POST | `/api/projects/:name/proposals` | Proposal erstellen |
| | GET | `/api/projects/:name/proposals/:id` | Proposal abrufen |
| | PUT | `/api/projects/:name/proposals/:id` | Proposal aktualisieren |
| | PATCH | `/api/projects/:name/proposals/:id/status` | Status ändern |
| | POST | `/api/projects/:name/proposals/search` | Proposal-Suche |
| **Code-Intelligence** | GET | `/api/projects/:name/code-intel/tree` | Dateibaum |
| | GET | `/api/projects/:name/code-intel/functions` | Funktionen |
| | GET | `/api/projects/:name/code-intel/variables` | Variablen |
| | GET | `/api/projects/:name/code-intel/symbols` | Symbole |
| | GET | `/api/projects/:name/code-intel/references` | Querverweise |
| | GET | `/api/projects/:name/code-intel/search` | Volltext-Suche |
| | GET | `/api/projects/:name/code-intel/file` | Dateiinhalt |
| **Files** | GET | `/api/projects/:name/files` | Dateien auflisten |
| | POST | `/api/projects/:name/files` | Datei schreiben/aktualisieren |
| | DELETE | `/api/projects/:name/files` | Datei löschen |
| **Ideen** | POST | `/api/projects/:name/ideas` | Idee speichern |
| | POST | `/api/projects/:name/ideas/confirm` | Idee bestätigen |
| **Tech** | POST | `/api/tech/detect` | Technologien erkennen |
| | POST | `/api/tech/index-docs` | Docs indexieren |
| **MCP** | GET | `/mcp/sse` | MCP via SSE (Streamable HTTP) |
| | POST | `/mcp/messages` | MCP Message-Endpunkt |
| **OAuth** | GET | `/.well-known/oauth-authorization-server` | OAuth Discovery |
| | GET | `/.well-known/oauth-protected-resource` | OAuth Resource Info |

### Beispiele (curl)

```bash
# Status
curl http://192.168.50.65:3456/api/status

# Code-Suche
curl -X POST http://192.168.50.65:3456/api/search/code \
  -H 'Content-Type: application/json' \
  -d '{"query": "file watcher implementation", "project": "synapse", "limit": 5}'

# Dateibaum
curl 'http://192.168.50.65:3456/api/projects/synapse/code-intel/tree?path=packages/core/src&depth=1'

# Funktionen einer Datei
curl 'http://192.168.50.65:3456/api/projects/synapse/code-intel/functions?file_path=packages/core/src/services/events.ts'

# Referenzen finden
curl 'http://192.168.50.65:3456/api/projects/synapse/code-intel/references?name=emitEvent'

# Memory lesen
curl 'http://192.168.50.65:3456/api/projects/synapse/memories/projekt-regeln'

# Thought erstellen
curl -X POST http://192.168.50.65:3456/api/projects/synapse/thoughts \
  -H 'Content-Type: application/json' \
  -d '{"source": "api-user", "content": "REST API funktioniert", "tags": ["test"]}'
```

---

## 🎭 Event-System

Events sind **verbindliche Steuersignale** — keine Chat-Nachrichten. Der Koordinator sendet Events, Agenten müssen reagieren.

### Event-Typen

| Event-Typ | Priority | Pflicht-Reaktion |
|-----------|----------|-----------------|
| `WORK_STOP` | critical | Arbeit sofort anhalten, Status posten |
| `CRITICAL_REVIEW` | critical | Betroffene Arbeit nicht abschließen |
| `ARCH_DECISION` | high | Plan neu prüfen, Ack mit Bewertung |
| `TEAM_DISCUSSION` | high | Status posten, auf Koordinator warten |
| `ANNOUNCEMENT` | normal | Lesen, Ack, weiterarbeiten |

### Delivery-Mechanismus

```
1. Koordinator: event(action: "emit", project, event_type, priority, scope, source_id, payload)
   → PostgreSQL: agent_events Tabelle

2. Agent führt beliebiges Tool aus
   → server.ts: withOnboarding() prüft getPendingEvents()
   → Tool-Response enthält pendingEvents mit Hint-Text
   → Broadcasts werden nur gelesen seit Agent-Registrierung (neue Agenten bekommen keine uralten Events)

3. PostToolUse Hook (chat-notify.sh)
   → Pollt Events via event-check.mjs
   → Zeigt Events VOR Chat-Nachrichten an

4. Agent: event(action: "ack", event_id, agent_id, reaction)
   → PostgreSQL: agent_event_acks Tabelle
```

### Eskalation

Nach **3 Tool-Calls** ohne Ack bei `critical`/`high` Events:
→ Automatische DM an Koordinator: *"Agent X ignoriert Event Y seit Z Calls"*

---

## 🤖 Multi-Agent Koordination

### Koordinator-Muster

```
┌─────────────────────────────────────────┐
│  Koordinator (Opus)                     │
│                                         │
│  1. chat(action: "register_batch")      │
│  2. coordinator-watch.sh starten        │
│  3. Agenten spawnen mit Prompt-Baustein │
│  4. Chat lesen + Events beobachten      │
│  5. search(action: "thoughts") für Ergebnisse
└────┬──────────┬──────────┬──────────────┘
     │          │          │
     ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │Haiku │  │Sonnet│  │Haiku │
  │Agent1│  │Agent2│  │Agent3│
  └──────┘  └──────┘  └──────┘
```

### Automatisches Onboarding

Jeder Agent bekommt beim ersten Tool-Call automatisch:
- **Projekt-Regeln** (Memories mit `category: "rules"`)
- **Ungelesene Chat-Nachrichten** und **ausstehende Events**
- **Liste aktiver Agenten**

### Coordinator-Watch

Der Koordinator hat kein echtes Push-System. Der `coordinator-watch.sh` Daemon läuft im Hintergrund:

```bash
# Alle 10s auf neue DMs und Events prüfen
bash ~/dev/synapse/scripts/coordinator-watch.sh "synapse" "koordinator" 10
```

Wenn neue Nachrichten oder Events ankommen:
→ Script gibt Output und beendet sich
→ Claude Code Task-Notification weckt den Koordinator
→ Koordinator liest Nachrichten, reagiert, startet Watcher neu

---

### 🧑‍🔬 Persistente Spezialisten — Architektur

```
MCP-Server (HeartbeatController)
    ↓ Unix Domain Socket (JSON-RPC 2.0)
Agent-Wrapper (Detached Node.js Prozess)
    ↓ stdin/stdout Pipe
Claude CLI Subprocess (--stream-json)
```

Ein Spezialist startet **einmal** und bleibt über Sessions hinweg erreichbar:

```
# Einmalig starten
specialist(action: "spawn", name: "code-analyst", model: "haiku",
           expertise: "TypeScript Analyse", project: "synapse")

# Jederzeit wieder aufwecken
specialist(action: "wake", name: "code-analyst",
           message: "Analysiere src/tools/consolidated/")
```

**Startup-Verhalten:**
- Heartbeat startet sofort nach Prozess-Launch (30s Verzögerung für MCP-Server-Init)
- Initial Wake läuft **parallel** zum Heartbeat (nicht sequenziell)
- Token-Sync funktioniert ab Sekunde 1 — liest echte Counts aus Session-JSONL
- Stuck-Detection prüft `lastEventTs` (zeitbasiert), keine false positives beim ersten Turn

Das **SKILL.md** des Spezialisten wächst mit jedem Einsatz:
- Neue Regeln aus Fehlern
- Patterns die sich bewährt haben
- Korrekturen via `update_skill`

Bei Context-Ceiling (95%): automatischer Handoff — der Spezialist liest in der Folge-Session nahtlos weiter.

---

## 🗄️ Datenbank-Schema

### PostgreSQL (13 Tabellen)

| Tabelle | Spalten | Beschreibung |
|---------|---------|--------------|
| `memories` | id, project, name, category, content, tags, created_at, updated_at | Langzeit-Wissen (Architektur, Regeln, Docs) |
| `thoughts` | id, project, source, content, tags, timestamp | Kurze Erkenntnisse und Ideen |
| `plans` | id, project, name, description, goals, architecture, tasks (JSONB) | Projekt-Pläne mit Tasks |
| `proposals` | id, project, file_path, suggested_content, description, author, status, tags | Code-Vorschläge mit Status-Tracking |
| `agent_sessions` | id, project, model, cutoff_date, status, registered_at | Registrierte Agenten mit Modell-Info |
| `chat_messages` | id, project, sender_id, recipient_id, content, timestamp | Agenten-Chat (Broadcasts + DMs) |
| `tech_docs` | id, framework, version, section, content, type, category, content_hash, source | Kuratierte Framework-Dokumentation |
| `code_files` | id, project, file_path, file_name, file_type, chunk_count, file_size, indexed_at, updated_at | Indexierte Dateien mit Metadaten (PG-basierte Pfadsuche) |
| `agent_events` | id, project, event_type, priority, scope, source_id, payload, requires_ack | Steuersignale zwischen Agenten |
| `agent_event_acks` | event_id, agent_id, acked_at, reaction | Quittierungen von Events |
| `code_symbols` | id, file_id, symbol_type, name, value, line_start, line_end, params, return_type, is_exported, parent_id | Code-Symbole (Funktionen, Klassen, Variablen, ...) |
| `code_references` | id, file_id, symbol_name, line_number, context | Querverweise auf Symbole |
| `code_chunks` | id, file_id, chunk_index, content, start_line, end_line | Code-Chunks für Volltext-Suche |

### Qdrant (Vektor-Collections)

| Collection | Inhalt | Dimension |
|------------|--------|-----------|
| `project_{name}_code` | Code-Chunks mit Metadaten | 3072 |
| `project_{name}_thoughts` | Gedanken (semantisch durchsuchbar) | 3072 |
| `project_{name}_memories` | Memories (Architektur, Regeln) | 3072 |
| `project_{name}_proposals` | Code-Vorschläge | 3072 |
| `project_{name}_docs` | Tech-Docs pro Projekt | 3072 |
| `project_{name}_media` | Bilder und Videos | 3072 |
| `tech_docs_cache` | Globaler Docs-Cache | 3072 |

---

## 🪝 Hooks

Synapse nutzt Claude Code Hooks für automatische Integrationen:

### PreToolUse

| Matcher | Hook | Beschreibung |
|---------|------|--------------|
| `Read` | `pre-synapse-onboarding.sh` | Koordinator-Onboarding: Zeigt Projekt-Kontext beim ersten Tool-Call der Session |

### PostToolUse

| Matcher | Hook | Beschreibung |
|---------|------|--------------|
| `Edit\|Write` | `post-edit-framework-docs.sh` | Wissens-Airbag: Zeigt Framework-Docs nach Datei-Bearbeitung |
| `.*` | `chat-notify.sh` | Chat + Event Notifications: Ungelesene DMs, Broadcasts und Events nach jedem Tool-Call |

### SubagentStart

| Matcher | Hook | Beschreibung |
|---------|------|--------------|
| `.*` | `pre-synapse-onboarding.sh` | Agent-Onboarding: Gibt Subagenten automatisch eine ID und Synapse-Regeln |

### Response Enhancement (server.ts)

Zusätzlich erweitert `server.ts` jede Tool-Response um:
- **pendingEvents** — unbestätigte Events mit Hint-Text
- **unreadChat** — ungelesene Nachrichten mit Lesehinweis
- **activeAgents** — Liste aktiver Agenten
- **agentOnboarding** — Projekt-Regeln beim ersten Besuch

---

## 🚀 Setup

### 1. Voraussetzungen

- **Node.js 20+** (via [mise](https://mise.jdx.dev/))
- **pnpm** (Paketmanager)
- **PostgreSQL** (relationale Daten)
- **Qdrant** (Vektor-Datenbank, Docker oder Cloud)
- **Google AI API Key** (für Embeddings, `gemini-embedding-2-preview`)
- Optional: **Context7 API Key** (für automatische Framework-Docs)

### 2. Installation

```bash
cd ~/dev/synapse
cp .env.example .env
# .env bearbeiten: DATABASE_URL, QDRANT_URL, GOOGLE_API_KEY

pnpm install
pnpm run build
```

### 3. MCP Server konfigurieren

In der `.mcp.json` im Projekt-Root (oder global):

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/home/<user>/dev/synapse/packages/mcp-server/dist/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "DATABASE_URL": "postgresql://synapse:password@localhost:5432/synapse",
        "EMBEDDING_PROVIDER": "google",
        "GOOGLE_API_KEY": "AIza...",
        "CONTEXT7_API_KEY": "ctx7sk-..."
      }
    }
  }
}
```

### 4. Claude Code Hooks einrichten

Kopiere die Hooks-Konfiguration in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [{
          "type": "command",
          "command": "<SYNAPSE_PATH>/packages/mcp-server/hooks/pre-synapse-onboarding.sh"
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "<SYNAPSE_PATH>/packages/mcp-server/hooks/post-edit-framework-docs.sh"
        }]
      },
      {
        "matcher": ".*",
        "hooks": [{
          "type": "command",
          "command": "<SYNAPSE_PATH>/scripts/chat-notify.sh",
          "timeout": 10
        }]
      }
    ],
    "SubagentStart": [
      {
        "matcher": ".*",
        "hooks": [{
          "type": "command",
          "command": "<SYNAPSE_PATH>/packages/mcp-server/hooks/pre-synapse-onboarding.sh"
        }]
      }
    ]
  }
}
```

> Ersetze `<SYNAPSE_PATH>` mit dem absoluten Pfad zu deinem Synapse-Verzeichnis.

Vorlage: [`hooks-setup.example.json`](hooks-setup.example.json)

### 5. Fish Shell Setup

In `~/.config/fish/config.fish`:

```fish
# Synapse DB-URL für Hooks und Scripts
# WICHTIG: Ohne diese Variable funktionieren Chat-Notifications,
# Event-Watcher und Coordinator-Watch NICHT.
set -gx SYNAPSE_DB_URL "postgresql://synapse:password@localhost:5432/synapse"

# Claude Code mit automatischem Context-Handoff + volle Rechte
alias cc "bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh --dangerously-skip-permissions"
```

Vorlage: [`shell-setup.example.fish`](shell-setup.example.fish)

### 6. Projekt initialisieren

```
> project(action: "init", path: "/home/<user>/dev/mein-projekt")
```

→ FileWatcher startet, Code wird indexiert, Technologien erkannt.

### 7. REST API starten (optional)

```bash
pnpm run dev:api
# Läuft auf http://0.0.0.0:3456
```

---

## 📁 Projektstruktur

```
synapse/
├── packages/
│   ├── core/                        # Gemeinsamer Kern
│   │   └── src/
│   │       ├── db/
│   │       │   ├── client.ts        # PostgreSQL Connection Pool
│   │       │   └── schema.ts        # 9 Tabellen + Indizes
│   │       ├── services/
│   │       │   ├── events.ts        # Event-System (emit, ack, pending)
│   │       │   ├── thoughts.ts      # Gedanken-Verwaltung
│   │       │   ├── memory.ts        # Memory-Verwaltung
│   │       │   ├── techDocs.ts      # Tech-Docs + Context7
│   │       │   └── ...
│   │       ├── parser/              # 61 Sprach-Parser (Regex-basiert)
│   │       │   ├── index.ts         # Parser-Registry + Extension-Matching
│   │       │   ├── types.ts         # LanguageParser Interface
│   │       │   ├── typescript.ts ... jsonnet.ts  # 61 Parser
│   │       │   └── __testdata__/    # Testdaten für alle Parser
│   │       ├── embeddings/          # Google / Ollama / OpenAI
│   │       └── watcher/             # FileWatcher (Chokidar)
│   ├── mcp-server/                  # MCP Server (13 konsolidierte Tools)
│   │   ├── src/
│   │   │   ├── server.ts            # Tool-Definitionen + Response Enhancement
│   │   │   └── tools/
│   │   │       ├── consolidated/    # 14 konsolidierte Super-Tools
│   │   │       │   ├── admin.ts
│   │   │       │   ├── chat.ts
│   │   │       │   ├── channel.ts
│   │   │       │   ├── code-intel.ts
│   │   │       │   ├── docs.ts
│   │   │       │   ├── event.ts
│   │   │       │   ├── memory.ts
│   │   │       │   ├── plan.ts
│   │   │       │   ├── project.ts
│   │   │       │   ├── proposal.ts
│   │   │       │   ├── search.ts
│   │   │       │   ├── specialist.ts
│   │   │       │   ├── thought.ts
│   │   │       │   ├── watcher.ts
│   │   │       │   └── index.ts
│   │   │       └── ...
│   │   └── hooks/
│   │       ├── pre-synapse-onboarding.sh   # Koordinator + Agent Onboarding
│   │       └── post-edit-framework-docs.sh # Wissens-Airbag Hook
│   ├── rest-api/                    # REST API (Fastify)
│   ├── agents/                      # Agent-Koordination
│   └── web-ui/                      # Web-Dashboard (React)
├── scripts/
│   ├── coordinator-watch.sh         # Coordinator Idle-Watcher
│   ├── chat-notify.sh               # PostToolUse Chat/Event Hook
│   ├── chat-check.mjs               # Chat-Polling Helper
│   └── event-check.mjs              # Event-Polling Helper
├── skills/
│   ├── synapse-nutzung/             # Koordinator-Regeln (Skill)
│   └── synapse-agent-regeln/        # Agent-Regeln (Skill)
├── .env.example                     # Konfigurationsvorlage
├── .mcp.json                        # MCP Server Konfiguration
├── .synapseignore                   # Dateien vom Index ausschließen
├── hooks-setup.example.json         # Claude Code Hooks Vorlage
├── shell-setup.example.fish         # Fish Shell Setup Vorlage
└── .mise.toml                       # Task-Runner Konfiguration
```

---

## 🔧 Konfiguration

### .env

| Variable | Beschreibung | Standard |
|----------|--------------|---------|
| `DATABASE_URL` | PostgreSQL Connection String | - |
| `QDRANT_URL` | Qdrant Server URL | `http://localhost:6333` |
| `QDRANT_API_KEY` | Qdrant API Key (optional) | - |
| `EMBEDDING_PROVIDER` | `google`, `ollama` oder `openai` | `google` |
| `GOOGLE_API_KEY` | Google AI API Key (für Embeddings) | - |
| `OLLAMA_URL` | Ollama Server URL | `http://localhost:11434` |
| `OLLAMA_MODEL` | Ollama Embedding Model | `nomic-embed-text` |
| `OPENAI_API_KEY` | OpenAI API Key (optional) | - |
| `CONTEXT7_API_KEY` | Context7 API Key (Auto-Fetch) | - |
| `API_PORT` | REST API Port | `3456` |
| `API_HOST` | REST API Host | `0.0.0.0` |
| `MAX_FILE_SIZE_MB` | Max Dateigröße für Indexierung | `1` |
| `CHUNK_SIZE` | Chunk-Größe in Zeichen | `1000` |
| `CHUNK_OVERLAP` | Overlap zwischen Chunks | `200` |
| `DEBOUNCE_MS` | FileWatcher Debounce | `500` |

### Shell-Umgebung

| Variable | Beschreibung | Benötigt für |
|----------|--------------|-------------|
| `SYNAPSE_DB_URL` | PostgreSQL URL (in Fish Shell) | Chat-Notify, Coordinator-Watch, Event-Check |

### Slash-Commands (Claude Code Skills)

| Command | Beschreibung |
|---------|--------------|
| `/synapse-nutzung` | Koordinator-Regeln laden |
| `/synapse-agent-regeln` | Agent-Regeln laden |
| `/projekt-setup` | Setup-Wizard (Beschreibung, Standards, Skills) |
| `/projekt-regeln` | Coding-Standards anzeigen/ändern |
| `/projekt-architektur` | Architektur-Übersicht |
| `/projekt-status` | Alles anzeigen was Synapse über das Projekt weiß |
| `/commit-arbeit` | Commit-Workflow mit Konventionen |

---

## 🧪 mise-Tasks

```bash
mr dev          # MCP Server im Dev-Modus
mr dev:api      # REST API im Dev-Modus
mr build        # Alle Packages bauen
mr build:core   # Nur Core bauen
mr build:mcp    # Nur MCP Server bauen
mr build:api    # Nur REST API bauen
mr clean        # Alle dist/ löschen
mr lint         # Linter ausführen
```

---

## 📋 Bekannte Einschränkungen

| Einschränkung | Details |
|----------------|---------|
| **Dual-Write Eventual Consistency** | Kein Rollback bei Partial-Failure (PG OK ↔ Qdrant FAIL) → Daten ggf. nur in einem Store. By Design: PG = strukturierte Queries, Qdrant = semantische Suche |
| **Keine PG-Transaktionen** | Kein BEGIN/COMMIT pro Schreiboperation → keine ACID-Garantien bei concurrent Updates |
| Context-Handoff | Nur auf Linux + fish/bash getestet |
| Kein echter Push | Coordinator-Watch (Polling alle 10s) als Workaround |
| Google Batch-Embedding | Max 100 Texte/Request (API-Limit) — Code erzwingt Splitting nicht, bei größeren Dateien (>100 Chunks) mögliche API-Fehler |
| REST-API FileWatcher | REST-API hat keinen eigenen FileWatcher |
| `detailed_stats` | Zeigt Gesamtzahlen über alle Projekte |

---

## 📜 Lizenz

MIT
