# Synapse Agent-Spawning System

**Datum:** 2026-03-25
**Status:** Genehmigt
**Branch:** feature/agent-spawning

## Zusammenfassung

Synapse bekommt die Faehigkeit, eigenstaendige Claude CLI Spezialisten zu spawnen. Diese Spezialisten haben volle Claude Code Power, lernen ueber selbstverwaltete Skill-Dateien, kommunizieren ueber Channels und Inbox, und ueberleben Koordinator-Neustarts dank Agent-Wrappern mit Unix Sockets.

## Motivation

- Der bestehende Synapse-Chat (PostgreSQL-Mailbox + Polling-Scripts) ist unzuverlaessig und funktioniert in anderen Projekten nicht
- Agent-Hub beweist, dass Claude CLI Subprozesse als vollwertige Agenten funktionieren
- Synapse soll diese Technik unabhaengig besitzen, Agent-Hub bleibt separat

## Voraussetzungen

- **Claude CLI** muss auf dem System installiert sein (`which claude`)
- Ohne Claude CLI: Agent-Spawning deaktiviert, alle anderen Synapse-Features funktionieren normal
- Erkennung via `detect.ts` beim MCP-Server Start

## Architektur

### Neues Package: `packages/agents/`

```
packages/agents/
├── src/
│   ├── detect.ts           # Claude CLI Erkennung (which claude, --version)
│   ├── process.ts          # ProcessManager — Subprocess-Lifecycle
│   ├── wrapper.ts          # Agent-Wrapper (detached, Unix Socket, Mini-Heartbeat)
│   ├── heartbeat.ts        # HeartbeatController — Polling, Token-Tracking, Auto-Rotation
│   ├── channels.ts         # Channel-System (Gruppenchat, PostgreSQL)
│   ├── inbox.ts            # Inbox-System (1:1 async, PostgreSQL)
│   ├── skills.ts           # SkillManager — SKILL.md / MEMORY.md Lesen/Schreiben
│   ├── status.ts           # JSON-Statusdatei (.synapse/agents/status.json)
│   ├── prompts.ts          # System-Prompt Builder (Rolle + Synapse-Regeln + MCP)
│   ├── schema.sql          # Neue DB-Tabellen
│   └── index.ts            # Public API
├── package.json
└── tsconfig.json
```

### Hierarchie

```
User
  └─ Koordinator (Opus, MCP-Server)
       ├─ Spezialist A (MCP-Spawn, SKILL.md, persistent, eigener Wrapper)
       │    ├─ Task-Agent 1 (Agent-Tool, temporaer)
       │    └─ Task-Agent 2 (Agent-Tool, temporaer)
       └─ Spezialist B (MCP-Spawn, SKILL.md, persistent)
            └─ Task-Agent 3 (Agent-Tool, temporaer)
```

**Zwei Spawn-Ebenen:**
- **MCP-Spawn** (neu): Persistent, eigene Skills, Heartbeat, ueberlebt Restarts
- **Agent-Tool** (existiert): Temporaer, lebt im Context des Spezialisten

Spezialisten koennen selbst Sub-Agenten ueber das Agent-Tool spawnen wenn ihre Aufgabe komplex genug ist. Sie muessen diese aber praezise anweisen (keine eigenen Skills).

Spezialisten sind vollwertige Synapse-Agenten mit Zugriff auf alle MCP-Tools (semantic_code_search, write_memory, update_project_plan, etc.).

## Agent-Wrapper (Prozess-Persistenz)

### Problem

Wenn der MCP-Server (Koordinator) neu startet, brechen die stdin/stdout Pipes zu den Subprozessen. Agenten sterben mit.

### Loesung

Jeder Spezialist bekommt einen eigenen Wrapper-Prozess:

```
MCP-Server ←── Unix Socket (reconnectable!) ──→ Agent-Wrapper (detached)
                                                   └─ stdin/stdout PIPE → claude CLI
```

