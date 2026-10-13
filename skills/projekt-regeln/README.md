# Projektregeln-Skill

[Synapse](../../README.md) › [Skills](../README.md) › Projektregeln

## Zweck

Dieser Skill beschreibt Projektregeln für Coding-Standards und Commit-Konventionen. Die konkreten Regeltexte liegen als projektbezogene Memories und werden über Synapse verwaltet.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`SKILL.md`](SKILL.md) | Beschreibt den Skill zur Anzeige und Änderung der Projektregeln. |

## Schnittstellen nach außen

Der Skill bezieht die Memories `projekt-regeln` und `commit-konventionen` für den aktuellen Projektkontext. Die Memory-Schnittstelle stellt diese Inhalte bereit und speichert deren Änderungen.

## Abhängigkeiten

Die Regeltexte liegen im Synapse-Memory-Dienst. Der verwaltete Skill-Inhalt wird in der zentralen Skill-Datenbank gepflegt; PostgreSQL ist deren Quelle der Wahrheit.

## Siehe auch

- [Projekt-Skills](../README.md)
- [Projektarchitektur](../projekt-architektur/README.md)
- [Projekt-Setup](../projekt-setup/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
