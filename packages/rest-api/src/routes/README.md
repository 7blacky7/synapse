# REST-API-Routen

[Synapse](../../../../README.md) › [REST-API](../../README.md) › [Quellcode](../README.md) › Routen

## Zweck

Die Route-Module verbinden HTTP-Pfade mit Core-Funktionen und den Diensten der REST-API. Die Route-Plugins werden über [`index.ts`](index.ts) exportiert und in [`server.ts`](../server.ts) registriert. Die Pfadfamilien unten sind in den jeweiligen Handlern deklariert.

## Inhalt

| Datei | Aufgabe und angebotene Pfade |
|---|---|
| [`agent-header.ts`](agent-header.ts) | Leitet eine Agentenkennung aus unterstützten Request-Headern ab; registriert selbst keine Route. |
| [`agent-runtimes.ts`](agent-runtimes.ts) | Runtime-Status, Konfiguration und Aktionen unter /api/agent-runtimes/:runtime/*; Terminal-Sessions sowie Main-Runtime und Sitzungen unter /api/main-agent/*. |
| [`agent-wissen.ts`](agent-wissen.ts) | Spezialistenwissen und System-Prompt unter /api/projects/:name/specialists/:specName/wissen/*; Gesundheitsübersicht unter /api/projects/:name/agent-wissen/health. |
| [`auth.ts`](auth.ts) | Web-UI-Authentifizierung unter /api/auth/*: Status, TOTP-Einrichtung und -Bestätigung, Verify, Service-Token, Logout und Session-Verwaltung. |
| [`code-intel.ts`](code-intel.ts) | /api/projects/:name/code-intel/{tree,functions,variables,symbols,references,search,file,statements,calls,flow,entrypoints}. |
| [`embedding-nodes.ts`](embedding-nodes.ts) | /api/embedding-nodes: Referenzvertrag, Registrierung, Knotenstatus, Heartbeat, Claims, Claim-Abschluss/-Freigabe und Sperrstatus. |
| [`files.ts`](files.ts) | POST, PUT und DELETE /api/projects/:name/files; Pfade werden vor den Handlern geprüft. |
| [`fs-events.ts`](fs-events.ts) | Nimmt Dateiänderungsereignisse über POST /api/fs/events entgegen. |
| [`graph.ts`](graph.ts) | /api/graph/overview sowie Projektabfragen /api/graph/projects/:name/{code,file,knowledge,knowledge-detail,timeline,diff}. |
| [`ideas.ts`](ideas.ts) | Idee speichern und bestätigen über /api/projects/:name/ideas und /api/projects/:name/ideas/confirm. |
| [`index.ts`](index.ts) | Re-exportiert die Route-Plugins als zentrale Registry. |
| [`intern-daemon.ts`](intern-daemon.ts) | Daemon-Befehle und Antworten über /api/intern/daemon/befehle und /api/intern/daemon/antwort. |
| [`mcp.ts`](mcp.ts) | MCP-Transport: GET /mcp/sse, POST /mcp/messages und Streamable-HTTP-JSON-RPC über POST /. |
| [`memory.ts`](memory.ts) | /api/projects/:name/memories: anlegen, lesen, auflisten, suchen, löschen und mit Code verknüpfen. |
| [`model-pool.ts`](model-pool.ts) | /api/model-pool: Modelle, Anbieter, Freigaben, Datenverwendung, Probe, Aktualisierung, Aliase, Cooldowns, Ereignisse und Zugangsdaten. |
| [`oauth.ts`](oauth.ts) | OAuth-Metadaten unter /.well-known/oauth-authorization-server und /.well-known/oauth-protected-resource; Clientregistrierung unter /register, Autorisierung unter /authorize und Token-Austausch unter /token. |
| [`projects.ts`](projects.ts) | /api/projects auflisten, /api/projects/init initialisieren sowie Projektplan lesen/ändern und Tasks ergänzen. |
| [`projekt-db.ts`](projekt-db.ts) | Projekt-Datenbank für ein Projekt über POST /api/projects/:name/projekt-db anlegen. |
| [`proposals.ts`](proposals.ts) | Vorschläge unter /api/projects/:name/proposals anlegen, auflisten, lesen, Status ändern, löschen und suchen. |
| [`search.ts`](search.ts) | Code-, Tech-Docs-, globale, Pfad- und Dokumentensuche samt Stream-Varianten unter /api/search/*. |
| [`shell.ts`](shell.ts) | Shell-Aufträge über POST /api/shell annehmen. |
| [`specialists.ts`](specialists.ts) | Spezialisten unter /api/projects/:name/specialists verwalten; Projektkanäle auflisten, Feed lesen sowie Nachrichten posten unter /api/projects/:name/channels/*. |
| [`stats.ts`](stats.ts) | Projektstatistiken und Detailstatistiken unter /api/projects/:name/stats und /api/projects/:name/stats/detailed. |
| [`status.ts`](status.ts) | API- und Projektstatus über GET /api/status bereitstellen. |
| [`tech.ts`](tech.ts) | Technologien erkennen und Tech-Dokumentation indexieren unter /api/tech/detect und /api/tech/index-docs. |
| [`thoughts.ts`](thoughts.ts) | Thoughts auflisten, anlegen, suchen und löschen unter /api/projects/:name/thoughts/*. |
| [`tray.ts`](tray.ts) | Agenten, Sessions und Channel-Informationen lesen sowie Projekt neu parsen oder einbetten unter /api/projects/:name/*. |
| [`workspaces.ts`](workspaces.ts) | Workspaces und Workspace-Rollen verwalten unter /api/workspaces, /api/workspace-roles und /api/projects/:name/workspace/*. |
| [`wrapper-bridge.ts`](wrapper-bridge.ts) | Spezialisten-Wrapper unter /api/projects/:name/specialists/:specName/*: Config, Wasserzeichen, Channel-Mitgliedschaft, Nachrichten, Inbox, Items, SSE-Stream und Health. |

## Schnittstellen nach außen

Die Route-Plugins werden von [`index.ts`](index.ts) zusammengeführt und von [`server.ts`](../server.ts) registriert. Der globale Auth-Hook prüft /api/* und /mcp/*; OAuth-Discovery und Web-UI-Auth sind vorgesehene Bootstrap-Wege.

## Abhängigkeiten

Die Handler rufen Core-Funktionen aus [`@synapse/core`](../../../core/README.md) sowie REST-interne Dienste aus [`services`](../services/README.md) auf. Fastify stellt Registrierung, Parameter, Requests und Responses bereit.

## Siehe auch

- [REST-API-Quellcode](../README.md)
- [Middleware](../middleware/README.md)
- [Dienste](../services/README.md)
