# Chunking

[Synapse](../../../../README.md) › [Core-Paket](../../../README.md) › [Quellcode](../README.md) › Chunking

## Zweck

Dieses Modul zerlegt lange Texte in überlappende Abschnitte für die Embedding-Pipeline. Es hält Start- und Endzeilen fest, damit jeder Abschnitt seiner Position im Quelldokument zugeordnet bleibt.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Definiert Chunk-Optionen und Chunk-Daten sowie die Funktionen `chunkText` und `chunkFile`. |

## Schnittstellen nach außen

[`chunkText`](index.ts) teilt Text anhand der Zeichenlimits und Überlappung in `TextChunk`-Werte. `chunkFile` ergänzt die Chunks um Dateipfad und Projektkennung. Beide Funktionen sind über den [Core-Einstieg](../index.ts) exportiert.

## Abhängigkeiten

Das Modul liest die Standardwerte für Chunkgröße und Überlappung aus der Core-Konfiguration in [`config.ts`](../config.ts). Es benötigt keine weitere externe Bibliothek.

## Siehe auch

- [Embeddings](../embeddings/README.md)
- [Core-Quellcode](../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
