# 🧠 Synapse — lokales KI-Gedächtnis, Code-Intelligence & Agenten-Orchestrierung

> Synapse verwandelt lokale Softwareprojekte in eine strukturierte, durchsuchbare und automatisierbare Wissensbasis für KI-Agenten.
>
> Es verbindet Dateisystem-Indexierung, PostgreSQL, Qdrant, Code-Parser, MCP/REST-Tools, persistente Spezialisten, Shell-Queues und isolierte Docker-Workspaces zu einem lokalen System für KI-gestützte Entwicklung. Spezialisten können je nach Provider über lokale CLI-Runtimes oder über API-Keys laufen; bei Gemini ist beides möglich: Gemini CLI oder Google/Gemini API-Key.

---

## Kurzfassung

Synapse ist kein einzelnes Suchtool. Es ist ein lokales Betriebssystem für KI-Arbeit an Codebasen:

```text
Projektdateien
   ↓
FileWatcher + Parser
   ↓
PostgreSQL: Dateien, Symbole, Referenzen, Chunks, Wissen, Jobs
   ↓
Qdrant: semantische Vektorsuche
   ↓
MCP / REST Tools
   ↓
KI-Agenten, Spezialisten, Shell-Jobs, Workspaces
```

Die Kernidee: Eine KI soll nicht bei jeder Session wieder bei null anfangen. Code, Erkenntnisse, Regeln, Tasks, Fehler-Patterns und Agentenstatus bleiben persistent und werden über Tools abrufbar.

---

## Was Synapse konkret macht

Synapse löst mehrere Probleme gleichzeitig:

| Problem | Synapse-Antwort |
|---|---|
| KI verliert Kontext nach Session-Ende | Memories, Thoughts, Plans, Proposals und Skills bleiben in PostgreSQL/Qdrant erhalten. |
| Code-Suche über `grep` ist flach | `code_intel` kennt Funktionen, Variablen, Symbole, Referenzen, Statements, Calls und Entrypoints. |
| Semantische Suche findet Konzepte, aber keine Struktur | Qdrant ergänzt PostgreSQL; Struktur bleibt in PostgreSQL. |
| Web-KIs haben keinen lokalen Dateisystemzugriff | REST-API + PG-Queues delegieren Arbeit an den lokalen FileWatcher-Daemon oder Workspaces. |
| Agenten arbeiten unkoordiniert | Chat, Inbox, Channels, Events und Specialist-Jobs bilden einen lokalen Agentenbus. |
| Shell-Ausführung von Web-KIs ist riskant | Shell-Jobs laufen über Queue, Daemon/Workspace-Routing, Logs und Audit-Trail. |
| Mehrere Edits sind schwer atomar zu reviewen | `files`/`files_batch` bieten Plan/Commit, Hash-Checks, Anchors, Versionierung und Rollback. |
| Integrationstests brauchen mehrere Dienste | Workspaces stellen benannte Docker-Instanzen mit DNS, Rollen und eigenem HOME bereit. |

---

## Architekturüberblick

```text
                            ┌──────────────────────────────┐
                            │          KI / User            │
                            │ Claude Code / Desktop / Web   │
                            │ ChatGPT / Claude.ai / Gemini  │
                            └───────────────┬──────────────┘
                                            │
                ┌───────────────────────────┴───────────────────────────┐
                │                                                       │
        ┌───────▼────────┐                                      ┌───────▼────────┐
        │ MCP Server     │                                      │ REST API       │
        │ stdio lokal    │                                      │ HTTP + SSE     │
        └───────┬────────┘                                      └───────┬────────┘
                │                                                       │
                └───────────────────────┬───────────────────────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │    Synapse Core    │
                              │  packages/core     │
                              └─────────┬─────────┘
                                        │
      ┌─────────────────────┬───────────┼───────────┬─────────────────────┐
      │                     │           │           │                     │
┌─────▼─────┐        ┌──────▼──────┐ ┌──▼──────┐ ┌──▼────────┐    ┌──────▼──────┐
│PostgreSQL │        │   Qdrant    │ │ Parser  │ │ FileWatch │    │ Agenten     │
│Source of  │        │ Vektorindex │ │ 60+     │ │ Daemon    │    │ Wrapper     │
│Truth      │        │             │ │ Sprachen│ │ + Queue   │    │ Spezialisten│
└─────┬─────┘        └──────┬──────┘ └─────────┘ └─────┬─────┘    └──────┬──────┘
      │                     │                          │                 │
      │                     │                          │                 │
      │             ┌───────▼────────┐                 │        ┌────────▼────────┐
      │             │ Semantische    │                 │        │ Claude/Gemini    │
      │             │ Suche          │                 │        │ Subprozesse      │
      │             └────────────────┘                 │        └─────────────────┘
      │                                                │
      │                                          ┌─────▼─────┐
      │                                          │Filesystem │
      │                                          │Projekte   │
      │                                          └───────────┘
      │
      └──────────────────────────────────────────────────────────────┐
                                                                     │
                                                          ┌──────────▼──────────┐
                                                          │ Docker Workspaces   │
                                                          │ main/app/db/qa/...  │
                                                          └─────────────────────┘
```

