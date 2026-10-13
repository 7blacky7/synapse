# REST-API-Dienste

[Synapse](../../../../README.md) › [REST-API](../../README.md) › [Quellcode](../README.md) › Dienste

## Zweck

Die Dienste kapseln API-nahe Fachlogik, die von mehreren Routen oder dem Serverstart verwendet wird. Sie verbinden Core-Funktionen mit Authentifizierung, Parser- und Embedding-Arbeit, Containerprüfungen, Workspace-Verwaltung und Ereignisströmen.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`auth.ts`](auth.ts) | Stellt TOTP-, PKCE- und Tokenfunktionen bereit; speichert Token-Hashes in PostgreSQL. |
| [`embedding-nodes.ts`](embedding-nodes.ts) | Verwaltet Registrierung, Status und Arbeit externer Embedding-Knoten. |
| [`parser-worker.ts`](parser-worker.ts) | Verarbeitet serverseitig den Parse-Backlog und stößt daran angebundene Embedding- und Wissensarbeit an. |
| [`pruef-container.ts`](pruef-container.ts) | Verwaltet den isolierten Prüfcontainer für Syntaxprüfungen außerhalb des Node-Prozesses. |
| [`pruef-container-treesitter.ts`](pruef-container-treesitter.ts) | Enthält die Treesitter-Anbindung des Prüfcontainer-Bereichs. |
| [`workspace-orchestrator.ts`](workspace-orchestrator.ts) | Steuert Workspace-Container und deren Lebenszyklus. |
| [`wrapper-stream.ts`](wrapper-stream.ts) | Verteilt PostgreSQL-Benachrichtigungen als Ereignisse an verbundene Wrapper-Streams und stellt deren Zustand dar. |
| [`agent-runtime`](agent-runtime/README.md) | Runtime-Treiber, Sitzungsverwaltung, Terminale und Artefaktzustellung für Hauptagenten. |

## Schnittstellen nach außen

Die Route-Module verwenden die Dienste direkt, etwa Auth in [`middleware/auth-hook.ts`](../middleware/auth-hook.ts), Embedding-Knoten in den Knotenrouten und Runtime-Funktionen in [`agent-runtimes.ts`](../routes/agent-runtimes.ts). Der Server startet Parser-, Syntaxprüfungs- und Workspace-Dienste während seiner Initialisierung. Die Dienste greifen für Daten und Kernlogik auf [`@synapse/core`](../../../core/README.md) zu.

## Abhängigkeiten

Die Dienste nutzen Core für PostgreSQL-Pool, Parser, Syntaxprüfer, Embeddings und Worker-Status. Fastify-Routen bilden die HTTP-Grenze. Docker-Zugriffe laufen über `dockerode`; der Prüfcontainer kommuniziert ohne Netz über Ein-/Ausgabe des Containers.

## Siehe auch

- [REST-API-Quellcode](../README.md)
- [Routen](../routes/README.md)
- [Agent-Runtime-Dienste](agent-runtime/README.md)
- [Core-Paket](../../../core/README.md)
