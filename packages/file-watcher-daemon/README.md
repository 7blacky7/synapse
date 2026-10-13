# Moo-FileWatcher-Daemon

[Synapse](../../README.md) › [Pakete](../README.md) › Moo-FileWatcher-Daemon

## Zweck

Dieses Paket enthält die ältere, eigenständige Moo-Variante des FileWatchers sowie die Tray-Oberflächen. Der Moo-Daemon pollt registrierte Projektordner, erkennt Dateiänderungen und kann Änderungsereignisse per HTTP an die REST-API weitergeben. Der TypeScript-Daemon ist ein separates Paket mit direkter Core-Anbindung und zusätzlichen Hintergrund-Workern.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [Moo-Quellcode](src/README.md) | Beschreibt Daemon-Start, Konfiguration, Polling und Dateiausschlussregeln. |
| [Tray](tray/README.md) | Enthält Go- und Moo-Oberflächen zur Anzeige und Steuerung von Synapse. |
| [End-to-End-Szenarien](tests/e2e_scenarios.sh) | Enthält Shell-Szenarien für die Integration des FileWatchers. |
| [.gitignore](.gitignore) | Schließt generierte Daemon-Artefakte aus der Versionsverwaltung aus. |

## Schnittstellen nach außen

Der Moo-Daemon stellt eine HTTP-API für Status und Projektverwaltung bereit. Seine Worker melden Dateiereignisse an den REST-Endpunkt für Dateisystemereignisse; der REST-Dienst delegiert die Indexierung und Entfernung von Dateien an Core-Funktionen. Die Tray-Oberflächen sind separate Prozesse, die API beziehungsweise Daemon-Discovery nutzen.

## Abhängigkeiten

Der Daemon verwendet die Moo-Laufzeit und deren Dateisystemfunktionen. Die aktuelle TypeScript-Implementierung liegt in [file-watcher-daemon-ts](../file-watcher-daemon-ts/README.md). Der REST-Empfänger für Dateiänderungen befindet sich im [REST-API-Paket](../rest-api/README.md).

## Siehe auch

- [Moo-Quellcode](src/README.md)
- [Tray](tray/README.md)
- [TypeScript-FileWatcher-Daemon](../file-watcher-daemon-ts/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