**Agent-Wrapper Verantwortung:**
- Haelt die Pipes zum Claude CLI Subprocess
- Oeffnet Unix Socket: `~/.synapse/sockets/{name}.sock` (chmod 600, nicht /tmp/)
- Hat eigenen Mini-Heartbeat (pollt Inbox/Channels, weckt Agent)
- Laeuft unabhaengig vom MCP-Server (`detached: true`, `child.unref()`)
- Aktualisiert status.json bei jedem Poll-Zyklus
- Message-Queue: Wenn Agent busy, werden Nachrichten gequeued (FIFO)
- Auto-Rotation wenn Agent-Context voll wird (experimentell, opt-in via Config)

**Wire-Protokoll (MCP-Server ↔ Wrapper):**

JSON-RPC ueber Unix Socket (newline-delimited):

```json
// Request (MCP-Server → Wrapper)
{"jsonrpc":"2.0","method":"wake","params":{"message":"..."},"id":1}
{"jsonrpc":"2.0","method":"stop","id":2}
{"jsonrpc":"2.0","method":"status","id":3}

// Response (Wrapper → MCP-Server)
{"jsonrpc":"2.0","result":{"content":"...","inputTokens":0,"outputTokens":0},"id":1}
{"jsonrpc":"2.0","result":{"stopped":true},"id":2}
{"jsonrpc":"2.0","result":{"busy":false,"tokens":{"input":45000,"output":12000}},"id":3}

// Notification (Wrapper → MCP-Server, kein id = fire-and-forget)
{"jsonrpc":"2.0","method":"agent_output","params":{"content":"Agent hat etwas gepostet"}}
{"jsonrpc":"2.0","method":"agent_error","params":{"error":"Subprocess exited unexpectedly"}}
```

**MCP-Server Restart:**
1. MCP-Server stirbt → Socket-Verbindung bricht
2. Wrapper + Claude CLI laufen WEITER
3. Wrapper-Heartbeat haelt Agenten aktiv (pollt DB, weckt bei Nachrichten)
4. MCP-Server startet neu → liest status.json
5. Fuer jeden Eintrag mit status "running":
   a. PID-Check: `kill -0 pid` — lebt der Wrapper noch?
   b. JA: Reconnect zum Unix Socket
   c. NEIN: Stale-Eintrag bereinigen, status auf "crashed" setzen
6. Koordinator liest Channel/Inbox-History seit letztem bekannten Zeitpunkt
7. Koordinator entscheidet: gecrashe Spezialisten neu spawnen oder nicht

**Crash-Recovery:**
- Wrapper-Crash: PID tot, Socket-File verwaist → MCP-Server raeumt auf beim Reconnect
- Claude CLI Crash: Wrapper erkennt `exit` Event → schreibt status "crashed" in status.json, benachrichtigt via Socket falls MCP-Server verbunden
- Orphaned Sockets: Beim MCP-Server Start werden alle `.sock` Files geprueft — PID tot? → Socket loeschen

## Specialist-Dateisystem (OpenClaw-inspiriert)

### Verzeichnisstruktur

```
.synapse/agents/{name}/
├── SKILL.md              # Identitaet + Regeln + Patterns (immer geladen, < 2000 Tokens)
├── MEMORY.md             # Entscheidungen, Projekt-Erkenntnisse (persistent, < 100 Zeilen)
├── logs/
│   ├── 2026-03-25.md     # Heutiges Log (append-only, auto-geladen)
│   └── 2026-03-24.md     # Gestriges Log (auto-geladen)
```

### SKILL.md Struktur

```markdown
---
name: test-experte
model: haiku
expertise: TypeScript Testing, Vitest
created: 2026-03-25
---

# Regeln
- IMMER: Typen explizit angeben, nie `any`
- NIEMALS: toBe() bei Objektvergleichen → toEqual() verwenden
- NIEMALS: SQLite fuer DB-Tests → Testcontainers mit echtem PostgreSQL

# Fehler → Loesung
- Import aus index.ts statt direkt → Circular Dependency, direkt importieren
- vi.mock() nicht am Datei-Anfang → Hoisting-Problem, immer ganz oben

# Patterns
- Bei Async-Tests → await expect(...).rejects.toThrow()
- Bei DB-Tests → Transaction + Rollback im afterEach
- Parallel → describe.concurrent() fuer unabhaengige Tests
```

### MEMORY.md Struktur

