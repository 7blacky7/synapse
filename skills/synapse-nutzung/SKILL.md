---
name: synapse-nutzung
description: >
  Use when working with Synapse MCP tools (semantic_code_search, search_by_path,
  search_memory, search_thoughts, etc.). Use when starting a session with Synapse,
  when search results are poor quality, when coordinating agents with Synapse,
  when storing project knowledge, or when context window is getting full and needs
  session handoff. Triggers: "synapse", "semantische suche", "agent benennung",
  "projekt wissen speichern", "memory anlegen", "context handoff", "session wechsel".
---

# Synapse-Nutzung

Korrekte Nutzung der Synapse MCP-Tools fuer hochwertige Suchergebnisse und saubere Agenten-Koordination.

## 0. Grundregeln (IMMER beachten)

### Suchreihenfolge

**Jeder Agent/Teammitglied MUSS Synapse ZUERST verwenden. Glob/Grep/Explore sind nur Fallback.**

```
1. Synapse: semantic_code_search / search_by_path / search_memory
2. NUR wenn Score < 0.60 oder 0 Ergebnisse → Glob / Grep
3. NUR wenn beides scheitert → Read / manuelle Suche
```

Der Koordinator sucht NICHT selbst, er delegiert an Agenten/Teammitglieder die diese Regel befolgen.

### ALLE Agenten und Teammitglieder brauchen Synapse

**JEDER Agent oder Teammate den der Koordinator spawnt MUSS:**
- Einen einzigartigen Namen bekommen (siehe Abschnitt 1)
- Den Synapse Prompt-Baustein im Prompt haben (siehe Abschnitt 3)
- Sich bei Synapse anmelden (get_index_stats)

Das gilt fuer ALLE Varianten — egal ob `Agent()` oder `Agent(team_name: ...)`:

| Typ | Beispiel subagent_type | Synapse-Regeln? | Worktree? |
|-----|------------------------|-----------------|-----------|
| Arbeiter | `general-purpose` | JA, PFLICHT | Ja, bei Code-Aenderungen |
| Sucher | `Explore` | JA, PFLICHT | Nein (nur lesen) |
| Planer | `Plan` | JA, PFLICHT | Nein (nur lesen) |
| Teammate | `general-purpose` + `team_name` | JA, PFLICHT | Ja, bei Code-Aenderungen |

**Explore-Agenten** nutzen Synapse fuer Code-Suche statt Glob/Grep.
**Plan-Agenten** nutzen Synapse fuer Architektur-/Memory-Suche statt Codebase-Exploration.
**Teammates** folgen exakt denselben Regeln wie einzelne Agenten.

## 1. Einzigartige Namen (Pflicht — Koordinator UND Agenten)

Jeder Koordinator und jeder Agent MUSS einen einzigartigen Namen haben.
Ohne einzigartigen `agent_id` liefert Synapse Onboarding-Regeln nur beim ersten Mal.

**Format:** `<adjektiv/nomen>-<tier/objekt>` (deutsch, kurz, merkbar)
Beispiele: `signal-fuchs`, `kabel-wolf`, `frost-rabe`

**Kein Name darf JEMALS wiederverwendet werden** - weder in der aktuellen noch in folgenden Sessions.

### Koordinator-Benennung (Session-Start)

1. `.synapse/status.json` im Projektordner lesen → `knownAgents` Array
2. Name waehlen der NICHT in `knownAgents` vorkommt
3. `search_thoughts` mit dem Namen pruefen → existiert er schon?
4. Falls frei: `add_thought` mit Tag `"agent-name"` und dem Namen speichern
5. Diesen Namen als `agent_id` an ALLE Synapse-Tool-Aufrufe uebergeben
6. Diesen Namen als `source` bei `add_thought` verwenden (NIEMALS "claude-code"!)

### Agenten-Benennung