---

## Die wichtigste Pipeline: Code-Indexierung

Die zentrale Indexing-Pipeline sitzt in `packages/core/src/services/code.ts`.

Die Analyse der Funktionen zeigt diesen Ablauf:

```text
indexFile()
   ↓
storeFileContent()
   ↓
enqueueParseAndEmbed()
   ↓
parseAndEmbed()
   ↓
PostgreSQL + Qdrant
```

### Stage 1: schnelle Speicherung

`storeFileContent(filePath, projectName, projectRoot)` liest Dateiinhalt und Metadaten und schreibt sie nach PostgreSQL.

```text
Datei vom FileWatcher
   ↓
readFileWithMetadata()
   ↓
content_hash berechnen
   ↓
upsertCodeFile()
   ↓
code_files
```

PostgreSQL enthält dadurch nicht nur Pfade, sondern auch Inhalt, Hash, Typ und später Indexierungszeitpunkte.

### Stage 2: asynchrones Parsing und Embedding

`enqueueParseAndEmbed(project, filePath)` entkoppelt die teure Arbeit vom FileWatcher. `parseAndEmbed(project, filePath)` ist der zentrale Hotspot.

Der Flow von `parseAndEmbed` sieht, vereinfacht, so aus:

```text
parseAndEmbed(project, filePath)
   ↓
getPool()
   ↓
Idempotenz-Check:
  indexed_at + embedded_at + unembedded count
   ↓
Dateiinhalt aus code_files lesen
   ↓
Parser über getParserForFile(filePath) wählen
   ↓
bei unbekanntem Filetype: parsed_at/indexed_at setzen und beenden
   ↓
Parser ausführen
   ├─ Symbole
   ├─ Referenzen
   ├─ Statements
   └─ CallEdges
   ↓
chunkFile(content, filePath, project)
   ↓
code_chunks in PostgreSQL ersetzen
   ↓
wenn Embeddings aktiv:
   ├─ ensureProjectCollection(project)
   ├─ deleteByFilePath(collection, filePath, project)
   ├─ embedBatch(chunks)
   └─ insertVectors(...)
   ↓
code_files.indexed_at / parsed_at / chunk_count aktualisieren
```

Wichtig: Synapse trennt bewusst Struktur und Semantik:

```text
PostgreSQL
  code_files
  code_symbols
  code_references
  code_statements
  code_call_edges
  code_chunks

Qdrant
  project_<name>_code
  project_<name>_memories
  project_<name>_thoughts
  project_<name>_proposals
  project_<name>_docs
  project_<name>_media
```

PostgreSQL ist die Wahrheit. Qdrant ist der semantische Suchindex.

---

## Code-Intelligence statt Grep

Synapse indexiert nicht nur Text. Es erzeugt aus Code eine strukturierte Analyseebene.

`packages/core/src/services/code-intel.ts` stellt u. a. bereit:

```text
getProjectTree()
getFunctions()
getVariables()
getSymbols()
getReferences()
fullTextSearchCode()
getFileContent()
getStatements()
getCallEdges()
getExecutionFlow()
getEntrypoints()
```

Das bedeutet: Eine KI muss nicht raten, welche Datei relevant ist. Sie kann fragen:

```text
Welche Funktionen gibt es in dieser Datei?
Wer ruft diese Funktion?
Wo ist dieses Symbol definiert?
Welche Statements laufen in dieser Funktion?
Welche Top-Level-Entrypoints gibt es?
```

### Empfohlener Analyse-Workflow

```text
1. code_intel.tree(path, depth: 1-2)
   ↓
2. code_intel.search_batch([...], limit_per_query: 3-5)
   ↓
3. code_intel.functions(file_path)
   ↓
4. code_intel.flow(file_path, scope)
   ↓
5. code_intel.file(file_path, from_line, to_line)
```

Erst Struktur, dann Flow, erst ganz zuletzt Rohtext.

---

## Parser-System

`packages/core/src/parser/` enthält viele spezialisierte Parser. In der analysierten Projektstruktur sind dort 72 Dateien mit über 300 Funktionen indexiert.

Synapse unterstützt u. a. Parser für:

