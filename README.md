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

**⚠️ ARCHITEKTUR-PROBLEM:** Reads kommen je nach Operation aus verschiedenen Stores:
- `get*/list*` Operationen lesen **Qdrant** (Read-Primary)
- `update*/delete*` Operationen lesen **PostgreSQL** (Write-Primary)
- **Konsequenz:** Bei Partial-Failure entstehen Geister-Datensätze (unsichtbar oder nicht-editierbar)

Jedes Projekt bekommt eigene Qdrant-Collections: `project_{name}_code`, `project_{name}_thoughts`, etc.

---

## 🛠️ MCP-Tools (13 konsolidierte Tools, 72 Actions)

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

---

### 📋 Pläne (`plan`)

**Actions:** `get`, `update`, `add_task`

| Action | Beschreibung |
|--------|--------------|
| `get` | Plan abrufen (Ziele, Tasks, Architektur) |
| `update` | Plan aktualisieren |
| `add_task` | Task zum Plan hinzufügen |

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

---

### ⚡ Events (`event`)

**Actions:** `emit`, `ack`, `pending`

| Action | Beschreibung |
|--------|--------------|
| `emit` | Steuersignal an Agenten senden |
| `ack` | Event quittieren (Pflicht bei `requires_ack`) |
| `pending` | Unbestätigte Events abrufen |

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

---

### 👁️ FileWatcher (`watcher`)

**Actions:** `status`, `start`, `stop`

| Action | Beschreibung |
|--------|--------------|
| `status` | FileWatcher-Status prüfen |
| `start` | FileWatcher starten |
| `stop` | FileWatcher stoppen |

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

### PostgreSQL (10 Tabellen)

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
│   │       ├── embeddings/          # Google / Ollama / OpenAI
│   │       └── watcher/             # FileWatcher (Chokidar)
│   ├── mcp-server/                  # MCP Server (13 konsolidierte Tools)
│   │   ├── src/
│   │   │   ├── server.ts            # Tool-Definitionen + Response Enhancement
│   │   │   └── tools/
│   │   │       ├── consolidated/    # 13 konsolidierte Super-Tools
│   │   │       │   ├── admin.ts
│   │   │       │   ├── chat.ts
│   │   │       │   ├── channel.ts
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
| **🚨 Dual-Write Consistency** | Kein Rollback bei Partial-Failure (PG OK ↔ Qdrant FAIL) → Daten in nur einem Store, keine automatischen Retries |
| **Inkonsistente Read-Pfade** | `get*/list*` liest Qdrant, `update*` liest PG → Geister-Datensätze bei Failures (unsichtbar oder nicht-editierbar) |
| **Keine PG-Transaktionen** | Kein BEGIN/COMMIT pro Schreiboperation → keine ACID-Garantien, Race Conditions bei concurrent Updates |
| **Kein Optimistic Locking** | Race Conditions bei concurrent Plan-Updates (updateTask), Lost Updates möglich — Blockiert bis Phase 3 |
| **tech-docs.ts Sonderfall** | Bare awaits OHNE try-catch bei Dual-Write (Ausnahme zum allgemeinen Error-Pattern) |
| **code.ts Invertierte Reihenfolge** | Schreibt Qdrant first statt PG first (Inkonsistenz zur Standard-Reihenfolge) |
| **Kein Reconciliation-Job** | Dual-Write Drift akkumuliert über Zeit, keine automatische Heilung |
| Context-Handoff | Nur auf Linux + fish/bash getestet |
| Kein echter Push | Coordinator-Watch (Polling alle 10s) als Workaround |
| Google Batch-Embedding | Limit von 100 Texten pro Batch-Request |
| REST-API FileWatcher | REST-API hat keinen eigenen FileWatcher |
| `detailed_stats` | Zeigt Gesamtzahlen über alle Projekte |

---

## 📜 Lizenz

MIT
