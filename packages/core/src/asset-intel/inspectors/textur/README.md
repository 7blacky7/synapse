# Bild- und Texturformate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › Texturen

## Zweck

Die Texturgruppe liest Format- und Bildmerkmale aus PNG, JPEG, WebP, DDS, KTX, KTX2, OpenEXR und Radiance HDR. Die Formaterkennung beruht auf den Inspektoren und ihrer Registrierung.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert alle Textur-Inspektoren als assetTexturInspektoren. |
| [`dds.ts`](dds.ts) | Stellt den DDS-Inspektor bereit. |
| [`exr.ts`](exr.ts) | Stellt den OpenEXR-Inspektor bereit. |
| [`formate.ts`](formate.ts) | Enthält gemeinsame Angaben zu Texturformaten. |
| [`hdr.ts`](hdr.ts) | Stellt den Radiance-HDR-Inspektor bereit. |
| [`jpeg.ts`](jpeg.ts) | Stellt den JPEG-Inspektor bereit. |
| [`ktx.ts`](ktx.ts) | Stellt den KTX-Inspektor bereit. |
| [`ktx2.ts`](ktx2.ts) | Stellt den KTX2-Inspektor bereit. |
| [`png.ts`](png.ts) | Stellt den PNG-Inspektor bereit. |
| [`util.ts`](util.ts) | Enthält Hilfsfunktionen für die Textur-Inspektoren. |
| [`webp.ts`](webp.ts) | Stellt den WebP-Inspektor bereit. |

## Schnittstellen nach außen

Der Sammelindex exportiert assetTexturInspektoren und die einzelnen Inspektoren. Die Resultate folgen dem gemeinsamen [Asset-Intel-Ergebnisformat](../../types.ts).

## Abhängigkeiten

Die Inspektoren werden in der [Asset-Intel-Pipeline](../../README.md) verwaltet. Ihre Liste wird vom übergeordneten [Inspector-Sammelordner](../README.md) zusammengeführt.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
