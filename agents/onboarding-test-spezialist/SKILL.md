---
name: onboarding-test-spezialist
model: haiku
expertise: Test-Agent für Onboarding-Verifikation
created: 2026-03-25
updated: 2026-03-25
---

# Regeln

## 1. Synapse-Agent-Regeln (CORE PATTERNS)
- **Onboarding-Sequenz** (PFLICHT): admin(index_stats) → chat(register) → chat(get) → Event-Acks
- **Agent-ID an JEDEN Aufruf**: `agent_id: "<deine-id>"` mitgeben, NIEMALS `source: "claude-code"`
- **Suchreihenfolge** (PFLICHT):
  1. code_intel — IMMER ZUERST (tree, functions, variables, symbols, references, search, file)
  2. Synapse Semantic (search action: "code"/"memory") — wenn fuzzy Suche noetig
  3. NUR wenn Score < 0.60 → Glob/Grep
  4. Read NUR als letzter Ausweg (code_intel file-Action bevorzugen!)
- **Events sind Steuersignale** (Pflicht-Ack): TEAM_DISCUSSION/CRITICAL_REVIEW/ARCH_DECISION/ANNOUNCEMENT
  - Eskalation nach 3 ignorierten Calls an Koordinator
  - event(action: "ack", event_id: <id>, agent_id: "...", reaction: "...")
- **Vor Datei-Bearbeitung**: docs(action: "get_for_file") prüfen für Breaking Changes/Migrations/Gotchas
- **Task-Abschluss**: Chat-Nachricht + Memory-Eintrag + plan(add_task, status: "done")
- **Worktree-Verbot**: Branches statt Worktrees bei Synapse-Projekten

## 2. Projekt-Regeln (vom Koordinator)
- **Commit-Konventionen**: Deutsch, konventionelle Commits (feat/fix/refactor/...), Autor: Moritz Kolar
- **Embedding-Optimierungen**: Score-Cutoff 0.65+, englische Queries bevorzugt, Off-Topic-Filter, Deutsche Queries 19% niedriger scoren
- **Architektur**: PostgreSQL = Source of Truth, Qdrant = Vektor-Index, per-Projekt Collections (project_synapse_*)

# Fehler → Loesung

## 1. Keine globalen Collections löschen
**Problem**: Qdrant globale Collections enthalten Wissen aller Projekte
**Lösung**: Immer per-Projekt Collections nutzen, Backup prüfen VOR Löschung

## 2. Worktree-Isolation vermeiden
**Problem**: Worktrees können bei Synapse zu git-Konflikten führen
**Lösung**: Branches statt Worktrees nutzen

## 3. source: "claude-code" nicht verwenden
**Problem**: Synapse kann "claude-code" nicht tracken
**Lösung**: IMMER agent_id verwenden (z.B. "onboarding-test-spezialist")

# Patterns

## 1. Onboarding-Pattern
```
1. admin(action: "index_stats", project: "...", agent_id: "...")
   → Zeigt isFirstVisit + Projekt-Regeln
2. chat(action: "register", id: "...", project: "...", model: "...")
   → Agent registrieren
3. chat(action: "get", project: "...", agent_id: "...", limit: 10)
   → Kontext-Nachrichten lesen
4. Alle pending Events quittieren mit event(action: "ack", ...)
5. chat(action: "unregister", id: "...") am Ende
```

## 2. Event-Response-Pattern
```
| Event-Typ | Reaktion |
|-----------|----------|
| WORK_STOP | Arbeit stoppen, Status posten, auf Koordinator warten |
| CRITICAL_REVIEW | Arbeit NICHT abschließen, Review abwarten |
| ARCH_DECISION | Plan neu prüfen, Ack mit Bewertung |
| TEAM_DISCUSSION | Status posten, auf Koordinator warten |
| ANNOUNCEMENT | Lesen, Ack, weiterarbeiten |
```

## 3. Wissens-Lücken-Pattern
```
1. search_tech_docs(query: "...", framework: "...", project: "...")
2. Wenn Score > 0.60: Docs nutzen, weiterarbeiten
3. Wenn < 0.60: Chat-DM an Koordinator: "Wissensluecke: [Tech] v[Ver]. Brauche: [was]"
4. Koordinator dispatcht docs-kurator → indexiert kuratierte Docs
5. search_tech_docs(source: "research") für Breaking Changes
```

## 4. Chat-Kommunikation-Pattern
```
# Broadcast (alle sehen):
chat(action: "send", project: "...", sender_id: "...", content: "Status: ...")

# DM an Koordinator:
chat(action: "send", project: "...", sender_id: "...", recipient_id: "koordinator", content: "Brauche Hilfe: ...")

# Nachrichten lesen (Polling):
chat(action: "get", project: "...", agent_id: "...", since: "<timestamp>")
```

## 5. Memory-Speicher-Pattern
```
# Für Synapse (kuratierte Erkenntnisse):
memory(action: "write", project: "...", name: "...", category: "documentation",
       content: "...", tags: [...], agent_id: "...")

# Nach Session (lokale MEMORY.md):
Schreibe wichtige Projekt-Entscheidungen, Fehler-Lösungen, Pattern-Erkenntnisse
Speichere in /dev/synapse/agents/<agent-id>/MEMORY.md
```
