# Projektarchitektur-Skill

[Synapse](../../README.md) › [Skills](../README.md) › Projektarchitektur

## Zweck

Dieser Skill ordnet Architekturwissen und Designentscheidungen einem Synapse-Projekt zu. Er behandelt die beiden Projekt-Memories `architektur-uebersicht` und `design-entscheidungen`, die über den Memory-Dienst verwaltet werden.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`SKILL.md`](SKILL.md) | Beschreibt Aktivierung und fachliche Nutzung der Projektarchitektur- und Designentscheidungs-Memories. |

## Schnittstellen nach außen

Der Skill verwendet projektbezogene Memories mit den Namen `architektur-uebersicht` und `design-entscheidungen`. Die Angaben werden über die Memory-Funktionen von Synapse gelesen und gespeichert; der aktive Projektkontext bestimmt die Zuordnung.

## Abhängigkeiten

Die Inhalte liegen im Synapse-Memory-Dienst und werden dem Projekt `architecture` beziehungsweise `decision` zugeordnet. Die Skill-Datenbank ist die maßgebliche Quelle für den verwalteten Skill-Inhalt; die Repository-Datei beschreibt den zugehörigen Skill-Bereich.

## Siehe auch

- [Projekt-Skills](../README.md)
- [Projektregeln](../projekt-regeln/README.md)
- [Projektstatus](../projekt-status/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
