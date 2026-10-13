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

## Funktionsweise

### Einstieg, Anmeldung und Datenquellen

[main.tsx](main.tsx) erstellt den React-Einstieg und rendert [App](App.tsx). Beim Laden fragt die App über [auth.ts](api/auth.ts) den Anmeldestatus ab. Solange die Antwort aussteht, zeigt sie den Ladezustand; ohne gültige Sitzung erscheint die Anmeldung, nach erfolgreicher Anmeldung der Arbeitsbereich. Der gemeinsame **apiFetch**-Aufruf ergänzt den Bearer-Token. Bei HTTP 401 entfernt er ihn und meldet der App, dass wieder die Anmeldung angezeigt werden muss.

Die Ansichten beziehen ihre Daten je nach Bereich aus unterschiedlichen Quellen. [StatusKennzeichnung](components/StatusKennzeichnung.tsx) unterscheidet **live**, **teilweise** und **demo**; der Hinweis „teilweise“ muss angeben, welche Werte echt sind. Lokale [Beispieldaten](mock/README.md) sind keine API-Antworten. Der Haupteinstieg rendert derzeit [App](App.tsx); [ControlPlaneApp.tsx](ControlPlaneApp.tsx) enthält einen eigenen Control-Plane-Ladepfad, wird aber nicht von **main.tsx** eingebunden.

### Adapter und Ansichtsmodelle

Ein API-Adapter übersetzt die Antwortform der Dienste in die Datentypen, die eine Ansicht rendert. Der [Control-Plane-Adapter](api/control-plane-adapter.ts) versucht Projekte, Channels und Feeds zunächst über **/watcher-api** zu laden. Er akzeptiert nur JSON-Antworten; liefert der Pfad etwa HTML statt JSON, gilt der GoTray-Zugriff als nicht verfügbar. Danach verwendet der Adapter die typisierten REST-Aufrufe aus [synapse-client.ts](api/synapse-client.ts). Die Daten werden zu Projekt-, Channel- und Nachrichten-View-Modellen zusammengeführt.

Der separate [Control-Plane-Einstieg](ControlPlaneApp.tsx) lädt nach erfolgreicher Anmeldung einen Snapshot. Währenddessen bleiben die lokalen Startdaten sichtbar; Ladefehler werden als Fehlerzustand an die Ansicht gegeben. Diese Trennung verhindert, dass ein leerer oder fehlender API-Endpunkt wie eine echte leere Datenmenge aussieht. Die tatsächliche Abdeckung bleibt bereichsabhängig: ein vorhandener REST-Endpunkt bedeutet nicht automatisch, dass jede Ansicht ihn nutzt.

### Hauptagenten und Wissensansichten

Die [Runtime-Adapter](api/agent-runtime.ts) rufen die REST-Routen für Runtime-Status, Hauptagenten-Sitzungen, Nachrichtenaustausch und Terminalströme auf. Die Oberfläche verarbeitet Serverereignisse für Antworttext, Runtime-Status, Nutzung, Fehler und Artefakte. Die Laufzeit- und Sitzungsregeln stehen in der [Runtime-Dokumentation](../../rest-api/src/services/agent-runtime/README.md).

Wissensansichten erhalten über ihre Adapter benannte Einträge oder Suchergebnisse. Ein direkt geladener Memory-, Thought- oder Plan-Eintrag stammt aus dem gespeicherten Datensatz. Eine semantische Suche gibt dagegen Kandidaten aus dem Suchindex zurück, die die Core-Dienste gegen PostgreSQL-Daten auflösen.

## Schnittstellen nach außen

[App.tsx](App.tsx) ruft den Auth-Status ab und zeigt bei erfolgreicher Anmeldung [SynapseWorkspaceMock](components/README.md) als Arbeitsoberfläche. Die API-Adapter liegen getrennt in [api](api/README.md); ihre Daten werden in View-Modelle aus [control-plane](control-plane/README.md) überführt. Die Graph-Ansicht nutzt [graph](graph/README.md), die Agenten-Artefaktdarstellung [kios](kios/README.md).

## Abhängigkeiten

Die Einstiegsdateien verwenden React. Der Auth- und REST-Verkehr läuft über [api](api/README.md); lokale Musterwerte stammen aus [mock](mock/README.md). Die Paket- und Vite-Konfiguration steht in der [Paketübersicht](../README.md).

## Siehe auch

- [API-Adapter](api/README.md)
- [Komponenten](components/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
