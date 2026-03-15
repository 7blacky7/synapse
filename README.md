# Synapse

> KI-Gedaechtnis & Code-Intelligenz — Semantische Suche, Multi-Agent-Koordination und automatisches Wissensmanagement ueber MCP

## Was ist Synapse?

Synapse gibt KI-Agenten ein **persistentes Gedaechtnis**. Code wird automatisch indexiert, Wissen bleibt ueber Sessions erhalten, und mehrere Agenten koennen koordiniert an einem Projekt arbeiten — mit Broadcast-Chat, Wissenslücken-Erkennung und automatischer Dokumentations-Recherche.

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
                                    │  Wissens-Airbag     │
                                    └──┬──────────┬───────┘
                                       │          │
                              ┌────────▼──┐  ┌───▼────────┐
                              │  Qdrant   │  │ PostgreSQL  │
                              │  (Vektor) │  │ (Relational)│
                              │           │  │             │
                              │ Code      │  │ Thoughts    │
                              │ Memories  │  │ Memories    │
                              │ Tech-Docs │  │ Chat        │
                              │ Proposals │  │ Sessions    │
                              └───────────┘  │ Tech-Docs   │
                                             │ Plans       │
                                             └─────────────┘
```

## Features

### Semantische Code-Suche
- **FileWatcher** indexiert Code automatisch bei jeder Aenderung (Chokidar)
- **Vektor-Suche** ueber Qdrant — findet konzeptuell aehnlichen Code, nicht nur String-Matches
- **Pfad-Filter** und **Dateityp-Filter** fuer gezielte Suche
- **Google Embeddings** (gemini-embedding-2-preview, 3072d) fuer hohe Qualitaet

### Multi-Agent-System
- **Agenten-Chat** mit Broadcasts und Direktnachrichten (PostgreSQL-basiert)
- **Koordinator-Muster**: Opus dispatcht Haiku/Sonnet-Agenten fuer parallele Arbeit
- **Cutoff-Erkennung**: Jeder Agent registriert sein Modell, Synapse kennt den Wissens-Cutoff
- **Wissensluecken-Workflow**: Agent meldet Luecke → Koordinator dispatcht Docs-Kurator → kuratierte Docs indexiert

### Wissens-Airbag
- **`get_docs_for_file`** — Agent ruft das vor jeder Datei-Bearbeitung auf
- Erkennt relevante Frameworks anhand der Datei-Extension (`.ts` → TypeScript, Fastify, React, ...)
- Zeigt nur **Breaking Changes, Migration-Warnungen und Gotchas** die neuer als der Agent-Cutoff sind
- Quelle: Kuratierte `research`-Docs (vom Docs-Kurator via Web-Recherche indexiert)

### Context7 Auto-Fetch
- **`search_tech_docs`** holt automatisch Docs von [Context7](https://context7.com) wenn keine lokalen Ergebnisse
- Library-ID Resolution → Docs abrufen → in Projekt-Collection indexieren → zurueckgeben
- Liefert Basis-Docs (Code-Beispiele, API-Referenz) — fuer Breaking Changes braucht es den Docs-Kurator

### Docs-Kurator (Opus-Agent)
- Wird automatisch dispatcht wenn ein Agent eine Wissensluecke meldet
- Recherchiert auf **allen verfuegbaren Quellen**: offizielle Docs, GitHub Issues, Release Notes, Stack Overflow, Reddit, Blog-Posts
- Bewertet Qualitaet und Relevanz — indexiert nur was wirklich wichtig ist
- Kategorisiert: `breaking-change`, `migration`, `gotcha`, `known-issue`
- Ergebnis: Kuratierte, kompakte Docs mit Vorher/Nachher-Code und Quellenangabe

### Persistentes Projekt-Wissen
- **Memories** — Architektur, Regeln, Entscheidungen (Qdrant + PostgreSQL)
- **Thoughts** — Kurze Erkenntnisse, Ideen, Recherche-Ergebnisse
- **Plans** — Projekt-Ziele, Tasks, Architektur-Ueberblick
- **Proposals** — Code-Vorschlaege mit Status-Tracking
- **Tech-Docs** — Kuratierte Framework-Dokumentation (research + context7)

### Context-Handoff
- Automatische Session-Uebergabe wenn das Context-Window voll wird (95%/98% Schwellwerte)
- Fortschritt wird in Synapse gespeichert, neue Session liest nahtlos weiter
- Hook-basiert — PostToolUse-Hook ueberwacht den Context-Verbrauch

## Packages

| Package | Beschreibung | Laeuft auf |
|---------|--------------|------------|
| `@synapse/core` | Gemeinsamer Kern (Qdrant, PostgreSQL, Embeddings, Services) | - |
| `@synapse/mcp-server` | MCP Server fuer Claude Code, Desktop, Cline | User PC |
| `@synapse/rest-api` | REST API fuer Web-KIs (Claude.ai, ChatGPT, Gemini) | Unraid Server |
| `@synapse/web-ui` | Web-Dashboard (in Entwicklung) | - |

## Schnellstart

### 1. Voraussetzungen

- **Node.js 20+**
- **pnpm** (Paketmanager)
- **Qdrant** (Vektor-Datenbank, Docker oder Cloud)
- **PostgreSQL** (relationale Daten, Docker oder lokal)
- **Google AI API Key** (fuer Embeddings)
- Optional: **Context7 API Key** (fuer automatische Docs)

### 2. Installation

```bash
cd synapse
pnpm install
pnpm run build
```

### 3. Konfiguration

```bash
cp .env.example .env
# .env bearbeiten: QDRANT_URL, DATABASE_URL, GOOGLE_API_KEY
```

### 4. MCP Server (Claude Code / Desktop)

In `.mcp.json` im Projekt-Root:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/pfad/zu/synapse/packages/mcp-server/dist/index.js"],
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

### 5. REST API (fuer Web-KIs)

```bash
pnpm run dev:api
# Laeuft auf http://0.0.0.0:3456
```

## MCP Tools (46 Tools)

### Projekt-Management

| Tool | Beschreibung |
|------|--------------|
| `init_projekt` | Projekt initialisieren, FileWatcher + Tech-Detection starten |
| `stop_projekt` | FileWatcher stoppen |
| `get_project_status` | Status mit Vektor-Statistiken |
| `detect_technologies` | Frameworks, Libraries und Tools erkennen |
| `list_active_projects` | Alle aktiven Projekte |
| `cleanup_projekt` | Projekt-Daten bereinigen |
| `complete_setup` | Setup-Wizard abschliessen |

### Code-Suche

| Tool | Beschreibung |
|------|--------------|
| `semantic_code_search` | Konzeptuelle Suche (Was macht der Code?) |
| `search_by_path` | Suche nach Dateipfad-Muster |
| `search_code_with_path` | Kombiniert: Konzept + Pfad |

### Wissen & Gedaechtnis

| Tool | Beschreibung |
|------|--------------|
| `write_memory` | Langform-Wissen speichern (Architektur, Regeln) |
| `read_memory` | Memory nach Name lesen |
| `read_memory_with_code` | Memory + zugehoerigen Code laden |
| `search_memory` | Semantische Memory-Suche |
| `list_memories` | Alle Memories auflisten |
| `update_memory` | Memory aktualisieren (PostgreSQL + re-embed) |
| `delete_memory` | Memory loeschen |
| `find_memories_for_file` | Relevante Memories fuer eine Datei |

### Gedanken & Ideen

| Tool | Beschreibung |
|------|--------------|
| `add_thought` | Kurze Erkenntnis speichern |
| `get_thoughts` | Letzte Gedanken abrufen |
| `search_thoughts` | Semantische Thought-Suche |
| `update_thought` | Thought aktualisieren |
| `delete_thought` | Thought loeschen |
| `save_project_idea` | Projekt-Idee als Proposal speichern |
| `confirm_idea` | Idee bestaetigen und Plan erstellen |

### Projekt-Plaene

| Tool | Beschreibung |
|------|--------------|
| `get_project_plan` | Plan abrufen |
| `update_project_plan` | Plan aktualisieren |
| `add_plan_task` | Task zum Plan hinzufuegen |

### Proposals

| Tool | Beschreibung |
|------|--------------|
| `list_proposals` | Alle Proposals auflisten |
| `get_proposal` | Proposal nach ID |
| `search_proposals` | Semantische Proposal-Suche |
| `update_proposal` | Proposal-Inhalt aendern |
| `update_proposal_status` | Status aendern (draft → approved → implemented) |
| `delete_proposal` | Proposal loeschen |

### Tech-Docs & Wissens-Airbag

| Tool | Beschreibung |
|------|--------------|
| `search_tech_docs` | Docs suchen (mit Context7 Auto-Fetch) |
| `add_tech_doc` | Kuratierte Docs indexieren |
| `get_docs_for_file` | Wissens-Airbag: Breaking Changes fuer eine Datei |

### Agenten-Chat

| Tool | Beschreibung |
|------|--------------|
| `register_chat_agent` | Agent registrieren (mit Cutoff-Erkennung) |
| `unregister_chat_agent` | Agent abmelden |
| `send_chat_message` | Broadcast oder DM senden |
| `get_chat_messages` | Nachrichten abrufen (mit Polling via `since`) |
| `list_chat_agents` | Aktive Agenten auflisten |

### Statistiken & Admin

| Tool | Beschreibung |
|------|--------------|
| `get_index_stats` | Vektor-Statistiken + Agent-Onboarding |
| `get_detailed_stats` | Aufschuesselung nach Dateityp, Source, Kategorie |
| `migrate_embeddings` | Embedding-Modell wechseln |
| `restore_backup` | Daten aus PostgreSQL-Backup wiederherstellen |

## Wissens-Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  Code-Agent (Haiku/Sonnet)                                      │
│                                                                  │
│  1. get_docs_for_file("src/api.ts")                             │
│     → Wissens-Airbag: 7 Breaking Changes, 2 Gotchas            │
│                                                                  │
│  2. search_tech_docs("fastify routing")                          │
│     → Context7 Auto-Fetch: 5 Code-Beispiele indexiert           │
│                                                                  │
│  3. Kuratiertes Wissen fehlt?                                    │
│     → Chat-DM: "Wissensluecke: Fastify v5 Breaking Changes"    │
│                                                                  │
│  4. Warte auf Koordinator (Polling)                              │
└────────────────────┬────────────────────────────────────────────┘
                     │ DM
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Koordinator (Opus)                                              │
│                                                                  │
│  → Dispatcht Docs-Kurator (Opus)                                │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Docs-Kurator (Opus)                                             │
│                                                                  │
│  1. Context7 Basis-Docs bewerten                                │
│  2. Web-Recherche: Offizielle Docs, GitHub Issues, Reddit, ...  │
│  3. Kuratieren: Was ist relevant? Vorher/Nachher-Code?          │
│  4. add_tech_doc(type: "breaking-change", source: "research")   │
│  5. Chat-Broadcast: "11 Docs indexiert"                         │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Code-Agent                                                      │
│                                                                  │
│  → search_tech_docs(source: "research") → findet kuratierte Docs│
│  → get_docs_for_file → Wissens-Airbag zeigt Breaking Changes   │
└─────────────────────────────────────────────────────────────────┘
```

