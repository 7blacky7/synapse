# 🧠 Synapse — KI-Gedaechtnis & Agenten-Orchestrierung

> Persistentes Projekt-Wissen, semantische Code-Suche und Multi-Agent-Koordination ueber MCP.
> Synapse gibt KI-Agenten ein Langzeitgedaechtnis: Code wird automatisch indexiert, Wissen bleibt ueber Sessions erhalten, und mehrere Agenten koennen koordiniert an einem Projekt arbeiten — mit Chat, Events, Wissens-Airbag und automatischer Dokumentations-Recherche.

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
                                    │  Embeddings (Google) │
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
                                             └─────────────┘
```

---

## ✨ Features

| Feature | Beschreibung |
|---------|--------------|
| 🔍 **Semantische Code-Suche** | FileWatcher indexiert Code automatisch. Vektor-Suche ueber Qdrant findet konzeptuell aehnlichen Code — nicht nur String-Matches. Google Embeddings (3072d). |
| 🧠 **Persistentes Projekt-Wissen** | Memories (Architektur, Regeln), Thoughts (Erkenntnisse), Plans (Ziele, Tasks), Proposals (Code-Vorschlaege), Tech-Docs — alles ueberlebt Session-Grenzen. |
| 💬 **Multi-Agent Chat** | Broadcast-Nachrichten an alle Agenten oder gezielte DMs. Polling-basiert mit `since`-Timestamp. Ungelesene Nachrichten werden in jeder Tool-Response eingeblendet. |
| ⚡ **Event-System** | Verbindliche Steuersignale (WORK_STOP, CRITICAL_REVIEW, ...) mit Pflicht-Ack. Eskalation nach 3 ignorierten Calls. Prioritaeten: critical, high, normal. |
| 🤖 **Agenten-Koordination** | Koordinator-Muster: Opus dispatcht Sonnet/Haiku-Agenten. Batch-Registrierung, automatisches Onboarding, Coordinator-Watch fuer Idle-Aufwachen. |
| 🔄 **Context-Handoff** | Automatische Session-Uebergabe wenn das Context-Window voll wird. Fortschritt in Synapse gespeichert, neue Session liest nahtlos weiter. |
| 📚 **Tech-Docs Auto-Fetch** | `search_tech_docs` holt automatisch Docs von [Context7](https://context7.com) wenn keine lokalen Ergebnisse. Docs-Kurator (Opus) recherchiert kuratierte Breaking Changes. |
| 🛡️ **Wissens-Airbag** | `get_docs_for_file` zeigt vor jeder Datei-Bearbeitung Breaking Changes, Migration-Warnungen und Gotchas — nur was neuer als der Agent-Cutoff ist. |
| 👁️ **FileWatcher** | Chokidar-basiert. Erkennt Aenderungen in Echtzeit → Chunking → Google Embedding → Qdrant. Respektiert `.synapseignore`. |
| 🔔 **Coordinator-Watch** | Background-Daemon pollt alle 10s auf neue Chat-Nachrichten und Events. Weckt den Koordinator im Idle via Task-Notification. |
| 🖼️ **Media-Suche** | Cross-Modal Suche: Bilder und Videos per Text-Query finden (Google Gemini Embedding 2). |
| 🔧 **Tech-Detection** | Erkennt automatisch Frameworks, Libraries und Tools im Projekt. |

---

## 🏗️ Architektur

### Monorepo-Packages

| Package | Beschreibung | Laeuft auf |
|---------|--------------|------------|
| `@synapse/core` | Gemeinsamer Kern — Services, DB, Embeddings, FileWatcher, Events | - |
| `@synapse/mcp-server` | MCP Server (stdio) fuer Claude Code, Claude Desktop, Cline | User PC |
| `@synapse/rest-api` | REST API (Fastify, HTTP) fuer Web-KIs (Claude.ai, ChatGPT, Gemini) | Server |
| `@synapse/web-ui` | Web-Dashboard (React, in Entwicklung) | - |

### Datenfluss

```
Datei gespeichert
  → FileWatcher (Chokidar) erkennt Aenderung
    → .synapseignore pruefen
      → Datei lesen + in Chunks aufteilen (1000 Zeichen, 200 Overlap)
        → Google Gemini Embedding (3072 Dimensionen)
          → Qdrant Vektor-DB (Upsert mit Metadaten)
