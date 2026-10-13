# Gemeinsame Parser-Muster

[Synapse](../../../../../README.md) › [Core](../../../README.md) › [Quellcode](../../README.md) › [Parser](../README.md) › Muster

## Zweck

Dieser Unterordner bündelt Konstanten und Hilfsfunktionen, die mehrere Sprachparser für die Erkennung von HTTP-Routen und eingebettetem SQL verwenden.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`http.ts`](http.ts) | Definiert HTTP-Verben und Framework-Decorator-Zuordnungen sowie Hilfen zur Prüfung und Formatierung von Route-Pfaden. |
| [`sql.ts`](sql.ts) | Definiert SQL-Schlüsselwörter, typische Datenbankmethoden und Tags; erkennt und parst SQL-Inhalte innerhalb anderer Sprachen. |

## Schnittstellen nach außen

Sprachparser importieren diese gemeinsamen Muster und erzeugen damit unter anderem Routensymbole sowie SQL-Symbole mit auf die umgebende Datei verschobenen Zeilenangaben.

## Abhängigkeiten

[http.ts](http.ts) definiert HTTP-Erkennungswerte ohne Abhängigkeit von einem einzelnen Sprachparser. [sql.ts](sql.ts) delegiert den SQL-Inhalt an den [SQL-Parser](../sql.ts) und nutzt die Symboltypen aus [types.ts](../types.ts).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Asset-Intel](../../asset-intel/README.md)
- [Core-Paket](../../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../../docs/README.md)
