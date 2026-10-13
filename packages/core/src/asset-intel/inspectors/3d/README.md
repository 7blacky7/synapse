# 3D-Formate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › 3D

## Zweck

Diese Gruppe liest 3D-Geometrie- und Szenendateien. Der Sammelindex exportiert Inspektoren für glTF und GLB, OBJ, STL, PLY und DAE.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert die 3D-Inspektoren und bündelt sie als asset3dInspektoren. |
| [`dae.ts`](dae.ts) | Stellt den Inspektor für DAE-Dateien bereit. |
| [`gltf.ts`](gltf.ts) | Stellt glTF- und GLB-Inspektoren bereit und enthält JSON-Array-Hilfen. |
| [`helpers.ts`](helpers.ts) | Enthält gemeinsam verwendete Hilfen der 3D-Inspektoren. |
| [`obj.ts`](obj.ts) | Stellt den OBJ-Inspektor bereit. |
| [`ply.ts`](ply.ts) | Stellt den PLY-Inspektor bereit. |
| [`stl.ts`](stl.ts) | Stellt den STL-Inspektor bereit. |

## Schnittstellen nach außen

Der Sammelindex exportiert asset3dInspektoren sowie einzelne Inspektoren. Alle Implementierungen nutzen den AssetInspector-Vertrag aus [Asset-Intel-Typen](../../types.ts).

## Abhängigkeiten

[Asset-Intel](../../README.md) stellt die gemeinsame Registry und das Ergebnisformat bereit. Die übrigen Inspector-Gruppen sind unter [Inspectoren](../README.md) verzeichnet.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
