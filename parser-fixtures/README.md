# Parser-Fixtures

[Synapse](../README.md) › Parser-Fixtures

## Zweck

Dieser Ordner sammelt eine eigenständige, verschachtelte C++-Beispielcodebasis. Die Unterteilung in Header und Implementierungen bildet zusammenhängende Typen und Abläufe ab, die sich für Parser- und Codeindex-Beispiele eignen.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`cpp-deep/`](cpp-deep/README.md) | C++-Beispiel mit Makefile, Headern und Quelldateien in getrennten Unterordnern. |

## Schnittstellen nach außen

Die Beispielcodebasis ist als eigener C++-Baum organisiert. [`cpp-deep/Makefile`](cpp-deep/Makefile) verwendet die Header in `include/cpp_fixture` und die Implementierungen in `src`.

## Abhängigkeiten

Das Makefile nutzt einen C++20-Compiler und Standardbibliotheken; die Quelldateien umfassen die im Beispiel verwendeten Typ- und Pipeline-Header.

## Siehe auch

- [C++-Fixture](cpp-deep/README.md)
- [Test-Fixtures](../test-fixtures/README.md)
- [Zusammenhang und Betriebsvarianten](../docs/README.md)
