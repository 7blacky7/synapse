# C++-Parser-Referenz

[Synapse](../../../README.md) › [Test-Fixtures](../../README.md) › [Parser-Test-Fixtures](../README.md) › C++

## Zweck

Dieser Ordner enthält eine selbst erstellte C++-Referenzdatei mit unabhängig festgelegten Sollwerten. Sie hält fest, welche Funktionen, Typen, Namespaces und Includes der Parser erkennen soll und welche Fälle nicht als eigene Funktionen zählen dürfen.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`referenz.cpp`](referenz.cpp) | C++-Referenz mit 24 erwarteten Funktionssymbolen, ergänzenden Symbolgruppen und Negativfällen. |

## Schnittstellen nach außen

Die Datei dient Parser-Tests als Eingabe und dokumentiert die Sollwerte direkt am Quelltext. Die Beschreibungen im Kopfkommentar erklären außerdem die Zählregeln für Definitionen, Deklarationen und Lambdas.

## Abhängigkeiten

Die Referenz nutzt keine externe Projektbibliothek; sie ist ein eigenständiger C++-Quelltext als Prüfmaterial.

## Siehe auch

- [Parser-Test-Fixtures](../README.md)
- [C++-Parser-Fixtures](../../../parser-fixtures/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