```text
TypeScript / JavaScript
Python
Go
Rust
Java
C / C++
C#
PHP
Ruby
Kotlin
Swift
Dart
SQL
Shell
Dockerfile
YAML
TOML
GraphQL
Elixir
Haskell
Zig
Solidity
Fortran
Ada
PowerShell
Objective-C
Nix
Svelte
Vue
WGSL / GLSL
COBOL
CMake
Racket
Lean
Dhall
Jsonnet
Moo
...
```

Die Parser liefern keine vollständige Compiler-AST für jede Sprache, sondern eine praktische Analyseform für KI-Arbeit:

```text
ParsedSymbol[]
ParsedReference[]
ParsedStatement[]
ParsedCallEdge[]
```

So kann Synapse auch für viele Sprachen zumindest Funktionen, Klassen, Imports, SQL, Routen, Strings, Statements und Call-Kanten extrahieren.

---

## MCP Server: lokale Tool-Schnittstelle

`@synapse/mcp-server` ist der lokale MCP-Server für Claude Code, Claude Desktop, Cline/Codex-ähnliche Clients und andere stdio-MCP-Clients.

Der Server nutzt das MCP SDK und registriert konsolidierte Tools wie:

```text
project
search
memory
thought
proposal
plan
chat
channel
event
specialist
docs
admin
code_intel
code_check
files
shell
guide
```

Der Startbereich von `packages/mcp-server/src/server.ts` zeigt, dass der Server Core-Services, Agenten-Services und Tool-Module zusammenführt.

### Response-Enrichment

Synapse ergänzt Tool-Antworten mit Kontext für Agenten:

```text
Tool Call
   ↓
withOnboarding / Response Enhancement
   ↓
optional:
  agentOnboarding
  pendingEvents
  unreadChat
  activeAgents
```

Damit sieht ein Agent beim normalen Arbeiten automatisch:

- ob Projektregeln geladen werden müssen
- ob Events zu bestätigen sind
- ob ungelesene Chatnachrichten warten
- welche anderen Agenten aktiv sind

---

## REST API und MCP-over-HTTP

`@synapse/rest-api` stellt dieselben Fähigkeiten für Web-KIs bereit.

Wichtige Eigenschaften:

```text
Fastify Server
   ↓
REST-Routen für Tools
   ↓
MCP-over-HTTP
   ↓
SSE + JSON-RPC
   ↓
OAuth Discovery für Claude.ai Connector
```

`packages/rest-api/src/routes/mcp.ts` enthält die MCP-over-HTTP-Schicht. Dort werden u. a. verarbeitet:

```text
initialize
tools/list
tools/call
```

Außerdem gibt es Endpunkte für:

```text
/mcp/sse
/mcp/messages?sessionId=...
/.well-known/oauth-authorization-server
/oauth/*
```

Die REST-API initialisiert zusätzlich einen Parser-Worker-Pool. Das verhindert Event-Loop-Stalls bei großen Dateien und kann serverseitig `parseUnparsedFiles` nachziehen, wenn kein lokaler FileWatcher läuft.

---

## FileWatcher-Daemon und PG-Queues

Der FileWatcher-Daemon ist die lokale Brücke zwischen Server/Web-KI und dem echten Projekt auf dem Rechner.

Es gibt zwei Generationen/Varianten im Repo:

```text
packages/file-watcher-daemon/      # Moo-basierter Daemon/Tray
packages/file-watcher-daemon-ts/   # TypeScript-Daemon mit HTTP API und Workers
```

Der Daemon übernimmt:

```text
Projekt aktivieren/deaktivieren
Dateisystem beobachten
Dateiänderungen an Core weitergeben
Shell-Jobs aus PostgreSQL claimen
eSpecialist-Jobs aus PostgreSQL claimen
Project-Init-Jobs claimen
Status per HTTP/SSE bereitstellen
```

### Queue-Architektur

PostgreSQL ist hier nicht nur DB, sondern auch Job-Bus:

```text
REST oder MCP schreibt Job nach PostgreSQL
   ↓
Trigger feuert NOTIFY
   ↓
Daemon LISTENt auf Channel
   ↓
Daemon claimt Job
   ↓
Daemon führt lokal aus
   ↓
Result/Logs zurück nach PostgreSQL
```

Wichtige Queues:

```text
shell_jobs
specialist_jobs
project_init_jobs
```

Aus dem Schema sind NOTIFY-Trigger für u. a. diese Jobs vorhanden:

```text
notify_shell_job_created()
notify_specialist_job_created()
notify_project_init_job_created()
```

---

## Shell: lokal oder Workspace

Das `shell`-Tool ist nicht einfach ein Bash-Wrapper. Es routet nach Umgebung:

