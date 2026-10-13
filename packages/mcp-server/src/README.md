# MCP-Server-Quellcode

[Synapse](../../../README.md) › [Übergeordneter Ordner](../README.md) › MCP-Server-Quellcode

## Zweck

Dieser Ordner enthält den stdio-Einstieg und die MCP-Anfrageverarbeitung. Die lokale Daemon-Anbindung und ein eigenständiger Projekt-Watcher ergänzen die Tool-Adapter.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | `startServer` eröffnet stdio; die Signalbehandlung sichert und pausiert verbundene Spezialisten. |
| [`server.ts`](server.ts) | `createServer` registriert Werkzeuge und verarbeitet MCP-Aufrufe samt Regeln, Onboarding und Antwort-Anhängen. |
| [`daemon-client.ts`](daemon-client.ts) | `ensureDaemon` und `ensureProjectInDaemon` verbinden den MCP-Server per HTTP und Discovery-Dateien mit dem lokalen Watcher-Daemon. |
| [`watcher-daemon.ts`](watcher-daemon.ts) | Betreibt einen projektbezogenen FileWatcher mit Unix-Socket für Status und Stop. |
| [`tools/`](tools/README.md) | Bündelt Fachadapter und konsolidierte Werkzeugdefinitionen. |

## Schnittstellen nach außen

[server.ts](server.ts) exportiert `createServer` und `startServer`; die Registry bedient `tools/list` und `tools/call`. [watcher-daemon.ts](watcher-daemon.ts) bietet am Projekt-Socket die Aktionen `status` und `stop`. Der HTTP-Client bildet die Verbindung zum Rechner-Daemon.

## Abhängigkeiten

Der Server verwendet das [MCP-SDK](../package.json), [Core](../../core/README.md) und [Agenten](../../agents/README.md). Watcher und Client verwenden Node-Prozess-, Dateisystem- und Netzwerkschnittstellen.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Konsolidierte Werkzeuge](tools/consolidated/README.md)
- [Rechner-Daemon](../../file-watcher-daemon-ts/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
