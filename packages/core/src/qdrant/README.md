# Qdrant

[Synapse](../../../../README.md) › [Core-Paket](../../../README.md) › [Quellcode](../README.md) › Qdrant

## Zweck

Dieser Bereich kapselt die Verbindung zum Qdrant-Vektorspeicher. Er verwaltet Sammlungen, prüft Dimensionen und bietet Operationen zum Einfügen, Suchen, Abrufen, Blättern und Löschen von Vektoren.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Re-exportiert die Funktionen der drei Qdrant-Module. |
| [`client.ts`](client.ts) | Erstellt den Qdrant-Client und prüft die Verbindung. |
| [`collections.ts`](collections.ts) | Prüft, erstellt, löscht und erfasst Kennzahlen von Sammlungen. |
| [`kennung-register.ts`](kennung-register.ts) | Registriert Sammlungsdimensionen und prüft Sammlungskennungen. |
| [`operations.ts`](operations.ts) | Führt Vektoroperationen und datei- oder projektbezogene Abfragen aus. |

## Schnittstellen nach außen

[`index.ts`](index.ts) bündelt Client-, Sammlungs- und Vektoroperationen. Dazu gehören `getQdrantClient`, `ensureCollection`, `insertVector`, `searchVectors`, Abruf- und Scroll-Funktionen sowie Löschoperationen. Das [Core-Paket](../index.ts) exportiert diese Schnittstelle weiter an API- und MCP-Komponenten.

## Abhängigkeiten

Die Qdrant-Clientbibliothek ist im [Core-Paket](../../package.json) deklariert. Die Verbindungseinstellungen stammen aus der [Core-Konfiguration](../config.ts); Vektordimensionen stimmen mit den vom [Embedding-Bereich](../embeddings/README.md) erzeugten Vektoren überein.

## Siehe auch

- [Embeddings](../embeddings/README.md)
- [Datenbank](../db/README.md)
- [Core-Quellcode](../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