```text
shell(exec)
   ↓
läuft lokaler Daemon mit frischem Heartbeat?
   ├─ ja: PG-Queue → lokaler Daemon → echtes Projekt-FS
   └─ nein: Docker Workspace → isolierte Ausführung
```

Antworten enthalten `executed_via`, damit Agenten sehen, ob der Befehl lokal oder im Workspace lief.

Logs und Historie bleiben in PostgreSQL erhalten:

```text
shell.history
shell.get
shell.log
shell.activity
```

`log` unterstützt Range-Reads und Regex-Suche in Job-Ausgaben.

---

## Files-Layer: versionierte Code-Änderungen

Das `files`-Tool schreibt nicht blind in Dateien. Es arbeitet über PostgreSQL und erzeugt Versionen.

Typische Operationen:

```text
read
create
update
search_replace
search_replace_batch
replace_lines
insert_after
delete_lines
move
copy
delete
versions
get_version
restore
restore_batch
history
```

### Dateiversionierung, History und Rollback

Jede Dateiänderung über den `files`-Layer erzeugt automatisch einen Snapshot in der Versionshistorie. Dadurch kann Synapse nicht nur Dateien schreiben, sondern Änderungen nachvollziehen, vergleichen und zurückrollen.

Wichtige Aktionen:

```text
files(versions)
  listet alle Versionen einer Datei

files(get_version)
  lädt den kompletten Inhalt einer alten Version

files(history)
  zeigt projektweit, wer wann was warum geändert hat

files(restore)
  stellt eine einzelne alte Dateiversion wieder her

files(restore_batch)
  rollt eine komplette Multi-File-Batch zurück
```

Das macht den Files-Layer zu einem Audit- und Recovery-System:

```text
Änderung durch Agent
   ↓
file_versions Snapshot
   ↓
reason / agent_id / edit_action / batch_id / feature_tag
   ↓
history zeigt den Änderungspfad
   ↓
get_version lädt alte Inhalte
   ↓
restore oder restore_batch geht zurück
```

Bei Multi-File-Commits bekommen alle betroffenen Dateien dieselbe `batch_id`. Damit kann eine ganze Änderungseinheit später gemeinsam wiederhergestellt werden, statt Datei für Datei manuell zurückzugehen.

Für Review-Workflows gibt es zwei Ebenen:

```text
Plan-Phase
  previews zeigen, was geändert würde
  expected_hashes schützen gegen Drift

History/Versionen
  versions + get_version zeigen alte Stände
  history zeigt Kontext, Agent, Grund und Batch
```

So kann ein Koordinator nach einem fehlerhaften Agentenlauf nicht nur fragen „was ist passiert?“, sondern gezielt jeden betroffenen Stand inspizieren und den passenden Snapshot zurückholen.

### Atomare Multi-File-Edits

`packages/core/src/services/file-batch.ts` implementiert Plan/Commit für mehrere Dateien.

Relevante Funktionen:

```text
prepareOpsForApply()
verifyAnchor()
applyOpInMemory()
planBatch()
commitBatch()
cancelBatch()
getBatchPlan()
```

Ablauf:

```text
files_batch(plan, ops[])
   ↓
Dateien lesen
   ↓
Ops im Speicher anwenden
   ↓
expected_hashes + previews speichern
   ↓
plan_id zurückgeben

files_batch(commit, plan_id)
   ↓
Hash gegen aktuellen Stand prüfen
   ↓
wenn stale: Konflikte zurückgeben
   ↓
wenn sauber: alle Änderungen in PG-TX anwenden
   ↓
file_versions mit gemeinsamer batch_id schreiben
```

Zusätzliche Sicherheitsmechanismen:

```text
anchor_text / anchor_contains
  schützt vor Drift an Zielzeilen

expected_hashes
  schützen vor Änderungen zwischen Plan und Commit

restore_batch
  rollt ganze Multi-File-Batches zurück

agent_note / reason / feature_tag
  machen Änderungen auditierbar
```

---

## Persistentes Wissen

Synapse unterscheidet mehrere Wissensformen:

| System | Zweck |
|---|---|
| `memory` | dauerhaftes Projektwissen: Architektur, Regeln, Entscheidungen, Gotchas |
| `thought` | kurzfristige Erkenntnisse, Zwischenstände, Handoffs |
| `plan` | Projektplan und Tasks |
| `proposal` | Code- oder Architekturvorschläge |
| `docs` | kuratierte Tech-Doku und Wissens-Airbag |
| `code_check` | bekannte Fehler-Patterns mit Fix-Hinweisen |

Diese Systeme sind nicht Markdown-Dateien, sondern Tools mit Speicherung, Suche, Tags, Versionierung und teilweise Embeddings.

---

## Agenten, Channels, Events und Spezialisten

