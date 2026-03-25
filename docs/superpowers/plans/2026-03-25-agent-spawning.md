# Agent-Spawning System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synapse bekommt die Faehigkeit, persistente Claude CLI Spezialisten zu spawnen die ueber selbstlernende Skills verfuegen und ueber Channels/Inbox kommunizieren.

**Architecture:** Neues Package `@synapse/agents` im Monorepo. Agent-Wrapper Prozesse (detached, Unix Socket) halten Claude CLI Subprozesse am Leben unabhaengig vom MCP-Server. Kommunikation ueber PostgreSQL-backed Channels und Inbox mit Heartbeat-Polling.

**Tech Stack:** TypeScript (ESM), Node.js child_process, Unix Domain Sockets (net), PostgreSQL (via @synapse/core), JSON-RPC

**Spec:** `docs/superpowers/specs/2026-03-25-agent-spawning-design.md`

---

## File Map

### Neues Package: `packages/agents/`

| Datei | Verantwortung |
|-------|---------------|
| `package.json` | Package-Config, Dependencies, bin-Entry fuer Wrapper |
| `tsconfig.json` | TypeScript-Config, extends tsconfig.base.json |
| `src/index.ts` | Public API — alle Exports |
| `src/detect.ts` | Claude CLI Erkennung (which, --version) |
| `src/schema.ts` | DB-Tabellen (specialist_channels, specialist_inbox, etc.) |
| `src/process.ts` | ProcessManager — Claude CLI Subprocess Lifecycle |
| `src/skills.ts` | SkillManager — SKILL.md / MEMORY.md / logs CRUD |
| `src/status.ts` | StatusManager — .synapse/agents/status.json |
| `src/channels.ts` | ChannelManager — Gruppenchat CRUD |
| `src/inbox.ts` | InboxManager — 1:1 Messaging CRUD |
| `src/prompts.ts` | System-Prompt Builder fuer Spezialisten |
| `src/heartbeat.ts` | HeartbeatController — Polling, Token-Tracking |
| `src/wrapper.ts` | Agent-Wrapper — Standalone Binary (Unix Socket + Pipes) |
| `src/types.ts` | Shared TypeScript Interfaces |

### Modifikationen in bestehenden Packages

