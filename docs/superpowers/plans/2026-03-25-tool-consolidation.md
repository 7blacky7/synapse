# MCP Tool-Konsolidierung: 68 → 12 Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 68 einzelne MCP-Tools zu ~12 konsolidierten Tools zusammenfuehren, wobei jedes Tool einen `action`-Parameter bekommt der die Sub-Aktion bestimmt.

**Architecture:** Jedes konsolidierte Tool hat ein `action`-Enum als Pflichtparameter. Der Switch in `server.ts` dispatcht anhand von `action` statt anhand des Tool-Namens. Die bestehenden Backend-Funktionen in `tools/*.ts` bleiben unveraendert — nur die MCP-Schicht (Registrierung + Dispatching) wird refaktoriert.

**Tech Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), bestehende `tools/*.ts` Module

---

## Konsolidierungsplan

| Neues Tool | Alte Tools | Actions |
|------------|-----------|---------|
| `project` | init_projekt, complete_setup, detect_technologies, cleanup_projekt, stop_projekt, get_project_status, list_active_projects | init, complete_setup, detect_tech, cleanup, stop, status, list |
| `stats` | get_index_stats, get_detailed_stats | index, detailed |
| `search` | semantic_code_search, search_by_path, search_code_with_path, search_memory, search_thoughts, search_proposals, search_tech_docs, search_media | code, path, code_with_path, memory, thoughts, proposals, tech_docs, media |
| `memory` | write_memory, read_memory, read_memory_with_code, list_memories, delete_memory, update_memory, find_memories_for_file | write, read, read_with_code, list, delete, update, find_for_file |
| `thought` | add_thought, get_thoughts, delete_thought, update_thought | add, get, delete, update |
| `proposal` | list_proposals, get_proposal, update_proposal_status, delete_proposal, update_proposal | list, get, update_status, delete, update |
| `plan` | get_project_plan, update_project_plan, add_plan_task | get, update, add_task |
| `chat` | register_chat_agent, unregister_chat_agent, register_chat_agents_batch, unregister_chat_agents_batch, send_chat_message, get_chat_messages, list_chat_agents, post_to_inbox, check_inbox | register, unregister, register_batch, unregister_batch, send, get, list, inbox_send, inbox_check |
| `channel` | create_channel, join_channel, leave_channel, post_to_channel, get_channel_feed, list_channels | create, join, leave, post, feed, list |
| `event` | emit_event, acknowledge_event, get_pending_events | emit, ack, pending |
| `specialist` | spawn_specialist, stop_specialist, specialist_status, wake_specialist, update_specialist_skill, get_agent_capabilities | spawn, stop, status, wake, update_skill, capabilities |
| `docs` | add_tech_doc, search_tech_docs, get_docs_for_file | add, search, get_for_file |
| `idea` | save_project_idea, confirm_idea | save, confirm |
| `admin` | migrate_embeddings, restore_backup | migrate, restore |
| `media` | index_media, search_media | index, search |

**Hinweis:** `search` wird ein Super-Tool das ALLE semantischen Suchen buendelt. `search_media` geht in `search(action: "media")`, aber `index_media` geht in `media(action: "index")`. Alternativ: `media` komplett in `search` + `admin` aufloesen. Entscheidung bei Implementierung.

**Vereinfachung:** `media` und `idea` haben nur 2 Actions — sie koennten in `admin` bzw. `project` aufgehen. Das wuerde auf **12 Tools** statt 15 reduzieren.

---

## Datei-Struktur

### Neue Dateien

