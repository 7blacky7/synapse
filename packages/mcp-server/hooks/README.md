# MCP-nahe Agenten-Hooks

[Synapse](../../../README.md) › [Übergeordneter Ordner](../README.md) › MCP-nahe Agenten-Hooks

## Zweck

Dieser Ordner enthält Shell-Hooks für lokale Agentensitzungen. Sie ergänzen Onboarding- und Framework-Dokumentationshinweise anhand des Hook-Eingangs und bearbeiteter Dateipfade.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`pre-synapse-onboarding.sh`](pre-synapse-onboarding.sh) | Leitet Projekt- und Agenten-Onboarding-Hinweise aus PreToolUse- beziehungsweise SubagentStart-Ereignissen ab. |
| [`pre-edit-framework-docs.sh`](pre-edit-framework-docs.sh) | Erkennt Frameworks vor einer Bearbeitung und begrenzt wiederholte Hinweise je Agent und Framework. |
| [`post-edit-framework-docs.sh`](post-edit-framework-docs.sh) | Erkennt Frameworks in bearbeiteten Dateien und ergänzt verfügbare Dokumentationshinweise. |

## Schnittstellen nach außen

Die Hooks lesen JSON über stdin, insbesondere `hook_event_name`, `tool_input.file_path`, `agent_id` und `session_id`. Ihre Ausgabe ergänzt den Kontext des aufrufenden Agenten; diese Dateien sind keine MCP-Werkzeugdefinitionen.

## Abhängigkeiten

Die Skripte verwenden Bash und jq sowie lokale Projektdateien zur Erkennung. Die Framework-Hinweise sind an die Synapse-Tech-Dokumentation angebunden; die Skripte ersetzen nicht die serverseitigen [Onboarding-Adapter](../src/tools/onboarding.ts).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Server](../src/README.md)
- [Tech-Doku-Adapter](../src/tools/tech-docs.ts)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
