# API-Adapter

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Web-Oberfläche](../../README.md) › [Quellcode](../README.md) › API

## Zweck

Die Module in diesem Ordner bündeln den Zugriff der Web-Oberfläche auf authentifizierte REST-Endpunkte. Sie kapseln Anmeldung, Projekt- und Chatdaten, Laufzeitsteuerung und Modellpool-Abfragen; der Control-Plane-Adapter übersetzt API-Antworten in Ansichtsmodelle.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [auth.ts](auth.ts) | Verwaltet den Sitzungstoken, stellt den gemeinsamen `apiFetch`-Aufruf bereit und behandelt nicht autorisierte Antworten zentral. |
| [synapse-client.ts](synapse-client.ts) | Stellt typisierte Aufrufe für Projekte, Chat, Channels, Spezialisten, Wissen, Datei-Versionen und weitere Synapse-Ressourcen bereit. |
| [control-plane-adapter.ts](control-plane-adapter.ts) | Lädt Projekt-, Channel-, Nachrichten- und Tool-Aufrufdaten und formt sie in Control-Plane-View-Modelle um. |
| [agent-runtime.ts](agent-runtime.ts) | Beschreibt Runtime- und Terminalsitzungen des Hauptagenten und bündelt ihre REST-Aufrufe. |
| [model-pool.ts](model-pool.ts) | Typisiert Modell- und Providerdaten sowie Abfragen und Änderungen am Modellpool. |
| [control-plane.ts](control-plane.ts) | Derzeit leere Datei ohne implementierte API-Funktionen. |

## Schnittstellen nach außen

[auth.ts](auth.ts) exportiert `apiFetch` und Authentifizierungsfunktionen; die übrigen Adapter verwenden diesen gemeinsamen Transport. [synapse-client.ts](synapse-client.ts) greift auf den REST-Bereich unter `/api` zu. [agent-runtime.ts](agent-runtime.ts) und [model-pool.ts](model-pool.ts) bieten typisierte Funktionen für ihre jeweiligen Ansichten. [control-plane-adapter.ts](control-plane-adapter.ts) liefert die View-Modelle, die von Komponenten wie [SynapseWorkspaceMock](../components/README.md) verwendet werden.

## Abhängigkeiten

Alle authentifizierten Aufrufe hängen von [auth.ts](auth.ts) ab. Der Control-Plane-Adapter nutzt zusätzlich Funktionen aus [synapse-client.ts](synapse-client.ts) und Typen aus [src/control-plane](../control-plane/README.md). Die serverseitigen Gegenstellen liegen im [REST-API-Paket](../../../rest-api/README.md).

## Siehe auch

- [Komponenten](../components/README.md)
- [View-Modelle](../control-plane/README.md)
- [REST-API](../../../rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
