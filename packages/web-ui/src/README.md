# Quellcode der Web-Oberfläche

[Synapse](../../../README.md) › [Pakete](../../README.md) › [Web-Oberfläche](../README.md) › Quellcode

## Zweck

Dieser Ordner verbindet den React-Einstieg und die Anwendungsansichten. Die Ansichten beziehen Daten teils über API-Adapter, teils aus lokalen Beispieldaten; [Statuskennzeichnungen](components/README.md) unterscheiden diese Ausbaustände sichtbar.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [api](api/README.md) | Authentifizierung und typisierte REST-Aufrufe einschließlich Control-Plane-Adapter. |
| [components](components/README.md) | Anwendungsansichten, Dialoge, Dashboards und wiederverwendbare Oberflächenbausteine. |
| [control-plane](control-plane/README.md) | View-Modelle für Navigationsbereiche und API-gestützte Projektdaten. |
| [graph](graph/README.md) | Datenzugriff, Graph-Engine, Darstellungsfarben und Kosmos-Canvas. |
| [kios](kios/README.md) | Isolierte Darstellung und schrittweiser Aufbau von Agenten-HTML. |
| [mock](mock/README.md) | Statische Beispieldaten für nicht durchgängig live angebundene Ansichten. |
| [App.tsx](App.tsx) | Prüft den Authentifizierungsstatus, wechselt zwischen Anmeldung und Arbeitsoberfläche und verarbeitet Abmeldung. |
| [ControlPlaneApp.tsx](ControlPlaneApp.tsx) | Derzeit leere Datei ohne implementierte Komponente. |
| [main.tsx](main.tsx) | Erstellt den React-Root und rendert die App. |
| [channel-project-surface.css](channel-project-surface.css) | Stile der Channel- und Projektoberfläche. |
| [codex-runtime.css](codex-runtime.css) | Stile für Runtime-Steuerung und Terminal. |
| [control-plane.css](control-plane.css) | Grundlegende Stile der Control-Plane-Oberfläche. |
| [control-plane-settings.css](control-plane-settings.css) | Stile für Control-Plane-Einstellungen. |
| [infrastructure-control-plane.css](infrastructure-control-plane.css) | Stile für Host-, Runtime-, Workspace- und Testsystem-Ansichten. |
| [main-agent-dashboard.css](main-agent-dashboard.css) | Stile des Hauptagenten-Dashboards. |
| [model-pool.css](model-pool.css) | Stile der Modellpool-Tabelle. |
| [personal-knowledge.css](personal-knowledge.css) | Stile für persönliche Memories und Artefakte. |
| [project-knowledge.css](project-knowledge.css) | Stile der Projektwissensansicht. |
| [status-kennzeichnung.css](status-kennzeichnung.css) | Stile für Ausbau- und Planungshinweise. |
| [ui-scale.css](ui-scale.css) | Globale Größen- und Skalierungsregeln. |
| [workspace-extensions.css](workspace-extensions.css) | Ergänzende Workspace-Stile. |
| [workspace-mock.css](workspace-mock.css) | Stile für die Workspace-Demonstrationsansicht. |

## Schnittstellen nach außen

[App.tsx](App.tsx) ruft den Auth-Status ab und zeigt bei erfolgreicher Anmeldung [SynapseWorkspaceMock](components/README.md) als Arbeitsoberfläche. Die API-Adapter liegen getrennt in [api](api/README.md); ihre Daten werden in View-Modelle aus [control-plane](control-plane/README.md) überführt. Die Graph-Ansicht nutzt [graph](graph/README.md), die Agenten-Artefaktdarstellung [kios](kios/README.md).

## Abhängigkeiten

Die Einstiegsdateien verwenden React. Der Auth- und REST-Verkehr läuft über [api](api/README.md); lokale Musterwerte stammen aus [mock](mock/README.md). Die Paket- und Vite-Konfiguration steht in der [Paketübersicht](../README.md).

## Siehe auch

- [API-Adapter](api/README.md)
- [Komponenten](components/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