1. Koordinator vergibt einzigartigen Namen (geprueft gegen `knownAgents` + `search_thoughts`)
2. `add_thought` mit Tag `"agent-name"` registrieren
3. Name als `agent_id` an alle Synapse-Tools UND als `name` beim Agent-Tool uebergeben
4. Synapse-Regeln DIREKT im Prompt einbetten (siehe Abschnitt "Agenten-Prompt Baustein")

## 2. Worktree-Isolation (optional)

Worktrees sind **optional** — Agenten koennen sich ueber Synapse (`add_thought`, `search_thoughts`) koordinieren und im selben Workspace arbeiten. Das hat sich in der Praxis als zuverlaessiger erwiesen.

Worktrees koennen bei grossen, unabhaengigen Tasks hilfreich sein, sind aber kein Standard-Workflow.

## 3. Agenten-Prompt Baustein (PFLICHT)

**NIEMALS darauf vertrauen dass ein Agent einen Skill laedt.**
Stattdessen: Die kritischen Synapse-Regeln DIREKT in den Agent-Prompt einbauen.

Der Koordinator MUSS diesen Block in JEDEN Agent-Prompt einfuegen
(Platzhalter `{AGENT_ID}` und `{PROJEKT}` ersetzen):

```
=== SYNAPSE PFLICHT-REGELN ===
Du arbeitest mit Synapse MCP-Tools. Deine agent_id ist: {AGENT_ID}
Projekt: {PROJEKT}

SCHRITT 1 (ALLERERSTE Aktion, vor allem anderen):
  get_index_stats(project: "{PROJEKT}", agent_id: "{AGENT_ID}")
  → Das triggert dein Onboarding, du siehst die Projekt-Regeln.
  → Lies die Regeln SORGFAELTIG, sie enthalten Coding-Standards und Verbote.

SCHRITT 2:
  read_memory(project: "{PROJEKT}", name: "projekt-regeln", agent_id: "{AGENT_ID}")
  → Kern-Coding-Regeln laden und befolgen.

SUCHE (WICHTIGSTE REGEL — vor jeder Code-Suche beachten!):
- IMMER zuerst Synapse MCP-Tools verwenden:
  semantic_code_search(query: "...", project: "{PROJEKT}", agent_id: "{AGENT_ID}")
  search_by_path(project: "{PROJEKT}", path_pattern: "...", agent_id: "{AGENT_ID}")
  search_memory(query: "...", project: "{PROJEKT}", agent_id: "{AGENT_ID}")
- NUR wenn Synapse-Score < 0.60 oder 0 Ergebnisse → Glob/Grep/Read als Fallback
- VERBOTEN: Read/Glob/Grep/Explore-Agent BEVOR Synapse versucht wurde
- Synapse kennt den gesamten Code — nutze es!

REGELN:
- agent_id: "{AGENT_ID}" an JEDEN Synapse-Aufruf uebergeben
- source: "{AGENT_ID}" bei add_thought (NIEMALS "claude-code")
- Erfolg: Task als completed markieren. KEIN Thought, KEIN Memory.
- Problem: add_thought(project: "{PROJEKT}", source: "{AGENT_ID}",
    content: "<problem>", tags: ["problem"], agent_id: "{AGENT_ID}")
  Task NICHT als completed markieren.

COMMIT:
- Du arbeitest in einem eigenen Git Worktree (isolierter Branch).
- Committe deine Aenderungen mit conventional commits (feat:/fix:/refactor:).
- Der Koordinator mergt deinen Branch spaeter.

ERGEBNISSE SPEICHERN (PFLICHT):
- Plaene, Analysen, Recherche-Ergebnisse als Synapse Memory speichern:
  write_memory(project: "{PROJEKT}", name: "<beschreibender-name>",
    category: "note", content: "<dein Ergebnis>", agent_id: "{AGENT_ID}")
- KEINE .md-Dateien erstellen — alles gehoert in Synapse Memories
- Kurze Erkenntnisse als add_thought, ausfuehrliche Ergebnisse als write_memory

KOMMUNIKATION:
- Dem Koordinator nur KURZ mitteilen was du gespeichert hast:
  "Plan gespeichert: read_memory(name: '<name>')"
  oder "Erledigt. Branch: <branch-name>"
- KEINE langen Nachrichten — der Koordinator liest in Synapse nach.
=== ENDE SYNAPSE REGELN ===
```

