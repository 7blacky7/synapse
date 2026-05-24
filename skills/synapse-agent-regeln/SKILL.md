---
name: synapse-agent-regeln
description: >
  Pflicht-Regeln fuer Subagenten die mit Synapse MCP-Tools arbeiten.
  Use when you are a subagent/teammate and need to use Synapse tools correctly.
  Triggers: Der Koordinator weist dich an diesen Skill aufzurufen,
  "synapse agent regeln", "agent briefing", "synapse onboarding".
---

# Synapse Agent-Regeln

Du bist ein Subagent. Diese Regeln gelten OHNE Ausnahme.

## 1. Onboarding (ALLERERSTE Aktion)

Du bist bereits im Chat registriert (vom Koordinator). Starte mit:

```
get_index_stats(project: "<projekt>", agent_id: "<deine-id>")
get_chat_messages(project: "<projekt>", agent_id: "<deine-id>", limit: 10)
```

## 2. Agent-ID an JEDEN Synapse-Aufruf

```
semantic_code_search(query: "...", project: "...", agent_id: "<deine-id>")
add_thought(project: "...", source: "<deine-id>", content: "...", agent_id: "<deine-id>")
```

**NIEMALS `source: "claude-code"` verwenden.** Immer deine agent_id.

## 3. Suchreihenfolge (PFLICHT)

```
1. code_intel — Strukturierte Abfragen (IMMER ZUERST fuer Code-Fragen!)
   → tree (Projektbaum), functions/symbols (finden), references (wo verwendet), search (Volltext), file (lesen mit from_line/to_line bei grossen Dateien)
   → Kein Embedding noetig, sofortige Ergebnisse aus PostgreSQL
2. Synapse Semantic: search(action: "code") / search(action: "memory")
   → Nur wenn fuzzy/konzeptuelle Suche noetig (Score-basiert via Qdrant)
3. NUR wenn Score < 0.60 oder 0 Ergebnisse → Glob / Grep
4. NUR wenn alles scheitert → Read / manuelle Suche / Bash als Notfall
```

**VERBOTEN:** Read/Glob/Grep/Bash-Suchbefehle BEVOR code_intel UND Synapse Semantic versucht wurden.

## 4. Kommunikation (ueber Agenten-Chat)

**Broadcasts** (alle sehen es):
```
send_chat_message(project: "<projekt>", sender_id: "<deine-id>",
  content: "Status: Task X laeuft, 50% erledigt")
```

**DM an Koordinator** (bei Problemen/Fragen):
```
send_chat_message(project: "<projekt>", sender_id: "<deine-id>",
  content: "Brauche Hilfe: ...", recipient_id: "koordinator")
```

**Direkt-Benachrichtigung an Koordinator (über Terminal):**
Wenn du mit der Erkundung fertig bist oder eine dringende Frage hast, pinge den Koordinator direkt über das Terminal an:
```bash
cc-send 2740640 "@agy-test: <deine Nachricht>"
```
*WICHTIG:* 
- Die Nachricht MUSS immer mit dem eigenen Agenten-Präfix `@agy-test:` beginnen, damit der Empfänger weiß, von wem sie stammt.
- Wenn du per `cc-send` eine Nachricht erhältst, antworte IMMER per `cc-send` zurück an die Absender-PID (z.B. `cc-send 2740640 "@agy-test: <deine Nachricht>"`). Antworte in diesem Fall NICHT im Channel.

**Neue Nachrichten lesen** (Polling):
```
get_chat_messages(project: "<projekt>", agent_id: "<deine-id>", since: "<letzter-timestamp>")
```

## 5. Vor jeder Datei-Bearbeitung (PFLICHT)

**BEVOR du eine Datei mit Edit/Write aenderst**, pruefe den Wissens-Airbag:

```
get_docs_for_file(file_path: "<datei>", agent_id: "<deine-id>", project: "<projekt>")
```

- Zeigt Breaking Changes, Migration-Warnungen und Gotchas fuer Frameworks die in der Datei relevant sind
- Wenn Warnings kommen: **LIES SIE** und beruecksichtige sie in deinen Aenderungen
- Warnt dich vor Dingen die du wegen deines Cutoffs nicht wissen kannst
- Ignoriere diese Warnungen NICHT — sie verhindern Fehler

## 6. Events (Pflicht-Reaktion)

Tool-Responses zeigen pending Events an. Events sind KEINE Chat-Nachrichten — sie sind **Steuersignale**.

**Wenn ein Event erscheint → SOFORT reagieren:**

```
acknowledge_event(event_id: <id>, agent_id: "<deine-id>", reaction: "Was du getan hast")
```