| Datei | Aenderung |
|-------|-----------|
| `packages/mcp-server/src/tools/index.ts` | Barrel-Export fuer specialists.ts |
| `packages/mcp-server/src/server.ts` | Neue MCP-Tools registrieren, alte Chat-Tools migrieren |
| `packages/mcp-server/package.json` | Dependency auf @synapse/agents hinzufuegen |
| `package.json` (root) | Build-Script fuer agents Package |
| `pnpm-workspace.yaml` | Unveraendert (packages/* matched automatisch) |

---

## Task 1: Package-Setup

**Files:**
- Create: `packages/agents/package.json`
- Create: `packages/agents/tsconfig.json`
- Create: `packages/agents/src/types.ts`
- Create: `packages/agents/src/index.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Package-Verzeichnis und package.json erstellen**

```json
// packages/agents/package.json
{
  "name": "@synapse/agents",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "synapse-agent-wrapper": "./dist/wrapper.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@synapse/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.10.0",
    "@types/pg": "^8.10.0",
    "rimraf": "^5.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json erstellen**

```json
// packages/agents/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: types.ts mit allen Interfaces erstellen**

```typescript
// packages/agents/src/types.ts

export interface SpecialistConfig {
  name: string
  model: 'opus' | 'sonnet' | 'haiku' | 'opus[1m]' | 'sonnet[1m]'
  expertise: string
  task: string
  project: string
  cwd?: string
  channel?: string
  allowedTools?: string[]
}

export interface SpecialistStatus {
  name: string
  model: string
  status: 'running' | 'idle' | 'stopped' | 'crashed'
  pid: number
  wrapperPid: number
  socket: string
  tokens: { input: number; output: number; percent: number }
  contextCeiling: number
  lastActivity: string
  channels: string[]
  currentTask: string | null
}

export interface StatusFile {
  specialists: Record<string, SpecialistStatus>
  maxSpecialists: number
  lastUpdate: string
}

export interface WrapperMessage {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
  id?: number
}

export interface WrapperResponse {
  jsonrpc: '2.0'
  result?: Record<string, unknown>
  error?: { code: number; message: string }
  id?: number
}

export interface StreamEvent {
  type: string
  subtype?: string
  message?: { content: Array<{ type: string; text: string }> }
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

export interface SendMessageResult {
  content: string
  inputTokens: number
  outputTokens: number
}

export interface ChannelMessage {
  id: number
  channelName: string
  sender: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: Date
}

export interface InboxMessage {
  id: number
  fromAgent: string
  toAgent: string
  content: string
  processed: boolean
  createdAt: Date
}

export interface HeartbeatConfig {
  pollIntervalMs: number
  contextCeilings: Record<string, number>
  warnPercent: number
  rotationPercent: number
  autoRotation: boolean
}

export const CONTEXT_CEILINGS: Record<string, number> = {
  haiku: 200_000,
  sonnet: 200_000,
  opus: 200_000,
  'sonnet[1m]': 1_000_000,
  'opus[1m]': 1_000_000,
}

export const WARN_THRESHOLDS: Record<string, number> = {
  haiku: 160_000,
  sonnet: 160_000,
  opus: 160_000,
  'sonnet[1m]': 980_000,
  'opus[1m]': 980_000,
}
```

- [ ] **Step 4: Leere index.ts erstellen**

```typescript
// packages/agents/src/index.ts
export * from './types.js'
```

- [ ] **Step 5: Root package.json — Build-Script hinzufuegen**

In `package.json` (root) im `scripts` Objekt NUR hinzufuegen:
```json
"build:agents": "pnpm --filter @synapse/agents build"
```

WICHTIG: Das bestehende `"build": "pnpm -r run build"` NICHT aendern! pnpm loest die Build-Reihenfolge automatisch ueber die workspace-Dependencies auf.

- [ ] **Step 6: Dependencies installieren und Build testen**

Run: `cd /home/blacky/dev/synapse && pnpm install && pnpm build:agents`
Expected: Erfolgreicher Build, dist/ Verzeichnis erstellt

- [ ] **Step 7: Commit**

```bash
git add packages/agents/ package.json
git commit -m "feat(agents): scaffold @synapse/agents package with types"
```

---

## Task 2: DB-Schema

**Files:**
- Create: `packages/agents/src/schema.ts`

WICHTIG: NICHT `packages/core/src/db/schema.ts` modifizieren! Das wuerde eine zirkulaere Dependency erzeugen (core ← agents ← core). Stattdessen: agents verwaltet sein eigenes Schema und fuehrt es selbst aus via `getPool()` aus core.

- [ ] **Step 1: Schema-Datei erstellen**

```typescript
// packages/agents/src/schema.ts

export const AGENTS_SCHEMA = `
-- Specialist Channels (Gruppenchat)
CREATE TABLE IF NOT EXISTS specialist_channels (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS specialist_channel_members (
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, agent_name)
);

CREATE TABLE IF NOT EXISTS specialist_channel_messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Specialist Inbox (1:1 Messaging)
CREATE TABLE IF NOT EXISTS specialist_inbox (
  id SERIAL PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indices
CREATE INDEX IF NOT EXISTS idx_specialist_inbox_unprocessed
  ON specialist_inbox(to_agent, processed) WHERE processed = false;
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_channel
  ON specialist_channel_messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_created
  ON specialist_channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channels_project
  ON specialist_channels(project);
`
```

- [ ] **Step 2: ensureAgentsSchema() Funktion hinzufuegen**

Am Ende von `packages/agents/src/schema.ts`:

```typescript
import { getPool } from '@synapse/core'

export async function ensureAgentsSchema(): Promise<void> {
  const pool = getPool()
  await pool.query(AGENTS_SCHEMA)
}
```

Diese Funktion wird spaeter beim MCP-Server Start aufgerufen (Task 14).

- [ ] **Step 3: Export in index.ts hinzufuegen**

```typescript
export { AGENTS_SCHEMA, ensureAgentsSchema } from './schema.js'
```

- [ ] **Step 4: Build testen**

Run: `cd /home/blacky/dev/synapse && pnpm build:agents`
Expected: Erfolgreicher Build

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/schema.ts packages/agents/src/index.ts
git commit -m "feat(agents): add specialist channels and inbox DB schema"
```

---

## Task 3: Claude CLI Erkennung

**Files:**
- Create: `packages/agents/src/detect.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: detect.ts implementieren**

```typescript
// packages/agents/src/detect.ts
import { execSync } from 'node:child_process'

export interface ClaudeCliInfo {
  available: boolean
  path: string | null
  version: string | null
  models: string[]
}

export function detectClaudeCli(): ClaudeCliInfo {
  try {
    const path = execSync('which claude', { encoding: 'utf-8' }).trim()
    if (!path) {
      return { available: false, path: null, version: null, models: [] }
    }

    let version: string | null = null
    try {
      version = execSync('claude --version', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
    } catch {
      // Version nicht ermittelbar, CLI aber vorhanden
    }

    return {
      available: true,
      path,
      version,
      models: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'],
    }
  } catch {
    return { available: false, path: null, version: null, models: [] }
  }
}
```

- [ ] **Step 2: Export in index.ts hinzufuegen**

```typescript
// packages/agents/src/index.ts
export * from './types.js'
export * from './detect.js'
```

- [ ] **Step 3: Build testen**

Run: `pnpm build:agents`
Expected: Erfolgreicher Build

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/detect.ts packages/agents/src/index.ts
git commit -m "feat(agents): add Claude CLI detection"
```

---

## Task 4: Skills Manager

**Files:**
- Create: `packages/agents/src/skills.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: skills.ts implementieren**

```typescript
// packages/agents/src/skills.ts
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'

export interface SkillFile {
  name: string
  model: string
  expertise: string
  created: string
  content: string
}

function agentDir(projectPath: string, agentName: string): string {
  return join(projectPath, '.synapse', 'agents', agentName)
}

export async function ensureAgentDir(projectPath: string, agentName: string): Promise<string> {
  const dir = agentDir(projectPath, agentName)
  await mkdir(join(dir, 'logs'), { recursive: true })
  return dir
}

export async function readSkill(projectPath: string, agentName: string): Promise<string | null> {
  const path = join(agentDir(projectPath, agentName), 'SKILL.md')
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeSkill(projectPath: string, agentName: string, content: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
}

export async function readMemory(projectPath: string, agentName: string): Promise<string | null> {
  const path = join(agentDir(projectPath, agentName), 'MEMORY.md')
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeMemory(projectPath: string, agentName: string, content: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  await writeFile(join(dir, 'MEMORY.md'), content, 'utf-8')
}

export async function readTodayLog(projectPath: string, agentName: string): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(agentDir(projectPath, agentName), 'logs', `${today}.md`)
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function readYesterdayLog(projectPath: string, agentName: string): Promise<string | null> {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const path = join(agentDir(projectPath, agentName), 'logs', `${yesterday}.md`)
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function appendLog(projectPath: string, agentName: string, entry: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  const today = new Date().toISOString().slice(0, 10)
  const path = join(dir, 'logs', `${today}.md`)

  let existing = ''
  try {
    existing = await readFile(path, 'utf-8')
  } catch {
    existing = `# Log ${today}\n\n`
  }

  await writeFile(path, existing + entry + '\n', 'utf-8')
}

export async function listAgentDirs(projectPath: string): Promise<string[]> {
  const base = join(projectPath, '.synapse', 'agents')
  try {
    const entries = await readdir(base, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && e.name !== 'status.json')
      .map(e => e.name)
  } catch {
    return []
  }
}

export function createInitialSkill(
  name: string,
  model: string,
  expertise: string,
): string {
  const today = new Date().toISOString().slice(0, 10)
  return `---
name: ${name}
model: ${model}
expertise: ${expertise}
created: ${today}
---

# Regeln
(Noch keine Regeln gelernt)

# Fehler → Loesung
(Noch keine Fehler dokumentiert)

# Patterns
(Noch keine Patterns erkannt)
`
}
```

- [ ] **Step 2: Export hinzufuegen**

In `packages/agents/src/index.ts` hinzufuegen:
```typescript
export * from './skills.js'
```

- [ ] **Step 3: Build testen**

Run: `pnpm build:agents`
Expected: Erfolgreicher Build

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/skills.ts packages/agents/src/index.ts
git commit -m "feat(agents): add SkillManager for SKILL.md, MEMORY.md, and logs"
```

---

## Task 5: Status Manager

**Files:**
- Create: `packages/agents/src/status.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: status.ts implementieren**

```typescript
// packages/agents/src/status.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpecialistStatus, StatusFile } from './types.js'

const DEFAULT_MAX_SPECIALISTS = 5

function statusPath(projectPath: string): string {
  return join(projectPath, '.synapse', 'agents', 'status.json')
}

export async function readStatus(projectPath: string): Promise<StatusFile> {
  try {
    const raw = await readFile(statusPath(projectPath), 'utf-8')
    return JSON.parse(raw) as StatusFile
  } catch {
    return {
      specialists: {},
      maxSpecialists: DEFAULT_MAX_SPECIALISTS,
      lastUpdate: new Date().toISOString(),
    }
  }
}

export async function writeStatus(projectPath: string, status: StatusFile): Promise<void> {
  const path = statusPath(projectPath)
  await mkdir(join(projectPath, '.synapse', 'agents'), { recursive: true })
  status.lastUpdate = new Date().toISOString()
  await writeFile(path, JSON.stringify(status, null, 2), 'utf-8')
}

export async function updateSpecialist(
  projectPath: string,
  name: string,
  update: Partial<SpecialistStatus>,
): Promise<void> {
  const status = await readStatus(projectPath)
  status.specialists[name] = { ...status.specialists[name], ...update } as SpecialistStatus
  await writeStatus(projectPath, status)
}

export async function removeSpecialist(projectPath: string, name: string): Promise<void> {
  const status = await readStatus(projectPath)
  delete status.specialists[name]
  await writeStatus(projectPath, status)
}

export async function getRunningCount(projectPath: string): Promise<number> {
  const status = await readStatus(projectPath)
  return Object.values(status.specialists).filter(s => s.status === 'running').length
}

export async function canSpawn(projectPath: string): Promise<{ ok: boolean; reason?: string }> {
  const status = await readStatus(projectPath)
  const running = Object.values(status.specialists).filter(s => s.status === 'running').length
  if (running >= status.maxSpecialists) {
    return {
      ok: false,
      reason: `Specialist-Limit erreicht (${running}/${status.maxSpecialists}). Stoppe einen Spezialisten zuerst.`,
    }
  }
  return { ok: true }
}
```

- [ ] **Step 2: Export hinzufuegen, Build testen**

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/status.ts packages/agents/src/index.ts
git commit -m "feat(agents): add StatusManager for status.json"
```

---

## Task 6: Channels

**Files:**
- Create: `packages/agents/src/channels.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: channels.ts implementieren**

Verwende den PostgreSQL-Pool aus `@synapse/core` (importiere `pool` oder die DB-Verbindung). Implementiere:

- `createChannel(project, name, description, createdBy)` → INSERT INTO specialist_channels
- `deleteChannel(name)` → DELETE (CASCADE loescht members + messages)
- `joinChannel(channelName, agentName)` → INSERT INTO specialist_channel_members
- `leaveChannel(channelName, agentName)` → DELETE FROM specialist_channel_members
- `postMessage(channelName, sender, content, metadata?)` → INSERT INTO specialist_channel_messages
- `getMessages(channelName, opts: { limit?, sinceId?, preview? })` → SELECT mit optionalem content-Trim
- `getChannelMembers(channelName)` → SELECT agent_name
- `listChannels(project?)` → SELECT mit optionalem project-Filter
- `getNewMessagesForAgent(agentName, sinceId)` → SELECT neue Messages aus allen Channels des Agenten

Folge dem Pattern aus `/home/blacky/dev/agent-hub/src/agents/channels.ts` aber nutze den `pg` Pool aus `@synapse/core` statt `postgres` (Postgres.js).

- [ ] **Step 2: Erstelle automatischen `{project}-general` Channel**

Funktion `ensureGeneralChannel(project, createdBy)` die den Default-Channel erstellt falls er nicht existiert. Wird bei `spawn_specialist` aufgerufen.

- [ ] **Step 3: Export, Build, Commit**

```bash
git add packages/agents/src/channels.ts packages/agents/src/index.ts
git commit -m "feat(agents): add ChannelManager for group communication"
```

---

## Task 7: Inbox

**Files:**
- Create: `packages/agents/src/inbox.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: inbox.ts implementieren**

- `postToInbox(fromAgent, toAgent, content)` → INSERT INTO specialist_inbox
- `checkInbox(agentName)` → UPDATE processed=true RETURNING (wie agent-hub)
- `getNewMessages(agentName, sinceId)` → SELECT unprocessed seit ID (fuer Heartbeat)
- `getInboxHistory(agentName, limit?)` → SELECT alle (auch processed)

- [ ] **Step 2: Export, Build, Commit**

```bash
git add packages/agents/src/inbox.ts packages/agents/src/index.ts
git commit -m "feat(agents): add InboxManager for 1:1 messaging"
```

---

## Task 8: Process Manager

**Files:**
- Create: `packages/agents/src/process.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: ProcessManager Klasse implementieren**

Adaptiere direkt von `/home/blacky/dev/agent-hub/src/agents/process.ts`. Kernfunktionen:

- `start(name, model, systemPrompt, opts?)` → `spawn('claude', [...])` mit stream-json I/O
- `sendMessage(name, message)` → stdin schreiben, stdout JSON parsen, Promise<SendMessageResult>
- `stop(name)` → SIGTERM, Timeout, SIGKILL
- `isRunning(name)` → boolean
- `getStatus()` → Map<string, AgentStatus>
- `stopAll()` → Promise

**PFLICHT CLI-Flags (aus der Spec):**
```typescript
const args = [
  '--print',
  '--verbose',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--model', model,
  '--system-prompt', systemPrompt,
  '--session-id', sessionId,              // randomUUID() — wichtig fuer Context-Kontinuitaet
  '--permission-mode', 'bypassPermissions', // PFLICHT — ohne das fragt Agent bei jedem Tool
]

// Optionale Tool-Einschraenkungen
if (opts?.allowedTools?.length) {
  for (const tool of opts.allowedTools) {
    args.push('--allowedTools', tool)
  }
}
```

Wichtige Unterschiede zu agent-hub:
- Der ProcessManager wird INNERHALB des Wrappers verwendet (nicht direkt vom MCP-Server)
- `busy` Flag + Queue fuer concurrent Messages (Array, FIFO)
- stderr logging nach `.synapse/agents/{name}/logs/stderr.log` (via `fs.createWriteStream`)
- `sessionId` wird in status.json gespeichert fuer spaetere Referenz

- [ ] **Step 2: Message-Queue einbauen**

Wenn Agent busy: Nachricht in Queue (Array), nach Response naechste Nachricht aus Queue senden. FIFO.

- [ ] **Step 3: Build testen**

Run: `pnpm build:agents`
Expected: Erfolgreicher Build

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/process.ts packages/agents/src/index.ts
git commit -m "feat(agents): add ProcessManager for Claude CLI subprocess lifecycle"
```

---

## Task 9: Prompt Builder

**Files:**
- Create: `packages/agents/src/prompts.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: prompts.ts implementieren**

Funktion `buildSpecialistPrompt(config: SpecialistConfig, skill?: string, memory?: string)` die den System-Prompt zusammenbaut:

1. Rolle + Expertise Header
2. SKILL.md Inhalt (wenn vorhanden)
3. Synapse MCP-Instruktionen (welche Tools verfuegbar sind, wie suchen)
4. Kommunikations-Regeln (Channel-Name, Inbox, [PRAXIS-FEEDBACK] Erkennung)
5. Skill-Learning Anweisungen (wann SKILL.md/MEMORY.md aktualisieren)
6. Onboarding-Anweisungen (SKILL.md lesen, MEMORY.md lesen, logs lesen, bei erstem Start Web-Recherche)

Orientiere dich am `buildSystemPrompt()` aus `/home/blacky/dev/agent-hub/src/agents/persona.ts` und am Synapse Agent-Regeln Prompt-Baustein aus dem `synapse-nutzung` Skill.

- [ ] **Step 2: Build, Commit**

```bash
git add packages/agents/src/prompts.ts packages/agents/src/index.ts
git commit -m "feat(agents): add Prompt Builder for specialist system prompts"
```

---

## Task 10: Agent-Wrapper (Standalone Binary)

**Files:**
- Create: `packages/agents/src/wrapper.ts`

Dies ist die komplexeste Komponente. Der Wrapper ist ein eigenstaendiger Node.js-Prozess.

- [ ] **Step 1: Wrapper Entry-Point erstellen**

```typescript
#!/usr/bin/env node
// packages/agents/src/wrapper.ts
```

Der Wrapper empfaengt Konfiguration via CLI-Argumente oder Environment:
- `SYNAPSE_AGENT_NAME` — Agent-Name
- `SYNAPSE_AGENT_MODEL` — Modell
- `SYNAPSE_PROJECT_PATH` — Projekt-Pfad
- `SYNAPSE_SOCKET_PATH` — Unix Socket Pfad
- `SYNAPSE_SYSTEM_PROMPT` — System-Prompt (als Datei-Pfad, zu gross fuer env)
- `SYNAPSE_DB_URL` — PostgreSQL Connection

- [ ] **Step 2: Unix Socket Server implementieren**

```typescript
import { createServer, type Socket } from 'node:net'
```

- Oeffnet Unix Socket unter `SYNAPSE_SOCKET_PATH` (chmod 600)
- Socket-Pfad Konvention: `{projectPath}/.synapse/sockets/{name}.sock`
- Akzeptiert multiple Verbindungen (MCP-Server kann reconnecten)
- Versteht JSON-RPC Nachrichten (newline-delimited):
  - `wake` → Nachricht an Claude CLI senden, Antwort zurueck
  - `stop` → Graceful Shutdown (Agent sichert MEMORY.md, dann beenden)
  - `status` → Aktuellen Status zurueck
  - `save_and_pause` → Agent sichert MEMORY.md+SKILL.md, Wrapper laeuft weiter (fuer MCP-Server Restart)
- Sendet Notifications an verbundene Clients:
  - `agent_output` → Agent hat etwas gepostet
  - `agent_error` → Fehler im Subprocess

- [ ] **Step 3: ProcessManager integrieren**

- Beim Start: `ProcessManager.start()` mit dem uebergebenen System-Prompt
- Socket `wake` Requests → `ProcessManager.sendMessage()`
- Message-Queue: Wenn Agent busy, queuen

- [ ] **Step 4: Mini-Heartbeat implementieren**

- Alle 15 Sekunden: DB pollen fuer neue Channel-Messages und Inbox
- Neue Nachrichten → Agent via stdin wecken
- [PRAXIS-FEEDBACK] Tag bei menschlichen Nachrichten
- Token-Tracking kumulieren
- status.json aktualisieren

- [ ] **Step 5: Context-Warnung und Rotation**

- Bei `warnPercent`: Warnung an Agent ("sichere MEMORY.md + SKILL.md")
- Bei `rotationPercent` (wenn autoRotation=true): Save → Stop → Restart → Onboard

- [ ] **Step 6: Crash-Handling**

- Claude CLI `exit` Event → status.json auf "crashed" setzen
- Socket-Clients benachrichtigen via `agent_error` Notification
- Wrapper beendet sich selbst nach Cleanup

- [ ] **Step 7: Build + Shebang testen**

Run: `pnpm build:agents`
Expected: Erfolgreicher Build, `dist/wrapper.js` existiert

WICHTIG: TypeScript strippt den `#!/usr/bin/env node` Shebang beim Kompilieren. Fix im `packages/agents/package.json` Build-Script:
```json
"build": "tsc && node -e \"const fs=require('fs');const f='dist/wrapper.js';const c=fs.readFileSync(f,'utf8');if(!c.startsWith('#!')){fs.writeFileSync(f,'#!/usr/bin/env node\\n'+c)}\""
```

Oder alternativ: `wrapper.ts` NICHT mit Shebang versehen, sondern ein separates `bin/synapse-agent-wrapper` Shell-Script erstellen das `node dist/wrapper.js` aufruft.

- [ ] **Step 8: Commit**

```bash
git add packages/agents/src/wrapper.ts packages/agents/package.json
git commit -m "feat(agents): add Agent-Wrapper with Unix Socket and Mini-Heartbeat"
```

---

## Task 11: Heartbeat Controller (MCP-Server Seite)

**Files:**
- Create: `packages/agents/src/heartbeat.ts`
- Modify: `packages/agents/src/index.ts`

- [ ] **Step 1: HeartbeatController implementieren**

Dies ist die MCP-Server-seitige Komponente die sich um die Socket-Verbindungen kuemmert:

- `connectToWrapper(name, socketPath)` → Unix Socket Client verbinden
- `reconnectAll(projectPath)` → Alle Wrapper aus status.json reconnecten, PIDs pruefen
- `sendWake(name, message)` → JSON-RPC `wake` an Wrapper senden
- `sendStop(name)` → JSON-RPC `stop` an Wrapper senden
- `getStatus(name)` → JSON-RPC `status` an Wrapper senden
- `handleNotification(name, notification)` → agent_output/agent_error verarbeiten
- `cleanupOrphans(projectPath)` → Stale PIDs und verwaiste Socket-Files bereinigen

- [ ] **Step 2: Socket-Client Klasse**

```typescript
import { connect, type Socket } from 'node:net'
```

- Verbindet zum Unix Socket des Wrappers
- Sendet JSON-RPC Requests, wartet auf Response
- Empfaengt Notifications (kein `id` Feld)
- Auto-Reconnect bei Verbindungsverlust (mit Backoff)

- [ ] **Step 3: Build, Commit**

```bash
git add packages/agents/src/heartbeat.ts packages/agents/src/index.ts
git commit -m "feat(agents): add HeartbeatController for MCP-Server side socket management"
```

---

## Task 12: MCP-Tools (Neue Specialist-Tools)

**Files:**
- Modify: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/src/tools/specialists.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Dependency hinzufuegen**

In `packages/mcp-server/package.json`:
```json
"dependencies": {
  "@synapse/agents": "workspace:*"
}
```

Run: `pnpm install`

- [ ] **Step 2: Wrapper-Datei fuer Specialist-Tools erstellen**

`packages/mcp-server/src/tools/specialists.ts` mit Tool-Wrapper-Funktionen:

- `spawnSpecialistTool(args)` → CLI-Check, Limit-Check, Agent-Dir erstellen, SKILL.md initial, Wrapper spawnen (detached), Socket registrieren, General-Channel joinen
- `stopSpecialistTool(args)` → save MEMORY.md auffordern, Wrapper stoppen, Cleanup
- `specialistStatusTool(args)` → status.json lesen, optional Detail-Info
- `wakeSpecialistTool(args)` → Socket wake senden, Antwort zurueck
- `updateSpecialistSkillTool(args)` → SKILL.md direkt editieren

- [ ] **Step 3: Channel-Tools registrieren**

In `server.ts` die Channel-Tools hinzufuegen:
- `create_channel`, `join_channel`, `leave_channel`
- `post_to_channel`, `get_channel_feed`, `list_channels`

- [ ] **Step 4: Inbox-Tools registrieren**

- `post_to_inbox`, `check_inbox`

- [ ] **Step 5: Utility-Tool registrieren**

- `get_agent_capabilities` → `detectClaudeCli()` aufrufen, Ergebnis zurueck

- [ ] **Step 6: Barrel-Export in tools/index.ts**

Falls `packages/mcp-server/src/tools/index.ts` existiert, hinzufuegen:
```typescript
export * from './specialists.js'
```

Falls nicht, die Imports in `server.ts` direkt aus `./tools/specialists.js` machen.

- [ ] **Step 7: Build testen**

Run: `pnpm build`
Expected: Alle Packages bauen erfolgreich

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/package.json packages/mcp-server/src/tools/ packages/mcp-server/src/server.ts
git commit -m "feat(mcp-server): register specialist, channel, and inbox MCP tools"
```

---

## Task 13: Legacy Chat Migration

**Files:**
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Alte Chat-Tools auf Dual-Path umbauen**

Fuer jedes bestehende Chat-Tool in server.ts:

**`send_chat_message`:**
```typescript
// Pruefe ob Empfaenger ein Specialist ist
const isSpecialist = /* status.json oder specialist_channels check */
if (recipientId && isSpecialist) {
  // Neuer Pfad: specialist_inbox
  await postToInbox(senderId, recipientId, content)
} else if (!recipientId && isSpecialist) {
  // Broadcast: general channel
  await postMessage(`${project}-general`, senderId, content)
} else {
  // Legacy-Pfad: chat_messages Tabelle
  await sendChatMessage(project, senderId, content, recipientId)
}
```

**`get_chat_messages`:**
- Kombiniere Inbox + Channel-Feed + Legacy chat_messages

**`register_chat_agent`:**
- Wenn CLI vorhanden: Specialist registrieren (DB-Eintrag, kein Subprocess)
- Sonst: Legacy agent_sessions

**`list_chat_agents`:**
- Specialist-Status + Legacy-Agents kombinieren

- [ ] **Step 2: Bestehende Tests (falls vorhanden) pruefen**

Stelle sicher dass keine bestehende Funktionalitaet bricht.

- [ ] **Step 3: Build testen**

Run: `pnpm build`
Expected: Alle Packages bauen erfolgreich

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/server.ts
git commit -m "feat(mcp-server): migrate legacy chat tools to dual-path routing"
```

---

## Task 14: Orphan-Cleanup & Lifecycle

**Files:**
- Modify: `packages/mcp-server/src/server.ts` (oder `index.ts`)

- [ ] **Step 1: Startup-Cleanup implementieren**

Beim MCP-Server Start (nach Synapse Init):

```typescript
import { detectClaudeCli, reconnectAll, cleanupOrphans } from '@synapse/agents'

const cli = detectClaudeCli()
if (cli.available) {
  // 1. Orphaned Socket-Files bereinigen
  await cleanupOrphans(projectPath)
  // 2. Laufende Wrapper reconnecten
  await reconnectAll(projectPath)
  // 3. Log: X Spezialisten reconnected, Y bereinigt
}
```

- [ ] **Step 2: SIGTERM/SIGINT Handler**

```typescript
process.on('SIGTERM', async () => {
  // Allen Wrappern save_and_pause senden (Wrapper laufen weiter)
  // MCP-Server beendet sich
})
```

- [ ] **Step 3: stop_projekt Integration**

Die bestehende `stopProjekt` Funktion (in `packages/mcp-server/src/tools/init.ts` oder `server.ts`) erweitern:
Wenn Claude CLI verfuegbar und Spezialisten laufen → alle Spezialisten stoppen via `sendStop()`.

- [ ] **Step 4: ensureAgentsSchema beim Start aufrufen**

Im MCP-Server Startup (nach `initSynapse()`):
```typescript
import { ensureAgentsSchema, detectClaudeCli } from '@synapse/agents'

// Nach initSynapse():
await ensureAgentsSchema()

const cli = detectClaudeCli()
if (cli.available) {
  await cleanupOrphans(projectPath)
  await reconnectAll(projectPath)
}
```

- [ ] **Step 5: Build, Commit**

```bash
git add packages/mcp-server/src/server.ts
git commit -m "feat(mcp-server): add orphan cleanup, schema init, and graceful shutdown for specialists"
```

---

## Task 15: Integration Test

**Files:**
- Kein neuer Code — manueller Test

- [ ] **Step 1: Build des gesamten Projekts**

Run: `pnpm build`
Expected: Alle 4 Packages bauen erfolgreich (core, agents, mcp-server, rest-api)

- [ ] **Step 2: CLI-Erkennung testen**

In einer Node.js REPL oder via temporaeres Script:
```typescript
import { detectClaudeCli } from '@synapse/agents'
console.log(detectClaudeCli())
// Expected: { available: true, path: '/path/to/claude', version: '...', models: [...] }
```

- [ ] **Step 3: Manueller Spawn-Test**

Via MCP-Tool `spawn_specialist` (ueber Claude Code):
1. `get_agent_capabilities()` → Pruefe ob spawning_available: true
2. `spawn_specialist(name: "test-spatz", model: "haiku", expertise: "Testing", task: "Sage Hallo", project: "synapse")`
3. Pruefe: `.synapse/agents/test-spatz/SKILL.md` existiert
4. Pruefe: `~/.synapse/sockets/test-spatz.sock` existiert
5. `specialist_status("test-spatz")` → status: "running"
6. `wake_specialist("test-spatz", "Sage Hallo")` → Antwort vom Agent
7. `stop_specialist("test-spatz")` → Agent gestoppt

- [ ] **Step 4: Channel-Test**

1. `create_channel(name: "test-channel", project: "synapse", description: "Test")`
2. `join_channel(channel_name: "test-channel", agent_name: "test-spatz")`
3. `post_to_channel(channel_name: "test-channel", sender: "koordinator", content: "Hallo!")`
4. Warte 15s (Heartbeat)
5. `get_channel_feed(channel_name: "test-channel")` → Sehe Koordinator-Nachricht + Agent-Antwort

- [ ] **Step 5: Legacy-Migration testen**

1. `send_chat_message(project: "synapse", sender_id: "koordinator", content: "Test", recipient_id: "test-spatz")`
2. Pruefe: Nachricht landet in specialist_inbox (nicht chat_messages)

- [ ] **Step 6: Cleanup**

```bash
stop_specialist("test-spatz")
```

- [ ] **Step 7: Commit (falls Fixes noetig waren)**

```bash
git add -A
git commit -m "fix(agents): integration test fixes"
```

---

## Abhaengigkeiten

```
Task 1 (Package-Setup)
  ├─→ Task 2 (DB-Schema)
  ├─→ Task 3 (CLI-Erkennung)
  ├─→ Task 4 (Skills Manager)
  ├─→ Task 5 (Status Manager)
  │
  ├─→ Task 6 (Channels) ── braucht DB-Schema (Task 2)
  ├─→ Task 7 (Inbox) ── braucht DB-Schema (Task 2)
  │
  ├─→ Task 8 (Process Manager)
  ├─→ Task 9 (Prompt Builder) ── braucht Skills (Task 4)
  │
  └─→ Task 10 (Agent-Wrapper) ── braucht: 4,5,6,7,8,9
       │
       └─→ Task 11 (Heartbeat Controller) ── braucht Wrapper (Task 10)
            │
            └─→ Task 12 (MCP-Tools) ── braucht: 3,10,11
                 │
                 ├─→ Task 13 (Legacy Migration) ── braucht MCP-Tools (Task 12)
                 └─→ Task 14 (Lifecycle) ── braucht MCP-Tools (Task 12)
                      │
                      └─→ Task 15 (Integration Test) ── braucht alles
```

**Parallelisierung:**
- Nach Task 1: Tasks **2, 3, 4, 5, 8** parallel
- Nach Task 2: Tasks **6, 7** parallel
- Nach Task 4: Task **9**
- Nach Tasks 4+5+6+7+8+9: Task **10**
- Sequentiell: **10 → 11 → 12 → 13 → 14 → 15**

**Hinweise:**
- Widerspruchs-Erkennung und Freigabe-Flow (aus der Spec) sind Koordinator-Logik, nicht Code — werden ueber System-Prompts und Koordinator-Verhalten umgesetzt, nicht als eigene Tasks.
- `.synapseignore`: Pruefen ob `.synapse/agents/` bereits durch `.synapse/` ignoriert wird. Falls nicht, zur `.synapseignore` hinzufuegen.
