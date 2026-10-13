# Projektstatus-Skill

[Synapse](../../README.md) › [Skills](../README.md) › Projektstatus

## Zweck

Dieser Skill stellt eine kompakte Übersicht der für ein Projekt gespeicherten Beschreibungs-, Regel- und Architektur-Memories dar. Er macht sichtbar, welche Projektinformationen vorhanden sind und welche noch nicht erfasst wurden.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`SKILL.md`](SKILL.md) | Beschreibt die Projektstatusübersicht und die berücksichtigten Memory-Kategorien. |

## Schnittstellen nach außen

Die Übersicht bezieht projektbezogene Memories wie `projekt-beschreibung`, `projekt-regeln`, `commit-konventionen`, `agenten-regeln`, `verfuegbare-skills`, `architektur-uebersicht` und `design-entscheidungen`. Diese Inhalte werden über die Memory-Funktionen von Synapse bereitgestellt.

## Abhängigkeiten

Der Skill hängt vom Synapse-Memory-Dienst und dem aktiven Projektkontext ab. Die Beschreibung dieses verwalteten Skills liegt in der zentralen Skill-Datenbank, deren Quelle der Wahrheit PostgreSQL ist.

## Siehe auch

- [Projekt-Skills](../README.md)
- [Projekt-Setup](../projekt-setup/README.md)
- [Projektregeln](../projekt-regeln/README.md)
- [Projektarchitektur](../projekt-architektur/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