| Event-Typ | Deine Reaktion |
|-----------|---------------|
| `WORK_STOP` | Arbeit sofort anhalten, Status per Chat posten, auf Koordinator warten |
| `CRITICAL_REVIEW` | Betroffene Arbeit NICHT abschliessen, Review abwarten |
| `ARCH_DECISION` | Plan neu pruefen, Ack mit Bewertung |
| `TEAM_DISCUSSION` | Status posten, auf Koordinator warten |
| `ANNOUNCEMENT` | Lesen, Ack, weiterarbeiten |

**WARNUNG:** Nach 3 Tool-Calls ohne Ack wird automatisch an den Koordinator eskaliert.
Events NICHT ignorieren — sie haben Vorrang vor deinem aktuellen Task.

## 7. Task-Abschluss

| Ergebnis | Aktion |
|----------|--------|
| Erfolg | Chat: "Task X erledigt." Task `completed`. |
| Problem | Chat-DM an Koordinator. `add_thought` mit Tag `"problem"`. Task NICHT completed. |

## 8. Ergebnisse speichern

- Plaene, Analysen → `write_memory` (ausfuehrlich)
- Kurze Erkenntnisse → `add_thought`
- KEINE .md-Dateien erstellen — alles in Synapse

## 9. Wissensluecken melden (Cutoff-Handling)

Wenn eine Technologie/Version jenseits deines Cutoffs liegt:

```
1. search_tech_docs(query: "[Frage]", framework: "[tech]", project: "<projekt>")
   → Hat Context7 Auto-Fetch, liefert Basis-Docs automatisch
2. Bei Treffern (Score > 0.60): Docs nutzen, weiterarbeiten
3. Wenn kuratiertes Wissen fehlt (Breaking Changes, Migration, Gotchas):
   → Chat-DM an Koordinator:
   "Wissensluecke: [Tech] v[Version]. Brauche: [was genau fehlt]"
4. NICHT selbst recherchieren (kein Context7, keine Web-Suche, keine externen Skills)
5. NICHT blockieren — mit bestem Wissen weiterarbeiten, TODO-Kommentar setzen
6. Arbeite weiter — unreadChat im nahexsten Tool-Response zeigt dir wenn Antwort da ist
7. Koordinator dispatcht Docs-Kurator → indexiert kuratierte Docs
8. Danach: search_tech_docs(source: "research") fuer Breaking Changes etc.
```

**Wichtig:** Context7 Auto-Fetch liefert nur Code-Beispiele und API-Referenz.
Fuer Breaking Changes, Migration-Guides und Gotchas braucht es den Docs-Kurator.
Der Koordinator dispatcht ihn automatisch wenn du "Wissensluecke:" meldest.

## 10. Abmeldung (PFLICHT am Ende)

```
unregister_chat_agent(id: "<deine-id>")
```

## 11. Verbote

- Keine Synapse-Einstellungen aendern (init, cleanup, stop)
- NIEMALS `source: "claude-code"` verwenden
- NIEMALS Worktree-Isolation verwenden
- Keine langen Nachrichten per SendMessage — Chat nutzen

## 12. Phasen-basiertes Arbeiten (PFLICHT)

- Halte dich strikt an die aktuelle Arbeitsphase des Projekts.
- In der ersten Phase gilt: **NUR ERKUNDEN + VORSCHLAGEN**. Es dürfen noch **KEINE Code-Änderungen** vorgenommen werden, es sei denn, der Koordinator weist dich explizit dazu an.
- Alle Findings und Vorschläge werden zuerst in den Kommunikationskanälen bzw. im Synapse-Memory dokumentiert und zur Diskussion gestellt.


## 13. Deployment & Live-Umgebung

- **NIEMALS** Dateien direkt in die Live-Umgebung des Users schreiben oder kopieren (z. B. `~/.synapse/file-watcher/`). Dies ist strikt dem Koordinator/User vorbehalten.
- Alle Builds und Kompilierungen (z. B. mit PyInstaller) dürfen ausschließlich im `dist/`-Verzeichnis des Repositories erstellt werden (z. B. `dist/tray_test` oder `dist/tray`).
- Eigene Test-Prozesse (z. B. gestartete Test-Trays) müssen nach der Verifizierung immer sofort selbst beendet werden.
- Headless-Tests oder Verifizierungen (z. B. DBus-Registrierungen) dürfen nur mit der Test-Binary aus dem `dist/`-Verzeichnis durchgeführt werden. Die Live-Binary darf zu Testzwecken niemals gestartet, beendet oder modifiziert werden.


