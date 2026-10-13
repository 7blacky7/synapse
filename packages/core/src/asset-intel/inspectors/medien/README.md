# Medienformate

[Synapse](../../../../../../README.md) › [Core](../../../../README.md) › [Quellcode](../../../README.md) › [Asset-Intel](../../README.md) › [Inspectoren](../README.md) › Medien

## Zweck

Die Mediengruppe extrahiert Eckdaten aus Audio- und Video-Containerformaten. Sie verwendet ffprobe vorrangig und bietet Header-Fallbacks in TypeScript, wenn ffprobe nicht verfügbar ist oder fehlschlägt.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert die Medien-Inspektoren und fasst deren gemeinsame Verarbeitung zusammen. |
| [`ffprobe.ts`](ffprobe.ts) | Ermittelt und startet ffprobe und übersetzt dessen Ergebnis. |
| [`gemeinsam.ts`](gemeinsam.ts) | Definiert gemeinsame Medienbefunde und Ergebnisbildung. |
| [`fallback-audio.ts`](fallback-audio.ts) | Enthält Header-Fallbacks für FLAC, MP3 und Ogg. |
| [`fallback-container.ts`](fallback-container.ts) | Enthält Header-Fallbacks für MKV und MP4. |
| [`fallback-riff.ts`](fallback-riff.ts) | Enthält Header-Fallbacks für AVI und WAV. |

## Schnittstellen nach außen

Der Gruppenindex stellt Medien-Inspektoren über assetMedienInspektoren bereit. Für die Ausführung gelten die [Asset-Intel-Typen](../../types.ts) und die gemeinsame [Asset-Intel-Pipeline](../../README.md).

## Abhängigkeiten

Die Erkennung und Ergebnisbildung verwendet AssetContext, AssetSource und AssetResult. Der [Inspector-Sammelordner](../README.md) gruppiert diese Familie neben den weiteren Formaterkennern.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../README.md)
- [Core-Paket](../../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../../docs/README.md)
