# Middleware

[Synapse](../../../../README.md) › [REST-API](../../README.md) › [Quellcode](../README.md) › Middleware

## Zweck

Die Middleware stellt serverweite HTTP-Verarbeitung bereit: Authentifizierung vor den Routen und eine einheitliche Fehlerantwort. Der Auth-Hook validiert Bearer-Tokens über den Auth-Dienst und behandelt ausdrücklich freigegebene Bootstrap-, OAuth-, Web-UI- und SSE-Wege gesondert.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`auth-hook.ts`](auth-hook.ts) | Prüft Zugriffe auf `/api/*` und `/mcp/*`, validiert Tokens und enthält die Allowlist sowie die SSE-Authentifizierung. |
| [`error.ts`](error.ts) | Wandelt Fastify-Fehler in eine Antwort mit `success: false`, Meldung und Fehlercode um. |

## Schnittstellen nach außen

[`registerAuthHook()`](auth-hook.ts) hängt den globalen `onRequest`-Hook in Fastify ein. Der Hook nutzt [`validateToken()`](../services/auth.ts) aus dem Auth-Dienst. [`errorHandler()`](error.ts) wird als Fastify-Error-Handler registriert und sendet den HTTP-Status des Fehlers samt standardisiertem JSON-Körper.

## Abhängigkeiten

Beide Module hängen an Fastifys Request-, Reply- und Servertypen. Der Auth-Hook bezieht die Tokenprüfung aus [`services/auth.ts`](../services/README.md); Registrierung und Reihenfolge der globalen Middleware liegen in [`server.ts`](../server.ts).

## Siehe auch

- [REST-API-Quellcode](../README.md)
- [REST-API-Routen](../routes/README.md)
- [Dienste](../services/README.md)
