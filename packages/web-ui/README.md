# Web-Oberfläche

[Synapse](../../README.md) › [Pakete](../README.md) › Web-Oberfläche

## Zweck

Dieses Paket enthält die browserbasierte Synapse-Oberfläche. Es verbindet React-Ansichten mit REST-Endpunkten und bündelt daneben ausdrücklich gekennzeichnete Demonstrationsdaten für Bereiche, deren Oberfläche noch nicht vollständig an produktive Datenquellen angeschlossen ist.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [src](src/README.md) | Einstieg, Ansichten, API-Adapter, Graph, Agentendarstellung und Demonstrationsdaten. |
| [index.html](index.html) | HTML-Grundgerüst mit dem Einhängepunkt der Anwendung. |
| [package.json](package.json) | Paketmetadaten und Entwicklungs-, Build- und Vorschau-Skripte; listet React, Vite, Cytoscape und xterm als Abhängigkeiten. |
| [tsconfig.json](tsconfig.json) | TypeScript-Konfiguration der Anwendung. |
| [tsconfig.node.json](tsconfig.node.json) | TypeScript-Konfiguration für die Node-seitige Vite-Konfiguration. |
| [vite.config.ts](vite.config.ts) | Vite- und React-Plugin-Konfiguration einschließlich lokaler Web-UI-Einstellungen. |

## Schnittstellen nach außen

Der Browser-Einstieg lädt die React-Anwendung aus [src/main.tsx](src/main.tsx). Die Oberfläche spricht über [src/api](src/api/README.md) mit der REST-API; die Authentifizierung ist dort zentralisiert. Graph-Ansichten verwenden zusätzlich die abgegrenzte [Graph-Implementierung](src/graph/README.md). Das Paket stellt selbst keine REST-Routen bereit.

## Abhängigkeiten

React und React DOM bilden die Oberfläche. Vite und das React-Plugin bündeln und servieren sie. Cytoscape zeichnet den Graphen; xterm und das Fit-Addon stellen die Terminalansicht bereit. Die konkrete Kommunikation mit Synapse läuft über die API-Module in [src/api](src/api/README.md).

## Siehe auch

- [Quellcode und Ansichten](src/README.md)
- [REST-API](../rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