## Datenbank-Schema

### Qdrant (Vektor-Suche)

| Collection | Inhalt | Dimension |
|------------|--------|-----------|
| `project_{name}_code` | Code-Chunks mit Metadaten | 3072 |
| `project_{name}_thoughts` | Gedanken (semantisch durchsuchbar) | 3072 |
| `project_{name}_memories` | Memories (Architektur, Regeln) | 3072 |
| `project_{name}_proposals` | Code-Vorschlaege | 3072 |
| `project_{name}_docs` | Tech-Docs pro Projekt | 3072 |
| `tech_docs_cache` | Globaler Docs-Cache | 3072 |

### PostgreSQL (Source of Truth)

| Tabelle | Inhalt |
|---------|--------|
| `thoughts` | Gedanken mit Tags, Source, Timestamp |
| `memories` | Memories mit Kategorie, Tags, Code-Links |
| `plans` | Projekt-Plaene mit Goals und Tasks |
| `proposals` | Code-Vorschlaege mit Status |
| `tech_docs` | Kuratierte Framework-Docs mit Content-Hash |
| `agent_sessions` | Registrierte Agenten mit Modell und Cutoff |
| `chat_messages` | Agenten-Chat (Broadcasts + DMs) |

## Slash-Commands

Synapse bringt eigene Slash-Commands fuer Claude Code mit:

