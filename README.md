# 🧠 Synapse — KI-Gedächtnis & Agenten-Orchestrierung

> Persistentes Projekt-Wissen, semantische Code-Suche, Code-Intelligenz und Multi-Agent-Koordination über MCP & REST.
>
> Synapse gibt KI-Agenten ein Langzeitgedächtnis: Code wird automatisch indexiert (semantisch + strukturell), Wissen bleibt über Sessions erhalten, Spezialisten laufen persistent als detached Subprozesse, und mehrere Agenten arbeiten koordiniert über Chat, Inbox, Channels, Events und einen Wissens-Airbag.

```
Du (User)
  │
  ├─ Claude Code ──── MCP Server (stdio) ────┐
  ├─ Claude Desktop ─ MCP Server (stdio) ────┤
  ├─ Gemini CLI ───── REST API (http) ───────┤
  ├─ Claude.ai ───── REST API + OAuth/SSE ──┤
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
                                    │  Inbox / Channels   │
                                    │  Event-System       │
                                    │  Wissens-Airbag     │
                                    │  Shell-Queue        │
                                    │  Specialist-Queue   │
                                    └──┬──────────┬───────┘
                                       │          │
                              ┌────────▼──┐  ┌───▼──────────┐
                              │  Qdrant   │  │ PostgreSQL    │
                              │  (Vektor) │  │ (Source of    │
                              │           │  │  Truth)       │
                              │ Code      │  │ Code-Files    │
                              │ Memories  │  │ Memories      │
                              │ Thoughts  │  │ Thoughts      │
                              │ Proposals │  │ Plans         │
                              │ Tech-Docs │  │ Proposals     │
                              │ Media     │  │ Tech-Docs     │
                              └───────────┘  │ Chat / Events │
                                             │ Channels      │
                                             │ Inbox         │
                                             │ Shell-Queue   │
                                             │ Specialist-Q. │
                                             │ Code-Intel    │
                                             │ Sessions      │
                                             └───────────────┘
                                                     │
                                     ┌───────────────▼──────────────┐
                                     │  FileWatcher-Daemon (Tray)   │
                                     │  HTTP-API :7878 + SSE        │
                                     │  Shell-Job-Worker  (LISTEN)  │
                                     │  Specialist-Job-Worker(LISTEN)│
                                     └──────────────────────────────┘
```

---

## ✨ Features