```markdown
# Projekt-Erkenntnisse

## Entscheidungen
- Auth-Tokens als HttpOnly Cookie, NICHT localStorage (XSS-Vorfall)
- Vitest statt Jest (schneller, native ESM)

## Projekt-Kontext
- 9 PostgreSQL-Tabellen, memories hat UNIQUE(project,name)
- Embedding-Provider: Google, erlaubt 250 Batch-Size

## Gelernte Praeferenzen
- User will Integration-Tests, keine Mocks
- Einzelne Commits pro logischer Aenderung
```

### Laden bei Agent-Start

1. SKILL.md lesen (immer)
2. MEMORY.md lesen (immer)
3. logs/heute.md + logs/gestern.md lesen (automatisch)
4. Aeltere Logs nur per `search_memory` bei Bedarf
5. Tiefes Wissen in Qdrant via Synapse MCP-Tools

### Verdichtung

Wenn MEMORY.md > 100 Zeilen: Agent verdichtet selbst — alte Details nach Qdrant (`write_memory`), nur Essenz behalten.

## Skill-Learning (4 Wege)

### Weg 1: Selbst-Lernen (kontinuierlich)

Agent macht Fehler → findet Loesung → aktualisiert SKILL.md Regeln-Sektion.

### Weg 2: User-Korrektur (via Koordinator)

User erklaert dem Koordinator wie es richtig ist → Koordinator sendet `[PRAXIS-FEEDBACK]` via Inbox → Agent aktualisiert SKILL.md.

### Weg 3: Peer-Learning (Agent → Agent)

Opus-Agent reviewt Haiku-Agent Code → erkennt wiederkehrenden Fehler → sendet Inbox-Nachricht mit konkreter Anweisung zum Skill-Update.

### Weg 4: Initiale Web-Recherche (erster Start)

Neuer Spezialist ohne SKILL.md → macht WebSearch zu seinem Fachgebiet → kuratiert Ergebnisse in SKILL.md (Best Practices, Gotchas, Patterns).

## Widerspruchs-Erkennung

Koordinator beobachtet Channels. Wenn zwei Spezialisten widersprüchliche Aussagen machen:

1. Koordinator erkennt den Widerspruch
2. Fragt User: "Zwei Spezialisten widersprechen sich bei X. Was ist richtig?"
3. User entscheidet
4. Koordinator sendet `[PRAXIS-FEEDBACK]` an BEIDE Agenten
5. Beide aktualisieren ihre SKILL.md

## Freigabe-Flow (Plaene & Proposals)

1. Spezialist erstellt Plan/Proposal via Synapse Tools
2. Postet in Channel: "Plan erstellt. Brauche Freigabe."
3. Koordinator liest Plan, praesentiert dem User
4. User + Koordinator bewerten gemeinsam
5. Koordinator → Inbox an Spezialist: "FREIGABE" oder "ABGELEHNT: Grund"
6. Spezialist arbeitet erst nach Freigabe

## Kommunikation

### 3 Kommunikationswege

#### 1. Channels (Gruppenchat)

PostgreSQL-backed. Alle Mitglieder sehen alle Nachrichten. Koordinator sieht alles.