- `packages/mcp-server/src/tools/consolidated/project.ts` — Tool-Definition + Dispatcher fuer project
- `packages/mcp-server/src/tools/consolidated/search.ts` — Tool-Definition + Dispatcher fuer search
- `packages/mcp-server/src/tools/consolidated/memory.ts` — Tool-Definition + Dispatcher fuer memory
- `packages/mcp-server/src/tools/consolidated/thought.ts` — Tool-Definition + Dispatcher fuer thought
- `packages/mcp-server/src/tools/consolidated/proposal.ts` — Tool-Definition + Dispatcher fuer proposal
- `packages/mcp-server/src/tools/consolidated/plan.ts` — Tool-Definition + Dispatcher fuer plan
- `packages/mcp-server/src/tools/consolidated/chat.ts` — Tool-Definition + Dispatcher fuer chat
- `packages/mcp-server/src/tools/consolidated/channel.ts` — Tool-Definition + Dispatcher fuer channel
- `packages/mcp-server/src/tools/consolidated/event.ts` — Tool-Definition + Dispatcher fuer event
- `packages/mcp-server/src/tools/consolidated/specialist.ts` — Tool-Definition + Dispatcher fuer specialist
- `packages/mcp-server/src/tools/consolidated/docs.ts` — Tool-Definition + Dispatcher fuer docs
- `packages/mcp-server/src/tools/consolidated/admin.ts` — Tool-Definition + Dispatcher fuer admin (inkl. idea, media, stats)
- `packages/mcp-server/src/tools/consolidated/index.ts` — Re-export aller konsolidierten Tools
- `packages/mcp-server/src/tools/consolidated/types.ts` — Gemeinsame Types (ToolDefinition, ToolHandler)

### Zu aendernde Dateien

- `packages/mcp-server/src/server.ts` — ListToolsRequest + CallToolRequest auf konsolidierte Tools umstellen
- `packages/mcp-server/src/tools/index.ts` — Neuen consolidated/index.ts re-exportieren

### Unveraendert (Backend-Logik)

- `packages/mcp-server/src/tools/chat.ts`
- `packages/mcp-server/src/tools/events.ts`
- `packages/mcp-server/src/tools/ideas.ts`
- `packages/mcp-server/src/tools/init.ts`
- `packages/mcp-server/src/tools/memory.ts`
- `packages/mcp-server/src/tools/migration.ts`
- `packages/mcp-server/src/tools/onboarding.ts`
- `packages/mcp-server/src/tools/plans.ts`
- `packages/mcp-server/src/tools/proposals.ts`
- `packages/mcp-server/src/tools/search.ts`
- `packages/mcp-server/src/tools/setup.ts`
- `packages/mcp-server/src/tools/specialists.ts`
- `packages/mcp-server/src/tools/stats.ts`
- `packages/mcp-server/src/tools/tech-docs.ts`
- `packages/mcp-server/src/tools/tech.ts`
- `packages/mcp-server/src/tools/thoughts.ts`

---

## Task 1: Konsolidierungs-Framework (types.ts + index.ts)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/types.ts`
- Create: `packages/mcp-server/src/tools/consolidated/index.ts`

- [ ] **Step 1: types.ts erstellen**

```typescript
// types.ts — Gemeinsame Types fuer konsolidierte Tools
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ConsolidatedTool {
  definition: Tool;
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
```

- [ ] **Step 2: Leere index.ts erstellen**

```typescript
// index.ts — Re-export aller konsolidierten Tools
// Wird pro Task gefuellt
export { projectTool } from './project.js';
// ... weitere folgen
```

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/tools/consolidated/
git commit -m "refactor(mcp-server): scaffold consolidated tools framework"
```

---

## Task 2: `project` Tool (7 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/project.ts`

Konsolidiert: init_projekt, complete_setup, detect_technologies, cleanup_projekt, stop_projekt, get_project_status, list_active_projects

- [ ] **Step 1: project.ts Schema definieren**

```typescript
import type { ConsolidatedTool } from './types.js';
import {
  initProjekt, stopProjekt, listActiveProjects, cleanupProjekt,
  getProjectStatusWithStats, detectProjectTechnologies,
} from '../index.js';
import { completeSetupTool } from '../index.js';

export const projectTool: ConsolidatedTool = {
  definition: {
    name: 'project',
    description: 'Projekt-Management: init, stop, cleanup, status, list, detect_tech, complete_setup',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'stop', 'cleanup', 'status', 'list', 'detect_tech', 'complete_setup'],
          description: 'Aktion: init (Projekt starten), stop, cleanup (.synapseignore), status, list (alle Projekte), detect_tech, complete_setup',
        },
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner (fuer init, cleanup, detect_tech, status)' },
        name: { type: 'string', description: 'Projekt-Name (optional bei init, pflicht bei cleanup)' },
        agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
        index_docs: { type: 'boolean', description: 'Framework-Doku vorladen (nur bei init, Standard: true)' },
        phase: { type: 'string', enum: ['initial', 'post-indexing'], description: 'Setup-Phase (nur bei complete_setup)' },
        project: { type: 'string', description: 'Projekt-Name (fuer complete_setup)' },
      },
      required: ['action'],
    },
  },
  handler: async (args) => {
    const action = args.action as string;
    switch (action) {
      case 'init':
        return await initProjekt(/* params from args */);
      case 'stop':
        return await stopProjekt(/* params */);
      // ... alle Actions
      default:
        return { success: false, message: `Unbekannte action: ${action}` };
    }
  },
};
```

