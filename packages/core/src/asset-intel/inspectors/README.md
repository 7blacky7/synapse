# Asset-Inspectoren

[Synapse](../../../../../README.md) › [Core](../../../README.md) › [Quellcode](../../README.md) › [Asset-Intel](../README.md) › Inspectoren

## Zweck

Die Inspector-Unterordner enthalten die formatspezifischen Leser für Binärdateien. Der Sammelindex führt ihre Gruppenlisten zu einer gemeinsamen Auswahl zusammen, die Asset-Intel in die Standard-Registry einträgt. Jede Familie dokumentiert ihre Formate und Hilfsmodule separat.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Exportiert die sieben Inspector-Listen und bündelt sie in alleInspektoren. |
| [3D](3d/README.md) | Liest Geometrie- und Szenenformate. |
| [Archive](archiv/README.md) | Liest Archiv- und SQLite-Strukturen. |
| [DCC](dcc/README.md) | Liest Austausch- und Projektdateien aus 3D- und Content-Werkzeugen. |
| [Ausführbare Dateien](exe/README.md) | Liest Strukturen von ELF- und PE-Dateien. |
| [Medien](medien/README.md) | Liest Audio- und Mediencontainer-Metadaten. |
| [Texturen](textur/README.md) | Liest Bild- und Texturformate. |
| [Unreal](unreal/README.md) | Liest Paket-, Pak- und IoStore-Dateien aus Unreal-Projekten. |

## Schnittstellen nach außen

[index.ts](index.ts) exportiert die einzelnen Listen und stellt deren Zusammenführung als alleInspektoren bereit. Die übergeordnete [Asset-Intel-Registry](../registry.ts) übernimmt diese Liste; die Dateierkennung richtet sich nach Magic Bytes und Dateiendungen.

## Abhängigkeiten

Alle Familien implementieren den Vertrag aus [Asset-Intel-Typen](../types.ts) und werden über [Asset-Intel](../index.ts) eingebunden. Für das Gesamtergebnis und die begrenzte Ausführung siehe [Asset-Intel](../README.md).

## Siehe auch

- [Asset-Intel](../README.md)
- [Core-Quellcode](../../README.md)
- [Core-Paket](../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../docs/README.md)
