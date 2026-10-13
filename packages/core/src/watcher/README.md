# Dateiüberwachung

[Synapse](../../../../README.md) › [Core-Paket](../../../README.md) › [Quellcode](../README.md) › Dateiüberwachung

## Zweck

Der Watcher-Bereich beobachtet Projektdateien und meldet Änderungen über definierte Ereignisse. Dazu gehören außerdem Pfadfilter, Datei- und Medientypklassifizierung sowie die Erkennung bestimmter Dateiköpfe.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Startet den Datei-Watcher und definiert seine Optionen und Instanz. |
| [`binary.ts`](binary.ts) | Erkennt Binärdateien, Medien und extrahierbare Dokumente und klassifiziert Dateitypen. |
| [`ignore.ts`](ignore.ts) | Kombiniert Git- und Synapse-Ignorierregeln und erklärt Treffer. |
| [`skip-meldung.ts`](skip-meldung.ts) | Dedupliziert Meldungen für wiederholt übersprungene Dateien. |

## Schnittstellen nach außen

[`index.ts`](index.ts) exportiert `startFileWatcher`, `readFileWithMetadata` und die Klassifizierungsfunktionen aus [`binary.ts`](binary.ts). Optionen für den Start enthalten Projektpfad, Projektkennung und Änderungs- sowie Fehler-Callbacks. Die Ignore-Funktionen sind ebenfalls über den [Core-Einstieg](../index.ts) erreichbar.

## Abhängigkeiten

Der Watcher verwendet [Chokidar](../../package.json) zur Dateisystembeobachtung und die Bibliothek `ignore` für regelbasierte Pfadfilter. Konfiguration, gemeinsame Ereignistypen und Worker-Steuerung stammen aus dem Core-Quellcode. Die Klassifizierung unterstützt den nachgelagerten Datei- und [Asset-Intel-Bereich](../asset-intel/README.md).

## Siehe auch

- [Core-Quellcode](../README.md)
- [Chunking](../chunking/README.md)
- [Embeddings](../embeddings/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
