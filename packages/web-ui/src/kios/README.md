# Agenten-HTML-Darstellung

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Web-Oberfläche](../../README.md) › [Quellcode](../README.md) › Kios

## Zweck

Der Kios-Bereich rendert HTML-Artefakte eines Agenten in einer abgegrenzten Oberfläche. Vor der Darstellung werden aktive Inhalte bereinigt; der optionale schrittweise Aufbau erzeugt gültige DOM-Elemente und berücksichtigt reduzierte Bewegung.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [AgentRenderingSurface.tsx](AgentRenderingSurface.tsx) | React-Komponente, die HTML bereinigt und in einer isolierten Darstellungsfläche ausgibt. |
| [sanitize.ts](sanitize.ts) | Entfernt gesperrte aktive Elemente, Ereignisattribute und JavaScript-URLs aus dem übergebenen HTML. |
| [fakeStream.ts](fakeStream.ts) | Baut den HTML-DOM schrittweise auf und stellt eine abbrechbare Darstellung bereit. |
| [kios-integration.css](kios-integration.css) | Stile für die Agenten-Darstellungsfläche. |

## Schnittstellen nach außen

[AgentRenderingSurface](AgentRenderingSurface.tsx) erhält den HTML-Inhalt, eine Revision und optionale Interaktions-Callbacks. Die Komponente nutzt [sanitize.ts](sanitize.ts) vor der Ausgabe und [fakeStream.ts](fakeStream.ts) für die animierte Darstellung. Sie wird in den Oberflächenkomponenten eingebettet, etwa in der [Projektkoordination](../components/README.md).

## Abhängigkeiten

Die Darstellungskomponente verwendet React und Browser-DOM-APIs wie `DOMParser`, `ShadowRoot` und `ResizeObserver). Sie benötigt keine separate API-Schicht; die HTML-Inhalte werden ihr von der aufrufenden Ansicht übergeben.

## Siehe auch

- [Oberflächenkomponenten](../components/README.md)
- [API-Adapter](../api/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
