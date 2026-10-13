# Agent-Runtime-Dienste

[Synapse](../../../../../README.md) › [REST-API](../../../README.md) › [Quellcode](../../README.md) › [Dienste](../README.md) › Agent-Runtime

## Zweck

Dieser Ordner verwaltet die vom REST-API-Server angebotenen Hauptagenten-Runtimes. Der Manager verbindet Runtime-Treiber mit einer PostgreSQL-basierten Konfiguration und Sitzungsablage. Die Treiber bilden Codex, Claude Code und den Modell-Pool auf ein gemeinsames Runtime-Verhalten ab; Terminal- und Artefaktströme werden separat verwaltet.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`artefakt-tool.ts`](artefakt-tool.ts) | Orchestriert das Hauptagenten-Artefaktwerkzeug, Ablage und Zustellung. |
| [`artifact-stream.ts`](artifact-stream.ts) | Registriert offene Sitzungsströme und sendet Artefakt-Ereignisse gezielt an eine Sitzung. |
| [`claude-driver.ts`](claude-driver.ts) | Implementiert den Runtime-Treiber für Claude Code. |
| [`codex-driver.ts`](codex-driver.ts) | Implementiert den Runtime-Treiber für Codex. |
| [`free-pool-driver.ts`](free-pool-driver.ts) | Implementiert Anfragen an den erlaubten Modell-Pool ohne eigenen Runtime-Container. |
| [`manager.ts`](manager.ts) | Wählt Treiber aus, prüft Runtime-Status und verwaltet Zuweisung und Hauptagenten-Sitzungen. |
| [`repository.ts`](repository.ts) | Liest und schreibt Runtime-Konfiguration und Sitzungsdaten in PostgreSQL. |
| [`runtime-root.ts`](runtime-root.ts) | Bestimmt und prüft das persistente Basisverzeichnis der Container-Runtimes. |
| [`terminal-sessions.ts`](terminal-sessions.ts) | Verwaltet offene Terminal-Sitzungen, Ereignisse und deren Bereinigung. |
| [`types.ts`](types.ts) | Definiert Runtime-, Status-, Sitzungs-, Treiber- und Stream-Typen. |

## Schnittstellen nach außen

[`AgentRuntimeManager`](manager.ts) ist die zentrale API für [`routes/agent-runtimes.ts`](../../routes/agent-runtimes.ts). Alle Treiber implementieren [`AgentRuntimeDriver`](types.ts). Nachrichten liefern Runtime-Ereignisse; ein Artefakt wird über [`artifact-stream.ts`](artifact-stream.ts) nur an den Stream der zugehörigen Sitzung ausgegeben.

## Abhängigkeiten

Die Treiber verwenden [`@synapse/core`](../../../../core/README.md) für Modell-Pool-Funktionen und Datenzugriff, `dockerode` für Runtime-Container und Node-APIs für Prozess- und Stream-Verarbeitung. [`repository.ts`](repository.ts) verwendet den Core-Datenbankpool. Das gemeinsame Verhalten und die Datentypen sind in [`types.ts`](types.ts) festgelegt.

## Funktionsweise

### Auswahl und Sitzungszustand

Die [REST-Routen](../../routes/agent-runtimes.ts) prüfen interaktive Anfragen auf eine gültige Benutzer-Session. Sie akzeptieren dafür Access- oder Session-Tokens; Service-, Daemon- und Wrapper-Tokens sind für diese Runtime-Routen ausgeschlossen. Der [AgentRuntimeManager](manager.ts) bündelt drei Treiber: Codex, Claude Code und den Modell-Pool. Die zugewiesene Hauptagenten-Runtime und die Sitzungen liegen in [repository.ts](repository.ts) in PostgreSQL.

Eine neue Hauptagenten-Sitzung entsteht nur, wenn eine Runtime zugewiesen und installiert, laufend sowie authentifiziert ist. Sie beginnt im Status **ready**. Vor dem Nachrichtenaustausch beansprucht der Manager die Sitzung als **running**; eine bereits laufende Sitzung wird abgelehnt. Nach einer Antwort speichert er Runtime-Sitzungskennung und Kontext als **completed**. Ein Fehler hinterlegt den Status **error** und die letzte Fehlermeldung. Statusabfragen spiegeln beobachtete Container- und Authentifizierungszustände in die PostgreSQL-Konfiguration zurück.

### Treiber, Antwortstrom und Terminal

Codex und Claude Code laufen als CLI-Prozesse in Docker-Containern. Ihre Treiber prüfen Container, Installation und Anmeldung und stellen eine persistente Runtime-Umgebung bereit. Der Modell-Pool läuft ohne eigenen Container: er sendet HTTP-Anfragen an freigegebene Anbieter und trägt den Gesprächsverlauf im Synapse-Sitzungskontext. Er bietet deshalb kein Terminal; ein Terminalaufruf wird ausdrücklich abgelehnt.

Antworten des Hauptagenten laufen als Server-Sent Events an die jeweilige Sitzung. Der Strom unterscheidet Bereitschaft, Textdeltas, Runtime- und Nutzungsdaten, Fehler sowie Artefakte. Ein Artefakt wird nur in den offenen Strom seiner Sitzung eingespeist. Terminal-Sitzungen haben einen eigenen Registry-Eintrag: Ausgaben, Verbindungs- und Exit-Ereignisse werden zwischengespeichert und beim erneuten Verbinden wiedergegeben. Nicht mehr abonnierte oder beendete Sitzungen werden später bereinigt.

### Grenzen und Fehlerzustände

Die drei Laufzeitarten teilen die Schnittstelle, aber nicht ihre Ausführungsumgebung. Containerzustände wie **not_created**, **running**, **stopped** und **error** beschreiben Codex und Claude. Beim Modell-Pool bedeutet der Status **running**, dass mindestens ein Anbieter erreichbar ist; er beschreibt keinen Container. Eine fehlende Zuweisung, nicht erfüllte Bereitschaftsprüfung, ungültige Session oder nicht erreichbarer Anbieter beendet den jeweiligen Vorgang mit einem Fehler, statt eine andere Runtime stillschweigend zu verwenden.

## Siehe auch

- [REST-API-Dienste](../README.md)
- [Runtime-Routen](../../routes/README.md)
- [REST-API-Paket](../../../README.md)
- [Zusammenhang](../../../../../docs/README.md)
