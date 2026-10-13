# C++-Parser-Fixture

[Synapse](../../README.md) › [Parser-Fixtures](../README.md) › C++-Parser-Fixture

## Zweck

Dieser Ordner enthält ein eigenständiges C++20-Beispielprojekt mit gemeinsam genutzten Domänentypen und einer Pipeline aus Validierungs- und Transformationsstufen. Header und Implementierungen sind getrennt, damit Datei- und Symbolbezüge über mehrere Quelldateien hinweg vorliegen.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`Makefile`](Makefile) | Baut und startet die C++-Beispielanwendung. |
| [`include/`](include/README.md) | Header der Fixture, gruppiert unter `cpp_fixture`. |
| [`src/`](src/README.md) | Implementierungen und Programmeinstieg. |

## Schnittstellen nach außen

[`src/main.cpp`](src/main.cpp) erstellt Domänenobjekte und führt statische sowie dynamische Pipelines aus. Die öffentlichen Typen liegen in [`include/cpp_fixture/`](include/cpp_fixture/README.md); die Implementierungen ergänzen diese Deklarationen.

## Abhängigkeiten

Der Build verwendet C++20, `g++` als voreingestellten Compiler und Header aus `include`. Eine externe Laufzeitbibliothek ist im Makefile nicht eingetragen.

## Siehe auch

- [Parser-Fixtures](../README.md)
- [Header](include/README.md)
- [Quelldateien](src/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
