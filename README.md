# Synapse

> KI-Gedaechtnis & Code-Intelligenz - Verbindet lokale CLIs und Web-KIs

## Uebersicht

Synapse ist ein System zur Integration verschiedener KI-Tools mit:
- **Automatischer Code-Indexierung** via FileWatcher
- **Semantischer Suche** ueber Vektor-Datenbank (Qdrant)
- **Gedankenaustausch** zwischen verschiedenen KIs
- **Projekt-Plaenen** fuer Ziele, Tasks und Architektur

## Komponenten

| Package | Beschreibung | Laeuft auf |
|---------|--------------|------------|
| `@synapse/core` | Gemeinsamer Kern | - |
| `@synapse/mcp-server` | MCP Server fuer Claude Code, Desktop, etc. | User PC |
| `@synapse/rest-api` | REST API fuer Claude Web, ChatGPT, etc. | Unraid Server |

## Schnellstart

### 1. Installation

```bash
cd synapse
npm install
npm run build
```

### 2. Konfiguration

```bash
cp .env.example .env
# .env bearbeiten!
```

### 3. MCP Server (Claude Code/Desktop)

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/pfad/zu/synapse/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### 4. REST API (fuer Web-KIs)

```bash
npm run dev:api
# Laeuft auf http://0.0.0.0:3456
```

## MCP Tools

| Tool | Beschreibung |
|------|--------------|
| `init_projekt(path, name?)` | Projekt initialisieren, FileWatcher starten |
| `semantic_code_search(query, project, fileType?, limit?)` | Code durchsuchen |
| `search_docs(query, framework?, useContext7?, limit?)` | Docs durchsuchen |
| `get_project_plan(project)` | Plan abrufen |
| `update_project_plan(project, updates)` | Plan aktualisieren |
| `add_plan_task(project, title, description, priority?)` | Task hinzufuegen |
| `add_thought(project, source, content, tags?)` | Gedanken speichern |
| `get_thoughts(project, limit?)` | Gedanken abrufen |
| `search_thoughts(query, project?, limit?)` | Gedanken durchsuchen |

## REST Endpoints

| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/api/status` | GET | Server-Status |
| `/api/projects` | GET | Projekte auflisten |
| `/api/projects/init` | POST | Projekt initialisieren |
| `/api/search/code` | POST | Code-Suche |
| `/api/search/docs` | POST | Docs-Suche |
| `/api/projects/:name/plan` | GET/PUT | Plan abrufen/aktualisieren |
| `/api/projects/:name/plan/tasks` | POST | Task hinzufuegen |
| `/api/projects/:name/thoughts` | GET/POST | Gedanken abrufen/hinzufuegen |
| `/api/projects/:name/thoughts/search` | POST | Gedanken durchsuchen |

## Voraussetzungen

- Node.js 20+
- Qdrant (Docker oder Cloud)
- Ollama (empfohlen) oder OpenAI API Key

## Architektur

```
                    ┌─────────────────────────────────────────────┐
                    │              SYNAPSE CORE                    │
                    │                                              │
                    │  FileWatcher │ Embeddings │ Qdrant │ Services│
                    └─────────────────────────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   SYNAPSE MCP       │     │   SYNAPSE API       │     │      QDRANT DB      │
│   (User PC)         │     │   (Unraid)          │     │      (Unraid)       │
│                     │     │                     │     │                     │
│  Claude Code        │     │  Claude Web         │     │  Vektoren           │
│  Claude Desktop     │     │  ChatGPT            │     │  Metadaten          │
│  Codex CLI          │     │  Custom Apps        │     │                     │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

## Roadmap

### Tech-Docs Integration (geplant)

