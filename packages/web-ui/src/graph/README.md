# Graph-Ansicht

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Web-Oberfläche](../../README.md) › [Quellcode](../README.md) › Graph

## Zweck

Der Graph-Bereich lädt Projekt-, Code- und Wissensdaten über die Graph-Endpunkte und stellt sie als interaktive Cytoscape-Ansicht dar. Die Engine verwaltet ihre Darstellung innerhalb eines eigenen DOM-Containers; der zusätzliche Canvas-Renderer zeichnet die kosmische Hintergrunddarstellung.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [api.ts](api.ts) | Kapselt typisierte Graph-Abfragen unter `/api/graph` über den gemeinsamen Auth-Aufruf. |
| [constants.ts](constants.ts) | Enthält Farb-, Größen- und Anzeigezuordnungen für Dateitypen, Symbole und Wissenselemente sowie das Polling-Intervall. |
| [engine.ts](engine.ts) | Baut Graph-DOM, Cytoscape-Elemente, Filter, Detailansichten und Aktualisierungslogik auf. |
| [cosmos.ts](cosmos.ts) | Zeichnet Hintergrundpartikel und Projekt-Kosmos auf einem separaten Canvas. |
| [graph.css](graph.css) | Stile der Graph-Oberfläche. |

## Schnittstellen nach außen

[GraphView](../components/README.md) erzeugt und entfernt die [GraphEngine](engine.ts) beim Mounten und Aushängen der React-Komponente. Die Engine fragt [api.ts](api.ts) ab; dessen Aufrufe laufen über [die gemeinsame Authentifizierung](../api/README.md). Die Graph- und Wissensantworten sind im API-Modul typisiert.

## Abhängigkeiten

[Cytoscape](../../package.json) verwaltet den Graphen. [cosmos.ts](cosmos.ts) ergänzt ihn um eine Canvas-Ebene. Der Transport hängt von [api/auth.ts](../api/auth.ts) und den Graph-Routen der [REST-API](../../../rest-api/README.md) ab.

## Siehe auch

- [Oberflächenkomponenten](../components/README.md)
- [API-Adapter](../api/README.md)
- [REST-API](../../../rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
