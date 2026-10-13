# Core-Paket

[Synapse](../../README.md) › [Pakete](../README.md) › Core

## Zweck

Das Paket `@synapse/core` stellt den gemeinsamen Anwendungskern für MCP-Server und REST-API bereit. Es bündelt unter anderem Konfiguration, Datenbank- und Vektorspeicherzugriff, Embeddings, Dateiüberwachung und die gemeinsam genutzten Dienste.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Beschreibt das Paket `@synapse/core`, seinen TypeScript-Build und die Laufzeitabhängigkeiten. |
| [`tsconfig.json`](tsconfig.json) | Begrenzt den TypeScript-Build auf `src` und schließt Parser-Testdaten aus. |
| [Daten](data/README.md) | Enthält Seed-Daten für Entscheidungstopf und Erklärungstopf. |
| [Skripte](scripts/README.md) | Enthält Hilfs- und Probeprogramme rund um Core-Daten und Assets. |
| [Quellcode](src/README.md) | Enthält die Core-Einstiegsdatei und die fachlichen Module. |
| [Tests](tests/README.md) | Prüft Core-Funktionen und ihre Integrationen. |

## Schnittstellen nach außen

Der Paket-Einstieg [`src/index.ts`](src/index.ts) exportiert gemeinsame Funktionen und Typen aus Konfiguration, Datenbank, Qdrant, Embeddings, Chunking, Dateiüberwachung und weiteren Core-Bereichen. REST-API und MCP-Server greifen dadurch auf dieselbe Implementierung zu. Die Paketmetadaten verweisen auf die gebauten Ein- und Typdateien unter `dist`.

## Abhängigkeiten

Die Laufzeitabhängigkeiten in [`package.json`](package.json) umfassen unter anderem den Qdrant-Client für Vektorspeicherung, `pg` für PostgreSQL, `openai` für Embedding-Provider sowie Parser- und Dateiformatbibliotheken. Die konkreten Datenbank- und Vektorspeichermodule sind in [`src/db`](src/db/README.md) und [`src/qdrant`](src/qdrant/README.md) eingeordnet.

## Siehe auch

- [Core-Quellcode](src/README.md)
- [REST-API](../rest-api/README.md)
- [MCP-Server](../mcp-server/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
