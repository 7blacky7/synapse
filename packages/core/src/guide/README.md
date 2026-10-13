# Guide-Inhalte

[Synapse](../../../../README.md) › [Core-Paket](../../../README.md) › [Quellcode](../README.md) › Guide

## Zweck

Dieser Ordner enthält die gemeinsam genutzten Texte des `guide`-Werkzeugs. Die Inhalte reichen von einer Übersicht bis zu Werkzeug- und Aktionsbeschreibungen mit Beispielen und Hinweisen.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`content.ts`](content.ts) | Definiert die Guide-Typen, den Übersichtstext und die Werkzeugbeschreibungen. |
| [`index.ts`](index.ts) | Re-exportiert Guide-Inhalte und Typen. |

## Schnittstellen nach außen

[`index.ts`](index.ts) exportiert `GUIDE_OVERVIEW` und `TOOL_GUIDES` sowie die Typen `ToolGuide` und `ActionGuide`. Diese Exporte werden über den [Core-Paket-Einstieg](../index.ts) bereitgestellt und können von API- und MCP-Oberflächen gemeinsam genutzt werden.

## Abhängigkeiten

Der Ordner enthält statische TypeScript-Inhalte und benötigt keine eigene externe Laufzeitbibliothek. Die gemeinsamen Exporte sind in [`index.ts`](../index.ts) gebündelt.

## Siehe auch

- [Core-Quellcode](../README.md)
- [Core-Paket](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