```

### Dual-Storage

- **Qdrant** — Semantische Vektor-Suche (Code, Memories, Thoughts, Proposals, Tech-Docs, Media)
- **PostgreSQL** — Source of Truth fuer strukturierte Daten (alle 9 Tabellen)

Jedes Projekt bekommt eigene Qdrant-Collections: `project_{name}_code`, `project_{name}_thoughts`, etc.

---

## 🛠️ MCP-Tools (53 Tools)

### 📦 Projekt-Management (9 Tools)

| Tool | Beschreibung |
|------|--------------|
| `init_projekt` | Projekt initialisieren, FileWatcher + Tech-Detection starten |
| `complete_setup` | Setup-Phase als abgeschlossen markieren |
| `detect_technologies` | Frameworks, Libraries und Tools erkennen |
| `cleanup_projekt` | Vektoren fuer ignorierte Dateien bereinigen |
| `stop_projekt` | FileWatcher stoppen |
| `list_active_projects` | Alle aktiven Projekte auflisten |
| `get_project_status` | Persistenter Status aus `.synapse/status.json` |
| `get_index_stats` | Vektor-Statistiken + Agent-Onboarding |
| `get_detailed_stats` | Aufschluesselung nach Dateityp, Source, Kategorie |

### 🔍 Code-Suche (3 Tools)

| Tool | Beschreibung |
|------|--------------|
| `semantic_code_search` | Konzeptuelle Suche — findet aehnlichen Code |
| `search_by_path` | Exakte Pfadsuche nach Glob-Pattern |
| `search_code_with_path` | Kombiniert: Semantisch + Pfad-Filter |

### 🖼️ Media (2 Tools)

| Tool | Beschreibung |
|------|--------------|
| `search_media` | Cross-Modal Suche: Bilder/Videos per Text-Query |
| `index_media` | Bilder und Videos indexieren (Gemini Embedding 2) |

### 🧠 Memories (8 Tools)

| Tool | Beschreibung |
|------|--------------|
| `write_memory` | Langform-Wissen speichern (Architektur, Regeln, Docs) |
| `read_memory` | Memory nach Name lesen |
| `read_memory_with_code` | Memory + verwandten Code laden |
| `search_memory` | Semantische Memory-Suche |
| `list_memories` | Alle Memories auflisten |
| `update_memory` | Memory aktualisieren (PostgreSQL + re-embed) |
| `delete_memory` | Memory loeschen |
| `find_memories_for_file` | Relevante Memories fuer eine Datei finden |

### 💭 Gedanken (5 Tools)

| Tool | Beschreibung |
|------|--------------|
| `add_thought` | Kurze Erkenntnis speichern |
| `get_thoughts` | Letzte Gedanken abrufen |
| `search_thoughts` | Semantische Thought-Suche |
| `update_thought` | Thought aktualisieren (PostgreSQL + re-embed) |
| `delete_thought` | Thought loeschen |

### 📋 Plaene (3 Tools)

| Tool | Beschreibung |
|------|--------------|
| `get_project_plan` | Plan abrufen (Ziele, Tasks, Architektur) |
| `update_project_plan` | Plan aktualisieren |
| `add_plan_task` | Task zum Plan hinzufuegen |

### 📝 Proposals (6 Tools)

| Tool | Beschreibung |
|------|--------------|
| `save_project_idea` | Projekt-Idee als Proposal speichern |
| `confirm_idea` | Idee bestaetigen und persistent speichern |
| `list_proposals` | Alle Proposals auflisten |
| `get_proposal` | Proposal nach ID abrufen |
| `search_proposals` | Semantische Proposal-Suche |
| `update_proposal_status` | Status aendern (pending → reviewed → accepted) |
| `update_proposal` | Proposal-Inhalt aendern |
| `delete_proposal` | Proposal loeschen |

### 💬 Chat (7 Tools)

| Tool | Beschreibung |
|------|--------------|
| `register_chat_agent` | Agent registrieren (mit Cutoff-Erkennung) |
| `register_chat_agents_batch` | Mehrere Agenten auf einmal registrieren |
| `unregister_chat_agent` | Agent abmelden |
| `unregister_chat_agents_batch` | Mehrere Agenten abmelden |
| `send_chat_message` | Broadcast (alle) oder DM (ein Agent) senden |
| `get_chat_messages` | Nachrichten abrufen (Polling via `since`) |
| `list_chat_agents` | Aktive Agenten auflisten |

### ⚡ Events (3 Tools)

| Tool | Beschreibung |
|------|--------------|
| `emit_event` | Steuersignal an Agenten senden |
| `acknowledge_event` | Event quittieren (Pflicht bei `requires_ack`) |
| `get_pending_events` | Unbestaetigte Events abrufen |

### 📚 Tech-Docs & Wissens-Airbag (3 Tools)

| Tool | Beschreibung |
|------|--------------|
| `add_tech_doc` | Kuratierte Docs indexieren (Breaking Changes, Migrations, ...) |
| `search_tech_docs` | Docs suchen (mit Context7 Auto-Fetch) |
| `get_docs_for_file` | Wissens-Airbag: Relevante Docs fuer eine Datei |

### 🔧 Migration & Backup (2 Tools)

| Tool | Beschreibung |
|------|--------------|
| `migrate_embeddings` | Embedding-Modell wechseln (Backup → Re-Embed) |
| `restore_backup` | Daten aus JSONL-Backup wiederherstellen |

---

## 🎭 Event-System

Events sind **verbindliche Steuersignale** — keine Chat-Nachrichten. Der Koordinator sendet Events, Agenten muessen reagieren.

### Event-Typen

| Event-Typ | Priority | Pflicht-Reaktion |
|-----------|----------|-----------------|
| `WORK_STOP` | critical | Arbeit sofort anhalten, Status posten |
| `CRITICAL_REVIEW` | critical | Betroffene Arbeit nicht abschliessen |
| `ARCH_DECISION` | high | Plan neu pruefen, Ack mit Bewertung |
| `TEAM_DISCUSSION` | high | Status posten, auf Koordinator warten |
| `ANNOUNCEMENT` | normal | Lesen, Ack, weiterarbeiten |

### Priority-Level

| Level | Bedeutung |
|-------|-----------|
| `critical` | Sofortige Reaktion, Arbeit anhalten |
| `high` | Zeitnah reagieren, vor naechstem Task |
| `normal` | Zur Kenntnis nehmen, weiterarbeiten |

### Scope

- `all` — alle aktiven Agenten sehen das Event
- `agent:<id>` — nur ein bestimmter Agent

### Delivery-Mechanismus

```
1. Koordinator: emit_event(project, event_type, priority, scope, source_id, payload)
   → PostgreSQL: agent_events Tabelle