| Command | Beschreibung |
|---------|--------------|
| `/projekt-setup` | **Setup-Wizard** — Erfasst Projektbeschreibung, Coding-Standards, Commit-Konventionen und Skills. Speichert alles als Synapse-Memories. |
| `/projekt-regeln` | **Coding-Standards** anzeigen und aendern — Sprache, Linter, Commit-Konventionen, Namensgebung |
| `/projekt-architektur` | **Architektur-Uebersicht** anzeigen und bearbeiten — Design-Entscheidungen, Komponentenstruktur |
| `/projekt-status` | **Alles anzeigen** was Synapse ueber das Projekt weiss — Regeln, Architektur, Beschreibung |
| `/synapse-nutzung` | **Koordinator-Regeln** laden — Session-Management, Agenten-Dispatching, Wissensluecke-Reaktion, Context-Handoff |
| `/synapse-agent-regeln` | **Agent-Regeln** laden — Onboarding, Suche, Kommunikation, Wissens-Airbag (wird Subagenten im Prompt mitgegeben) |
| `/commit-arbeit` | **Commit-Workflow** — Konventionelle Commits, logische Aufteilung, Patch-Staging, Sicherheitspruefungen |

### Typischer Projekt-Start

```bash
# 1. Synapse fuer ein neues Projekt einrichten
> /projekt-setup
# → Wizard fragt nach Beschreibung, Standards, Konventionen
# → Speichert alles als Synapse-Memories (category: "rules")

# 2. Projekt initialisieren (MCP-Tool)
> init_projekt(path: "/pfad/zum/projekt")
# → FileWatcher startet, Code wird indexiert, Technologien erkannt

# 3. Arbeiten — Synapse-Regeln laden
> /synapse-nutzung
# → Koordinator-Regeln aktiv, Agenten koennen dispatcht werden
```

