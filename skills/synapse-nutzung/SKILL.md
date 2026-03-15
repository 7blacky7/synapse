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

## 3. Chat-Pflicht (WENN Agenten aktiv)

Der PostToolUse-Hook zeigt ungelesene Nachrichten nach jedem Tool-Call:
```
📨 Chat: 3 Broadcasts, 2 DMs von agent-1, agent-2 ungelesen
```

**WENN diese Notification erscheint → SOFORT reagieren:**
1. `get_chat_messages(project, agent_id: "koordinator")` — Nachrichten lesen
2. Auf JEDE DM antworten per `send_chat_message(recipient_id: "<sender>")`
3. Bei "Wissensluecke:" → Docs-Kurator dispatchen (siehe §4)
4. Bei Problemen → Hilfestellung oder neuen Task dispatchen

**Solange Agenten registriert sind, bleibt der Koordinator im Chat aktiv.**
Nicht ignorieren, nicht aufschieben — Agenten warten auf Antworten.

## 4. Agenten dispatchen

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

VOR JEDER DATEI-BEARBEITUNG (PFLICHT):
- BEVOR du eine Datei mit Edit/Write aenderst:
  get_docs_for_file(file_path: "<datei>", agent_id: "{AGENT_ID}", project: "{PROJEKT}")
  → Zeigt Breaking Changes, Migration-Warnungen und Gotchas fuer relevante Frameworks
  → Wenn Warnings kommen: LIES SIE und beruecksichtige sie in deinen Aenderungen
  → Ignoriere diese Warnungen NICHT — sie verhindern Fehler die du nicht kennst

WISSENSLUECKEN (Cutoff-Handling):
- Wenn Technologie/Version jenseits deines Cutoffs liegt:
  1. search_tech_docs(query: "[Frage]", framework: "[tech]", project: "{PROJEKT}")
     → Hat Context7 Auto-Fetch, liefert Basis-Docs automatisch
  2. Bei Treffern (Score > 0.60): Docs nutzen, weiterarbeiten
  3. Wenn kuratiertes Wissen fehlt (Breaking Changes, Migration, Gotchas):
     Chat-DM an Koordinator: "Wissensluecke: [Tech] v[Version]. Brauche: [was genau fehlt]"
  4. NICHT selbst recherchieren (kein Context7, keine Web-Suche, keine externen Skills)
  5. NICHT blockieren — mit bestem Wissen weiterarbeiten, TODO-Kommentar setzen
  6. Arbeite weiter — unreadChat im naechsten Tool-Response zeigt dir wenn Antwort da ist
  7. Koordinator dispatcht Docs-Kurator, indexiert kuratierte Docs
  8. Danach: search_tech_docs(source: "research") fuer Breaking Changes etc.

ABMELDUNG (PFLICHT am Ende): unregister_chat_agent(id: "{AGENT_ID}")
=== ENDE AGENT-REGELN ===
```

## 5. Wissensluecke-Reaktion (AUTOMATISCH)

Wenn ein Agent eine DM mit "Wissensluecke:" schickt → SOFORT reagieren:

### Schritt 1: Agent informieren
```
send_chat_message(recipient_id: "<agent-id>",
  content: "Docs werden recherchiert und indexiert, ~5min. Arbeite weiter.")
```

### Schritt 2: Docs-Kurator dispatchen (Opus)
```
register_chat_agent(id: "docs-kurator", model: "claude-opus-4-6")
```

Prompt-Kern fuer den Docs-Kurator:
```
DEINE AUFGABE — DOCS-KURATOR fuer {FRAMEWORK} {VERSION}:
Agent "{AGENT_ID}" braucht kuratiertes Wissen.

1. CONTEXT7 PRUEFEN:
   search_tech_docs(framework: "{FRAMEWORK}", project: "{PROJEKT}")
   → Bewerten: Deckt das Breaking Changes ab? Meist nur Code-Beispiele.

2. UMFASSEND RECHERCHIEREN — alle verfuegbaren Quellen:
   - WebSearch: "{FRAMEWORK} {VERSION} breaking changes migration guide"
   - WebSearch: "{FRAMEWORK} {VERSION} release notes changelog"
   - WebSearch: "{FRAMEWORK} {VERSION} known issues gotchas"
   - GitHub: Releases, MIGRATION.md, Issues mit "breaking" Label
   - Offizielle Docs: Migration Guides, Upgrade Guides
   - Community: Stack Overflow, Reddit, Blog-Posts
   - WebFetch auf die besten Treffer fuer den vollen Content
   DU entscheidest was wichtig ist und was nicht.

3. KURATIEREN + INDEXIEREN — fuer jedes relevante Thema:
   add_tech_doc(
     framework: "{FRAMEWORK}", version: "{VERSION}",
     section: "<Aussagekraeftiger Titel>",
     content: "<Max 2000 Zeichen. Code Vorher/Nachher. Quelle angeben.>",
     type: "<breaking-change|migration|gotcha|known-issue>",
     source: "research", project: "{PROJEKT}"
   )

4. QUALITAET:
   - Mindestens 5 Docs, alle konkret und actionable
   - Undokumentierte Gotchas (aus GitHub Issues) besonders wertvoll
   - Lieber 2 kleine Docs als 1 riesiger
   - search_tech_docs am Ende → genuegend research-Docs?

5. ABSCHLUSS:
   Chat-Broadcast: "{FRAMEWORK} {VERSION} Docs kuratiert: X Breaking Changes,
   Y Migration-Guides, Z Gotchas. search_tech_docs(framework: '{FRAMEWORK}',
   source: 'research') fuer Details."
```

### Warum Opus?
Opus entscheidet selbst welche Quellen relevant sind, bewertet Qualitaet,
erkennt undokumentierte Probleme in GitHub Issues und filtert Rauschen raus.
Haiku/Sonnet koennen das nicht zuverlaessig.

## 6. Richtige Tool-Wahl

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

## 7. Filter-Regeln

- `file_type` IMMER setzen wenn Zielsprache bekannt (typescript, rust, python, css)
- `path_pattern` nutzen wenn Bereich bekannt (src/**/*.ts)
- `limit`: gezielt 3-5, standard 10, breit 15-20

## 8. Ergebnis-Bewertung

| Score | Bedeutung |
|-------|-----------|
| > 0.75 | Sehr relevant |
| 0.60 - 0.75 | Vermutlich relevant |
| < 0.60 | Rauschen → Query umformulieren |

## 9. Projekt-Wissen speichern

| Was | Kategorie | Name |
|-----|-----------|------|
| Coding-Standards | `rules` | `"projekt-regeln"` |
| Architektur | `architecture` | `"projekt-vision"` |
| Entscheidungen | `decision` | `"multi-tab-architektur"` |
| Plaene | `note` | `"plan-001-feature-name"` |

- Memories kurz und praegnant
- `category: "rules"` wird Agenten beim Onboarding gezeigt
- KEINE .md-Dateien — alles in Synapse Memories

## 10. Context-Handoff

Der Context-Verbrauch wird per PostToolUse-Hook ueberwacht (95% gelb, 98% rot).

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

## 11. .synapseignore Hygiene

Gehoert NICHT in den Index:
- `docs/` (Scores hoeher als Code)
- Build-Artefakte, Lock-Files, Binaerdateien
