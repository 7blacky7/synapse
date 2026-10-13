# File-Watcher-Daemon-Tests

[Synapse](../../../README.md) › File-Watcher-Daemon-Paket › Tests

## Zweck

Dieser Ordner enthält ein End-to-End-Szenario für den File-Watcher-Daemon. Es prüft die lokale HTTP-API, Dateisystemereignisse, mehrere überwachte Projekte, Worker-Neustarts und die Weiterleitung von Ereignissen an einen HTTP-Empfänger.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`e2e_scenarios.sh`](e2e_scenarios.sh) | Prüft Health- und Statusantworten, Projektregistrierung, Add/Modify/Delete-Ereignisse, Fehlerantworten, parallele Projekte, Neustart und Event-Forwarding mit einem Mock-Empfänger. |

## Schnittstellen nach außen

Das Szenario spricht mit dem Daemon über dessen lokale HTTP-Endpunkte und beobachtet dessen Logausgaben. Als Gegenstelle für weitergeleitete Dateiänderungen dient ein lokaler Mock-HTTP-Server. Die Daemon-Implementierung ist im [File-Watcher-Daemon-Paket](../README.md) beschrieben.

## Abhängigkeiten

Das Szenario benötigt Bash, `curl`, Python 3 für den Mock-Empfänger und eine gebaute Daemon-Binärdatei. Es verwendet lokale temporäre Testverzeichnisse, Log- und PID-Dateien sowie eine lokale Daemon-Konfiguration. Datenbankgestützte Tests im Projekt sind ausschließlich mit der Testdatenbank `synapse_test` und eigenen Testprojekten auszuführen; dieses Szenario prüft den Daemon über HTTP.

## Siehe auch

- [File-Watcher-Daemon-Paket](../README.md)
- [Daemon und Betriebsvarianten](../../../docs/README.md)
- [Core-Tests](../../core/tests/README.md)