- [ ] **Step 2: Handler mit korrekten Parametern implementieren**

Jeden Case mit den exakt gleichen Parametern wie der alte einzelne Tool-Handler befuellen. Die Parameter-Extraktion aus `args` muss identisch sein zu den bestehenden Cases in server.ts (Zeilen 1626-1733).

- [ ] **Step 3: In index.ts exportieren**

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 7 Projekt-Tools zu project(action)"
```

---

## Task 3: `search` Tool (8 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/search.ts`

Konsolidiert: semantic_code_search, search_by_path, search_code_with_path, search_memory, search_thoughts, search_proposals, search_tech_docs, search_media

- [ ] **Step 1: search.ts Schema definieren**

Actions: code, path, code_with_path, memory, thoughts, proposals, tech_docs, media

Gemeinsame Parameter: query, project, limit, agent_id
Action-spezifische Parameter: file_type, path_pattern, framework, source, scope, category

- [ ] **Step 2: Handler implementieren**

Jeden Case aus server.ts (Zeilen 1733-1785) uebernehmen.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 8 Such-Tools zu search(action)"
```

---

## Task 4: `memory` Tool (7 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/memory.ts`

Konsolidiert: write_memory, read_memory, read_memory_with_code, list_memories, delete_memory, update_memory, find_memories_for_file

- [ ] **Step 1: memory.ts Schema + Handler**

Actions: write, read, read_with_code, list, delete, update, find_for_file

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 7 Memory-Tools zu memory(action)"
```

---

## Task 5: `thought` Tool (4 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/thought.ts`

Konsolidiert: add_thought, get_thoughts, delete_thought, update_thought

- [ ] **Step 1: thought.ts Schema + Handler**

Actions: add, get, delete, update

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 4 Thought-Tools zu thought(action)"
```

---

## Task 6: `proposal` Tool (5 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/proposal.ts`

Konsolidiert: list_proposals, get_proposal, update_proposal_status, delete_proposal, update_proposal

- [ ] **Step 1: proposal.ts Schema + Handler**

Actions: list, get, update_status, delete, update

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 5 Proposal-Tools zu proposal(action)"
```

---

## Task 7: `plan` Tool (3 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/plan.ts`

Konsolidiert: get_project_plan, update_project_plan, add_plan_task

- [ ] **Step 1: plan.ts Schema + Handler**

Actions: get, update, add_task

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 3 Plan-Tools zu plan(action)"
```

---

## Task 8: `chat` Tool (9 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/chat.ts`

Konsolidiert: register_chat_agent, unregister_chat_agent, register_chat_agents_batch, unregister_chat_agents_batch, send_chat_message, get_chat_messages, list_chat_agents, post_to_inbox, check_inbox

- [ ] **Step 1: chat.ts Schema + Handler**

Actions: register, unregister, register_batch, unregister_batch, send, get, list, inbox_send, inbox_check

**WICHTIG:** Die `get`-Action hat Sonder-Logik (lastChatRead Tracking, server.ts:2064-2105). Diese muss in den Handler uebernommen werden, nicht nur die Backend-Funktion.

- [ ] **Step 2: lastChatRead Tracking aus server.ts extrahieren**

Das Map `lastChatRead` und die Tracking-Logik muss in chat.ts wandern (oder als Dependency injected werden).

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 9 Chat-Tools zu chat(action)"
```

---

## Task 9: `channel` Tool (6 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/channel.ts`

Konsolidiert: create_channel, join_channel, leave_channel, post_to_channel, get_channel_feed, list_channels

- [ ] **Step 1: channel.ts Schema + Handler**

Actions: create, join, leave, post, feed, list

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 6 Channel-Tools zu channel(action)"
```

---

## Task 10: `event` Tool (3 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/event.ts`

Konsolidiert: emit_event, acknowledge_event, get_pending_events

- [ ] **Step 1: event.ts Schema + Handler**

