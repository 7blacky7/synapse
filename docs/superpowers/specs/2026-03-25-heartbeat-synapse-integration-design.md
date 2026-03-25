# Heartbeat Synapse-Integration: Autonome Task- und Korrektur-Verarbeitung

## Problem

Spezialisten reagieren aktuell nur auf Channel-Messages und Inbox-Nachrichten. Der Koordinator muss ihnen alles explizit schreiben. Dabei existieren in Synapse bereits Systeme (Memories, Thoughts, Plan-Tasks, Events), die Aufgaben und Korrekturen enthalten können — der Wrapper pollt sie nur nicht.

## Lösung

Der Wrapper prüft im Heartbeat alle Synapse-Systeme auf Items die **explizit den Agenten-Namen tragen** und noch nicht abgeschlossen sind. Items werden verarbeitet, in SKILL.md integriert und danach aufgeräumt.

## Consume-and-Integrate Pattern

```
Koordinator erstellt Item (Memory/Thought/Task/Event) mit Agent-Name
    ↓ Heartbeat erkennt: "Das ist für mich"
    ↓ Agent liest den Inhalt
    ↓ Agent integriert in SKILL.md (Fehler/Patterns) oder arbeitet Task ab
    ↓ Agent räumt auf (löscht Memory/Thought, setzt Task-Status)
    ↓ DB bleibt sauber
```

## Heartbeat-Reaktionen nach Typ

| Quelle | Erkennung | Agent-Reaktion | Aufräumen |
|--------|-----------|----------------|-----------|
| **Memory** | `tags` enthält Agent-Name | Inhalt in SKILL.md integrieren (Fehler/Patterns/Regeln) | `delete_memory` |
| **Thought** | `tags` enthält Agent-Name | Verarbeiten, ggf. antworten | `delete_thought` |
| **Plan Task** | Titel enthält Agent-Name | Task abarbeiten | `update_plan_task(status: 'done')` |
| **Event** | `scope: "agent:{name}"` | Je nach Event-Typ reagieren | `acknowledge_event` |

## SKILL.md Ziel-Sektionen

Korrekturen und Erkenntnisse landen in der SKILL.md des Agenten:

```markdown
# Regeln
- Keine Emojis in Output verwenden
- Immer TypeScript strict mode

# Fehler → Lösung
- `Cannot find module '@synapse/core'` → Import-Pfad prüfen, package.json hat @synapse/core als dependency?
- Off-by-one in Array-Iteration → forEach statt manuellem Index

# Patterns
- Bei DB-Queries immer try/catch mit spezifischer Fehlermeldung
- Channel-Posts unter 500 Zeichen halten
```

## Technische Umsetzung

### Wrapper-Erweiterung (wrapper.ts)

Neue Poll-Funktionen im Heartbeat-Zyklus, analog zu `pollChannelMessages()`:

```typescript
async function heartbeatPoll() {
  const hadChannelMessages = await pollChannelMessages()
  const hadInboxMessages = await pollInboxMessages()
  const hadSynapseItems = await pollSynapseItems()  // NEU
  await updateStatusFile()

  if (KEEP_ALIVE && !hadChannelMessages && !hadInboxMessages && !hadSynapseItems && !agentBusy) {
    await wakeAgent(keepAlivePrompt)
  }
}
```

### pollSynapseItems() — Gebündelte Abfrage

Eine Funktion die alle vier Quellen prüft und einen Wake-Prompt baut:

```typescript
async function pollSynapseItems(): Promise<boolean> {
  if (agentBusy) return false

  const items: string[] = []

  // 1. Memories mit Agent-Tag
  const memories = await listMemories(PROJECT)
  const myMemories = memories.filter(m => m.tags?.includes(AGENT_NAME))
  for (const m of myMemories) {
    items.push(`[MEMORY] "${m.name}": ${m.content}`)
  }

  // 2. Thoughts mit Agent-Tag
  const thoughts = await getThoughtsByTag(PROJECT, AGENT_NAME)
  for (const t of thoughts) {
    items.push(`[THOUGHT] ${t.content}`)
  }

  // 3. Plan Tasks mit Agent-Name im Titel
  const plan = await getPlan(PROJECT)
  if (plan?.tasks) {
    const myTasks = plan.tasks.filter(t =>
      t.title.toLowerCase().includes(AGENT_NAME.toLowerCase()) &&
      (t.status === 'todo' || t.status === 'in_progress')
    )
    for (const t of myTasks) {
      items.push(`[TASK] "${t.title}" (${t.status}): ${t.description}`)
    }
  }

  // 4. Pending Events
  const events = await getPendingEvents(PROJECT, AGENT_NAME)
  for (const e of events) {
    items.push(`[EVENT:${e.event_type}] ${e.payload}`)
  }

  if (items.length === 0) return false

  const prompt = buildSynapseWakePrompt(items)
  await wakeAgent(prompt)
  return true
}
```