```sql
CREATE TABLE specialist_channels (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE specialist_channel_members (
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, agent_name)
);

CREATE TABLE specialist_channel_messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 2. Inbox (1:1 Direkt-Nachrichten)

Async, DB-backed. Fuer Peer-Korrekturen, Koordinator-Anweisungen, Wissensluecken-Meldungen.

```sql
CREATE TABLE specialist_inbox (
  id SERIAL PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance-Indices
CREATE INDEX idx_specialist_inbox_unprocessed ON specialist_inbox(to_agent, processed) WHERE processed = false;
CREATE INDEX idx_specialist_channel_messages_channel ON specialist_channel_messages(channel_id, id DESC);
CREATE INDEX idx_specialist_channel_messages_created ON specialist_channel_messages(channel_id, created_at DESC);
CREATE INDEX idx_specialist_channels_project ON specialist_channels(project);
```

#### 3. Status-Datei (Koordinator-Ueberblick)

```json
{
  "specialists": {
    "test-experte": {
      "model": "haiku",
      "status": "running",
      "pid": 12345,
      "wrapperPid": 12340,
      "socket": "~/.synapse/sockets/test-experte.sock",
      "tokens": { "input": 45000, "output": 12000, "percent": 32 },
      "contextCeiling": 200000,
      "lastActivity": "2026-03-25T14:30:00Z",
      "channels": ["refactor-auth", "synapse-general"],
      "currentTask": "Integration-Tests fuer Event-System"
    }
  },
  "maxSpecialists": 5,
  "lastUpdate": "2026-03-25T14:30:15Z"
}
```

### Heartbeat-Flow (alle 15 Sekunden)

```
Agent-Wrapper Heartbeat:
  ├─ Channel-Messages: Neue seit letzter ID?
  │   └─ JA: Agent via stdin wecken
  │       └─ Menschliche Nachricht? → [PRAXIS-FEEDBACK] Tag
  ├─ Inbox: Unprocessed fuer diesen Agent?
  │   └─ JA: Agent via stdin wecken, als gelesen markieren
  ├─ Token-Tracking aktualisieren
  │   ├─ > 80%: Warnung ("sichere MEMORY.md")
  │   └─ > 95%: Auto-Rotation (experimentell)
  └─ status.json aktualisieren
```

### Alte Chat-Tools → Wrapper (Migration)

| Altes Tool | Neues Verhalten |
|-----------|----------------|
| `send_chat_message(recipient)` | → `specialist_inbox` INSERT |
| `send_chat_message(broadcast)` | → Default-Channel posten |
| `get_chat_messages` | → Inbox + Channel-Feed kombiniert |
| `register_chat_agent` | → Specialist registrieren (ohne Subprocess) |
| `list_chat_agents` | → specialist_status() + Legacy-Agents |

Kein Breaking Change fuer bestehende Projekte.

## MCP-Tools

### Neue Tools

```
spawn_specialist(
  name: string,
  model: "opus" | "sonnet" | "haiku" | "opus[1m]" | "sonnet[1m]",
  expertise: string,
  task: string,
  project: string,
  cwd?: string,
  channel?: string,
  allowed_tools?: string[]
)

stop_specialist(name: string)

specialist_status(name?: string)

wake_specialist(name: string, message: string)

update_specialist_skill(
  name: string,
  section: "regeln" | "fehler" | "patterns",
  action: "add" | "remove",
  content: string
)
```

### Channel-Tools

```
create_channel(name, project, description)
join_channel(channel_name, agent_name)
leave_channel(channel_name, agent_name)
post_to_channel(channel_name, sender, content)
get_channel_feed(channel_name, limit?, since?)
list_channels(project?)
```

### Inbox-Tools

```
post_to_inbox(from_agent, to_agent, content)
check_inbox(agent_name)
```

### Utility

```
get_agent_capabilities()
→ { claude_cli, claude_version, spawning_available, max_specialists, available_models }
```

## Technische Referenz

### Claude CLI Spawn-Befehl

```typescript
spawn('claude', [
  '--print',
  '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--model', model,
  '--system-prompt', systemPrompt,
  '--session-id', sessionId,
  '--permission-mode', 'bypassPermissions',
], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: projectPath,
})
```

### Stream-Protokoll

**Input (Wrapper → Claude CLI):**
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

**Output (Claude CLI → Wrapper):**
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"result","result":"...","usage":{"input_tokens":X,"output_tokens":Y}}
```

### System-Prompt Aufbau (prompts.ts)

1. Rolle + Expertise (aus spawn_specialist Parameter)
2. SKILL.md Inhalt (falls vorhanden)
3. Synapse MCP-Instruktionen (search, memory, plans, etc.)
4. Kommunikations-Regeln (Channels, Inbox, Feedback-Protokoll)
5. Skill-Learning Anweisungen (wann und wie SKILL.md/MEMORY.md aktualisieren)
6. Onboarding-Anweisungen (was beim Start zu tun ist)

## Ressourcen-Limits

### Max Spezialisten

Konfigurierbar, Default: **5** gleichzeitig laufende Spezialisten.
`spawn_specialist` gibt Fehler zurueck wenn Limit erreicht:
`{ success: false, error: "Specialist-Limit erreicht (5/5). Stoppe einen Spezialisten zuerst." }`

