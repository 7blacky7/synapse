# Erklärungsmessung

[Synapse](../../README.md) › [Skripte](../README.md) › Erklärungsmessung

## Zweck

Dieser Ordner enthält die Datenbasis und Messskripte für die Qualität und Sprachwahl von Fehlererklärungen. Das Korpus wird aus vorhandenen Projektdateien und gezielten Mutationen erzeugt; ein weiteres Skript misst Erklärungen über den Erklärung-Dienst.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`gold-erklaerungen.mjs`](gold-erklaerungen.mjs) | Stellt zweisprachige Gold-Erklärungen und Prüfer-Familien für das Korpus bereit. |
| [`korpus.mjs`](korpus.mjs) | Erzeugt Situationen für die Erklärungsmessung und schreibt das Ergebnis in einen angegebenen Ausgabeordner. |
| [`messung-sprache.mjs`](messung-sprache.mjs) | Bewertet die Sprachwahl für Erklärungen auf Basis des Korpus. |

## Schnittstellen nach außen

[`korpus.mjs`](korpus.mjs) erzeugt `situationen.json`, das [`messung-sprache.mjs`](messung-sprache.mjs) als Eingabe liest. Das Messskript bindet die Gold-Daten aus [`gold-erklaerungen.mjs`](gold-erklaerungen.mjs) und den gebauten Erklärung-Dienst aus Core ein.

## Abhängigkeiten

Die Skripte verwenden Node.js, das gebaute Core-Paket und die Synapse-Testdatenbank für Messläufe. Die Gold-Texte stammen aus [`packages/core/data/erklaerungstopf-seed.json`](../../packages/core/data/erklaerungstopf-seed.json).

## Siehe auch

- [Skripte](../README.md)
- [Core-Paket](../../packages/core/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
