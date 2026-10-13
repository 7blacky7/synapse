# Projekt-Skills

[Synapse](../README.md) › Skills

## Zweck

Dieser Ordner enthält die projektbezogenen Skill-Beschreibungen und zugehörige Dateien. Die sechs Unterordner gliedern Inhalte zu Architektur, Regeln, Setup, Status und Synapse-Agentenarbeit.

Die zentrale Skill-Datenbank ist die Quelle der Wahrheit für die verwalteten Skill-Inhalte. Die Skill-Schnittstelle liest ihre Datensätze aus PostgreSQL; der Vektorindex wird daraus nachgeführt.

## Inhalt

| Ordner | Aufgabe |
|---|---|
| [`projekt-architektur/`](projekt-architektur/README.md) | Ordnet Architekturwissen zum Synapse-Projekt. |
| [`projekt-regeln/`](projekt-regeln/README.md) | Bündelt Projektregeln. |
| [`projekt-setup/`](projekt-setup/README.md) | Beschreibt Projekt-Setup-Wissen. |
| [`projekt-status/`](projekt-status/README.md) | Beschreibt projektbezogene Statusinformationen. |
| [`synapse-agent-regeln/`](synapse-agent-regeln/README.md) | Enthält Regeln zur Arbeit von Synapse-Agenten. |
| [`synapse-nutzung/`](synapse-nutzung/README.md) | Enthält Hinweise zur Nutzung von Synapse; der Ordner umfasst außerdem [Skripte](synapse-nutzung/scripts/README.md). |

## Schnittstellen nach außen

Die Skill-Ordner enthalten jeweils eine `SKILL.md`. Über den [Skill-Dienst](../packages/core/src/services/README.md) werden Skill-Daten über die Skill-Datenbank bereitgestellt und aktualisiert.

## Abhängigkeiten

Die verwalteten Skill-Inhalte liegen in der Skill-Datenbank. Der Vektorindex unterstützt deren Suche; PostgreSQL bleibt laut Skill-Schnittstelle die Quelle der Wahrheit. Die Repository-Dateien und Unterordner ordnen die projektbezogenen Skill-Bereiche und begleitenden Dateien ein.

## Siehe auch

- [Projekt-Einstieg](../README.md)
- [Core-Dienste](../packages/core/src/services/README.md)
- [Zusammenhang und Betriebsvarianten](../docs/README.md)
