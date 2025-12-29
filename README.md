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

## Lizenz

MIT
