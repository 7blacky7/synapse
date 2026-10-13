# Architekturbilder

[Synapse](../../README.md) › [Dokumentation](../README.md) › Bilder

## Zweck

Die sechs eigenständigen SVGs visualisieren den Zusammenhang der implementierten Komponenten. Die [Zusammenhangsseite](../README.md) erläutert die Varianten und verlinkt ihre Ordnerdokumentation.

## Inhalt

| Datei | Aufgabe |
| --- | --- |
| [ueberblick.svg](ueberblick.svg) | Zugänge, Core und Datenhaltung |
| [lokal.svg](lokal.svg) | stdio-MCP und bidirektionale Dateisynchronisation |
| [web.svg](web.svg) | HTTP-MCP, Web-UI und vorgeschalteter Tunnel |
| [agenten.svg](agenten.svg) | Channels, Events, Wrapper, externer Codex-Weg und Jev |
| [ausfuehrung.svg](ausfuehrung.svg) | Shell-Zielwahl und separater Syntaxprüfcontainer |
| [embedding.svg](embedding.svg) | Parser, Chunks, Claims, Ollama und Qdrant |

### Gesamtbild

![Zugänge, Core und Datenhaltung](ueberblick.svg)

### Lokale KI

![stdio-MCP und bidirektionale Dateisynchronisation](lokal.svg)

### Web-Zugang

![HTTP-MCP, Web-UI und vorgeschalteter Tunnel](web.svg)

### Agententeam

![Channels, Events, Wrapper, externer Codex-Weg und Jev](agenten.svg)

### Ausführung

![Shell-Zielwahl und separater Syntaxprüfcontainer](ausfuehrung.svg)

### Embedding

![Parser, Chunks, Claims, Ollama und Qdrant](embedding.svg)

## Quellen der Verbindungen

Die folgenden Codepfade belegen die Kanten. Die SVG-Beschreibungen enthalten zusätzlich Zeilenbereiche des gelesenen Stands; Dateilinks bleiben auch bei späteren Zeilenverschiebungen verwendbar.

| Bild | Belege |
| --- | --- |
| Gesamtbild | [MCP-Server](../../packages/mcp-server/src/server.ts), [HTTP-MCP](../../packages/rest-api/src/routes/mcp.ts), [PG-Client](../../packages/core/src/db/client.ts), [Qdrant-Client](../../packages/core/src/qdrant/client.ts) |
| Lokal | [stdio-Transport](../../packages/mcp-server/src/server.ts), [Daemon-Worker und Sync](../../packages/file-watcher-daemon-ts/src/main.ts), [Watcher-Manager](../../packages/file-watcher-daemon-ts/src/manager.ts) |
| Web | [API-Server: Auth, Routen, statische Web-UI](../../packages/rest-api/src/server.ts), [Web-UI-Client](../../packages/web-ui/src/api/synapse-client.ts), [Container-Komposition](../../docker-compose.yml) |
| Agenten | [Channel-Polling im Wrapper](../../packages/agents/src/wrapper.ts), [CLI-Prozessstart](../../packages/agents/src/process.ts), [Channels](../../packages/core/src/services/channels.ts), [Events](../../packages/core/src/services/events.ts), [Jev](../../packages/core/src/services/jev-entscheidung.ts), [cc-send-Anbindung](../../scripts/codex-kontext-hook.mjs), [Abgrenzung cc-wrap](../../AGENTS.md) |
| Ausführung | [REST-Shell-Routing](../../packages/rest-api/src/routes/mcp.ts), [Daemon-Shell-Worker](../../packages/file-watcher-daemon-ts/src/main.ts), [Prüfcontainer-Adapter](../../packages/rest-api/src/services/pruef-container.ts) |
| Embedding | [Code-Pipeline](../../packages/core/src/services/code.ts), [Server-Worker](../../packages/rest-api/src/services/parser-worker.ts), [Compute-Node](../../packages/compute-node-agent/src/index.ts), [Claim-Abschluss und Qdrant](../../packages/core/src/services/embedding-claims.ts), [Modellprofil](../../scripts/p15-t8-modellprofile-startwerte.sql) |

## Schnittstellen nach außen

Die SVGs werden als relative Markdown-Bilder eingebunden. Sie enthalten keine Skripte, externen Schriftdateien oder nachgeladenen Bildressourcen. Ein fester schwarzer Hintergrund (#0d0d0d), leicht abgesetzte Kästen (#1a1a1a), orangene Akzente (#ff8c1a) und helle Beschriftungen erhalten den Kontrast in hellen und dunklen GitHub-Themes. Der Textkontrast beträgt mindestens 14,20:1 für Fließtext, 10,30:1 für Nebentext und 7,47:1 für Orange. Die Schriftgrößen liegen zwischen 16 und 32 px; alle Bilder besitzen Titel und Beschreibung.

Pfeile zeigen die jeweils beschrifteten Aufrufe oder Datenwege, keine vollständige zeitliche Ablaufspur. Doppelpfeile im Embedding-Bild fassen Arbeitsvergabe und Ergebnisrückgabe zusammen. Kurz gepunktete Konturen gruppieren Datenspeicher sowie ergänzende oder optionale Komponenten. Lange Striche kennzeichnen externe Komponenten und Wege, insbesondere den externen cc-wrap-Weg; im Web-Bild markieren sie den vorgeschalteten Cloudflare-Tunnel.

## Abhängigkeiten

SVG-fähige Markdown-/Browserdarstellung genügt. Die PNG-Vorschauen zur Sichtprüfung sind temporäre Renderartefakte und gehören nicht zum Repository.

## Siehe auch

- [Zusammenhang und Varianten](../README.md)
- [Paketverzeichnis](../../packages/README.md)
- [Architekturkonzepte](../konzepte/README.md)