2. Agent fuehrt beliebiges Tool aus
   → server.ts: withOnboarding() prueft getPendingEvents()
   → Tool-Response enthaelt pendingEvents mit Hint-Text

3. PostToolUse Hook (chat-notify.sh)
   → Pollt Events via event-check.mjs
   → Zeigt Events VOR Chat-Nachrichten an

4. Agent: acknowledge_event(event_id, agent_id, reaction)
   → PostgreSQL: agent_event_acks Tabelle
```

### Eskalation

Nach **3 Tool-Calls** ohne Ack bei `critical`/`high` Events:
→ Automatische DM an Koordinator: *"Agent X ignoriert Event Y seit Z Calls"*

### Beispiel

```typescript
// Koordinator stoppt alle Agenten
emit_event(
  project: "synapse",
  event_type: "WORK_STOP",
  priority: "critical",
  scope: "all",
  source_id: "koordinator",
  payload: "Architektur-Aenderung in schema.ts. Wartet auf Review."
)

// Agent quittiert
acknowledge_event(
  event_id: 5,
  agent_id: "code-spatz",
  reaction: "Arbeit angehalten. Aktueller Stand: 3/5 Tests geschrieben."
)
```

---

## 🤖 Multi-Agent Koordination

### Koordinator-Muster

```
┌─────────────────────────────────────────┐
│  Koordinator (Opus)                     │
│                                         │
│  1. register_chat_agents_batch          │
│  2. coordinator-watch.sh starten        │
│  3. Agenten spawnen mit Prompt-Baustein │
│  4. Chat lesen + Events beobachten      │
│  5. search_thoughts nach Ergebnissen    │
└────┬──────────┬──────────┬──────────────┘
     │          │          │
     ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │Haiku │  │Sonnet│  │Haiku │
  │Agent1│  │Agent2│  │Agent3│
  └──────┘  └──────┘  └──────┘
