# Moo-Daemon-Quellcode

[Synapse](../../../README.md) › [Pakete](../../README.md) › [Moo-FileWatcher-Daemon](../README.md) › Quellcode

## Zweck

Die Moo-Quelldateien bilden den Prozess für die ältere FileWatcher-Implementierung. Sie trennen Prozesskonfiguration, HTTP-Routen, wiederholtes Scannen der Projektdateien und Ignore-Regeln.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [config.moo](config.moo) | Verwaltet Port, Konfigurationsordner, Projektkonfiguration und Discovery-Dateien. |
| [daemon.moo](daemon.moo) | Startet den HTTP-Dienst und stellt Health-, Host- und Projektverwaltungsrouten bereit. |
| [ignore.moo](ignore.moo) | Lädt Ignore-Muster und entscheidet, ob ein Pfad aus der Überwachung ausgeschlossen wird. |
| [watcher.moo](watcher.moo) | Scannt Verzeichnisbäume, erkennt Änderungen und sendet Dateiereignisse weiter. |

## Schnittstellen nach außen

[daemon.moo](daemon.moo) stellt die HTTP-Routen bereit und startet Worker aus [watcher.moo](watcher.moo). Die Worker verwenden Konfiguration und Ignore-Entscheidungen, um Änderungen zu verfolgen; erkannte Ereignisse können an den REST-Dateiereignis-Endpunkt übermittelt werden.

## Abhängigkeiten

Der Quellcode nutzt Moo-Funktionen und Runtime-Builtins für Dateimetadaten, Verzeichnisoperationen und Prozesse. Die Tray-Clients sind im benachbarten [Tray-Ordner](../tray/README.md) dokumentiert; die alternative Implementierung liegt in [file-watcher-daemon-ts](../../file-watcher-daemon-ts/README.md).

## Siehe auch

- [Moo-FileWatcher-Daemon](../README.md)
- [Tray](../tray/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
