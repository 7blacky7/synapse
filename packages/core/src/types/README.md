# Gemeinsame Core-Typen

[Synapse](../../../../README.md) › [Core](../../README.md) › [Quellcode](../README.md) › Typen

## Zweck

Dieser Ordner bündelt gemeinsame Typdefinitionen des Core-Pakets. Er beschreibt Konfiguration, Code- und Medien-Chunks, Suchergebnisse, Projektpläne, Wissen, Datei-Ereignisse und weitere Datenverträge, die von mehreren Core-Bereichen verwendet werden.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert gemeinsame Interfaces für Core-Daten und das Objekt `COLLECTIONS` zur Benennung projektbezogener und globaler Qdrant-Sammlungen. |

## Schnittstellen nach außen

[`index.ts`](index.ts) exportiert unter anderem `SynapseConfig`, `CodeChunk`, `CodeChunkPayload`, `MediaChunkPayload`, `ProjectPlan`, `ProjectTask`, `Thought`, `DocEntry`, `SearchResult`, `FileEvent`, `EmbeddingResult`, `Proposal`, `ChannelMessage` und `InboxMessage`. `COLLECTIONS` stellt Namensfunktionen für projektspezifische Code-, Media-, Memory-, Thought-, Plan-, Proposal- und Dokumentationssammlungen sowie Konstanten für globale Sammlungen bereit.

[`config.ts`](../config.ts) verwendet `SynapseConfig` für die geladene Core-Konfiguration. Qdrant- und Backup-Komponenten greifen auf `COLLECTIONS` zurück, um die Sammlungsnamen konsistent zu bestimmen.

## Abhängigkeiten

Die Datei enthält gemeinsame TypeScript-Verträge und hängt für diese Typdefinitionen nicht von einem separaten Unterordner ab. Ihre Verträge verbinden unter anderem [Konfiguration](../config.ts), [Embeddings](../embeddings/README.md), [Qdrant](../qdrant/README.md) und [Datenbankmigrationen](../migrations/README.md).

## Siehe auch

- [Core-Quellcode](../README.md)
- [Core-Paket](../../README.md)
- [Datenbankmigrationen](../migrations/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