```

### Agent-Registrierung

```typescript
// Batch-Registrierung (spart API-Calls)
register_chat_agents_batch(
  agents: [
    { id: "code-spatz", model: "claude-haiku-4-5" },
    { id: "test-falke", model: "claude-sonnet-4-6" }
  ],
  project: "synapse"
)
```

### Automatisches Onboarding

Jeder Agent bekommt beim ersten Tool-Call automatisch:
- **Projekt-Regeln** (Memories mit `category: "rules"`)
- **Ungelesene Chat-Nachrichten** und **ausstehende Events**
- **Liste aktiver Agenten**

### Coordinator-Watch

Der Koordinator hat kein echtes Push-System. Der `coordinator-watch.sh` Daemon lauft im Hintergrund:

```bash
# Alle 10s auf neue DMs und Events pruefen
bash ~/dev/synapse/scripts/coordinator-watch.sh "synapse" "koordinator" 10
```

Wenn neue Nachrichten oder Events ankommen:
→ Script gibt Output und beendet sich
→ Claude Code Task-Notification weckt den Koordinator
→ Koordinator liest Nachrichten, reagiert, startet Watcher neu

### Wissensluecken-Workflow

```
Agent meldet: "Wissensluecke: Fastify v5 Breaking Changes"
  → Koordinator empfaengt DM
    → Dispatcht Docs-Kurator (Opus)
      → Web-Recherche, GitHub Issues, offizielle Docs
        → add_tech_doc(type: "breaking-change", source: "research")
          → Agent: search_tech_docs(source: "research")
            → Kuratierte Breaking Changes verfuegbar
```

---

## 🗄️ Datenbank-Schema

### PostgreSQL (9 Tabellen)

| Tabelle | Spalten | Beschreibung |
|---------|---------|--------------|
| `memories` | id, project, name, category, content, tags, created_at, updated_at | Langzeit-Wissen (Architektur, Regeln, Docs) |
| `thoughts` | id, project, source, content, tags, timestamp | Kurze Erkenntnisse und Ideen |
| `plans` | id, project, name, description, goals, architecture, tasks (JSONB) | Projekt-Plaene mit Tasks |
| `proposals` | id, project, file_path, suggested_content, description, author, status, tags | Code-Vorschlaege mit Status-Tracking |
| `agent_sessions` | id, project, model, cutoff_date, status, registered_at | Registrierte Agenten mit Modell-Info |
| `chat_messages` | id, project, sender_id, recipient_id, content, timestamp | Agenten-Chat (Broadcasts + DMs) |
| `tech_docs` | id, framework, version, section, content, type, category, content_hash, source | Kuratierte Framework-Dokumentation |
| `agent_events` | id, project, event_type, priority, scope, source_id, payload, requires_ack | Steuersignale zwischen Agenten |
| `agent_event_acks` | event_id, agent_id, acked_at, reaction | Quittierungen von Events |

### Qdrant (Vektor-Collections)

| Collection | Inhalt | Dimension |
|------------|--------|-----------|
| `project_{name}_code` | Code-Chunks mit Metadaten | 3072 |
| `project_{name}_thoughts` | Gedanken (semantisch durchsuchbar) | 3072 |
| `project_{name}_memories` | Memories (Architektur, Regeln) | 3072 |
| `project_{name}_proposals` | Code-Vorschlaege | 3072 |
| `project_{name}_docs` | Tech-Docs pro Projekt | 3072 |
| `project_{name}_media` | Bilder und Videos | 3072 |
| `tech_docs_cache` | Globaler Docs-Cache | 3072 |

---

## 🪝 Hooks

Synapse nutzt Claude Code Hooks fuer automatische Integrationen:

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

Zusaetzlich erweitert `server.ts` jede Tool-Response um:
- **pendingEvents** — unbestaetigte Events mit Hint-Text
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
- **Google AI API Key** (fuer Embeddings, `gemini-embedding-2-preview`)
- Optional: **Context7 API Key** (fuer automatische Framework-Docs)

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
# Synapse DB-URL fuer Hooks und Scripts
# WICHTIG: Ohne diese Variable funktionieren Chat-Notifications,
# Event-Watcher und Coordinator-Watch NICHT.
set -gx SYNAPSE_DB_URL "postgresql://synapse:password@localhost:5432/synapse"

# Claude Code mit automatischem Context-Handoff + volle Rechte
alias cc "bash ~/.claude/skills/synapse-nutzung/scripts/claude-session.sh --dangerously-skip-permissions"
```

