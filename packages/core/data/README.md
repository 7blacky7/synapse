# Core-Daten

[Synapse](../../../README.md) › [Core](../README.md) › Daten

## Zweck

Dieser Ordner enthält strukturierte JSON-Startbestände für die Jev-Entscheidungs- und Erklärungstöpfe. Die Seed-Loader des Core-Pakets lesen daraus Einträge, die über die jeweilige Laufzeitlogik in den Datenbankbestand übernommen werden.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`entscheidungstopf-seed.json`](entscheidungstopf-seed.json) | Enthält den versionierten Startbestand mit Einträgen des Formats `entscheidungstopf-seed`. |
| [`erklaerungstopf-seed.json`](erklaerungstopf-seed.json) | Enthält den versionierten Startbestand mit Einträgen des Formats `erklaerungstopf-seed`. |

## Schnittstellen nach außen

[`entscheidungstopf-seed.json`](entscheidungstopf-seed.json) wird vom Loader `ladeEntscheidungstopfSeed` in [`entscheidungstopf.ts`](../src/services/entscheidungstopf.ts) als Entscheidungs-Startbestand eingelesen. [`erklaerungstopf-seed.json`](erklaerungstopf-seed.json) wird von `ladeErklaerungstopfSeed` in [`erklaerungen.ts`](../src/services/erklaerungen.ts) als Erklärungs-Startbestand eingelesen. Die REST-API bindet beide Seed-Loader beim Start ein.

Die Dateien verwenden jeweils ein eigenes Formatfeld und eine Sammlung von Einträgen; ihre Datenstruktur ist damit an die passenden Loader gebunden.

## Abhängigkeiten

Die Loader schreiben in die jeweiligen PostgreSQL-gestützten Core-Dienste. Der Entscheidungs-Startbestand gehört zum [Entscheidungstopf-Dienst](../src/services/entscheidungstopf.ts), der Erklärungs-Startbestand zum [Erklärungsdienst](../src/services/erklaerungen.ts). Der Ordner ist Datenquelle dieser Loader und enthält keine ausführbare Laufzeitlogik.

## Siehe auch

- [Core-Paket](../README.md)
- [Datenbankzugriff und Schema](../src/db/README.md)
- [Core-Quellcode](../src/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
