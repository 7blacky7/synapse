# Kontextübergabe-Helfer

[Synapse](../../README.md) › [Skripte](../README.md) › Kontextübergabe-Helfer

## Zweck

Die drei Shell-Dateien in diesem Ordner sind lokale Einstiegspunkte für Kontextübergaben der Agentenumgebung. Sie enthalten Verweise auf die außerhalb dieses Projektordners verwalteten Hilfsskripte; die ausführbare Implementierung liegt deshalb nicht hier.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`claude-session.sh`](claude-session.sh) | Einstiegspunkt für sitzungsbezogene Übergaben. |
| [`context-counter.sh`](context-counter.sh) | Einstiegspunkt für die Kontextstand-Anzeige. |
| [`context-handoff.sh`](context-handoff.sh) | Einstiegspunkt für die Kontextübergabe. |
| [Implementierung im Synapse-Nutzungs-Skill](../../skills/synapse-nutzung/scripts/context-handoff.sh) | Versionierte Kontextübergabe-Logik im Projekt-Skill. |

## Schnittstellen nach außen

Die Einträge verweisen auf die lokale Agentenumgebung. Die im Projekt gepflegte [Skill-Implementierung](../../skills/synapse-nutzung/scripts/context-handoff.sh) ist die zugehörige Quellstelle.

## Abhängigkeiten

Die Einstiegspunkte setzen die lokale Agentenumgebung voraus. Die versionierte Skill-Implementierung verwendet die Synapse-Agentenregeln.

## Siehe auch

- [Skripte](../README.md)
- [Synapse-Nutzung](../../skills/synapse-nutzung/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