## Skills (Dateien)

| Skill | Pfad | Zweck |
|-------|------|-------|
| `synapse-nutzung` | `skills/synapse-nutzung/SKILL.md` | Koordinator-Regeln (im Repo) |
| `synapse-agent-regeln` | `skills/synapse-agent-regeln/SKILL.md` | Agent-Regeln (im Repo) |
| `projekt-setup` | `~/.claude/skills/projekt-setup/` | Setup-Wizard (global) |
| `projekt-regeln` | `~/.claude/skills/projekt-regeln/` | Coding-Standards (global) |
| `projekt-architektur` | `~/.claude/skills/projekt-architektur/` | Architektur (global) |
| `projekt-status` | `~/.claude/skills/projekt-status/` | Status-Uebersicht (global) |
| `commit-arbeit` | `~/.claude/skills/commit-arbeit/` | Commit-Workflow (global) |

## Entwicklung

### mise-Tasks

```bash
mr dev          # MCP Server im Dev-Modus starten
mr dev:api      # REST API im Dev-Modus starten
mr build        # Alle Packages bauen
mr build:core   # Nur Core bauen
mr build:mcp    # Nur MCP Server bauen
mr build:api    # Nur REST API bauen
mr clean        # Alle dist/ Ordner loeschen
mr lint         # Linter ausfuehren
```

### Projekt-Struktur

```
synapse/
├── packages/
│   ├── core/           # Gemeinsamer Kern (Services, DB, Embeddings)
│   ├── mcp-server/     # MCP Server (stdio, 46 Tools)
│   ├── rest-api/       # REST API (Fastify, HTTP)
│   └── web-ui/         # Web-Dashboard (React, in Entwicklung)
├── skills/
│   ├── synapse-nutzung/      # Koordinator-Regeln
│   └── synapse-agent-regeln/ # Agent-Regeln
├── .mcp.json           # MCP Server Konfiguration
├── .synapseignore      # Dateien vom Index ausschliessen
└── .mise.toml          # Task-Runner Konfiguration
```

## Bekannte Einschraenkungen

| Problem | Status |
|---------|--------|
| `get_detailed_stats` zeigt Gesamtzahlen ueber alle Projekte | Offen |
| REST-API hat keinen eigenen FileWatcher | Offen |
| Projekt-Pfade sind systemspezifisch (kein relatives Mapping) | Offen |
| Context-Handoff nur auf Linux + fish/bash getestet | Plattform |

## Lizenz

MIT