### Context-Ceiling pro Modell

| Modell | Context-Ceiling | Warnung (80%) | Rotation (95%, opt-in) |
|--------|----------------|---------------|----------------------|
| haiku | 200.000 | 160.000 | 190.000 |
| sonnet | 200.000 | 160.000 | 190.000 |
| opus | 200.000 | 160.000 | 190.000 |
| sonnet[1m] | 1.000.000 | 980.000 | 995.000 |
| opus[1m] | 1.000.000 | 980.000 | 995.000 |

### Auto-Rotation (opt-in)

Standardmaessig deaktiviert (`autoRotation: false` in Config). Wenn aktiviert:
1. Agent wird aufgefordert MEMORY.md + SKILL.md zu sichern
2. Claude CLI Subprocess wird gestoppt
3. Neuer Subprocess mit frischem Context wird gestartet
4. Agent laedt SKILL.md + MEMORY.md + logs → arbeitet weiter

## Lifecycle & Shutdown

### Graceful Shutdown

Bei `SIGTERM`/`SIGINT` des MCP-Servers:
1. Allen Wrappern "save_and_pause" senden via Socket
2. Agenten sichern MEMORY.md
3. Wrapper laufen weiter (detached) — Agenten bleiben aktiv
4. Beim naechsten MCP-Start: Reconnect

Bei `stop_projekt()`:
1. Allen Wrappern "stop" senden
2. Agenten sichern MEMORY.md
3. Wrapper + Claude CLI beenden
4. Socket-Files aufraeumen
5. status.json: alle auf "stopped"

### Orphan-Cleanup (MCP-Server Start)

```
Fuer jede .sock Datei in ~/.synapse/sockets/:
  1. Lade PID aus status.json
  2. kill -0 pid → Lebt der Prozess?
  3. NEIN: Socket loeschen, status.json bereinigen
  4. JA: Reconnect versuchen
```

## Package-Beziehungen

```
packages/agents/          # Library + Wrapper-Binary
  ├── src/index.ts        # Exportiert: ProcessManager, HeartbeatController, etc.
  ├── src/wrapper.ts      # Standalone Entry-Point (#!/usr/bin/env node)
  └── package.json        # bin: { "synapse-agent-wrapper": "./dist/wrapper.js" }

packages/mcp-server/
  └── src/server.ts       # Importiert von @synapse/agents, registriert MCP-Tools

packages/core/
  └── (unveraendert)      # Shared DB, Embeddings, etc.
```

`packages/mcp-server` importiert aus `@synapse/agents` und registriert die neuen MCP-Tools.
`packages/agents` importiert aus `@synapse/core` fuer DB-Zugriff.
Der Wrapper (`wrapper.ts`) ist ein eigenstaendiger Node.js-Prozess der als Binary installiert wird.

## Migration (Legacy Chat)

### Dual-Path Routing

Alte Chat-Tools pruefen ob ein Agent ein Specialist oder Legacy-Agent ist:

```
send_chat_message(recipient_id: "test-experte"):
  → Ist "test-experte" in specialist_channels registriert?
    → JA: specialist_inbox INSERT
    → NEIN: chat_messages INSERT (Legacy-Verhalten)
```

### Bestehende Daten

Die `chat_messages` Tabelle bleibt bestehen. Historische Nachrichten sind weiterhin
ueber `get_chat_messages` abrufbar (Legacy-Pfad). Neue Nachrichten gehen in die
neuen Tabellen wenn der Empfaenger ein Specialist ist.

### Hinweise

- WebSearch fuer Skill-Learning (Weg 4) ist optional — funktioniert nur wenn Claude CLI
  WebSearch aktiviert hat. Ohne WebSearch startet der Agent mit leerem SKILL.md und
  lernt rein durch Arbeit + Feedback.
- `--allowedTools` Parameter in `spawn_specialist` wird 1:1 an Claude CLI `--allowedTools`
  Flags weitergegeben (ein Flag pro Tool).
- stderr des Claude CLI Subprocess wird vom Wrapper geloggt nach
  `.synapse/agents/{name}/logs/stderr.log`