### Wake-Prompt für Synapse-Items

```typescript
function buildSynapseWakePrompt(items: string[]): string {
  return `SYNAPSE-ITEMS für dich (${items.length} offen):

${items.join('\n\n')}

REAKTION (PFLICHT):
- [MEMORY] → Inhalt in SKILL.md integrieren (update_specialist_skill), dann delete_memory
- [THOUGHT] → Verarbeiten/antworten, dann delete_thought
- [TASK] → Abarbeiten, dann update_plan_task(status: 'done')
- [EVENT] → Je nach Typ reagieren, dann acknowledge_event

Arbeite diese Items jetzt ab.`
}
```

### Imports (wrapper.ts)

Benötigte Core-Services die bereits in `@synapse/core` existieren:

```typescript
import { listMemories } from '@synapse/core/services/memory'
import { getThoughtsByTag } from '@synapse/core/services/thoughts'
import { getPlan } from '@synapse/core/services/plans'
import { getPendingEvents } from '@synapse/core/services/events'
```

### Kein Watermark nötig

Anders als Channel/Inbox brauchen Synapse-Items kein Watermark-Tracking:
- **Memories/Thoughts** werden nach Verarbeitung gelöscht → tauchen nicht wieder auf
- **Tasks** werden auf `done` gesetzt → Filter greift nicht mehr
- **Events** werden acknowledged → `getPendingEvents` liefert sie nicht mehr

## Beispiel-Flows

### Flow 1: Programmier-Korrektur

```
Koordinator: write_memory(
  name: "fix-witz-spatz-emoji",
  tags: ["witz-spatz"],
  category: "note",
  content: "FEHLER: Du verwendest Emojis in Witzen. LÖSUNG: Nur Text, keine Emojis."
)

→ Heartbeat erkennt Memory mit Tag "witz-spatz"
→ Agent wacht auf mit: [MEMORY] "fix-witz-spatz-emoji": FEHLER: Du verwendest...
→ Agent: update_specialist_skill(section: "fehler", action: "add",
    content: "Emojis in Witzen → Nur Text, keine Emojis verwenden")
→ Agent: delete_memory(name: "fix-witz-spatz-emoji")
```

### Flow 2: Aufgabe zuweisen

```
Koordinator: add_plan_task(
  title: "code-spatz: API-Endpoint /health implementieren",
  description: "GET /health soll {status: 'ok', uptime: ...} zurückgeben",
  priority: "high"
)

→ Heartbeat erkennt Task mit "code-spatz" im Titel
→ Agent wacht auf mit: [TASK] "code-spatz: API-Endpoint /health..." (todo)
→ Agent arbeitet Task ab
→ Agent: update_plan_task(taskId, status: 'done')
```

### Flow 3: Pattern-Erkennung teilen

```
Koordinator: add_thought(
  source: "koordinator",
  tags: ["code-spatz"],
  content: "PATTERN: Bei allen DB-Services immer getPool().connect() mit try/finally release() verwenden"
)

→ Heartbeat erkennt Thought mit Tag "code-spatz"
→ Agent: update_specialist_skill(section: "patterns", action: "add",
    content: "DB-Services: getPool().connect() mit try/finally release()")
→ Agent: delete_thought(id: ...)
```

## Dateien die geändert werden

| Datei | Änderung |
|-------|----------|
| `packages/agents/src/wrapper.ts` | `pollSynapseItems()` + `buildSynapseWakePrompt()` hinzufügen, in `heartbeatPoll()` einbinden |
| `packages/agents/src/prompts.ts` | System-Prompt erweitern: Agent muss SKILL.md-Integration und Aufräumen kennen |
| `packages/agents/package.json` | Ggf. Core-Service-Imports prüfen (sollte bereits dependency sein) |

## Nicht betroffen

- Kein neues DB-Schema
- Keine neuen MCP-Tools
- Keine Änderungen an `@synapse/core`
- Keine Änderungen am MCP-Server
