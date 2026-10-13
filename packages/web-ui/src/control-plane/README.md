# Control-Plane-Modelle

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Web-Oberfläche](../../README.md) › [Quellcode](../README.md) › Control Plane

## Zweck

Dieser Ordner beschreibt die Datenformen, die zwischen API-Adaptern und Control-Plane-Ansichten verwendet werden. Die Typen fassen Projekt-, Channel-, Nachrichten- und Tool-Aufrufdaten zu UI-orientierten View-Modellen zusammen.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [types.ts](types.ts) | Derzeit leere Datei ohne implementierte Typdeklarationen. |
| [view-model.ts](view-model.ts) | Definiert Navigationsbereiche sowie View-Modelle für Projekte, Channels, Nachrichten und weitere Oberflächendaten. |

## Schnittstellen nach außen

[view-model.ts](view-model.ts) wird vom [Control-Plane-Adapter](../api/README.md) und den [Oberflächenkomponenten](../components/README.md) verwendet. Die API-Antworten werden dort in die hier definierten Präsentationsformen überführt.

## Abhängigkeiten

Die Modelle beziehen sich auf die Daten, die der [API-Bereich](../api/README.md) abruft. Die Darstellung erfolgt in [components](../components/README.md); Beispieldatensätze liegen getrennt in [mock](../mock/README.md).

## Siehe auch

- [API-Adapter](../api/README.md)
- [Komponenten](../components/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
