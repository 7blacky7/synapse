# REST-API

[Synapse](../../README.md) › REST-API

## Zweck

Dieses Paket stellt den Fastify-Server für die HTTP-Schnittstellen von Synapse bereit. Es bündelt REST-Routen, MCP über HTTP, Authentifizierung und OAuth sowie die optionale Auslieferung des Web-Dashboards. Beim Start initialisiert es Core, Parser- und Syntaxprüfer sowie – sofern aktiviert – Workspace- und Hintergrunddienste.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Beschreibt das ESM-Paket `@synapse/rest-api`, seine Build- und Startskripte sowie Laufzeitabhängigkeiten. |
| [`tsconfig.json`](tsconfig.json) | Legt die TypeScript-Konfiguration für den Paket-Build fest. |
| [`src`](src/README.md) | Einstiegspunkt, Fastify-Konfiguration, Middleware, Routen und API-Dienste. |

## Schnittstellen nach außen

Das Paket startet über [`src/index.ts`](src/index.ts) den Server aus [`src/server.ts`](src/server.ts). Der Server registriert die Module aus [`src/routes`](src/routes/README.md), den globalen Auth-Hook und den Fehlerhandler. Er bietet unter anderem `/health`, `/api`, projektbezogene API-Routen sowie MCP über `POST /`, `GET /mcp/sse` und `POST /mcp/messages`. Liegt ein Web-UI-Build vor, wird dieses aus demselben Server ausgeliefert.

## API-Contract für Web-UI-Clients

HTTP-Clients der Web-UI müssen bei API-Aufrufen den Header `X-Synapse-Contract-Version: 1` mitsenden. Die REST-API wertet ihn über `apiCapabilitiesForClient` aus; für Asset- und Daemon-Sync-Routen muss der ausgehandelte Contract das Feature `asset_sync` enthalten. Ohne passenden Header antworten diese Routen mit `426 vertrag_erforderlich`. Der Header gehört in jede Anfrage des Clients, nicht nur in den Capability-Aufruf.

## Abhängigkeiten

Das Paket verwendet [`@synapse/core`](../core/README.md) für Initialisierung, Datenbankzugriff und Fachfunktionen sowie Fastify und dessen CORS-/Static-Plugins für HTTP. Docker-Steuerung wird über `dockerode` für Workspace-, Prüfcontainer- und Runtime-Funktionen angebunden. OAuth/TOTP und Ausgabedaten verwenden unter anderem `otplib`, `qrcode` und `tar-stream`; Konfiguration wird über `dotenv` geladen.

## Siehe auch

- [Synapse-Pakete](../README.md)
- [REST-API-Quellcode](src/README.md)
- [Zusammenhang](../../docs/README.md)
