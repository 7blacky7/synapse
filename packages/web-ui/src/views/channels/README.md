# Channel-Ansichten

[Synapse](../../../../README.md) › [Web-Oberfläche](../../README.md) › Views › Channels

## Zweck

Dieser Ordner enthält die projektbezogenen Channel-Ansichten der Web-Oberfläche. P26-T15 extrahiert die Channel-Nachrichten-Konstanten und die reine Nachrichtentext-Logik aus der bisherigen Workspace-Referenz; die Quelldatei bleibt dabei unverändert.

## Inhalt

| Datei | Zweck |
|---|---|
| [channel-nachrichten-konstanten.ts](channel-nachrichten-konstanten.ts) | Modulweite Bild-/Datei-Markierungs-RegExp und die einzige mockChannelImages-Map. |
| [channel-nachrichten-logik.ts](channel-nachrichten-logik.ts) | Zerlegt Channel-Nachrichten in Text-, Bild- und Dateipfade. |

## Funktionsweise und Schnittstellen

splitChannelMessageContent entfernt die bekannten [Bild: ...]- und [Datei: ...]-Marker aus dem Nachrichtentext und liefert die drei resultierenden Bereiche. Die RegExp-Objekte und die Map bleiben modulweit und werden von den zugehörigen Channel-Views importiert.

## Abhängigkeiten

Die Logik hängt ausschließlich vom Konstantenmodul ab. Beide neuen Dateien bleiben innerhalb der Web-UI und ändern keine Tools, API- oder Synapse-Module.

## Siehe auch

- [Web-UI-Views](../README.md)
- [Web-UI](../../README.md)
