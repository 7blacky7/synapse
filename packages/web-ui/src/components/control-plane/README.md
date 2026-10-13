# Control-Plane-Bausteine

[Synapse](../../../../../README.md) › [Pakete](../../../../README.md) › [Web-Oberfläche](../../../README.md) › [Quellcode](../../README.md) › [Komponenten](../README.md) › Control Plane

## Zweck

Dieser Unterordner enthält die eigenständigen Bausteine der Control-Plane-Oberfläche. Er trennt den Control-Plane-Einstieg und seine Ansichtssammlung von den übrigen Komponenten auf der obersten Komponentenebene.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [ControlPlane.tsx](ControlPlane.tsx) | Derzeit leere Datei ohne implementierte Komponente. |
| [Views.tsx](Views.tsx) | Derzeit leere Datei ohne implementierte View-Komponenten. |

## Schnittstellen nach außen

Die Dateien bilden einen separaten Komponentenbereich innerhalb von [components](../README.md). Das übergeordnete Modul [ControlPlaneSettingsView.tsx](../ControlPlaneSettingsView.tsx) enthält daneben die Einstellungsansicht der Control Plane.

## Abhängigkeiten

Der übergeordnete Komponentenbereich bündelt die übrigen Ansichten; gemeinsame UI-Datenmodelle liegen in [src/control-plane](../../control-plane/README.md).

## Siehe auch

- [Komponenten](../README.md)
- [View-Modelle](../../control-plane/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../docs/README.md)
