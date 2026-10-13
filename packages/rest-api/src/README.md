# REST-API-Quellcode

[Synapse](../../../README.md) › [REST-API](../README.md) › Quellcode

## Zweck

Dieser Ordner enthält den Einstiegspunkt und die Zusammensetzung des Fastify-Servers. `server.ts` richtet globale HTTP-Verarbeitung ein, registriert Middleware und Route-Module und startet die zentralen API-Dienste.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Lädt die Umgebungsvariablen, startet den Server und beendet den Prozess bei einem fatalen Startfehler. |
| [`server.ts`](server.ts) | Erstellt Fastify, registriert CORS, Authentifizierung, Fehlerbehandlung, Routen und optionale Hintergrunddienste. |
| [`middleware`](middleware/README.md) | Gemeinsamer Auth-Hook und globaler Fehlerhandler. |
| [`routes`](routes/README.md) | REST-, OAuth-, MCP- und ergänzende HTTP-Routen. |
| [`services`](services/README.md) | Dienste für Auth, Embeddings, Parser, Prüfcontainer, Workspaces und Streams. |

## Schnittstellen nach außen

[`createServer()`](server.ts) liefert eine konfigurierte Fastify-Instanz; [`startServer()`](server.ts) initialisiert Core und die aktivierten API-Dienste und startet den Listener. Die Route-Registry [`routes/index.ts`](routes/index.ts) exportiert die in `server.ts` registrierten Route-Plugins. Der globale Hook schützt API- und MCP-Pfade mit den vorgesehenen Bootstrap- und Stream-Ausnahmen.

## Abhängigkeiten

Der Server bezieht Konfiguration, Pool und Initialisierung aus [`@synapse/core`](../../core/README.md). Fastify samt CORS und Static-Plugin stellt den HTTP-Rahmen bereit. Laufzeitoptionen werden aus Umgebungsvariablen gelesen; externe Prozess- und Containerfunktionen liegen in den Diensten.

## Siehe auch

- [REST-API-Paket](../README.md)
- [Routen](routes/README.md)
- [REST-API-Dienste](services/README.md)
- [Zusammenhang](../../../docs/README.md)
