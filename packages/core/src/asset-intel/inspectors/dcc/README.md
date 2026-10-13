# DCC- und USD-Formate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › DCC

## Zweck

Diese Gruppe liest Blender-, FBX- und USD-Dateien. Der USD-Inspektor behandelt USD-, USDA- und USDC-Formate; USDZ wird über seine Dateiendung zugeordnet.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert die DCC-Inspektoren, Hilfsquellen und ihre gemeinsame Liste. |
| [`blend.ts`](blend.ts) | Stellt den Blender-Inspektor bereit. |
| [`fbx.ts`](fbx.ts) | Stellt den FBX-Inspektor für Binär- und ASCII-Dateien bereit. |
| [`hilfen.ts`](hilfen.ts) | Enthält Buffer- und Ausschnittquellen für DCC-Inspektionen. |
| [`usd.ts`](usd.ts) | Stellt den USD-Inspektor für USD, USDA und USDC bereit. |
| [`usdz.ts`](usdz.ts) | Stellt den USDZ-Inspektor bereit. |

## Schnittstellen nach außen

[index.ts](index.ts) exportiert assetDccInspektoren und die formatspezifischen Inspektoren. Die APIs verwenden den gemeinsamen [AssetInspector-Vertrag](../../types.ts).

## Abhängigkeiten

Die Familie arbeitet mit den Asset-Typen aus [Asset-Intel](../../README.md). Der übergeordnete [Inspector-Sammelordner](../README.md) führt ihre Liste mit den übrigen Gruppen zusammen.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
