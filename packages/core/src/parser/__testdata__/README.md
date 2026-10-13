# Parser-Testdaten

[Synapse](../../../../../README.md) › [Core-Paket](../../../README.md) › [Core-Quellcode](../../README.md) › [Parser](../README.md) › Parser-Testdaten

## Zweck

Dieser Ordner enthält Quellbeispiele, mit denen Core-Tests konkrete Parser-Ergebnisse festhalten. Die Tests prüfen unter anderem Symbolzeilen, Kommentarbehandlung, Feld- und String-Erkennung sowie Aufrufkanten.

## Inhalt

| Datei | Geprüfter Bereich |
|---|---|
| [`sample-kommentare.kt`](sample-kommentare.kt) | Kotlin-Kommentarzeilen, mehrzeilige Kommentare und Negativfälle. |
| [`sample-kommentare.yaml`](sample-kommentare.yaml) | YAML-Kommentare, Block-Skalare und Zeichenfolgen, die keine Kommentare sind. |
| [`sample-kommentar-nachbarn.ts`](sample-kommentar-nachbarn.ts) | Benachbarte TypeScript-Kommentare und Zeilenanker. |
| [`sample-kommentare.sql`](sample-kommentare.sql) | SQL-Kommentarzeilen und Negativanker. |
| [`sample-felder-strings.ts`](sample-felder-strings.ts) | Feldsymbole, Referenzen und unterschiedlich lange String-Literale. |
| [`sample-pfeilfunktion-argument.ts`](sample-pfeilfunktion-argument.ts) | Zusagen für Aufrufkanten und verbotene Symbole rund um Pfeilfunktionen. |

## Schnittstellen nach außen

Die Beispiele werden von [Parser-Tests](../../../tests/README.md) direkt eingelesen und mit dem gebauten Parser aus [`parser/index.ts`](../index.ts) ausgewertet. Testdateien legen die erwarteten Ergebnisse als Kommentare und absolute Zeilenpositionen in den Beispielen ab.

## Abhängigkeiten

Die Tests hängen von den Parser-Ergebnissen in [Core](../../README.md) ab. Ihre Dateipfade werden in den Tests relativ zu deren Speicherort aufgelöst; die Testdaten sind keine Core-Module und werden im [TypeScript-Build](../../../tsconfig.json) ausgeschlossen.

## Siehe auch

- [Parser](../README.md)
- [Core-Tests](../../../tests/README.md)
- [Core-Paket](../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../docs/README.md)