Synapse hat ein lokales Agentenmodell.

```text
Koordinator
   ↓
spawn / wake / stop / purge
   ↓
Spezialist-Wrapper
   ↓
Claude/Gemini/Subprozess
```

### Chat, Inbox, Channels

```text
chat
  Broadcasts und DMs zwischen Agenten

inbox
  1:1 Nachrichten an Spezialisten

channel
  Gruppenräume für Spezialisten-Teams
```

### Event-System

Events sind verbindliche Steuersignale, keine normalen Chatnachrichten.

```text
event.emit()
   ↓
agent_events
   ↓
Agent sieht pendingEvents in Tool-Antworten
   ↓
event.ack()
   ↓
agent_event_acks
```

Typische Event-Arten:

```text
WORK_STOP
CRITICAL_REVIEW
ARCH_DECISION
TEAM_DISCUSSION
ANNOUNCEMENT
NEW_TASK
CHECK_CHANNEL
```

---

## Spezialisten-Wrapper

Der Spezialisten-Wrapper liegt in `packages/agents/src/wrapper.ts` und ist einer der großen Hotspots des Projekts.

Er startet als eigener Node-Prozess und steuert einen KI-CLI-Subprozess.

```text
MCP / REST / Daemon
   ↓
Unix Domain Socket / JSON-RPC
   ↓
Agent Wrapper
   ↓
ProcessManager
   ↓
Provider-Runtime
   ├─ Claude CLI Subprozess
   ├─ Gemini CLI Runtime
   └─ Gemini API Runtime (`@google/genai`, GOOGLE_API_KEY)
```

Wichtige Funktionen im Wrapper:

```text
setupPgListeners()
startSocketServer()
handleRpcRequest()
handleWake()
handleStop()
handleStatus()
wakeAgent()
heartbeatPoll()
recoverStuckAgent()
pollChannelMessages()
pollInboxMessages()
pollSynapseItems()
updateStatusPg()
rotateAgent()
cleanup()
main()
```

Der Wrapper pollt und verarbeitet:

```text
Channel-Nachrichten
Inbox-Nachrichten
Memories
Thoughts
Plan-Tasks
Pending Events
Token-/Context-Status
Statusupdates nach PostgreSQL
```

Dadurch kann ein Spezialist über längere Zeit als persistente lokale Helferinstanz existieren.

---

## Skills für Spezialisten

Spezialisten haben ein eigenes Skill-Verzeichnis.

Typische Dateien:

```text
rules.md
errors.md
patterns.md
context.md
meta.yaml
logs/YYYY-MM-DD.md
```

Damit können Regeln, bekannte Fehler, Muster und Kontext über Wrapper-Neustarts hinweg erhalten bleiben.

---

## Workspaces: isolierte Docker-Testumgebungen

Synapse enthält einen Workspace-Orchestrator für Docker-Sandboxen.

Grundidee:

```text
Projekt
   ├─ main
   ├─ app
   ├─ qa
   ├─ db-1
   └─ db-2
```

Jeder Workspace ist ein Container mit eigenem HOME-Volume. Alle teilen `/workspace` als Source-Sicht, aber Builds und Zustände können getrennt laufen.

DNS-Schema:

```text
main:     http://synapse-ws-<projekt>:<port>
benannt:  http://synapse-ws-<projekt>-<name>:<port>
```

Beispiel für einen Integrationstest:

```text
workspace: db-1    Rolle db-postgres, Port 5432
workspace: app     Backend, Port 3000
workspace: qa      Testclient, curl/wine/etc.
```

Ablauf:

```text
workspace db-1 startet PostgreSQL
   ↓
workspace app startet Backend
   ↓
workspace qa testet http://synapse-ws-<projekt>-app:3000/health
```

Workspaces sind lazy gestartet, werden nach Idle-Zeit gestoppt und können per `pin` geschützt werden.

---

## Datenmodell: wichtigste PostgreSQL-Tabellen

### Grundregel: PostgreSQL ist die Wahrheit, Qdrant ist ein abgeleiteter Index

**Alles landet zuerst in PostgreSQL, bevor es ueberhaupt nach Qdrant geht.** Das gilt fuer
jeden Datentyp — Memories, Thoughts, Proposals, Code-Chunks und alles, was noch dazukommt.
Daraus folgt in beide Richtungen:

**Schreiben — erst PG, dann der Index.** Ein Schreibvorgang gilt als erfolgreich, sobald die
Zeile in PostgreSQL steht. Das Embedding wird *nachgereicht* und darf das Schreiben nicht
aufhalten; ein fehlgeschlagenes Embedding ist deshalb kein Datenverlust, sondern ein Nachtrag.
Erkennbar bleibt er an einer Spalte, die genau das festhaelt (`embedded_at IS NULL`), und ein
Backlog-Worker holt ihn nach. Vorbild ist `writeMemory` in
`packages/core/src/services/memory.ts`: PostgreSQL fail-fast, danach `embeddeMemoryNach` ohne
`await`.

