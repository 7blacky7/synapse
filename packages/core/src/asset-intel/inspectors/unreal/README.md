# Unreal-Formate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › Unreal

## Zweck

Die Unreal-Gruppe erkennt klassische Paketdateien sowie Pak- und IoStore-Dateien. Der Gruppenindex exportiert fünf Inspektoren für Paket, UEXP, PAK, UTOC und UCAS.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert Unreal-Inspektoren und paketbezogene Konstanten. |
| [`iostore.ts`](iostore.ts) | Stellt Inspektoren für UTOC- und UCAS-Dateien bereit. |
| [`lesen.ts`](lesen.ts) | Enthält Hilfen zum Lesen von Unreal-Strukturen. |
| [`package.ts`](package.ts) | Stellt den Inspektor für UASSET- und UMAP-Paketdateien bereit. |
| [`pak.ts`](pak.ts) | Stellt den PAK-Inspektor bereit. |
| [`uexp.ts`](uexp.ts) | Stellt den UEXP-Inspektor bereit. |

## Schnittstellen nach außen

Der Index stellt assetUnrealInspektoren sowie einzelne Inspektoren und Formatkonstanten bereit. Alle Ergebnisse folgen dem [Asset-Intel-Modell](../../types.ts).

## Abhängigkeiten

Die Gruppe ist Teil der gemeinsamen [Asset-Intel-Inspectoren](../README.md) und nutzt deren begrenzten Lese- und Ergebnisvertrag aus [Asset-Intel](../../README.md).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
