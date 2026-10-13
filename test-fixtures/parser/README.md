# Parser-Test-Fixtures

[Synapse](../../README.md) › [Test-Fixtures](../README.md) › Parser-Test-Fixtures

## Zweck

Dieser Ordner gruppiert versionierte Parser-Referenzdateien nach Sprache.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`cpp/`](cpp/README.md) | Enthält eine C++-Referenzdatei mit festgeschriebenen Parser-Sollwerten. |

## Schnittstellen nach außen

Die [C++-Referenzdatei](cpp/README.md) legt ihre erwarteten Symbole und Syntaxfälle im eigenen Kopfkommentar fest. Sie ist dafür geschrieben, Parserleistung an einer selbst erstellten Referenz zu prüfen.

## Abhängigkeiten

Die Dateien werden von Parser-Tests ausgewertet; die erwarteten Zahlen stammen aus der Fixture-Spezifikation und nicht aus dem laufenden Parser.

## Siehe auch

- [Test-Fixtures](../README.md)
- [C++-Referenz](cpp/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
