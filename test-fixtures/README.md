# Test-Fixtures

[Synapse](../README.md) › Test-Fixtures

## Zweck

Dieser Ordner bündelt fest versionierte Eingabedateien für Tests. Der dokumentierte Teil enthält eine C++-Referenzdatei mit unabhängig festgelegten Sollwerten für die Parser-Erkennung.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`parser/`](parser/README.md) | Gruppiert die Parser-Referenzdateien nach Sprache. |

## Schnittstellen nach außen

Die C++-Referenzdatei liegt unter [`parser/cpp/`](parser/cpp/README.md). Ihr Kopfkommentar beschreibt die Sollzahlen und Fälle, die Parser-Tests gegen die Datei prüfen.

## Abhängigkeiten

Die Fixture-Dateien werden von den jeweils zugehörigen Tests eingelesen; sie sind Testdaten und keine Anwendungsmodule.

## Siehe auch

- [Parser-Fixtures](../parser-fixtures/README.md)
- [Core-Tests](../packages/core/tests/README.md)
- [Zusammenhang und Betriebsvarianten](../docs/README.md)
