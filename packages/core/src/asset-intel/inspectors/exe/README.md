# Ausführbare Dateiformate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › Ausführbare Dateien

## Zweck

Die Gruppe liest Metadaten aus ausführbaren Dateien der Formate ELF und PE. Der Sammelindex exportiert beide Inspektoren als gemeinsame Gruppe.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert ELF- und PE-Inspektoren als assetExeInspektoren. |
| [`elf.ts`](elf.ts) | Stellt den Inspektor für ELF-Dateien bereit. |
| [`pe.ts`](pe.ts) | Stellt den Inspektor für PE-Dateien bereit. |
| [`util.ts`](util.ts) | Enthält Hilfsfunktionen für die EXE-Inspektoren. |

## Schnittstellen nach außen

Der Index exportiert assetExeInspektoren sowie die Inspektoren für ELF und PE. Sie erfüllen den gemeinsamen [AssetInspector-Vertrag](../../types.ts).

## Abhängigkeiten

Die Inspektoren liefern Ergebnisse an die begrenzte Ausführung in [Asset-Intel](../../README.md) und werden im [Inspector-Sammelordner](../README.md) eingebunden.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
