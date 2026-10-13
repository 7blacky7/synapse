# Core-Quellcode

[Synapse](../../../README.md) › [Pakete](../../README.md) › [Core](../README.md) › Quellcode

## Zweck

`src` enthält die gemeinsam genutzte Implementierung des Core-Pakets. Die Einstiegspunkte laden die Konfiguration und bündeln Exporte aus spezialisierten Modulen, die unter anderem Datenbankzugriff, Parser, Dateiüberwachung, Embeddings und Vektorsuche bereitstellen.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`config.ts`](config.ts) | Lädt und verwaltet die Core-Konfiguration. |
| [`index.ts`](index.ts) | Bündelt die vom Paket nach außen angebotenen Funktionen und Typen. |
| [Asset-Intel](asset-intel/README.md) | Untersucht und verwaltet nicht als Quellcode behandelte Dateien. |
| [Chunking](chunking/README.md) | Teilt Text und Dateien in verarbeitbare Abschnitte. |
| [Datenbank](db/README.md) | Kapselt PostgreSQL-Verbindungen und Schemafunktionen. |
| [Embeddings](embeddings/README.md) | Stellt Embedding-Provider und gemeinsame Einbettungsfunktionen bereit. |
| [Guide-Inhalte](guide/README.md) | Hält die gemeinsam genutzten Tool-Beschreibungen. |
| [Migrationen](migrations/README.md) | Enthält Datenbank- und Pfad-Migrationslogik. |
| [Parser](parser/README.md) | Analysiert unterstützte Quell- und Datenformate. |
| [Qdrant](qdrant/README.md) | Kapselt Sammlungserstellung und Vektoroperationen. |
| [Dienste](services/README.md) | Enthält projektübergreifend genutzte Anwendungsdienste. |
| [Typen](types/README.md) | Definiert gemeinsam verwendete Datenstrukturen. |
| [Dateiüberwachung](watcher/README.md) | Beobachtet und klassifiziert Projektdateien. |

## Schnittstellen nach außen

[`index.ts`](index.ts) ist der zentrale Export-Einstieg von `@synapse/core`: Er re-exportiert unter anderem Konfigurationsfunktionen, Typen, Datenbankzugriff, Embeddings, Qdrant-Operationen, Chunking, Dateiüberwachung und Dienste. Dadurch können REST-API und MCP-Server die Core-Funktionen gemeinsam nutzen. [`config.ts`](config.ts) stellt das Laden, Abrufen und Zurücksetzen der Konfiguration bereit.

## Abhängigkeiten

Die Module verwenden die im [Core-Paket](../package.json) deklarierten Bibliotheken. Dazu zählen PostgreSQL über `pg`, der Qdrant-REST-Client und mehrere Provider- sowie Formatbibliotheken. Die fachlichen Bereiche sind im Quellbaum getrennt, ihre Paket-Schnittstelle wird jedoch in [`index.ts`](index.ts) gebündelt.

## Siehe auch

- [Core-Paket](../README.md)
- [Core-Dienste](services/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
