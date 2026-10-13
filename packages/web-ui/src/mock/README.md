# Beispieldaten

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Web-Oberfläche](../../README.md) › [Quellcode](../README.md) › Beispieldaten

## Zweck

Dieser Ordner enthält lokale Beispieldatensätze und Ausgangszustände für ausgewählte Oberflächen. Die Werte sind in den Quelldateien als Mock-Daten angelegt; sie sind keine Live-Antworten der REST-API. Komponenten können zugleich echte API-Daten und lokale Beispieldaten nutzen, daher kennzeichnet [StatusKennzeichnung](../components/README.md) den jeweiligen Ausbaustand.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [control-plane.ts](control-plane.ts) | Derzeit leere Datei ohne Beispieldatensätze. |
| [infrastructure-control-plane.ts](infrastructure-control-plane.ts) | Enthält Musterprofile für Hosts, Runtimes und Infrastrukturzustände. |
| [personal-knowledge.ts](personal-knowledge.ts) | Enthält Ausgangsdaten und Typen für persönliche Memories und Artefakte. |
| [ui-control-plane.ts](ui-control-plane.ts) | Enthält lokale Navigations-, Einstellungs- und Entitätsdaten für die Control-Plane-Oberfläche. |

## Schnittstellen nach außen

[InfrastructureView](../components/README.md) und [ControlPlaneSettingsView](../components/README.md) greifen auf Musterprofile aus [infrastructure-control-plane.ts](infrastructure-control-plane.ts) zu. Die Wissensansicht erhält Ausgangszustände aus [personal-knowledge.ts](personal-knowledge.ts). [ui-control-plane.ts](ui-control-plane.ts) liefert Navigation und Entitätsdaten an die Arbeitsfläche.

## Abhängigkeiten

Die Datentypen für Control-Plane-Musterobjekte liegen in [src/control-plane](../control-plane/README.md). Ansichten, die echte Daten laden, verwenden stattdessen Adapter aus [api](../api/README.md); die Trennung der Datenherkunft macht [StatusKennzeichnung](../components/README.md) sichtbar.

## Siehe auch

- [Komponenten](../components/README.md)
- [API-Adapter](../api/README.md)
- [Control-Plane-Modelle](../control-plane/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
