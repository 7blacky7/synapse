# C++-Fixture-Schnittstellen

[Synapse](../../../../README.md) › [Parser-Fixtures](../../../README.md) › [C++-Parser-Fixture](../../README.md) › [Header](../README.md) › cpp_fixture

## Zweck

Dieser Ordner definiert die Datentypen und Pipeline-Schnittstellen für die C++-Beispielcodebasis. Die Implementierungen liegen im Geschwisterordner [`src/`](../../src/README.md).

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`generator.hpp`](generator.hpp) | Definiert einen Generator für Werte der Pipeline. |
| [`meta.hpp`](meta.hpp) | Stellt Compile-Time- und Template-Hilfen bereit. |
| [`model.hpp`](model.hpp) | Deklariert Zustände, Kennzahlen und Entitäten der Fixture. |
| [`pipeline.hpp`](pipeline.hpp) | Deklariert Validierungs- und Transformationsstufen sowie Pipeline-Ausführungen. |

## Schnittstellen nach außen

[`pipeline.hpp`](pipeline.hpp) baut auf den Entitäten aus [`model.hpp`](model.hpp) und dem Generator aus [`generator.hpp`](generator.hpp) auf. [`meta.hpp`](meta.hpp) wird sowohl vom Modell als auch von der Pipeline verwendet.

## Abhängigkeiten

Die Header verwenden C++-Standardbibliotheken sowie interne Includes innerhalb von `cpp_fixture`.

## Siehe auch

- [Header-Ordner](../README.md)
- [Implementierungen](../../src/README.md)
- [C++-Fixture](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
