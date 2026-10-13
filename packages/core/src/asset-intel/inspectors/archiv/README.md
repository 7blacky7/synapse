# Archiv- und SQLite-Formate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › Archive

## Zweck

Die Archivgruppe liest ZIP-, TAR-, 7z- und SQLite-Strukturen. Ihre Inspektoren werden im Sammelindex der Asset-Intel-Inspectoren in die gemeinsame Auswahl aufgenommen.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert die Archiv-Inspektoren und stellt assetArchivInspektoren bereit. |
| [`sevenzip.ts`](sevenzip.ts) | Liest Metadaten zu 7z-Archiven. |
| [`sicherheit.ts`](sicherheit.ts) | Enthält gemeinsame Sicherheitsprüfungen für Archivdaten. |
| [`sqlite.ts`](sqlite.ts) | Liest Strukturinformationen aus SQLite-Dateien. |
| [`tar.ts`](tar.ts) | Liest TAR-Archive einschließlich gzip-Variante. |
| [`zip.ts`](zip.ts) | Liest ZIP-Archive. |

## Schnittstellen nach außen

assetArchivInspektoren und einzelne Inspektoren werden aus [index.ts](index.ts) exportiert. Die gemeinsamen Ergebnis- und Quellverträge stehen in [Asset-Intel-Typen](../../types.ts).

## Abhängigkeiten

Die Inspektoren verwenden AssetSource für begrenzte Bytezugriffe und liefern AssetResult. Die gemeinsame Ausführung und Formatzuordnung liegen in [Asset-Intel](../../README.md).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