## 4. Kommunikation ueber Synapse (Token-Sparend)

**Agenten sollen NICHT lange Nachrichten per SendMessage senden.**

Stattdessen:
1. Agent speichert Ergebnis/Erkenntnis als `add_thought` mit beschreibendem Tag
2. Agent meldet KURZ: "Erledigt. Branch: worktree-frost-rabe"
3. Koordinator liest bei Bedarf ueber `search_thoughts` nach

**Beispiel:**

Agent speichert:
```
add_thought(
  project: "<projekt>",
  source: "<agent-id>",
  content: "Task X erledigt. Feature Y implementiert. Branch: <branch>. Geaenderte Dateien: ...",
  tags: ["<agent-id>-ergebnis", "task-X"],
  agent_id: "<agent-id>"
)
```

Agent meldet kurz:
```
"Task X erledigt. Branch: <branch-name>"
```

## 4. Richtige Tool-Wahl

| Situation | Tool | Warum |
|-----------|------|-------|
| Konzeptuelle Frage ("wie funktioniert X") | `semantic_code_search` | Semantische Aehnlichkeit |
| Bekannter Dateipfad/Pattern | `search_by_path` | Exakt, kein Embedding |
| Konzept + Pfad kombiniert | `search_code_with_path` | Semantik + Pfad-Filter |
| Architektur / Projekt-Regeln | `search_memory` | Memories sind Wissen |
| Memory + zugehoeriger Code | `read_memory_with_code` | Verknuepft beides |
| Framework-Doku | `search_docs` | Gecachte Docs |
| Frueherer Kontext / Probleme | `search_thoughts` | Gedankenaustausch |

## 5. Filter-Regeln (PFLICHT)

### file_type IMMER setzen wenn Zielsprache bekannt

| Sprache | file_type |
|---------|-----------|
| Rust | `"rust"` |
| TypeScript/SolidJS | `"typescript"` |
| CSS | `"css"` |
| Gemischt/unklar | weglassen, aber `limit` erhoehen |

### path_pattern nutzen wenn Bereich bekannt

Beispiele (projektabhaengig):
- `src/**/*.rs` — alle Rust-Dateien
- `tests/**` — alle Tests
- `crates/<name>/**` — bestimmtes Crate

### limit anpassen

- Gezielte Suche: `3-5`
- Standard: `10`
- Breite Suche: `15-20`

### content_pattern (Regex) bei search_by_path fuer Text-Filter

## 6. Session-Start: Status pruefen (PFLICHT)

```
1. get_project_status → FileWatcher aktiv?
2. Falls "stopped" → init_projekt ausfuehren
3. get_index_stats → Genuegend Chunks vorhanden?
4. search_thoughts mit Tag "session-uebergabe" → Gibt es eine Uebergabe von der letzten Session?
   Falls ja: Kontext lesen und beruecksichtigen, dann Thought loeschen oder als erledigt taggen.
```

## 7. Projekt-Wissen in Synapse speichern

Projektwissen gehoert in Synapse Memories, NICHT in Dateien.

| Was | Kategorie | Name (Beispiel) |
|-----|-----------|-----------------|
| Projekt-Regeln / Coding-Standards | `rules` | `"projekt-regeln"` |
| Projekt-Vision / Ziele | `architecture` | `"projekt-vision"` |
| Architektur-Entscheidungen | `decision` | `"multi-tab-architektur"` |
| Aktueller Plan | `note` | `"plan-001-feature-name"` |

### Memory-Regeln

- `.md`-Dateien: NUR Pfad im Memory speichern, Agenten lesen selbst nach
- Kein Copy-Paste von Dateiinhalten
- Memories kurz und praegnant
- `category: "rules"` wird neuen Agenten beim Onboarding automatisch gezeigt

