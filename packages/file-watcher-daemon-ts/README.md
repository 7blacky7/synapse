# TypeScript-FileWatcher-Daemon

[Synapse](../../README.md) › [Pakete](../README.md) › TypeScript-FileWatcher-Daemon

## Zweck

Dieses eigenständige Node.js-Paket stellt den aktuellen HTTP-gesteuerten FileWatcher-Daemon bereit. Es überwacht aktivierte Projektordner und verbindet die lokale Dateisynchronisation mit Core- und REST-Funktionen, darunter Shell-, Specialist- und Project-Init-Aufträge.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [package.json](package.json) | Definiert Paketmetadaten, Build- und Startskripte sowie Workspace-Abhängigkeiten. |
| [tsconfig.json](tsconfig.json) | Enthält die TypeScript-Compilerkonfiguration. |
| [Quellcode](src/README.md) | Dokumentiert HTTP-API, Watcher-Verwaltung und Hintergrund-Worker. |

## Schnittstellen nach außen

Das Paket bietet einen ausführbaren Einstiegspunkt und eine HTTP-API für den lokalen Daemon. Es verwendet Core- und Agentenmodule und startet Hintergrundarbeiter für Dateisynchronisation, Shell-Jobs, Specialist-Jobs und Projektinitialisierung. Der Tray kann die Daemon-Discovery-Dateien für Status und Verbindung verwenden.

## Abhängigkeiten

Das Paket verwendet Fastify sowie `@synapse/core`, `@synapse/agents` und `@synapse/mcp-server` als Workspace-Abhängigkeiten. Build und Start sind in [package.json](package.json) definiert.

## Siehe auch

- [Daemon-Quellcode](src/README.md)
- [Moo-Variante und Tray](../file-watcher-daemon/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
