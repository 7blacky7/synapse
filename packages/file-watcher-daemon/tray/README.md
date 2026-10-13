# Synapse-Tray

[Synapse](../../../README.md) › [Pakete](../../README.md) › [Moo-FileWatcher-Daemon](../README.md) › Tray

## Zweck

Der Ordner enthält zwei getrennte Tray-Oberflächen: eine Go-Anwendung mit nativer Tray-Integration und eine Moo-Variante. Sie zeigen Synapse-Status und Projektinformationen und stellen Interaktionen mit API, Datenbank und FileWatcher bereit.

## Inhalt

### Go-Tray

| Datei | Aufgabe |
|---|---|
| [tray.go](tray.go) | Initialisiert die Tray-Anwendung, aktualisiert Menü und Ansichten und verbindet ihre UI-Aktionen. |
| [api_client.go](api_client.go) | Kommuniziert mit der Synapse-API über HTTP und verarbeitet Antworten der API-Clients. |
| [api_client_test.go](api_client_test.go) | Prüft Funktionen des Go-API-Clients. |
| [gpu_setup.go](gpu_setup.go) | Verwaltet GPU-Erkennung und -Konfiguration für die Go-Oberfläche. |
| [gpu_helfer_einstellungen.go](gpu_helfer_einstellungen.go) | Hält Einstellungen des GPU-Helfers. |
| [gpu_setup_test.go](gpu_setup_test.go) | Enthält Tests für GPU-Setup-Funktionen. |
| [gpu_helfer_basen_test.go](gpu_helfer_basen_test.go) | Enthält Basistests für GPU-Helfer. |
| [disk_free_unix.go](disk_free_unix.go) | Stellt freien Speicherplatz für Unix-Systeme bereit. |
| [disk_free_windows.go](disk_free_windows.go) | Stellt freien Speicherplatz für Windows bereit. |
| [lock_unix.go](lock_unix.go) | Implementiert plattformspezifische Sperren für Unix. |
| [lock_windows.go](lock_windows.go) | Implementiert plattformspezifische Sperren für Windows. |
| [proc_unix.go](proc_unix.go) | Implementiert Prozessabfragen für Unix. |
| [proc_windows.go](proc_windows.go) | Implementiert Prozessabfragen für Windows. |
| [start-watcher.sh](start-watcher.sh) | Enthält die Startanbindung des Watcher-Prozesses. |
| [go.mod](go.mod) | Definiert Go-Modul und direkte Abhängigkeiten des Tray-Programms. |
| [go.sum](go.sum) | Fixiert Prüfsummen der Go-Abhängigkeiten. |
| [icon.png](icon.png) | Bildressource des Tray-Symbols. |

### Moo-Tray und Datenbankzugriff

| Datei | Aufgabe |
|---|---|
| [tray.moo](tray.moo) | Implementiert die Moo-Tray-Oberfläche, Projektaktionen und Chat-/Statusansichten. |
| [pg_client.moo](pg_client.moo) | Implementiert den PostgreSQL-Wire-Protocol-Client für direkte Datenbankabfragen aus der Moo-Oberfläche. |
| [pg_test.moo](pg_test.moo) | Enthält Testcode für die Moo-PostgreSQL-Anbindung. |
| [user_chat_test.go](user_chat_test.go) | Enthält Tests zu Chatfunktionen der Go-Oberfläche. |

## Schnittstellen nach außen

Der Go-Tray spricht über [api_client.go](api_client.go) mit den HTTP-Endpunkten der Synapse-API und bezieht Status- und Agenteninformationen von dort. Die Moo-Oberfläche verwendet [pg_client.moo](pg_client.moo) für PostgreSQL-Abfragen und [tray.moo](tray.moo) für DateiWatcher- und Projektaktionen. Beide Ansätze bleiben getrennte Anwendungen und teilen sich einzelne Funktionsbereiche.

## Abhängigkeiten

Der Go-Tray basiert auf den in [go.mod](go.mod) festgelegten Bibliotheken; plattformspezifische Dateien kapseln Speicherplatz-, Prozess- und Sperroperationen. Die Moo-Variante benötigt die Moo-Laufzeit. Beide Oberflächen gehören zum [Moo-FileWatcher-Paket](../README.md), der aktuelle TypeScript-Daemon liegt separat in [file-watcher-daemon-ts](../../file-watcher-daemon-ts/README.md).

## Siehe auch

- [Moo-FileWatcher-Daemon](../README.md)
- [Moo-Daemon-Quellcode](../src/README.md)
- [TypeScript-Daemon](../../file-watcher-daemon-ts/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