### Plaene gehoeren in Synapse Memories

- NICHT als .md-Dateien im Repo (verschwendet Platz, verschmutzt Suchergebnisse)
- Schema: `"plan-001-feature-name"`, `"plan-002-bugfix-name"` (fortlaufend)
- Jeder Plan enthaelt: Datum, Status (`offen`/`erledigt`), Kurzreferenz auf Tasks
- Nur bei komplettem Strategiewechsel wird ein Plan als `verworfen` markiert
- Alte Plaene bleiben fuer Kontext und Rueckverfolgbarkeit

### Koordinator Session-Start Workflow

1. `list_memories` → Welches Projektwissen existiert?
2. `read_memory("projekt-regeln")` → Aktuelle Regeln laden
3. `search_memory("plan offen")` → Offene Plaene finden
4. Offene Plaene weiterfuehren, neue mit naechster Folgenummer anlegen

## 8. Task-Abschluss-Protokoll (Agenten)

| Situation | Aktion |
|-----------|--------|
| Erfolgreich, keine Probleme | Task als `completed` markieren. **Nichts weiter.** |
| Probleme / Risiko erkannt | Task als `problematisch` markieren (NICHT `completed`!) |

**Bei "problematisch":**
- `add_thought` mit Tag `"problem"` und Beschreibung
- Koordinator entscheidet ueber Nacharbeit

**Was Agenten NICHT tun:**
- Keine langen Zusammenfassungen per SendMessage
- Keine Thoughts/Memories bei erfolgreichen Tasks
- Task markieren reicht — bei Bedarf kurzer Synapse-Verweis

## 9. .synapseignore Hygiene

Gehoert NICHT in den Index (verschmutzt Ergebnisse):
- `docs/` (Plaene, Design-Docs → Scores hoeher als Code)
- `*.md` in Root ausser README.md (optional)
- Build-Artefakte, Lock-Files, Binaerdateien

## 10. Suchanfrage-Qualitaet

**Gut:**
- Fachbegriffe: `"createMemo reactive polling effect"`
- Funktionsnamen: `"updateActiveTab connectionStore"`
- Architektur-Begriffe: `"per-connection lock AsyncMutex HashMap"`

**Schlecht:**
- Zu generisch: `"wie funktioniert die App"`
- Zu lang: ganze Saetze als Query
- Mischsprachen vermeiden: Code-Begriffe ODER natuerliche Sprache

## 11. Ergebnis-Bewertung

| Score | Bedeutung |
|-------|-----------|
| > 0.75 | Sehr relevant |
| 0.60 - 0.75 | Vermutlich relevant, pruefen |
| < 0.60 | Wahrscheinlich Rauschen |

Wenn Top-Ergebnis < 0.60 → Query umformulieren oder anderen Filter verwenden.

## 12. Context-Monitoring und automatischer Session-Handoff

Der Context-Verbrauch wird **automatisch per PostToolUse-Hook** ueberwacht.
Du musst NICHT selbst zaehlen — der Hook warnt dich automatisch.

### Automatischer Context-Monitor (Hook-basiert)

Ein PostToolUse-Hook (`scripts/context-handoff/context-counter.sh`) liest den echten Context-Window-Verbrauch
aus `context_window.used_percentage` (gleiche Daten wie die Statusline) und warnt automatisch:

| Schwellwert | Warnstufe | Was passiert |
|-------------|-----------|--------------|
| 80% Context verbraucht | GELB | Hook gibt Warnung: "Plane Handoff nach aktuellem Task" |
| 85% Context verbraucht | ROT | Hook gibt dringende Warnung: "SOFORTIGER HANDOFF!" |

**Konfiguration** (via Umgebungsvariablen, optional):
- `CONTEXT_WARN_PERCENT` — GELB-Schwellwert in Prozent (Standard: 60)
- `CONTEXT_CRIT_PERCENT` — ROT-Schwellwert in Prozent (Standard: 80)

