# Synapse-Nutzung

[Synapse](../../README.md) › [Skills](../README.md) › Synapse-Nutzung

## Zweck

Dieser Skill beschreibt den Einsatz von Synapse für Projektwissen, Suche, Agentensitzungen und Zusammenarbeit. Er ordnet Werkzeuge und Datenquellen ein und behandelt Ereignisse, Kontextübergaben sowie den Umgang mit Projekt- und Testdatenbanken.

## Inhalt

| Abschnitt | Themen |
|---|---|
| [`SKILL.md`](SKILL.md) | Agentendelegation und Sitzungsstatus, Agentenkommunikation, Asset-Index, Events, Aufsicht, Projektregeln, Onboarding, Suchreihenfolge und Werkzeugübersicht. |
| [Skripte](scripts/README.md) | Shell-Helfer für Claude-Sitzungen und Kontextverwaltung. |

## Schnittstellen nach außen

Der Skill beschreibt die Beziehungen zwischen Agenten, Channels, Events, Projektplänen und Synapse-Werkzeugen. Dazu gehören unter anderem `code_intel` für Codewissen, `search` für Synapse-Einträge, `files` für versionierte Änderungen sowie `shell` für Ausführung.

## Abhängigkeiten

Die Inhalte beziehen sich auf Synapse-MCP-Werkzeuge und den lokalen Agenten-Wrapper. Die Skripte im Unterordner ergänzen einzelne Abläufe für Claude-Sitzungen.

## Siehe auch

- [Skills im Projekt](../README.md)
- [Synapse-Agent-Regeln](../synapse-agent-regeln/README.md)
- [Skripte](scripts/README.md)