**Lesen — was *existiert*, beantwortet PG. Was *aehnlich* ist, beantwortet Qdrant.** Eine
Existenz-, Vollstaendigkeits- oder Regelfrage darf nie gegen den Index gestellt werden: der
kann hinterherhinken, Eintraege verloren haben oder geloeschte noch fuehren — und er sagt es
nicht. Semantische Aehnlichkeit ist das Einzige, wofuer Qdrant zustaendig ist.

> **Bekannte Verstoesse auf der Leseseite** (Stand 15.08.2026, offen): `listMemories`,
> `getRulesForNewAgent`, `getMemoryByName` und `getMemoriesByNames` in
> `packages/core/src/services/memory.ts` lesen aus Qdrant statt aus PostgreSQL — die
> Projekt-Regeln werden also aus dem Index ausgeliefert. Belegte Folgen: eine Regel kann in
> PG stehen und niemanden erreichen, eine geloeschte kann weiter zugestellt werden, und ein
> Eintrag, den nur PG kennt, meldet über die Werkzeuge "nicht gefunden".

Wichtige Tabellen/Subsysteme:

```text
code_files
code_chunks
code_symbols
code_references
code_statements
code_call_edges
memories
thoughts
plans
proposals
tech_docs
agent_sessions
chat_messages
agent_events
agent_event_acks
specialist_channels
specialist_channel_messages
specialist_inbox
shell_jobs
specialist_jobs
project_init_jobs
wrapper_status
project_workspaces
workspace_roles
file_versions
file_batch_plans
error_patterns
watcher_events
```

Qdrant hält dazu die semantischen Collections, z. B.:

```text
project_<name>_code
project_<name>_memories
project_<name>_thoughts
project_<name>_proposals
project_<name>_docs
project_<name>_media
```

---

## Projektstruktur

Aus der analysierten Codebase:

```text
synapse/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── services/        # Code, Files, Memory, Plans, Events, Queues, Workspaces
│   │       ├── parser/          # 60+ Sprachparser
│   │       ├── db/              # PostgreSQL Schema + Client
│   │       ├── embeddings/      # Google/OpenAI/Ollama/Cohere Provider
│   │       ├── qdrant/          # Collections + Vektoroperationen
│   │       ├── watcher/         # Ignore/Binary/FileWatcher-Utilities
│   │       └── guide/           # Tool-Dokumentation
│   ├── mcp-server/
│   │   ├── src/server.ts
│   │   ├── src/tools/
│   │   └── hooks/
│   ├── rest-api/
│   │   ├── src/server.ts
│   │   ├── src/routes/mcp.ts
│   │   └── src/services/workspace-orchestrator.ts
│   ├── agents/
│   │   ├── src/wrapper.ts
│   │   ├── src/heartbeat.ts
│   │   ├── src/process.ts
│   │   └── src/skills.ts
│   ├── agents-gemini/
│   ├── agents-antigravity/
│   ├── file-watcher-daemon/
│   ├── file-watcher-daemon-ts/
│   └── web-ui/
├── docker/
│   ├── synapse-workspace/
│   └── synapse-workspace-podman/
├── scripts/
└── skills/
```

---

## Setup

### Voraussetzungen

```text
Node.js >= 20
pnpm
PostgreSQL
Qdrant
Google AI API Key für Embeddings
optional: Context7 API Key
optional: Claude/Gemini CLI für Spezialisten
optional: Docker für Workspaces
```

### Installation

```bash
pnpm install
pnpm run build
```

Wichtige Root-Skripte:

```bash
pnpm run build        # alle Packages bauen
pnpm run build:core   # Core
pnpm run build:mcp    # MCP Server
pnpm run build:api    # REST API
pnpm run build:agents # Agenten
pnpm run dev:mcp      # MCP Server watch/dev
pnpm run dev:api      # REST API dev
pnpm run lint
pnpm run clean
```

### Datenbank-Schema aufbauen

Das vollstaendige Schema liegt als SQL in **`packages/core/src/db/schema-sql/`** —
nur Struktur, keine Daten. Die Zahlen im Dateinamen sind die Aufbaureihenfolge
(Extensions und Typen zuerst, Fremdschluessel zuletzt), alphabetisch sortiert also
einfach der Reihe nach einspielen.

**Der einfachste Weg — Datenbank mitstarten lassen:**

```bash
cp .env.example .env        # POSTGRES_PASSWORD setzen, passend zu DATABASE_URL
docker compose --profile bundled up -d
```