| Feature | Beschreibung |
|---------|--------------|
| 🔍 **Semantische Code-Suche** | FileWatcher (Chokidar) indexiert Code automatisch. Vektor-Suche über Qdrant findet konzeptuell ähnlichen Code. Google Gemini Embedding 2 (3072d). |
| 🧬 **Code-Intelligence** | PostgreSQL-basierter Parser (60+ Sprachen): `tree`, `functions`, `variables`, `symbols`, `references`, `search` (PG-Volltext + Qdrant-Fusion), `file`-Read mit Zeilen-Range. Kein Qdrant-Roundtrip nötig. |
| 🧠 **Persistentes Projekt-Wissen** | Memories (Architektur, Regeln), Thoughts (Erkenntnisse), Plans (Ziele, Tasks), Proposals (Code-Vorschläge), Tech-Docs — alles überlebt Session-Grenzen. |
| 💬 **Multi-Agent Chat + Inbox** | Broadcast-Nachrichten an alle, gezielte DMs (Inbox für 1:1, Chat für Gruppe), Channels für Spezialisten-Gruppen. Polling-basiert mit `since`-Timestamp. |
| ⚡ **Event-System** | Verbindliche Steuersignale (WORK_STOP, CRITICAL_REVIEW, ARCH_DECISION, TEAM_DISCUSSION, ANNOUNCEMENT, NEW_TASK, CHECK_CHANNEL) mit Pflicht-Ack. Eskalation nach 3 ignorierten Calls. |
| 🤖 **Agenten-Koordination** | Koordinator-Muster: Opus dispatcht Sonnet/Haiku-Agenten. Batch-Registrierung, automatisches Onboarding, Coordinator-Watch für Idle-Aufwachen. |
| 🧑‍🔬 **Persistente Spezialisten** | Dauerhaft laufende Claude-Agenten (detached Subprozess + Unix Socket). 4-Datei-Skill-System (rules/errors/patterns/context + meta.yaml). Auto-Wake via `wake`, Heartbeat-Polling (15s), Stuck-Detection event-basiert. |
| 🔄 **Context-Handoff** | Automatische Session-Übergabe bei 95% Context. Fortschritt in Skill-Dateien gespeichert, neue Session liest nahtlos weiter. |
| 📚 **Tech-Docs Auto-Fetch** | `docs.search` holt automatisch Docs von [Context7](https://context7.com) wenn lokal leer. Docs-Kurator (Opus) recherchiert kuratierte Breaking Changes. |
| 🛡️ **Wissens-Airbag** | `docs.get_for_file` zeigt vor Datei-Bearbeitung Breaking Changes, Migrations & Gotchas — nur was neuer als der Agent-Cutoff ist. |
| 📝 **PG-Files-Layer** | Datei-CRUD direkt in PostgreSQL (`files`-Tool): create/update/read/delete/move/copy + `replace_lines`, `insert_after`, `delete_lines`, `search_replace`, `search_replace_batch` (bis 50 Edits atomar). FileWatcher synct auf Disk. |
| 🐚 **Shell-Queue** | `shell`-Tool für REST-Clients: PG-Queue → Daemon claim → Exec → Live-Stream-Log → Result. Actions: `exec`, `get_stream`, `history`, `get`, `log` (Range/Regex-Suche). |
| 👁️ **FileWatcher** | Chokidar-basiert. Erkennt Änderungen → Chunking → Google Embedding → PG + Qdrant. Respektiert `.synapseignore`/`.gitignore`. In-Process-Indexierung im Daemon (kein HTTP-Umweg). |
| 🔔 **Coordinator-Watch** | Background-Daemon pollt alle 10s auf neue Chat-Nachrichten und Events. Weckt den Koordinator im Idle. |
| 🖼️ **Media-Suche** | Cross-Modal Suche: Bilder und Videos per Text-Query (Google Gemini Embedding 2). |
| 🔧 **Tech-Detection** | Erkennt automatisch Frameworks, Libraries und Tools im Projekt. |
| 🚨 **Code-Check** | `code_check`-Tool: Error-Patterns werden bei jedem `files.create/update` automatisch geprüft (wenn `agent_id` gesetzt) — verhindert wiederkehrende Modell-Fehler. |
| 🔐 **OAuth + SSE** | REST-API mit `/.well-known/oauth-authorization-server` und `GET /mcp/sse` für Claude.ai-Connector. |

---

## 🏗️ Architektur

### Monorepo-Packages

| Package | Beschreibung | Läuft auf |
|---------|--------------|----------|
| `@synapse/core` | Gemeinsamer Kern — 26 Services, DB, Embeddings, FileWatcher, Code-Intel, Shell-/Specialist-Queue | - |
| `@synapse/mcp-server` | MCP Server (stdio) für Claude Code, Claude Desktop, Cline | User-PC |
| `@synapse/rest-api` | REST API (Fastify) für Web-KIs (Claude.ai, ChatGPT, Gemini) — 15 MCP-Tools über HTTP | Server (Container) |
| `@synapse/agents` | Agent-Wrapper, Heartbeat, ProcessManager, Skill-System, Channels, Inbox | User-PC |
| `@synapse/file-watcher-daemon-ts` | Lokaler Tray-Daemon (Port 7878) — FileWatcher-Manager + Shell-Job-Worker + Specialist-Job-Worker | User-PC |
| `@synapse/web-ui` | Web-Dashboard (React, in Entwicklung) | - |

### Datenfluss (Indexierung)

```
Datei gespeichert
  → FileWatcher-Daemon (Chokidar) erkennt Änderung
    → .synapseignore / .gitignore prüfen
      → storeFileContent() schreibt PG (code_files)
        → parseAndEmbed() — Tree-sitter / Regex-Parser für 60+ Sprachen
          → Code-Intel-Daten in PG (functions, variables, symbols, imports)
            → Chunking (1000 Zeichen, 200 Overlap)
              → Google Gemini Embedding (3072d)
                → Qdrant Upsert (project_{name}_code)
```

### Dual-Storage (Write-Primary / Read-Primary, Eventual Consistency)

- **PostgreSQL** — relationale Schicht für Memories, Thoughts, Plans, Proposals, Chat, Events, Inbox, Channels, Shell-Queue, Specialist-Queue, Code-Intelligence (Symbole, Referenzen, Volltext)
- **Qdrant** — Vektor-Schicht für semantische Suche (Code, Memories, Thoughts, Proposals, Tech-Docs, Media); Code-Inhalte werden bei Änderungen re-embedded und alte Vektoren ausindexiert

**Konsistenz-Modell:** Eventual Consistency (by design — Single-User-System, keine konkurrierenden Writer).

**Schreib-Flow:** PG first → Qdrant second (Standard für **alle** Services).
**Fehlertoleranz:** Beide Writes in separaten try/catch, `warning`-Feld bei Partial-Failure (Schreibvorgang scheitert nicht still).

**Read-Routing (by design):** Semantische Suche (`search*`, `get*/list*`) liest aus Qdrant, strukturierte Operationen (`update*/delete*`, Code-Intelligence) lesen aus PostgreSQL.

Jedes Projekt bekommt eigene Qdrant-Collections: `project_{name}_code`, `project_{name}_thoughts`,
`project_{name}_memories`, `project_{name}_proposals`, `project_{name}_docs`, `project_{name}_media`.
Strukturierte Code-Intelligence-Daten (Symbole, Referenzen, Volltext) liegen in PostgreSQL — Qdrant hält parallel die Embeddings der Code-Chunks für semantische Suche.

---

## 🛠️ MCP-Tools (15 konsolidierte Tools + 2 Hilfstools, ~100 Actions)

### 📦 Admin & Projekt-Management (`admin`)

**Actions:** `index_stats`, `migrate`, `restore`, `save_idea`, `confirm_idea`, `index_media`, `detailed_stats`, `migrate_paths`

| Action | Beschreibung |
|--------|--------------|
| `index_stats` | Projekt-Statistiken + automatisches Agent-Onboarding (Regeln + activeAgents) |
| `migrate` | Embedding-Modell wechseln (Backup → Re-Embed) |
| `restore` | Daten aus JSONL-Backup wiederherstellen |
| `save_idea` / `confirm_idea` | Projekt-Idee als Proposal vorschlagen + bestätigen (30 min TTL) |
| `index_media` | Bilder und Videos indexieren (Gemini Embedding 2) |
| `detailed_stats` | Aufschlüsselung nach Dateityp, Source, Kategorie |
| `migrate_paths` | Pfad-Normalisierung in `code_files` (absolute → relative) |

---

### 🔍 Suche (`search`)

**Actions:** `code`, `path`, `code_with_path`, `memory`, `thoughts`, `proposals`, `tech_docs`, `media`

| Action | Beschreibung |
|--------|--------------|
| `code` | Reine **Qdrant Semantic Search** über Code-Chunks |
| `path` | Glob-Pattern-Suche auf Datei-Pfaden (auto relative→absolute Konvertierung) |
| `code_with_path` | Hybrid: Semantisch + Pfad-Filter |
| `memory` / `thoughts` / `proposals` | Semantische Suche in den jeweiligen Stores |
| `tech_docs` | Framework-Docs (mit Context7 Auto-Fetch wenn lokal leer) |
| `media` | Cross-Modal: Bilder/Videos per Text-Query |

> **Tipp:** Für strukturierte Code-Fragen (Funktionen, Variablen, Imports) ist `code_intel` schneller und präziser. `search.code` ist für fuzzy/konzeptuelle Suche.

---

### 🧬 Code-Intelligence (`code_intel`)

**Actions:** `tree`, `functions`, `variables`, `symbols`, `references`, `search`, `file`

| Action | Beschreibung |
|--------|--------------|
| `tree` | Projektbaum mit Optionen (`show_counts`, `show_lines`, `show_functions`, `show_comments`, `show_imports`, `depth`, `recursive`) |
| `functions` | Funktionen einer Datei oder per Name (mit `exportedOnly`-Filter) |
| `variables` | Variablen-Liste (optional mit Werten) |
| `symbols` | Filterbar nach `symbol_type`: function, variable, string, comment, import, export, class, interface, enum, const_object, todo |
| `references` | Definition + alle Cross-File-Imports in einem Call |
| `search` | **Search-Fusion** — PG-Volltext (`ts_rank`) + Qdrant-Fallback (live seit 2026-04-26) |
| `file` | Dateiinhalt direkt aus PG mit `from_line`, `to_line`, `total_lines`, `truncate_long_lines` (Auto-Trim wenn > 80k Zeichen) |

PostgreSQL-basiert, kein Qdrant nötig. Parser für TypeScript/JavaScript, Python, Go, Rust, Java, C/C++, Ruby, PHP, Kotlin, Swift, Dart, SQL, Lua, YAML, Dockerfile, TOML, Scala, Protobuf, GraphQL, Elixir, HCL/Terraform, Makefile, R, Perl, Haskell, Zig, Groovy, OCaml, Clojure, Julia, Nim, V, Erlang, F#, Solidity, Fortran, Ada, PowerShell, Objective-C, Nix, Svelte, Vue SFC, WGSL, GLSL, Starlark, D, Crystal, Tcl, COBOL, CMake, Puppet, Assembly, Racket, Vala, Meson, Lean, Smithy, Dhall, Jsonnet u. v. m. (60+ Sprachen).

---

### 📝 Datei-Operationen (`files`)

**Actions:** `create`, `update`, `read`, `delete`, `move`, `copy`, `replace_lines`, `insert_after`, `delete_lines`, `search_replace`, `search_replace_batch`

| Action | Beschreibung |
|--------|--------------|
| `create` / `update` | Datei in PG anlegen/aktualisieren — FileWatcher synct auf Disk. Bei `agent_id`: Error-Pattern + Framework-Docs Check |
| `read` | Inhalt aus PG mit `from_line`, `to_line`, `total_lines`, `truncate_long_lines` (Auto-Trim wenn Content > 80k Zeichen) |
| `delete` / `move` / `copy` | Soft-Delete / atomares Verschieben / Kopieren in PG + Qdrant |
| `replace_lines` | Zeilenrange ersetzen (`line_start`..`line_end`) |
| `insert_after` | Inhalt nach Zeile einfügen |
| `delete_lines` | Zeilenrange löschen |
| `search_replace` | Exakter String-Replace mit **Fuzzy-Match-Vorschlägen** bei Miss |
| `search_replace_batch` | **Bis zu 50 Edits atomar** in einem Call |

> **Auto-Unescape:** Doppelt-escaped Content (z. B. `\\n` statt `\n`) wird automatisch normalisiert.

---

### 🚨 Code-Check / Error-Patterns (`code_check`)

**Actions:** `add_pattern`, `list_patterns`, `delete_pattern`

Patterns werden bei `files.create/update`-Operationen **automatisch** geprüft, wenn `agent_id` gesetzt ist. Felder: `description`, `fix`, `severity` (error/warning/info), `found_in_model`, `found_by`, `model_scope`. Der `model_scope` wird aus `found_in_model` abgeleitet (haiku-Fehler treffen alle Tiers, opus-Fehler nur opus).

---

### 🐚 Shell-Ausführung (`shell`)

**Actions:** `exec`, `get_stream`, `history`, `get`, `log`

| Action | Beschreibung |
|--------|--------------|
| `exec` | Synchrone Ausführung mit Active-Gate (prüft ob Projekt im Daemon aktiviert) |
| `get_stream` | Live-Output laufender Jobs lesen |
| `history` | Vergangene Jobs auflisten (limit, offset, status-Filter) |
| `get` | Einzelnen Job + voller Output |
| `log` | Zeilen-Range oder Regex-Suche im Job-Output (`query`, `regex`, `case_sensitive`, `max_matches`) |

Alle Aufrufe werden in `shell_jobs` persistiert. Web-KIs nutzen die PG-Queue: Daemon claimt → führt aus → Stream-Log nach `~/.synapse/shell-streams/`.

---

### 🧠 Memories (`memory`)

**Actions:** `write`, `read`, `read_with_code`, `list`, `delete`, `update`, `find_for_file`

| Action | Beschreibung |
|--------|--------------|
| `write` | Langform-Wissen speichern (Architektur, Regeln, Docs) |
| `read` | Memory(s) nach Name laden — **Array-Support** |
| `read_with_code` | Memory + verwandten Code laden |
| `list` | Alle Memories auflisten |
| `delete` | Memory löschen — **Array + `dry_run` + `max_items`** |
| `update` | Memory aktualisieren (PG + Re-Embed) |
| `find_for_file` | Relevante Memories für eine Datei (oder Array von Pfaden) |

---

### 💭 Gedanken (`thought`)

**Actions:** `add`, `add_batch`, `get`, `delete`, `update`, `search`

| Action | Beschreibung |
|--------|--------------|
| `add` / `add_batch` | Einzeln oder bis zu 50 Gedanken atomar |
| `get` | Gedanken abrufen — **Array-Support für IDs** |
| `delete` | Gedanken löschen — **Array + `dry_run` + `max_items`** |
| `search` | Semantische Thought-Suche |
| `update` | Inhalt/Tags ändern |

---

### 📋 Pläne (`plan`)

**Actions:** `get`, `update`, `add_task`, `add_tasks_batch`, `update_task`, `delete_tasks`, `delete`

Tasks als JSONB im Plan, mit Status-Tracking, Prioritäten und Batch-Ops für Bulk-Updates.

---

### 📝 Proposals (`proposal`)

**Actions:** `list`, `get`, `update_status`, `delete`, `update`

| Action | Beschreibung |
|--------|--------------|
| `list` | Alle Proposals auflisten |
| `get` | Proposal nach ID — **Array-Support** |
| `update_status` | Status ändern (`pending` → `reviewed` → `accepted`) — **Array-Support** |
| `delete` | Löschen — **Array + dry_run + max_items** |
| `update` | Content / SuggestedContent / Status ändern |

---

### 💬 Chat & Inbox (`chat`)

**Actions:** `register`, `unregister`, `register_batch`, `unregister_batch`, `send`, `get`, `list`, `inbox_send`, `inbox_check`

| Action | Beschreibung |
|--------|--------------|
| `register` / `register_batch` | Agent(en) registrieren (mit Cutoff-Erkennung). Setzt `lastChatRead`-Watermark |
| `unregister` / `unregister_batch` | Agent(en) abmelden |
| `send` | Broadcast (alle) oder DM — **Array-Support für `recipient_id` (Multicast)** |
| `get` | Nachrichten abrufen (Polling via `since`) |
| `list` | Aktive Agenten auflisten |
| `inbox_send` | 1:1-Nachricht in Inbox eines Spezialisten — **Array-Support für `to_agent`** |
| `inbox_check` | Inbox lesen + als verarbeitet markieren |

> **Specialist Dual-Path:** `chat.send` mit `project_path` routet automatisch in Inbox, wenn der Empfänger ein Spezialist ist.

---

### 📢 Kanäle (`channel`)

**Actions:** `create`, `join`, `leave`, `post`, `feed`, `list`

| Action | Beschreibung |
|--------|--------------|
| `create` | Kanal für Spezialisten-Gruppen erstellen |
| `join` / `leave` | Agent zu/aus Kanal — **Array-Support für mehrere Channels** |
| `post` | Nachricht in Kanal posten |
| `feed` | Kanal-Nachrichten abrufen (`since_id`, `limit`, `preview`) |
| `list` | Alle Kanäle des Projekts auflisten |

> **Hinweis:** `project` ist bei `create`/`join`/`leave`/`feed`/`list` Pflicht-Parameter.

---

### ⚡ Events (`event`)

**Actions:** `emit`, `ack`, `pending`

| Action | Beschreibung |
|--------|--------------|
| `emit` | Steuersignal an Agenten senden |
| `ack` | Event quittieren (Pflicht bei `requires_ack`) — **Array-Support für mehrere IDs** |
| `pending` | Unbestätigte Events abrufen |

---

### 🤖 Spezialisten (`specialist`)

**Actions:** `spawn`, `spawn_batch`, `stop`, `purge`, `status`, `wake`, `update_skill`, `capabilities`

| Action | Beschreibung |
|--------|--------------|
| `spawn` | Spezialisten-Agent starten (detached Subprozess) |
| `spawn_batch` | Mehrere Spezialisten atomar starten |
| `stop` | Agent stoppen — **Array-Support** |
| `purge` | Agent komplett entfernen (Skill-Verzeichnis löschen) |
| `status` | Status prüfen — **Array-Support** |
| `wake` | Agent mit Nachricht aufwecken — **Array-Support** |
| `update_skill` | Skill-Datei aktualisieren — `file`-Parameter: `rules` / `errors` / `patterns` / `context` |
| `capabilities` | Verfügbare Modelle + Limits |

**Modelle:** `opus`, `sonnet`, `haiku`, `opus[1m]`, `sonnet[1m]`

---

### 📚 Tech-Docs & Wissens-Airbag (`docs`)

**Actions:** `add`, `search`, `get_for_file`

| Action | Beschreibung |
|--------|--------------|
| `add` | Kuratierte Docs indexieren (Breaking Changes, Migrations, Gotchas) |
| `search` | Docs suchen mit `scope: 'global' \| 'project' \| 'all'` (Context7 Auto-Fetch) |
| `get_for_file` | **Wissens-Airbag**: relevante Docs für eine Datei — **Array-Support für mehrere Pfade**. Liefert `warnings` + `agentCutoff` |

---

### 🔧 Projekt-Management (`project`)

**Actions:** `init`, `complete_setup`, `detect_tech`, `cleanup`, `stop`, `status`, `list`

---

### 👁️ FileWatcher (`watcher`)

**Actions:** `status`, `start`, `stop`

Steuert den lokalen Daemon via Unix Socket + PID-File.

---

### 🔄 Array / Batch-Parameter

Viele Actions unterstützen **Array-Input** (backward compatible). Skalare Inputs liefern unverändertes Format, Array-Inputs liefern `{ results[], errors[], count }`.

- **Read-only Batch:** `specialist.status`, `thought.get`, `memory.read`, `proposal.get`, `docs.get_for_file`, `memory.find_for_file` (Promise.allSettled)
- **Steuerungs-Batch:** `specialist.stop` / `wake` / `spawn_batch`, `event.ack`, `channel.join` / `leave`, `chat.send` (Multicast), `chat.inbox_send`, `proposal.update_status`
- **Batch-Delete mit Safeguards:** `thought.delete`, `memory.delete`, `proposal.delete` — mit `dry_run` (Preview), `max_items` (Limit, Default 10), Audit-Logging
- **Atomare Batch-Writes:** `thought.add_batch`, `plan.add_tasks_batch`, `files.search_replace_batch` (bis 50 Edits)

---

## 🎭 Event-System

Events sind **verbindliche Steuersignale** — keine Chat-Nachrichten. Der Koordinator sendet, Agenten müssen reagieren.

### Event-Typen

| Event-Typ | Priority | Pflicht-Reaktion |
|-----------|----------|-----------------|
| `WORK_STOP` | critical | Arbeit sofort anhalten, Status posten |
| `CRITICAL_REVIEW` | critical | Betroffene Arbeit nicht abschließen |
| `ARCH_DECISION` | high | Plan neu prüfen, Ack mit Bewertung |
| `TEAM_DISCUSSION` | high | Status posten, auf Koordinator warten |
| `NEW_TASK` | high | Task übernehmen, Ack mit Bestätigung |
| `CHECK_CHANNEL` | normal | Channel lesen, Ack |
| `ANNOUNCEMENT` | normal | Lesen, Ack, weiterarbeiten |

### Delivery-Mechanismus

```
1. Koordinator: event(action: "emit", project, event_type, priority, scope, source_id, payload)
   → PostgreSQL: agent_events Tabelle

2. Agent führt beliebiges Tool aus
   → server.ts: withOnboarding() prüft getPendingEvents()
   → Tool-Response enthält pendingEvents mit Hint-Text (⛔/⚠️/📋)
   → Broadcasts werden nur seit Agent-Registrierung gelesen

3. PostToolUse-Hook (chat-notify.sh)
   → Pollt Events via event-check.mjs
   → Zeigt Events VOR Chat-Nachrichten

4. Agent: event(action: "ack", event_id, agent_id, reaction)
   → PostgreSQL: agent_event_acks Tabelle
```

### Eskalation

Nach **30 s Grace + 3 Tool-Calls** ohne Ack bei `critical`/`high` Events
→ Automatische DM an Koordinator: *„Agent X ignoriert Event Y seit Z Calls"*

---

## 🤖 Multi-Agent Koordination

### Koordinator-Muster

```
┌─────────────────────────────────────────┐
│  Koordinator (Opus / Opus[1m])          │
│                                         │
│  1. chat(action: "register_batch")      │
│  2. coordinator-watch.sh starten        │
│  3. specialist(action: "spawn_batch")   │
│  4. Channel-Feed + Events beobachten    │
│  5. thought / memory / files lesen      │
└────┬──────────┬──────────┬──────────────┘
     │          │          │
     ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │Haiku │  │Sonnet│  │Opus[1m]│
  │Spec. │  │Spec. │  │Spec.   │
  └──────┘  └──────┘  └──────┘
```

### Automatisches Onboarding

Jeder Tool-Call eines neuen Agenten liefert in der Response:
- **agentOnboarding** — Projekt-Regeln (Memories mit `category: "rules"`) beim ersten Besuch
- **pendingEvents** — Unbestätigte Events mit Priority-Markern
- **unreadChat** — Anzahl ungelesener Broadcasts + DMs seit Registrierung
- **activeAgents** — Liste aktiver Agenten

### Coordinator-Watch

```bash
bash ~/dev/synapse/scripts/coordinator-watch.sh "synapse" "koordinator" 10
```

Pollt alle 10 s auf neue DMs/Events. Bei Treffer → Output → Script endet → Claude Code Task-Notification weckt den Koordinator.

---

### 🧑‍🔬 Persistente Spezialisten — Architektur

```
MCP-Server (HeartbeatController)
    ↓ Unix Domain Socket (JSON-RPC 2.0, newline-delimited)
Agent-Wrapper (Detached Node.js Prozess)
    ↓ stdin/stdout Pipe (--stream-json)
Claude CLI Subprocess
```

```
# Einmalig starten
specialist(action: "spawn", name: "code-analyst", model: "haiku",
           expertise: "TypeScript Analyse", project: "synapse",
           project_path: "/home/user/dev/synapse",
           channel: "analyse-team", keep_alive: false)

# Jederzeit wieder aufwecken
specialist(action: "wake", name: "code-analyst",
           message: "Analysiere src/tools/consolidated/")

# Skill anpassen
specialist(action: "update_skill", name: "code-analyst",
           file: "patterns", skill_action: "add",
           content: "Pattern: Tool-Files immer mit case-Statement matchen")
```

#### Skill-System (4-Datei-Format + meta.yaml)

`.synapse/agents/<name>/`
- `meta.yaml` — name, model, expertise, created
- `rules.md` — Verbindliche Regeln
- `errors.md` — Bekannte Fehler + Lösungen
- `patterns.md` — Bewährte Patterns
- `context.md` — Projekt-Kontext
- `logs/YYYY-MM-DD.md` — Tageslogs (datum-basiertes Append)

`migrateSkillMd()` migriert altes SKILL.md + MEMORY.md automatisch in das neue 4-Datei-Format.

#### Heartbeat (alle 15 s, parallel zum Initial Wake)

1. **Token-Sync** — liest echte Counts aus `~/.claude/projects/<cwd>/<sessionId>.jsonl` (letzter Turn Input = aktuelle Context-Größe). Funktioniert ab Sekunde 1.
2. **Context-Rotation** bei 95 % — `wakeAgent("CONTEXT-RESET ... sichere Wissen")` → stop → reset → restart → re-onboarding
3. **Stuck-Detection event-basiert** — kein ProcessManager-Activity-Event seit 120 s + Agent „busy" → busy-Flag zurücksetzen (kein Kill). Keine false positives beim ersten Turn.
4. **pollChannelMessages()** — neue Channel-Nachrichten an alle Member
5. **pollInboxMessages()** — 1:1-DMs aus `specialist_inbox`
6. **pollSynapseItems()** — getaggte Memories + Thoughts + Plan-Tasks + Pending Events in einem Zyklus
7. **PRAXIS-FEEDBACK-Erkennung** — Nachrichten von Nicht-Agenten (Mensch) werden mit `[PRAXIS-FEEDBACK]` markiert
8. **KEEP_ALIVE-Modus** (`SYNAPSE_KEEP_ALIVE=1`) — Heartbeat-Wake auch bei leerer Queue

**Sliding Timeout** — `writeAndCollect` resettet bei jedem Stream-Event (statt fest 120 s).

**Context-Ceilings** (`types.ts`):
- `opus[1m]` / `sonnet[1m]` → 1 000 000 Tokens
- `opus` / `sonnet` / `haiku` → 200 000 Tokens

**IPC** — Unix Domain Socket (`chmod 0600`) + JSON-RPC 2.0. Methoden: `wake`, `stop`, `status`, `save_and_pause`.

**Crash-Handling** — `cleanupOrphans()` scannt `.synapse/sockets/` nach verwaisten `.sock`-Dateien (PID-Check via `process.kill(pid, 0)`).

---

### 🛰️ FileWatcher-Daemon (Tray)

Standalone Node-Daemon auf Port `7878` (moo-daemon-kompatibel).

**Workers:**
- **shell-job-worker** — `LISTEN shell_job_created` → Claim → Exec → Stream-Log → Complete
- **specialist-job-worker** — `LISTEN specialist_job_created` → Claim → spawn / spawn_batch / stop / purge / wake / update_skill via dynamischem Import von `@synapse/mcp-server`

**Safety-Net:** Alle 10 s `expirePendingShellJobs(30)` + `expirePendingSpecialistJobs(30)` (Multi-Daemon-Sicher via `daemon-<host>-<pid>`-ID).

**HTTP-Endpoints:**

| Endpoint | Methode | Zweck |
|----------|---------|-------|
| `GET /health` | - | Liveness |
| `GET /host/status` | - | Daemon-Status |
| `GET /projects` | - | Projektliste + REST-API-URL |
| `POST /projects` | Body | Projekt registrieren |
| `GET /projects/:name/status` | - | enabled / running |
| `POST /projects/:name/enable` / `disable` | - | FileWatcher steuern |
| `DELETE /projects/:name` | - | Projekt entfernen |
| `GET /projects/:name/history` | `?limit=` | Letzte FileWatcher-Events aus PG |
| `GET /projects/:name/specialists` | - | status.json (alle Spezialisten) |
| `POST /projects/:name/specialists/:name/stop` | - | SIGTERM + Cleanup |
| `GET /projects/:name/channels` | - | Alle Channels |
| `GET /projects/:name/channels/:ch/feed` | `?limit=` | Channel-Feed |
| `POST /projects/:name/channels/:ch/post` | Body | In Channel posten |
| `GET /projects/:name/agents` | - | Aktive Agenten |
| `GET /events` | SSE | State-Stream (`event: state`, heartbeat 25 s) |

**In-Process-Indexierung:** `WatcherManager.forwardEvent()` ruft `indexFile()` / `removeFile()` direkt — kein HTTP-Umweg.

---

## 🌐 REST-API (für Web-KIs)

`@synapse/rest-api` (Fastify) stellt 15 MCP-Tools über HTTP bereit. Läuft als Container auf dem Server (siehe Deployment).

### Verfügbarkeit pro Tool

| Tool | via REST | Anmerkung |
|------|----------|-----------|
| `search`, `memory`, `thought`, `plan`, `proposal`, `docs`, `code_intel`, `files`, `event` | ✅ vollständig | Alle Actions |
| `chat` | ⚠️ teilweise | Ohne `inbox_send` / `inbox_check` |
| `admin` | ⚠️ teilweise | Ohne `migrate` / `restore` |
| `project` | ⚠️ teilweise | Ohne `complete_setup` / `cleanup` / `stop` |
| `specialist` | 🔄 via PG-Queue | Daemon + Claude-CLI auf User-PC nötig |
| `shell` | 🔄 via PG-Queue | Daemon claimt + führt aus |
| `channel`, `watcher` | ❌ nur MCP | stdio-only |

### MCP-over-HTTP

| Endpoint | Methode | Zweck |
|----------|---------|-------|
| `GET /mcp/sse` | SSE | SSE-Session (altes MCP v2024-11-05) — für Claude.ai Connector |
| `POST /mcp/messages?sessionId=` | JSON-RPC | Tool-Calls in SSE-Session |
| `POST /` | JSON-RPC | Direkter Root-Endpoint (ohne SSE) |
| `GET /.well-known/oauth-authorization-server` | - | OAuth-Discovery für Claude.ai |
| `GET / POST /oauth/*` | - | OAuth 2.0 Flow |

### Standalone-REST-Routes

`/api/health`, `/api/status`, `/api/search/*`, `/api/thoughts/*`, `/api/memory/*`, `/api/projects/*`, `/api/stats/*`, `/api/ideas/*`, `/api/tech/*`, `/api/proposals/*`, `/api/code-intel/*`, `/api/files/*`, `/api/guide` (KI-Doku via `guide-content.ts`).

> **Setup-Voraussetzung:** Wenn der REST-API-Container `specialist` / `shell` an User-PCs delegieren soll, muss er im selben Docker-Netzwerk wie der lokale Daemon liegen — bei der Standard-Unraid-Topologie z. B. `proxynet`.

---

## 🗄️ Datenbank-Schema

### PostgreSQL — wichtigste Tabellen

| Tabelle | Beschreibung |
|---------|--------------|
| `code_files` | Indexierte Dateien (Pfad, Typ, Chunks, Größe) — primärer Code-Store |
| `code_functions` / `code_variables` / `code_symbols` / `code_imports` | Code-Intelligence-Daten (PG-only) |
| `memories` | Langzeit-Wissen mit Tags + Kategorien |
| `thoughts` | Kurzerkenntnisse + Ideen |
| `plans` | Projekt-Pläne mit Tasks (JSONB) |
| `proposals` | Code-Vorschläge mit Status-Tracking |
| `tech_docs` | Kuratierte Framework-Doku (mit `content_hash`) |
| `agent_sessions` | Registrierte Agenten + Cutoff-Datum |
| `chat_messages` | Broadcasts + DMs |
| `agent_events` / `agent_event_acks` | Event-Layer |
| `specialist_channels` / `_members` / `_messages` | Channel-System |
| `specialist_inbox` | 1:1-Inbox für Spezialisten |
| `shell_jobs` | Shell-Queue (PG-LISTEN) |
| `specialist_jobs` | Specialist-Queue (PG-LISTEN) |
| `error_patterns` | Bekannte Fehler-Patterns für `code_check` |
| `watcher_events` | History pro Projekt |

### Qdrant — Vektor-Collections (3072d, Google Gemini Embedding 2)

`project_{name}_code`, `project_{name}_memories`, `project_{name}_thoughts`, `project_{name}_proposals`, `project_{name}_docs`, `project_{name}_media` + globaler `tech_docs_cache`.

---

## 🪝 Hooks (Claude Code)

### PreToolUse

| Matcher | Hook | Beschreibung |
|---------|------|--------------|
| `Read` | `pre-synapse-onboarding.sh` | Koordinator-Onboarding (Status alle 30 min) |
| `Edit\|Write` | `pre-edit-framework-docs.sh` | Framework-Hint einmalig pro Agent + Framework |

### PostToolUse

| Matcher | Hook | Beschreibung |
|---------|------|--------------|
| `Edit\|Write` | `post-edit-framework-docs.sh` | Wissens-Airbag — Framework-Docs nach jedem Edit |
| `.*` | `chat-notify.sh` | Chat + Event Notifications |

### SubagentStart

| Matcher | Hook | Beschreibung |
|---------|------|--------------|
| `.*` | `pre-synapse-onboarding.sh` | Subagent-Onboarding (ID + Pflicht-Schritte: chat.register → admin.index_stats → chat.get) |

### Response-Enhancement (server.ts `withOnboarding`)

Jede Tool-Response wird automatisch erweitert um: `pendingEvents`, `unreadChat`, `activeAgents`, `agentOnboarding` (beim ersten Besuch).

---

## 🚀 Setup

### 1. Voraussetzungen

- **Node.js 20+** (via [mise](https://mise.jdx.dev/))
- **pnpm** (Paketmanager — `npm`/`yarn` nicht verwenden)
- **PostgreSQL** (relationale Schicht)
- **Qdrant** (Vektor-Index, Docker oder Cloud)
- **Google AI API Key** (`gemini-embedding-2-preview`)
- Optional: **Context7 API Key** (Auto-Fetch Framework-Docs)

### 2. Installation

```bash
cd ~/dev/synapse
cp .env.example .env
# .env bearbeiten: DATABASE_URL, QDRANT_URL, GOOGLE_API_KEY

pnpm install
pnpm run build
```

### 3. MCP-Server konfigurieren

In `.mcp.json` im Projekt-Root (oder global):

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

### 4. Claude Code Hooks

Vorlage: [`hooks-setup.example.json`](hooks-setup.example.json) → in `~/.claude/settings.json` einfügen, `<SYNAPSE_PATH>` ersetzen.

### 5. Fish-Shell Setup

```fish
set -gx SYNAPSE_DB_URL "postgresql://synapse:password@localhost:5432/synapse"
alias cc "bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh --dangerously-skip-permissions"
```

Vorlage: [`shell-setup.example.fish`](shell-setup.example.fish)

### 6. Projekt initialisieren

```
> project(action: "init", path: "/home/<user>/dev/mein-projekt")
```

→ FileWatcher startet, Code wird indexiert, Technologien erkannt.

### 7. REST-API starten (optional)

**Lokal:**

```bash
pnpm run dev:api
# Läuft auf http://0.0.0.0:3456
```

**Container (Unraid / Docker):**

```bash
docker run -d --name synapse-rest-api \
  --network proxynet \
  -e DATABASE_URL=... -e QDRANT_URL=... -e GOOGLE_API_KEY=... \
  -p 3456:3456 \
  ghcr.io/<user>/synapse-rest-api:latest
```

> **Wichtig:** Container muss im selben Docker-Netzwerk wie Qdrant + PostgreSQL laufen (Standard auf Unraid: `proxynet`). Sonst keine DB-Verbindung.

### 8. FileWatcher-Daemon (Tray)

```bash
cd packages/file-watcher-daemon-ts
pnpm run start    # Port 7878
```

Läuft als Tray-Anwendung (Electron) und verarbeitet Shell-/Specialist-Jobs aus der PG-Queue für REST-Clients.

---

## 📁 Projektstruktur

```
synapse/
├── packages/
│   ├── core/                        # Gemeinsamer Kern (26 Services)
│   │   └── src/
│   │       ├── db/
│   │       ├── services/
│   │       │   ├── code.ts            # FileWatcher-Indexierung + Konsistenz
│   │       │   ├── code-intel.ts      # Code-Intelligence Queries
│   │       │   ├── code-write.ts      # files-Tool Backend (search_replace_batch)
│   │       │   ├── memory.ts / thoughts.ts / plans.ts / proposals.ts
│   │       │   ├── chat.ts / channels.ts / inbox.ts
│   │       │   ├── events.ts
│   │       │   ├── shell-queue.ts / shell-exec.ts
│   │       │   ├── specialist-queue.ts
│   │       │   ├── tech-docs.ts / docs.ts / docs-indexer.ts
│   │       │   ├── error-patterns.ts
│   │       │   ├── project-registry.ts
│   │       │   ├── tech-detection.ts
│   │       │   ├── global-search.ts
│   │       │   └── ...
│   │       ├── embeddings/            # google / openai / ollama / cohere
│   │       └── watcher/               # Chokidar
│   ├── mcp-server/                   # MCP Server (15 Tools + watcher + shell)
│   │   ├── src/
│   │   │   ├── server.ts             # Tool-Registry + withOnboarding
│   │   │   └── tools/consolidated/
│   │   │       ├── admin.ts / search.ts / memory.ts / thought.ts
│   │   │       ├── plan.ts / proposal.ts / chat.ts / channel.ts
│   │   │       ├── event.ts / specialist.ts / docs.ts / project.ts
│   │   │       ├── code_intel.ts / code_check.ts / files.ts
│   │   │       ├── shell.ts / watcher.ts
│   │   │       └── index.ts
│   │   └── hooks/
│   │       ├── pre-synapse-onboarding.sh
│   │       ├── pre-edit-framework-docs.sh
│   │       └── post-edit-framework-docs.sh
│   ├── rest-api/                     # Fastify HTTP-API (15 MCP-Tools)
│   │   └── src/routes/
│   │       ├── mcp.ts                # MCP-over-HTTP (JSON-RPC + SSE)
│   │       ├── guide-content.ts      # KI-Doku
│   │       ├── oauth.ts              # OAuth 2.0
│   │       ├── code-intel.ts / files.ts / shell.ts
│   │       ├── memory.ts / thoughts.ts / proposals.ts / projects.ts
│   │       ├── search.ts / stats.ts / status.ts / tech.ts / ideas.ts
│   │       └── index.ts
│   ├── agents/                       # Wrapper + Heartbeat + Skill-System
│   │   └── src/
│   │       ├── wrapper.ts            # Detached Spezialist-Prozess
│   │       ├── heartbeat.ts          # MCP-Server-Side Controller
│   │       ├── process.ts            # Claude-CLI ProcessManager
│   │       ├── skills.ts             # 4-Datei-Skill-System
│   │       ├── channels.ts / inbox.ts
│   │       └── ...
│   ├── file-watcher-daemon-ts/       # Tray-Daemon (Port 7878)
│   │   └── src/
│   │       ├── main.ts
│   │       ├── manager.ts            # WatcherManager
│   │       ├── api.ts                # Fastify HTTP-API
│   │       ├── shell-job-worker.ts
│   │       └── specialist-job-worker.ts
│   └── web-ui/                       # React Dashboard (in Entwicklung)
├── scripts/
│   ├── coordinator-watch.sh
│   ├── chat-notify.sh
│   ├── chat-check.mjs
│   └── event-check.mjs
├── skills/
│   ├── synapse-nutzung/              # Koordinator-Regeln
│   └── synapse-agent-regeln/         # Agent-Regeln
├── .env.example
├── .mcp.json
├── .synapseignore
├── hooks-setup.example.json
├── shell-setup.example.fish
└── .mise.toml
```

---

## 🔧 Konfiguration

### .env

| Variable | Beschreibung | Standard |
|----------|--------------|---------|
| `DATABASE_URL` | PostgreSQL Connection String | - |
| `QDRANT_URL` | Qdrant Server URL | `http://localhost:6333` |
| `QDRANT_API_KEY` | Qdrant API Key (optional) | - |
| `EMBEDDING_PROVIDER` | `google` / `openai` / `ollama` / `cohere` / `openai-compatible` | `google` |
| `GOOGLE_API_KEY` | Google AI API Key | - |
| `OLLAMA_URL` / `OLLAMA_MODEL` | Ollama Server + Model | `http://localhost:11434` / `nomic-embed-text` |
| `OPENAI_API_KEY` | OpenAI API Key | - |
| `CONTEXT7_API_KEY` | Context7 Auto-Fetch | - |
| `API_PORT` / `API_HOST` | REST-API Port + Host | `3456` / `0.0.0.0` |
| `MAX_FILE_SIZE_MB` | Max-Größe für Indexierung | `1` |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | Chunking-Parameter | `1000` / `200` |
| `DEBOUNCE_MS` | FileWatcher Debounce | `500` |

### Shell-Umgebung

| Variable | Beschreibung |
|----------|--------------|
| `SYNAPSE_DB_URL` | PostgreSQL-URL für Hooks/Watcher (Pflicht) |
| `SYNAPSE_KEEP_ALIVE` | `1` → Heartbeat-Wake auch ohne Queue |
| `SYNAPSE_POLL_INTERVAL` | Heartbeat-Intervall (ms, default `15000`) |

### Slash-Commands (Claude Code Skills)

| Command | Beschreibung |
|---------|--------------|
| `/synapse-nutzung` | Koordinator-Regeln laden |
| `/synapse-agent-regeln` | Agent-/Subagent-Regeln laden |
| `/projekt-setup` | Setup-Wizard |
| `/projekt-regeln` | Coding-Standards |
| `/projekt-architektur` | Architektur-Übersicht |
| `/projekt-status` | Was Synapse über das Projekt weiß |

---

## 🧪 mise-Tasks

```bash
mr dev          # MCP Server im Dev-Modus
mr dev:api      # REST API im Dev-Modus
mr build        # Alle Packages bauen
mr build:core   # Nur Core
mr build:mcp    # Nur MCP Server
mr build:api    # Nur REST API
mr clean        # Alle dist/ löschen
mr lint         # Linter
```

---

## 📜 Lizenz

MIT