Automatische Framework-Dokumentation direkt in Synapse. Aktuell existiert ein separater [tech-docs-researcher](https://github.com/7blacky7/synapse) Skill, der Framework-Docs recherchiert und in Qdrant speichert — zukuenftig soll das nativ in Synapse integriert werden:

- **Automatische Erkennung** — Beim Indexieren eines Projekts erkennt Synapse verwendete Frameworks und Sprachen (React, Fastify, Tailwind, etc.)
- **Docs-Indexierung** — Offizielle Dokumentation wird automatisch in eine eigene Qdrant-Collection (`tech_docs`) geladen
- **Kontextuelle Vorschlaege** — Beim Bearbeiten von Code-Dateien liefert Synapse passende Doku-Snippets zum verwendeten Framework
- **Versioniert** — Docs werden pro Framework-Version gecacht, veraltete Versionen automatisch aktualisiert

### Framework-Docs Hook (verfuegbar)

Ein Claude Code Hook (`packages/mcp-server/hooks/`) der beim Bearbeiten von Code-Dateien automatisch Frameworks erkennt und verfuegbare Dokumentation aus Qdrant anzeigt:

- **Multi-Language** — JavaScript/TypeScript, Go, Python, Rust, Ruby, PHP, CSS, HTML
- **Import-Analyse** — Liest die ersten 50 Zeilen einer Datei und extrahiert Import-Statements
- **Zwei Doku-Quellen** — DocsBySkill (Workflow-Recherche) und DocsByTool (Context7)
- **Plattformuebergreifend** — Bash (Linux/macOS) und PowerShell (Windows) Varianten
- **Zero-Config** — Aktiviert sich automatisch als PostToolUse-Hook bei Edit/Write

### Automatischer Context-Handoff — PROTOTYP (`scripts/context-handoff/`)

Ein dreistufiges System das Claude Code Sessions automatisch neustartet wenn das Context-Window voll wird — ohne Kontextverlust dank Synapse.

> **PROTOTYP** — Experimentelles Feature. API und Verhalten koennen sich aendern.
> Handoff-Regeln werden beim ersten Agent-Onboarding automatisch als Synapse-Memory
> (category: `rules`) erstellt, sodass der Koordinator die Handoff-Anweisung erhaelt.

**1. Context-Counter** (`scripts/context-handoff/context-counter.sh`) — PostToolUse-Hook
- Liest den echten Context-Verbrauch aus der StatusLine
- Warnt bei **60%** (gelb): "Plane Handoff nach aktuellem Task"
- Warnt bei **80%** (rot): "SOFORTIGER HANDOFF!"
- Schwellwerte konfigurierbar via `CONTEXT_WARN_PERCENT` / `CONTEXT_CRIT_PERCENT`

**2. Context-Handoff** (`scripts/context-handoff/context-handoff.sh`) — Vom Agenten aufgerufen
- Speichert Fortschritt, offene Tasks und naechste Schritte in Synapse (Thought + Memory)
- Extrahiert CLI-Flags der laufenden Session (Permissions, Model, etc.)
- Setzt Handoff-Marker und beendet die aktuelle Claude-Session

**3. Session-Wrapper** (`scripts/context-handoff/claude-session.sh`) — Ersetzt den `claude` Befehl
- Startet Claude normal, ueberwacht den Exit
- Erkennt Handoff-Marker und startet automatisch eine neue Session
- Uebergibt CLI-Flags, Model und Synapse-Prompt an die Folge-Session
- Die neue Session laedt den gespeicherten Kontext aus Synapse und arbeitet nahtlos weiter

```
Session 1 (Context voll)          Session 2 (frischer Context)
  │                                  │
  ├─ Context 80% erreicht            ├─ Liest Synapse Thought
  ├─ add_thought (Fortschritt)       ├─ Liest Synapse Memory
  ├─ write_memory (Details)          ├─ Loescht alten Handoff-Thought
  ├─ context-handoff.sh              ├─ Registriert neuen Namen
  └─ Session beendet                 └─ Arbeitet weiter
         │                                  ▲
         └──── claude-session.sh ───────────┘
               (erkennt Marker, startet neu)
```

## Bekannte Probleme

| Problem | Status | Workaround |
|---------|--------|------------|
| **Statistiken zaehlen alle Projekte** — `get_index_stats` und `get_detailed_stats` zeigen Gesamtzahlen ueber alle Projekte, nicht nur das aktuelle. Ein Agent sieht z.B. 1115 Vektoren, obwohl er nur auf sein Projekt Zugriff hat. | Offen | Keine — Zahlen sind korrekt, aber irreführend |
| **Projekt-Init ueber Web-API fehlerhaft** — Ueber die REST-API (`/api/projects/init`) kann ein noch nicht initialisiertes Projekt manchmal nicht erstellt werden, obwohl es zuvor funktioniert hat. | Bug | Projekt ueber MCP (STDIO) oder CLI initialisieren |
| **MCP auf unterschiedlichen Systemen** — Wenn dasselbe Projekt auf verschiedenen Rechnern oder Festplatten liegt (z.B. Desktop A und Desktop B), gibt es zwei Probleme: Der FileWatcher laeuft nur lokal im MCP (nicht auf der REST-API), und die Projekt-Pfade unterscheiden sich zwischen den Systemen. | Geplant | KI auf System B kann ueber `semantic_code_search` alles nachbauen was auf System A gebaut wurde. Loest sich wenn die REST-API FileWatcher-Funktionalitaet bekommt und Pfade relativ aufgeloest werden. |

## Lizenz

MIT
