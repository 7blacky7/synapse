# TypeScript-Daemon-Quellcode

[Synapse](../../../README.md) › [Pakete](../../README.md) › [TypeScript-FileWatcher-Daemon](../README.md) › Quellcode

## Zweck

Der Quellcode startet den Daemon, verwaltet pro Projekt die Dateiüberwachung und bindet HTTP-Routen sowie Hintergrundaufgaben an. Die Komponenten halten die lokale Synchronisation und die von der REST-API eingereihten Jobs zusammen.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [api.ts](api.ts) | Erstellt die Fastify-API des Daemons und bindet deren Routen. |
| [config.ts](config.ts) | Lädt Konfiguration und verwaltet Daemon-Konfigurations- und Discovery-Pfade. |
| [daemon-heartbeat.ts](daemon-heartbeat.ts) | Meldet den Zustand des Daemons über Heartbeat-Daten. |
| [enabled-sync.ts](enabled-sync.ts) | Synchronisiert aktivierte Projekte mit dem laufenden Watcher-Manager. |
| [gpu-helfer-datei.ts](gpu-helfer-datei.ts) | `gpuHelferStatus` liest Einstellungen und Status; `gpuHelferEinstellen` setzt die GPU-Helfer-Einstellungen. |
| [intern-bruecke.ts](intern-bruecke.ts) | Verbindet interne Daemon-Abfragen mit den zuständigen Diensten. |
| [logpflege.ts](logpflege.ts) | Verwaltet die Rotation und Bereinigung lokaler Synapse-Logs. |
| [main.ts](main.ts) | Bootstrapped den Prozess, startet API, Manager und Worker und behandelt den Shutdown. |
| [manager.ts](manager.ts) | Verwaltet Watcher je Projekt und steuert Synchronisations- und Indexier-Slots. |
| [project-init-worker.ts](project-init-worker.ts) | Verarbeitet Projektinitialisierungs-Aufträge. |
| [shell-job-worker.ts](shell-job-worker.ts) | Verarbeitet eingereihte Shell-Jobs für Projekte mit aktivem Watcher. |
| [skills-proxy.ts](skills-proxy.ts) | Stellt die lokale Weiterleitung von Skill-Abfragen bereit. |
| [specialist-job-worker.ts](specialist-job-worker.ts) | Verarbeitet Specialist-Aufträge des Daemons. |

## Schnittstellen nach außen

[main.ts](main.ts) startet den [Fastify-Endpunkt](api.ts) und den [WatcherManager](manager.ts). Core-Module registrieren Daemon-Worker und stellen Datenbankzugriff sowie Dateisynchronisation bereit. Die API und Worker verbinden den lokalen Prozess mit der REST-API, ohne den Tray in denselben Prozess einzubetten.

## Abhängigkeiten

Die Paketzusammenarbeit verwendet `@synapse/core`, `@synapse/agents` und `@synapse/mcp-server`; Fastify stellt den HTTP-Server bereit. Die Paketgrenzen und Metadaten stehen in [package.json](../package.json).

## Siehe auch

- [TypeScript-Daemon-Paket](../README.md)
- [REST-API-Services](../../rest-api/src/services/README.md)
- [Moo-Daemon](../../file-watcher-daemon/src/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
