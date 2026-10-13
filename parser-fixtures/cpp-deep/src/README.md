# C++-Implementierungen

[Synapse](../../../README.md) › [Parser-Fixtures](../../README.md) › [C++-Parser-Fixture](../README.md) › Quelldateien

## Zweck

Dieser Ordner enthält die Implementierungen und den Einstieg der C++-Fixture. Gemeinsam zeigen sie Verbindungen zwischen der Domänenlogik und den Pipeline-Schnittstellen.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`main.cpp`](main.cpp) | Erstellt Beispieldaten und führt statische und dynamische Pipelines aus. |
| [`model.cpp`](model.cpp) | Implementiert Entitäten, Zustandsübergänge und Domänenoperationen. |
| [`pipeline.cpp`](pipeline.cpp) | Implementiert Validierung, Transformation und die Verarbeitungsschritte. |

## Schnittstellen nach außen

Die Dateien implementieren die Deklarationen in [`include/cpp_fixture/model.hpp`](../include/cpp_fixture/model.hpp) und [`include/cpp_fixture/pipeline.hpp`](../include/cpp_fixture/pipeline.hpp). [`main.cpp`](main.cpp) verbindet die bereitgestellten Typen und Stufen.

## Abhängigkeiten

Alle drei Dateien binden Header aus [`include/cpp_fixture/`](../include/cpp_fixture/README.md) und verwenden C++-Standardbibliotheken.

## Siehe auch

- [C++-Fixture](../README.md)
- [Header](../include/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