Das Profil `bundled` startet zusaetzlich Postgres und Qdrant. Postgres legt Rolle
und Datenbank beim ersten Start selbst an (aus `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`) und spielt anschliessend die Dateien aus `schema-sql/` ein — die
liegen dazu als Init-Verzeichnis eingehaengt. Es ist also nichts von Hand anzulegen.

Zwei Dinge, an denen es sonst still schiefgeht:

- Die `POSTGRES_*`-Werte muessen zu `DATABASE_URL` passen. Weichen sie ab, startet
  die Datenbank mit anderen Zugangsdaten, als die API benutzt — und das faellt erst
  beim ersten Zugriff auf, nicht beim Start.
- Das Init-Verzeichnis wird **nur einmal** ausgefuehrt: beim Anlegen des leeren
  Datenverzeichnisses. Spaetere Aenderungen an `schema-sql/` erreichen eine bereits
  bestehende Datenbank nicht mehr, die muss man von Hand nachziehen.

**Ohne Profil** (`docker compose up -d`) startet nur `synapse-api` und erwartet
Datenbank und Qdrant ausserhalb — das ist der Betrieb bestehender Installationen,
an dem sich nichts aendert.

**Von Hand**, wenn Postgres schon laeuft:

```bash
createdb synapse
for f in packages/core/src/db/schema-sql/*.sql; do psql -v ON_ERROR_STOP=1 -d synapse -f "$f"; done
```

Details, Fallstricke und was der Export bewusst nicht enthaelt (keine Stammdaten,
keine Rollen/Rechte, keine Qdrant-Collections): `packages/core/src/db/schema-sql/README.md`.
Im laufenden Betrieb legt `ensureSchema()` in `packages/core/src/db/schema.ts` das
Schema selbst an; die SQL-Dateien sind dessen Spiegelung fuer den Kaltstart.

Zwei Dinge, die man dazu wissen muss, bevor man sich darauf verlaesst:

- Der Export wurde aus der laufenden Datenbank per `pg_dump` erzeugt und danach um
  Fremdobjekte gekuerzt, die nicht zu Synapse gehoeren. **Beide Staende sind gegen
  eine leere Datenbank aufgebaut worden:** der Vollabzug am 02.08.2026 mit einem
  Nulldiff gegen die Produktion (`pg_dump` gegen `pg_dump`, 2221 zu 2221 Zeilen),
  der gekuerzte Stand am selben Tag ueber das `bundled`-Profil in einem Wegwerf-
  Container — fehlerfrei durchgelaufen, danach 49 Tabellen, 495 Spalten, 145 Indizes
  (91 eigene plus 49 Primaerschluessel und 5 UNIQUE), 19 Fremdschluessel, 11 Trigger,
  4 Aufzaehlungstypen. Die Fremdobjekte sind nachweislich draussen: `agent_profiles`,
  `agents`, `cli_agents`, `swarm_events`, Schema `drizzle` und Extension `citext`
  ergeben in der frisch aufgebauten Datenbank jeweils 0 Treffer.
  Die Ordner-README sagt im Einzelnen, was womit geprueft wurde.
- Wie die Datenbank `synapse` und die gleichnamige Rolle ueberhaupt entstehen, sagt
  das Repo an keiner Stelle. Das muss man vorher selbst einrichten; die SQL-Dateien
  setzen eine leere, bereits existierende Datenbank voraus.


### Google API Key: Embeddings und Gemini-Spezialisten

Synapse kann denselben `GOOGLE_API_KEY` an zwei Stellen nutzen:

```text
1. Embeddings
   → Google Embedding Provider für semantische Suche

2. Gemini-Spezialisten
   → optional API-basierte Specialist-Runtime über @google/genai
```

Bei Gemini gibt es zwei Betriebsarten:

```text
Gemini CLI
  → nutzt lokale CLI/Auth auf dem Zielsystem

Google/Gemini API-Key
  → nutzt @google/genai + GOOGLE_API_KEY
```

Das ist eine bewusste Entscheidung pro Setup: Wer seine Gemini CLI verwenden will, kann das tun. Wer lieber über den API-Key geht, kann die API-basierte Runtime verwenden. `packages/agents-gemini/src/runtime.ts` enthält dafür eine eigene Google/Gemini-Runtime. Sie kann standalone laufen oder im `SYNAPSE_WRAPPER_MODE=1` vom Synapse-Wrapper gespawnt werden.

```text
GOOGLE_API_KEY=...
   ↓
Synapse Embeddings
   ↓
Qdrant Vektoren

GOOGLE_API_KEY=...
   ↓
Gemini Specialist Runtime
   ↓
Spezialist läuft über Google API statt lokale Claude CLI
```

