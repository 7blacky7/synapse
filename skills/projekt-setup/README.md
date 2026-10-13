# Projekt-Setup-Skill

[Synapse](../../README.md) › [Skills](../README.md) › Projekt-Setup

## Zweck

Dieser Skill bündelt Setup-Wissen für ein Synapse-Projekt. Er erfasst Projektzweck, Coding-Standards, Commit-Konventionen und relevante Skills als projektbezogene Memories.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`SKILL.md`](SKILL.md) | Beschreibt den Setup-Skill und die vom Wizard verwalteten Projektangaben. |

## Schnittstellen nach außen

Der Skill liest und speichert die Memories `projekt-beschreibung`, `projekt-regeln`, `commit-konventionen` und `verfuegbare-skills`. Die Einträge werden dem jeweils aktiven Projekt zugeordnet.

## Abhängigkeiten

Die Projektangaben liegen im Synapse-Memory-Dienst. Die Tech-Erkennung liefert zusätzliche Projektinformationen; die verwaltete Skill-Beschreibung liegt in der zentralen Skill-Datenbank, deren Quelle der Wahrheit PostgreSQL ist.

## Siehe auch

- [Projekt-Skills](../README.md)
- [Projektregeln](../projekt-regeln/README.md)
- [Projektarchitektur](../projekt-architektur/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