**Dateien:**
- `scripts/context-handoff/context-counter.sh` — PostToolUse Hook (liest echten Context-% + warnt)
- Kein SessionStart-Reset noetig (kein Counter-File, liest live-Daten)

**Was DU tun musst wenn die Warnung kommt:**
- GELB: Aktuellen Task abschliessen, dann Handoff-Protokoll starten
- ROT: SOFORT Handoff-Protokoll starten, keine neuen Tasks

### Handoff-Protokoll (3 Schritte)

Wenn Schwellwert erreicht → fuehre SOFORT aus:

**Schritt 1: Thought speichern (Schnelleinstieg)**

```
add_thought(
  project: "<projekt>",
  source: "<koordinator-name>",
  content: "SESSION-HANDOFF: <Was wurde erreicht> | NAECHSTER SCHRITT: <Was als naechstes> | MEMORY: session-handoff-<projekt>-<YYYY-MM-DD-HH-MM>",
  tags: ["session-uebergabe"],
  agent_id: "<koordinator-name>"
)
```

**Schritt 2: Memory speichern (Detaillierter Stand)**

```
write_memory(
  project: "<projekt>",
  name: "session-handoff-<projekt>-<YYYY-MM-DD-HH-MM>",
  category: "note",
  content: "## Session-Handoff

### User-Auftrag
<Original-Auftrag des Users — woertlich>

### Erledigtes
- <Task 1>: erledigt
- <Task 2>: erledigt
- ...

### Offene Tasks
- <Task N>: Status, was fehlt
- <Task N+1>: noch nicht angefangen

### Naechste Schritte (KONKRET)
1. <Exakter naechster Schritt mit Dateipfad>
2. <Schritt danach>

### Aktive Dateien
- <pfad/datei.rs>: <was daran gemacht wird>

### Offene Probleme / Blocker
- <Problem 1>
- <Problem 2>

### Branch / Git-Status
- Branch: <aktueller Branch>
- Uncommitted Changes: <ja/nein, welche Dateien>

### Agenten-Kontext
- Koordinator-Name: <name> (NICHT wiederverwenden!)
- Verwendete Agenten: <liste>
- Aktive Team-Tasks: <task-ids falls vorhanden>",
  agent_id: "<koordinator-name>"
)
```

**Schritt 3: Neue Session starten**

```bash
bash <projekt-pfad>/scripts/context-handoff/context-handoff.sh \
  "<projekt-verzeichnis>" \
  "<projekt-name>" \
  "<kurze-aufgabenbeschreibung>"
```

Das Script startet eine neue interaktive Claude-Session die:
1. Den synapse-nutzung Skill laedt
2. Den session-uebergabe Thought findet
3. Das referenzierte Memory laedt
4. Sich mit neuem Namen registriert
5. Die Arbeit nahtlos fortsetzt

### Was die neue Session tun MUSS (automatisch im Script-Prompt)

1. `search_thoughts(query: "session-uebergabe", project: "<projekt>")` → Neuesten Thought lesen
2. `read_memory(project: "<projekt>", name: "<aus-thought>")` → Detaillierten Stand laden
3. Alten session-uebergabe Thought loeschen (nach erfolgreichem Lesen)
4. Neuen einzigartigen Koordinator-Namen registrieren
5. Arbeit an den offenen Tasks fortsetzen

### Agenten-Prompt Ergaenzung

Fuer Agenten die lange laufen koennten, fuege dem Prompt hinzu:

```
CONTEXT-MONITORING:
Du hast begrenzte Kapazitaet. Falls du merkst dass du sehr viele
Tool-Aufrufe machst (>60), speichere deinen Zwischenstand:
- add_thought mit Tag "agent-zwischenstand"
- Dann weitermachen oder dem Koordinator melden
```

### WICHTIG — Timing

- Handoff NICHT mitten in einer Datei-Bearbeitung starten
- Erst aktuellen Schritt sauber abschliessen (commit wenn moeglich)
- Dann Handoff-Protokoll ausfuehren
- Lieber 5 Minuten frueher als 1 Minute zu spaet