Actions: emit, ack, pending

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 3 Event-Tools zu event(action)"
```

---

## Task 11: `specialist` Tool (6 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/specialist.ts`

Konsolidiert: spawn_specialist, stop_specialist, specialist_status, wake_specialist, update_specialist_skill, get_agent_capabilities

- [ ] **Step 1: specialist.ts Schema + Handler**

Actions: spawn, stop, status, wake, update_skill, capabilities

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 6 Specialist-Tools zu specialist(action)"
```

---

## Task 12: `docs` Tool (3 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/docs.ts`

Konsolidiert: add_tech_doc, search_tech_docs, get_docs_for_file

- [ ] **Step 1: docs.ts Schema + Handler**

Actions: add, search, get_for_file

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere 3 Docs-Tools zu docs(action)"
```

---

## Task 13: `admin` Tool (6 alte Tools → 1)

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/admin.ts`

Konsolidiert: migrate_embeddings, restore_backup, save_project_idea, confirm_idea, index_media, get_index_stats, get_detailed_stats

- [ ] **Step 1: admin.ts Schema + Handler**

Actions: migrate, restore, save_idea, confirm_idea, index_media, index_stats, detailed_stats

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp-server): konsolidiere Admin/Idea/Media/Stats zu admin(action)"
```

---

## Task 14: server.ts umstellen

**Files:**
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/src/tools/index.ts`

- [ ] **Step 1: Imports in server.ts auf consolidated/index.ts umstellen**

Alte Einzel-Imports entfernen, neue konsolidierte Tools importieren.

- [ ] **Step 2: ListToolsRequest umstellen**

Statt 68 einzelne Tool-Definitionen → Array von 12 `.definition` Objekten.

- [ ] **Step 3: CallToolRequest Switch umstellen**

Statt 68 Cases → 12 Cases die `tool.handler(args)` aufrufen.

```typescript
case 'project': return withOnboarding(await projectTool.handler(args));
case 'search':  return withOnboarding(await searchTool.handler(args));
// ...
```

- [ ] **Step 4: withOnboarding + lastChatRead + eventIgnoreCount beibehalten**

Diese server-seitige Logik (Zeilen 96-168, 1528-1620) muss bestehen bleiben und korrekt an die neuen Handlers angebunden werden. `withOnboarding` braucht weiterhin `agentId` und `projectName` aus den Tool-Args.

- [ ] **Step 5: Alte Einzel-Tool-Definitionen entfernen**

Die gesamte alte Tool-Liste (Zeilen 188-1516) und den alten Switch (Zeilen 1626-2400) entfernen.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(mcp-server): server.ts auf 12 konsolidierte Tools umstellen"
```

---

## Task 15: Build + Manueller Test

- [ ] **Step 1: TypeScript Build**

```bash
cd /home/blacky/dev/synapse && pnpm build
```

Erwartung: Keine Fehler.

- [ ] **Step 2: MCP Server starten und Tool-Liste pruefen**

Verifizieren dass genau 12 Tools registriert sind statt 68.

- [ ] **Step 3: Basis-Funktionstest**

```
search(action: "code", query: "heartbeat", project: "synapse")
memory(action: "list", project: "synapse")
chat(action: "list", project: "synapse")
specialist(action: "status", project_path: "/home/blacky/dev/synapse")
```

- [ ] **Step 4: Commit (falls Fixes noetig)**

```bash
git commit -m "fix(mcp-server): tool-konsolidierung build-fixes"
```

---

## Task 16: Skills + Hooks anpassen

**Files:**
- Modify: `~/.claude/skills/synapse-nutzung/SKILL.md`
- Modify: `~/.claude/skills/synapse-agent-regeln/SKILL.md`
- Modify: Hooks die alte Tool-Namen referenzieren

- [ ] **Step 1: synapse-nutzung Skill aktualisieren**

Tool-Referenzen von alten Namen auf neue `tool(action)` Syntax umstellen.
z.B. `semantic_code_search` → `search(action: "code")`

- [ ] **Step 2: synapse-agent-regeln Skill aktualisieren**

Agent-Prompt-Baustein mit neuen Tool-Namen.

- [ ] **Step 3: Hooks pruefen**

chat-notify.sh, context-counter.sh — pruefen ob sie Tool-Namen matchen.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(skills): tool-namen auf konsolidierte syntax aktualisieren"
```

