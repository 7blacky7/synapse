# Pakete

[Synapse](../README.md) › Pakete

## Zweck

Der Ordner `packages/` enthält die eigenständigen Projektpakete des Synapse-Monorepos. Dazu gehören der gemeinsame Core, Transport- und API-Server, Agenten-Laufzeiten, der FileWatcher sowie die Web-Oberfläche.

## Inhalt

### Gemeinsame Basis und Schnittstellen

| Paket | Aufgabe |
|---|---|
| [`core/`](core/README.md) | Stellt die gemeinsame Logik bereit, die unter anderem MCP- und REST-API verwenden. |
| [`mcp-server/`](mcp-server/README.md) | Bietet den MCP-Server und die dazugehörigen Werkzeuge für lokale Clients. |
| [`rest-api/`](rest-api/README.md) | Bietet die REST-Schnittstelle für Web-Clients. |

### Agenten und Ausführung

| Paket | Aufgabe |
|---|---|
| [`agents/`](agents/README.md) | Enthält Agenten- und Wrapper-Laufzeit auf Basis des Core-Pakets. |
| [`agents-antigravity/`](agents-antigravity/README.md) | Stellt die Antigravity-CLI-Laufzeit für Synapse-Agenten bereit. |
| [`agents-gemini/`](agents-gemini/README.md) | Stellt eine Gemini-basierte Agenten-Laufzeit bereit. |
| [`compute-node-agent/`](compute-node-agent/README.md) | Stellt den HTTP-Agenten für Ollama-Compute-Nodes bereit. |
| [`file-watcher-daemon/`](file-watcher-daemon/README.md) | Enthält die bestehende FileWatcher-Daemon-Implementierung. |
| [`file-watcher-daemon-ts/`](file-watcher-daemon-ts/README.md) | Enthält die TypeScript-Implementierung des FileWatcher-Daemons. |

### Oberfläche

| Paket | Aufgabe |
|---|---|
| [`web-ui/`](web-ui/README.md) | Enthält die Web-Oberfläche von Synapse mit Chat-Interface. |

## Schnittstellen nach außen

Die Paketgrenzen werden durch die jeweiligen Paketmanifeste und Exporte beschrieben. [`core/`](core/README.md) ist eine Workspace-Abhängigkeit der MCP- und REST-Server; Agenten- und Daemon-Pakete beziehen Core- oder Agenten-Funktionen ebenfalls als Workspace-Pakete.

## Abhängigkeiten

Die Pakete sind Teil des gemeinsamen pnpm-Workspace. Ihre internen Abhängigkeiten sind in den Paketmanifesten der jeweiligen Paketordner deklariert. Die Paket-READMEs beschreiben die jeweiligen Laufzeitkomponenten und Schnittstellen.

## Siehe auch

- [Projekt-Einstieg](../README.md)
- [Core-Paket](core/README.md)
- [MCP-Server](mcp-server/README.md)
- [REST-API](rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../docs/README.md)