Vorlage: [`shell-setup.example.fish`](shell-setup.example.fish)

### 6. Projekt initialisieren

```
> init_projekt(path: "/home/<user>/dev/mein-projekt")
```

→ FileWatcher startet, Code wird indexiert, Technologien erkannt.

### 7. REST API starten (optional)

```bash
pnpm run dev:api
# Laeuft auf http://0.0.0.0:3456
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
│   ├── mcp-server/                  # MCP Server (53 Tools)
│   │   ├── src/
│   │   │   ├── server.ts            # Tool-Definitionen + Response Enhancement
│   │   │   └── tools/               # Tool-Implementierungen
│   │   └── hooks/
│   │       ├── pre-synapse-onboarding.sh   # Koordinator + Agent Onboarding
│   │       └── post-edit-framework-docs.sh # Wissens-Airbag Hook
│   ├── rest-api/                    # REST API (Fastify)
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
├── .synapseignore                   # Dateien vom Index ausschliessen
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
| `GOOGLE_API_KEY` | Google AI API Key (fuer Embeddings) | - |
| `OLLAMA_URL` | Ollama Server URL | `http://localhost:11434` |
| `OLLAMA_MODEL` | Ollama Embedding Model | `nomic-embed-text` |
| `OPENAI_API_KEY` | OpenAI API Key (optional) | - |
| `CONTEXT7_API_KEY` | Context7 API Key (Auto-Fetch) | - |
| `API_PORT` | REST API Port | `3456` |
| `API_HOST` | REST API Host | `0.0.0.0` |
| `MAX_FILE_SIZE_MB` | Max Dateigroesse fuer Indexierung | `1` |
| `CHUNK_SIZE` | Chunk-Groesse in Zeichen | `1000` |
| `CHUNK_OVERLAP` | Overlap zwischen Chunks | `200` |
| `DEBOUNCE_MS` | FileWatcher Debounce | `500` |

### Shell-Umgebung

| Variable | Beschreibung | Benoetigt fuer |
|----------|--------------|---------------|
| `SYNAPSE_DB_URL` | PostgreSQL URL (in Fish Shell) | Chat-Notify, Coordinator-Watch, Event-Check |

### Slash-Commands (Claude Code Skills)

| Command | Beschreibung |
|---------|--------------|
| `/synapse-nutzung` | Koordinator-Regeln laden |
| `/synapse-agent-regeln` | Agent-Regeln laden |
| `/projekt-setup` | Setup-Wizard (Beschreibung, Standards, Skills) |
| `/projekt-regeln` | Coding-Standards anzeigen/aendern |
| `/projekt-architektur` | Architektur-Uebersicht |
| `/projekt-status` | Alles anzeigen was Synapse ueber das Projekt weiss |
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
mr clean        # Alle dist/ loeschen
mr lint         # Linter ausfuehren
```

---

## 📋 Bekannte Einschraenkungen

| Einschraenkung | Details |
|----------------|---------|
| Context-Handoff | Nur auf Linux + fish/bash getestet |
| Kein echter Push | Coordinator-Watch (Polling alle 10s) als Workaround |
| Google Batch-Embedding | Limit von 100 Texten pro Batch-Request |
| REST-API FileWatcher | REST-API hat keinen eigenen FileWatcher |
| Pfade systemspezifisch | Absolute Pfade, kein relatives Mapping |
| `get_detailed_stats` | Zeigt Gesamtzahlen ueber alle Projekte |

---

## 📜 Lizenz

MIT
