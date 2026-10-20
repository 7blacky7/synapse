# Docker-Umgebung

[Synapse](../README.md) › Docker-Umgebung

## Zweck

Der Ordner bündelt Docker-Images für zwei unterschiedliche Aufgaben: die isolierte Syntaxprüfung durch den Prüfcontainer und die projektbezogenen Entwicklungs-Workspaces. Die Images werden von der REST-API beziehungsweise dem Workspace-Orchestrator als Ausführungsumgebungen verwendet.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [Prüfcontainer](synapse-pruefcontainer/README.md) | Enthält das Image und die Parser-Hilfsprogramme für Syntaxprüfungen außerhalb des Node-Prozesses. |
| [Workspace](synapse-workspace/README.md) | Beschreibt das Basis-Image mit Werkzeugen für Build-, Analyse- und Laufzeitaufgaben in einer Projektsandbox. |
| [Workspace mit Podman](synapse-workspace-podman/README.md) | Erweitert das Workspace-Image um rootless Podman für Container-Szenarien innerhalb der Sandbox. |
| [Agenten-Runtime](synapse-agent-runtime/README.md) | Image für Hauptagent und Spezialisten: Daemon im Startprofil runtime plus versionierte Claude-/Codex-CLI mit Update und Rollback. |

## Schnittstellen nach außen

Die REST-API bindet den Prüfcontainer als separaten Prozess für ausgewählte Sprachprüfungen ein. Der Workspace-Orchestrator verwaltet Workspace-Container für Shell- und Projektaufgaben; das Podman-Image ist die spezialisierte Variante für Container-Builds und Compose-Umgebungen. Die Image-Inhalte und Parser sind in den jeweiligen Ordnern dokumentiert.

## Abhängigkeiten

Die Dockerfiles bauen auf Debian-Basis-Images und ergänzen je nach Zweck Sprachwerkzeuge, Bibliotheken und Laufzeitkomponenten. Der Workspace mit Podman baut auf dem Basis-Workspace auf. Die API- und Orchestrator-Schnittstellen liegen in [REST-API](../packages/rest-api/README.md) und [Core](../packages/core/README.md).

## Siehe auch

- [REST-API](../packages/rest-api/README.md)
- [Core-Paket](../packages/core/README.md)
- [Zusammenhang und Betriebsvarianten](../docs/README.md)