Standardmäßig nutzt die Gemini-Runtime den Embedding-Key mit:

```text
SYNAPSE_GEMINI_USE_EMBEDDING_KEY=true
```

Wenn das auf `false` gesetzt wird, kann die Runtime perspektivisch Credentials aus `provider_credentials` laden und fällt sonst wieder auf ENV zurück.

### Embedding-Provider und Vektor-Dimensionen

Synapse nutzt Embeddings für semantische Suche in Qdrant. Der empfohlene Standard ist Google, wenn ein `GOOGLE_API_KEY` vorhanden ist. Ollama ist primär der lokale Fallback, wenn kein Google-Key genutzt werden soll oder darf.

Wichtig: Qdrant-Collections haben eine feste Vektorgröße. Man kann den Embedding-Provider oder das Modell daher nicht beliebig wechseln, wenn das neue Modell eine andere Dimension erzeugt.

```text
Google Embedding Modell
   → z. B. 3072 Dimensionen
   → Qdrant Collection wird mit 3072 angelegt

Ollama Modell
   → je nach Modell andere Dimension
   → passt NICHT automatisch in dieselbe Collection
```

Wenn du den Provider wechselst, gibt es nur sichere Wege:

```text
1. Modell wählen, das dieselbe Vektor-Dimension erzeugt
   → bestehende Collection bleibt kompatibel

2. Collection neu aufbauen / migrieren
   → alte Vektoren löschen oder re-embedden

3. Projekt bewusst neu indexieren
   → alle Chunks mit neuem Modell neu schreiben
```

Unsicher ist:

```text
Provider wechseln
   ↓
neue Embeddings mit anderer Dimension
   ↓
in alte Qdrant-Collection schreiben
   ↓
Dimension-Mismatch / kaputte oder unbrauchbare Suche
```

Kurz gesagt:

```text
GOOGLE_API_KEY vorhanden → Google verwenden
kein Google-Key       → Ollama möglich
Provider-Wechsel     → Dimension prüfen oder re-indexieren
```

### MCP-Konfiguration

Beispiel aus `.mcp.json.example`:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/pfad/zu/synapse/packages/mcp-server/dist/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_PROVIDER": "google",
        "GOOGLE_API_KEY": "dein-google-api-key",
        "DATABASE_URL": "postgresql://synapse:passwort@localhost:5432/synapse",
        "OLLAMA_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "nomic-embed-text",
        "CONTEXT7_API_KEY": "dein-context7-key"
      }
    }
  }
}
```

---

## Wichtige Umgebungsvariablen

```text
DATABASE_URL
QDRANT_URL
QDRANT_API_KEY
EMBEDDING_PROVIDER
GOOGLE_API_KEY
OPENAI_API_KEY
OLLAMA_URL
OLLAMA_MODEL
CONTEXT7_API_KEY
API_PORT
API_HOST
MAX_FILE_SIZE_MB
CHUNK_SIZE
CHUNK_OVERLAP
DEBOUNCE_MS
PARSER_WORKER_THREADS
PARSER_LOOP_DISABLED
PARSER_LOOP_INTERVAL_MS
SYNAPSE_SKIP_EMBEDDINGS
SYNAPSE_KEEP_ALIVE
SYNAPSE_POLL_INTERVAL
SYNAPSE_WS_PER_PROJECT_CAP
SYNAPSE_WS_PRIVILEGED_ROLES
```

---

## Praktische Arbeitsweise für KI-Agenten

Synapse ist am stärksten, wenn Agenten nicht direkt Dateien dumpen, sondern strukturierte Tools nutzen.

### Code verstehen

```text
code_intel.tree(path, depth)
code_intel.search_batch([...])
code_intel.functions(file_path)
code_intel.flow(file_path, scope)
code_intel.file(file_path, from_line, to_line)
```

### Impact-Analyse

```text
code_intel.references(name)
code_intel.calls(callee)
code_intel.functions(name)
```

### Änderung vorbereiten

```text
memory.find_for_file(file_path)
docs.get_for_file(file_path)
files_batch(plan, ops[], anchor_contains)
files_batch(commit, plan_id)
```

### Wissen sichern

```text
thought.add(...)
memory.write(...)
plan.update_task(...)
channel.post(...)
```

---

## Design-Prinzipien

```text
PostgreSQL first
Qdrant second
code_intel before grep
flow before file dump
tools before shell
files before direct write
plans before multi-file commit
anchors before risky edits
DNS names before container IPs
```

Synapse ist absichtlich lokal-first. Es soll dem User gehören: eigene Projekte, eigene Datenbank, eigene Agenten, eigene Workspaces.

---

## Lizenz

MIT
