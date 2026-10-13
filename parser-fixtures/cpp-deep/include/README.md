# C++-Header

[Synapse](../../../README.md) › [Parser-Fixtures](../../README.md) › [C++-Parser-Fixture](../README.md) › Header

## Zweck

Dieser Ordner bündelt die Header der C++-Fixture. Die Deklarationen liegen im Unterordner `cpp_fixture` und werden von den Quelldateien eingebunden.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`cpp_fixture/`](cpp_fixture/README.md) | Domänen-, Meta- und Pipeline-Schnittstellen der Beispielcodebasis. |

## Schnittstellen nach außen

Die Header im Unterordner werden von den Quelldateien über `cpp_fixture/...` eingebunden; die Include-Suchwurzel setzt das [Makefile](../Makefile).

## Abhängigkeiten

Die Header referenzieren einander innerhalb des Beispiels und nutzen C++-Standardbibliotheken.

## Siehe auch

- [C++-Fixture](../README.md)
- [Headerdateien](cpp_fixture/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
