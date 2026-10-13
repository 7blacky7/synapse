# Agent-Runtime-Dienste

[Synapse](../../../../../README.md) › [REST-API](../../../README.md) › [Quellcode](../../README.md) › [Dienste](../README.md) › Agent-Runtime

## Zweck

Dieser Ordner verwaltet die vom REST-API-Server angebotenen Hauptagenten-Runtimes. Der Manager verbindet Runtime-Treiber mit einer PostgreSQL-basierten Konfiguration und Sitzungsablage. Die Treiber bilden Codex, Claude Code und den Modell-Pool auf ein gemeinsames Runtime-Verhalten ab; Terminal- und Artefaktströme werden separat verwaltet.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`artefakt-tool.ts`](artefakt-tool.ts) | Orchestriert das Hauptagenten-Artefaktwerkzeug, Ablage und Zustellung. |
| [`artifact-stream.ts`](artifact-stream.ts) | Registriert offene Sitzungsströme und sendet Artefakt-Ereignisse gezielt an eine Sitzung. |
| [`claude-driver.ts`](claude-driver.ts) | Implementiert den Runtime-Treiber für Claude Code. |
| [`codex-driver.ts`](codex-driver.ts) | Implementiert den Runtime-Treiber für Codex. |
| [`free-pool-driver.ts`](free-pool-driver.ts) | Implementiert Anfragen an den erlaubten Modell-Pool ohne eigenen Runtime-Container. |
| [`manager.ts`](manager.ts) | Wählt Treiber aus, prüft Runtime-Status und verwaltet Zuweisung und Hauptagenten-Sitzungen. |
| [`repository.ts`](repository.ts) | Liest und schreibt Runtime-Konfiguration und Sitzungsdaten in PostgreSQL. |
| [`runtime-root.ts`](runtime-root.ts) | Bestimmt und prüft das persistente Basisverzeichnis der Container-Runtimes. |
| [`terminal-sessions.ts`](terminal-sessions.ts) | Verwaltet offene Terminal-Sitzungen, Ereignisse und deren Bereinigung. |
| [`types.ts`](types.ts) | Definiert Runtime-, Status-, Sitzungs-, Treiber- und Stream-Typen. |

## Schnittstellen nach außen

[`AgentRuntimeManager`](manager.ts) ist die zentrale API für [`routes/agent-runtimes.ts`](../../routes/agent-runtimes.ts). Alle Treiber implementieren [`AgentRuntimeDriver`](types.ts). Nachrichten liefern Runtime-Ereignisse; ein Artefakt wird über [`artifact-stream.ts`](artifact-stream.ts) nur an den Stream der zugehörigen Sitzung ausgegeben.

## Abhängigkeiten

Die Treiber verwenden [`@synapse/core`](../../../../core/README.md) für Modell-Pool-Funktionen und Datenzugriff, `dockerode` für Runtime-Container und Node-APIs für Prozess- und Stream-Verarbeitung. [`repository.ts`](repository.ts) verwendet den Core-Datenbankpool. Das gemeinsame Verhalten und die Datentypen sind in [`types.ts`](types.ts) festgelegt.

## Siehe auch

- [REST-API-Dienste](../README.md)
- [Runtime-Routen](../../routes/README.md)
- [REST-API-Paket](../../../README.md)
- [Zusammenhang](../../../../../docs/README.md)