---

## Task 17: FileWatcher als eigenstaendigen Daemon extrahieren

**Files:**
- Create: `packages/mcp-server/src/watcher-daemon.ts` — Eigenstaendiger Prozess mit PID-File + Unix-Socket
- Modify: `packages/mcp-server/src/tools/init.ts` — Watcher nicht mehr inline starten, sondern Daemon pruefen
- Modify: `packages/mcp-server/package.json` — `watcher-daemon` als eigenes Binary/Script

### Problem

Der FileWatcher laeuft in-memory im MCP-Server-Prozess (`activeWatchers` Map). Bei jedem MCP-Neustart (= jede neue Claude-Session) wird er neu gestartet. Das triggert chokidar `add`-Events fuer alle Dateien → Re-Indexierung → Embedding-API-Kosten.

### Loesung

FileWatcher als eigenstaendiger Daemon-Prozess:
- Eigene PID-Datei: `.synapse/watcher.pid`
- Unix-Socket: `.synapse/sockets/watcher.sock` (fuer Status/Stop-Kommandos)
- `init_projekt` prueft nur ob Daemon laeuft, startet ihn NUR wenn nicht aktiv
- Daemon ueberlebt MCP-Server-Neustarts (wie Specialist-Wrapper: `detached: true, unref()`)

- [ ] **Step 1: watcher-daemon.ts Grundgeruest**

```typescript
// watcher-daemon.ts — Eigenstaendiger FileWatcher-Daemon
// Gestartet via: node watcher-daemon.js <projectPath> <projectName>
// Kommunikation: Unix-Socket fuer Status/Stop
// PID-File: .synapse/watcher.pid

import { startFileWatcher } from '@synapse/core';
import { createServer as createSocketServer } from 'node:net';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const projectPath = process.env.SYNAPSE_WATCHER_PROJECT_PATH!;
const projectName = process.env.SYNAPSE_WATCHER_PROJECT_NAME!;
const socketPath = join(projectPath, '.synapse/sockets/watcher.sock');
const pidFile = join(projectPath, '.synapse/watcher.pid');

// PID-File schreiben
writeFileSync(pidFile, String(process.pid));

// FileWatcher starten (einmalig, ueberlebt MCP-Restarts)
const watcher = startFileWatcher({
  projectPath,
  projectName,
  onFileChange: handleFileEvent,
  onError: (err) => console.error('[Watcher-Daemon] Error:', err),
  onIgnoreChange: async () => { /* cleanup */ },
});

// Socket-Server fuer Steuerung (status, stop)
const socketServer = createSocketServer((client) => {
  client.on('data', (data) => {
    const cmd = JSON.parse(data.toString());
    switch (cmd.action) {
      case 'status':
        client.write(JSON.stringify({ running: true, pid: process.pid, project: projectName }));
        break;
      case 'stop':
        client.write(JSON.stringify({ stopped: true }));
        cleanup();
        break;
    }
    client.end();
  });
});
socketServer.listen(socketPath);

function cleanup() {
  watcher.close();
  socketServer.close();
  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(socketPath); } catch {}
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
```

- [ ] **Step 2: init.ts anpassen — Daemon statt Inline-Watcher**

```typescript
// Statt:
//   const watcher = startFileWatcher({...});
//   activeWatchers.set(name, watcher);
// Neu:
//   if (isWatcherDaemonRunning(projectPath)) → skip
//   else → spawnWatcherDaemon(projectPath, name)

async function isWatcherDaemonRunning(projectPath: string): Promise<boolean> {
  const pidFile = join(projectPath, '.synapse/watcher.pid');
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
    process.kill(pid, 0); // Prueft ob Prozess lebt
    return true;
  } catch {
    return false;
  }
}

function spawnWatcherDaemon(projectPath: string, projectName: string) {
  const daemon = spawn('node', [watcherDaemonPath], {
    env: {
      ...process.env,
      SYNAPSE_WATCHER_PROJECT_PATH: projectPath,
      SYNAPSE_WATCHER_PROJECT_NAME: projectName,
    },
    detached: true,
    stdio: 'ignore',
  });
  daemon.unref();
}
```

- [ ] **Step 3: activeWatchers Map entfernen**

Die In-Memory Map `activeWatchers` wird nicht mehr gebraucht. Stattdessen prueft `isWatcherDaemonRunning()` das PID-File.

