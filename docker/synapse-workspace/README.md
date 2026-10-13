# Projekt-Workspace

[Synapse](../../README.md) › [Docker-Umgebung](../README.md) › Projekt-Workspace

## Zweck

Dieses Basis-Image stellt Werkzeuge für projektbezogene Entwicklungs- und Laufzeitumgebungen bereit. Der Workspace-Orchestrator der REST-API verwendet es für isolierte Shell-Aufgaben und persistente Workspace-Container. Der Quellbestand wird dabei als Workspace bereitgestellt; der Container dient der Ausführung und erzeugt Build-Artefakte.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [Dockerfile](Dockerfile) | Definiert Basisbetriebssystem, Sprachlaufzeiten, Compiler, Analysewerkzeuge und Entwicklungsbibliotheken des Images. |

## Schnittstellen nach außen

Die REST-API verwaltet Workspace-Instanzen und leitet Shell-Aufgaben in sie weiter. Projektdateien liegen unter `/workspace`; ein separates Home-Verzeichnis hält benutzerspezifische Werkzeuge und Caches. Ressourcenlimits und Workspace-Eigenschaften werden durch die API-Orchestrierung festgelegt.

## Abhängigkeiten

Das Image basiert auf Debian und bündelt unter anderem Node.js mit pnpm, Python, Rust, Go, Java sowie native Compiler und Bibliotheken. Die API-Orchestrierung liegt in [REST-API-Services](../../packages/rest-api/src/services/README.md). Das spezialisierte [Podman-Image](../synapse-workspace-podman/README.md) baut auf diesem Image auf.

## Siehe auch

- [Docker-Umgebung](../README.md)
- [Workspace-Orchestrierung](../../packages/rest-api/src/services/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
