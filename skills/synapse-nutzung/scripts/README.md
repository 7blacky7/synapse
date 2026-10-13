# Synapse-Nutzungs-Skripte

[Synapse](../../../README.md) › [Skills](../../README.md) › [Synapse-Nutzung](../README.md) › Skripte

## Zweck

Dieser Ordner enthält Hilfsskripte für Claude-Sitzungen und die Verwaltung von Kontextübergängen. Die Skripte arbeiten mit lokalen Sitzungsinformationen und Dateien unter `/tmp` sowie der Claude-Konfiguration.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`claude-session.sh`](claude-session.sh) | Startet Claude und verarbeitet vom Wrapper gesetzte Handoff-Marker, um bei Bedarf eine neue Sitzung mit übergebenem Kontext zu starten. |
| [`context-counter.sh`](context-counter.sh) | PostToolUse-Hook, der den Kontextverbrauch aus einer StatusLine-Datei liest und Schwellenereignisse je Sitzung verfolgt. |
| [`context-handoff.sh`](context-handoff.sh) | Bereitet Marker und Prompt für eine neue Claude-Sitzung vor und beendet die aktuelle Sitzung. Das Skript warnt ausdrücklich vor Ausführung über Synapse-Shell-Kontexte. |

## Schnittstellen nach außen

Die Skripte greifen auf die Claude-CLI, Hook-Eingaben, StatusLine-Daten, Session-Marker und Wrapper-Umgebungsvariablen zu. `context-handoff.sh` kommuniziert mit `claude-session.sh` über Markerdateien; `context-counter.sh` liest den Kontextwert über eine temporäre Datei.

## Abhängigkeiten

Verwendete lokale Programme umfassen Bash, Claude CLI, jq und für das Kontext-Tracking sqlite3. Die Skripte setzen eine lokale Claude-Umgebung und deren Wrapper- beziehungsweise Hook-Konfiguration voraus.

## Siehe auch

- [Synapse-Nutzung](../README.md)
- [Synapse-Agent-Regeln](../../synapse-agent-regeln/README.md)