- [ ] **Step 4: handleFileEvent muss vom Daemon aus erreichbar sein**

Die `handleFileEvent`-Funktion braucht Zugriff auf Qdrant/PostgreSQL fuer die Indexierung. Der Daemon muss die gleichen DB-Connections nutzen wie der MCP-Server. Pruefen ob `@synapse/core` direkt importiert werden kann.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(mcp-server): FileWatcher als eigenstaendigen Daemon extrahieren"
```

---

## Task 18: `watcher` in konsolidiertes Tool integrieren

**Files:**
- Create: `packages/mcp-server/src/tools/consolidated/watcher.ts`
- Modify: `packages/mcp-server/src/tools/consolidated/index.ts`

Das `watcher`-Tool erlaubt manuelle Steuerung des FileWatcher-Daemons.

- [ ] **Step 1: watcher.ts Schema + Handler**

```typescript
export const watcherTool: ConsolidatedTool = {
  definition: {
    name: 'watcher',
    description: 'FileWatcher-Daemon steuern: status, start, stop',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop'],
          description: 'status: Laeuft der Watcher? start: Starten falls nicht aktiv. stop: Stoppen.',
        },
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        name: { type: 'string', description: 'Projekt-Name' },
      },
      required: ['action', 'path'],
    },
  },
  handler: async (args) => {
    switch (args.action) {
      case 'status':
        // PID-File pruefen + Socket-Status abfragen
        break;
      case 'start':
        // spawnWatcherDaemon() falls nicht laeuft
        break;
      case 'stop':
        // Stop-Kommando ueber Socket senden
        break;
    }
  },
};
```

- [ ] **Step 2: In index.ts + server.ts registrieren**

- [ ] **Step 3: project(action: "init") anpassen**

`init_projekt` nutzt jetzt intern `watcher(action: "start")` Logik — startet Daemon nur wenn nicht bereits aktiv.

- [ ] **Step 4: project(action: "stop") anpassen**

`stop_projekt` stoppt auch den Watcher-Daemon (oder laesst ihn optional laufen).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(mcp-server): watcher-Tool fuer FileWatcher-Daemon-Steuerung"
```

---

## Risiken & Mitigationen

| Risiko | Mitigation |
|--------|-----------|
| Breaking Change fuer laufende Agenten | Alle Agenten stoppen vor Deployment, Skills vorher aktualisieren |
| withOnboarding verliert agent_id/project Context | agent_id und project als Top-Level-Parameter in JEDEM konsolidierten Tool beibehalten |
| lastChatRead State-Management | Map bleibt in server.ts, wird per Closure an chat-Handler uebergeben |
| Hooks matchen auf alte Tool-Namen | PostToolUse matcher `.*` matcht alles — kein Problem. PreToolUse pruefen. |
| Skill-DB (Qdrant) referenziert alte Tool-Namen | Skill-Chunks aktualisieren nach Deployment |
| Agent-Prompt-Baustein referenziert alte Tool-Namen | synapse-nutzung + synapse-agent-regeln Skills aktualisieren (Task 16). Alle Tool-Referenzen: get_docs_for_file → docs(action: "get_for_file"), send_chat_message → chat(action: "send"), etc. |
| withOnboarding muss bei allen konsolidierten Tools greifen | Jedes konsolidierte Tool muss agent_id + project als Parameter akzeptieren. withOnboarding in server.ts wrapping beibehalten (Task 14 Step 4) |
| PreToolUse/PostToolUse Hooks | KEIN Risiko — Hooks matchen auf Claude-Native-Tools (Read, Edit, Write), nicht auf MCP-Tool-Namen |
| FileWatcher-Daemon braucht DB-Zugriff | Daemon importiert @synapse/core direkt fuer Qdrant/PG Zugriff. Gleiche ENV-Vars wie MCP-Server (Task 17 Step 4) |

---

## Ergebnis

| Metrik | Vorher | Nachher |
|--------|--------|---------|
| Anzahl Tools | 68 | 13 (inkl. watcher) |
| server.ts Zeilen (geschaetzt) | 2453 | ~800 |
| Tool-Definitionen | 1330 Zeilen | ~400 Zeilen |
| Switch-Cases | 68 | 12 |
| Backend-Logik | unveraendert | unveraendert |
