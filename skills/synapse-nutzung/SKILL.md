---
name: synapse-nutzung
description: >
  Koordinator-Regeln fuer Synapse MCP-Tools. Session-Management, Agenten-Dispatching,
  Suche, Wissens-Speicherung, Context-Handoff. Triggers: "synapse", "semantische suche",
  "projekt wissen speichern", "memory anlegen", "context handoff", "session wechsel".
---

# Synapse-Nutzung (Koordinator)

Regeln fuer den Koordinator. Agenten bekommen den `synapse-agent-regeln` Skill.

## 1. Session-Start (PFLICHT)

```
1. get_project_status → FileWatcher aktiv?
2. Falls "stopped" → init_projekt ausfuehren
3. register_chat_agent(id: "koordinator", project: "<projekt>", model: "claude-opus-4-6")
4. get_index_stats → Genuegend Chunks vorhanden?
5. get_chat_messages(project: "<projekt>", agent_id: "koordinator", limit: 10)
   → Letzte Nachrichten lesen (Kontext von vorheriger Session)
6. search_thoughts mit Tag "session-uebergabe" → Gibt es eine Uebergabe?
```

## 2. Suchreihenfolge (PFLICHT)

```
1. Synapse: semantic_code_search / search_by_path / search_memory
2. NUR wenn Score < 0.60 oder 0 Ergebnisse → Glob / Grep
3. NUR wenn beides scheitert → Read / manuelle Suche
```

Der Koordinator sucht NICHT selbst, er delegiert an Agenten.

## 3. Agenten dispatchen

### Worktree-Isolation — VERBOTEN

> ⛔ `isolation: "worktree"` NIEMALS verwenden wenn Synapse aktiv ist!
> Agenten arbeiten direkt im Haupt-Repo auf eigenen Branches.

### Agent spawnen (PFLICHT-Ablauf)

**VOR dem Spawnen** registriert der Koordinator den Agent in PostgreSQL:

```
1. Agent-ID waehlen (task-bezogen: "agent-pg-layer", nummeriert: "agent-1")
2. register_chat_agent(id: "<AGENT_ID>", project: "<PROJEKT>")
   → Agent ist jetzt in PostgreSQL registriert
3. Agent spawnen mit ID im Prompt (siehe Prompt-Baustein unten)
```

**Der Agent muss sich NICHT selbst registrieren** — der Koordinator hat das bereits gemacht.
Der Agent muss sich am Ende nur abmelden: `unregister_chat_agent(id: "<AGENT_ID>")`

### Prompt-Baustein (PFLICHT in jedem Agent-Prompt)

```
=== SYNAPSE AGENT-REGELN ===
Du arbeitest mit Synapse MCP-Tools. Deine agent_id ist: {AGENT_ID}
Projekt: {PROJEKT}
Du bist bereits im Chat registriert (vom Koordinator).

SCHRITT 1 (ALLERERSTE Aktion):
  get_index_stats(project: "{PROJEKT}", agent_id: "{AGENT_ID}")
  → Onboarding + Projekt-Regeln laden
  get_chat_messages(project: "{PROJEKT}", agent_id: "{AGENT_ID}", limit: 10)
  → Letzte Nachrichten lesen

SUCHE (vor jeder Code-Suche):
- IMMER zuerst Synapse MCP-Tools verwenden
- NUR wenn Score < 0.60 → Glob/Grep/Read als Fallback

KOMMUNIKATION (Agenten-Chat):
- send_chat_message(project: "{PROJEKT}", sender_id: "{AGENT_ID}", content: "...")
- Bei Problemen: DM an Koordinator (recipient_id: "koordinator")
- Polling: get_chat_messages(since: "<timestamp>")

REGELN:
- agent_id: "{AGENT_ID}" an JEDEN Synapse-Aufruf
- source: "{AGENT_ID}" bei add_thought (NIEMALS "claude-code")
- Erfolg: Chat "Task erledigt." + Task completed
- Problem: Chat-DM + add_thought mit Tag "problem"

ABMELDUNG (PFLICHT am Ende): unregister_chat_agent(id: "{AGENT_ID}")
=== ENDE AGENT-REGELN ===
```

## 4. Richtige Tool-Wahl

| Situation | Tool |
|-----------|------|
| Konzeptuelle Frage | `semantic_code_search` |
| Bekannter Dateipfad | `search_by_path` |
| Konzept + Pfad | `search_code_with_path` |
| Architektur / Regeln | `search_memory` |
| Memory + Code | `read_memory_with_code` |
| Framework-Doku | `search_tech_docs` |
| Frueherer Kontext | `search_thoughts` |
| Datei-spezifische Docs | `get_docs_for_file` (Wissens-Airbag) |

## 5. Filter-Regeln

- `file_type` IMMER setzen wenn Zielsprache bekannt (typescript, rust, python, css)
- `path_pattern` nutzen wenn Bereich bekannt (src/**/*.ts)
- `limit`: gezielt 3-5, standard 10, breit 15-20

## 6. Ergebnis-Bewertung

| Score | Bedeutung |
|-------|-----------|
| > 0.75 | Sehr relevant |
| 0.60 - 0.75 | Vermutlich relevant |
| < 0.60 | Rauschen → Query umformulieren |

## 7. Projekt-Wissen speichern

| Was | Kategorie | Name |
|-----|-----------|------|
| Coding-Standards | `rules` | `"projekt-regeln"` |
| Architektur | `architecture` | `"projekt-vision"` |
| Entscheidungen | `decision` | `"multi-tab-architektur"` |
| Plaene | `note` | `"plan-001-feature-name"` |

- Memories kurz und praegnant
- `category: "rules"` wird Agenten beim Onboarding gezeigt
- KEINE .md-Dateien — alles in Synapse Memories

## 8. Context-Handoff

Der Context-Verbrauch wird per PostToolUse-Hook ueberwacht (60% gelb, 80% rot).

### Handoff-Protokoll (2 Schritte)

**Schritt 1: Handoff-Thought (nur das Noetigste)**

```
add_thought(
  project: "<projekt>", source: "koordinator",
  content: "SESSION-HANDOFF: <Auftrag> | OFFEN: <was fehlt> | NEXT: <naechster Schritt> | BRANCH: <branch> | CHAT-SEIT: <timestamp>",
  tags: ["session-uebergabe"], agent_id: "koordinator"
)
```

CHAT-SEIT = Timestamp ab dem Chat-Nachrichten relevant sind.

**Schritt 2: Neue Session starten**

```bash
bash ~/.claude/skills/synapse-nutzung/scripts/context-handoff.sh \
  "<projekt-verzeichnis>" "<projekt-name>" "<aufgabe>"
```

### Neue Session liest:

1. `register_chat_agent(id: "koordinator", project: "<projekt>")`
2. `search_thoughts(query: "session-uebergabe")` → Handoff-Thought
3. `get_chat_messages(since: "<CHAT-SEIT>", limit: 20)` → nur relevante Nachrichten
4. Handoff-Thought loeschen
5. Arbeit fortsetzen

## 9. .synapseignore Hygiene

Gehoert NICHT in den Index:
- `docs/` (Scores hoeher als Code)
- Build-Artefakte, Lock-Files, Binaerdateien
