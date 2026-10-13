# Datenbankzugriff und Schema

[Synapse](../../../../README.md) › [Core](../../README.md) › [Quellcode](../README.md) › Datenbank

## Zweck

Dieser Ordner bündelt den PostgreSQL-Zugriff des Core-Pakets und die Laufzeitdefinition des Datenbankschemas. Er stellt Verbindungspools, Schema-Prüfung und -Initialisierung sowie die Erfassung von Parse-Ausfällen und Wiederholungen transienter Datenbanktransaktionen bereit.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`client.ts`](client.ts) | Erstellt Haupt- und Hintergrundpools, stellt den kontextabhängigen Pool bereit und verwaltet LISTEN-Verbindungen sowie den Verbindungstest. |
| [`index.ts`](index.ts) | Exportiert die Datenbankverbindungs- und Schemafunktionen als gebündelte Datenbankschnittstelle. |
| [`parse-failures.ts`](parse-failures.ts) | Schreibt Parse-Ausfälle je Projekt und Datei fort und entfernt den Eintrag nach erfolgreichem Parse. |
| [`schema.ts`](schema.ts) | Definiert das Laufzeit-DDL und stellt Funktionen zum Prüfen, Absichern und Initialisieren des Schemas bereit. |
| [`shell-altbestand-schema.ts`](shell-altbestand-schema.ts) | Liefert den SQL-Teil für den Shell-Altbestand an die Laufzeit-Schemadefinition. |
| [`transient-retry.ts`](transient-retry.ts) | Erkennt ausgewählte transiente PostgreSQL-Fehler und wiederholt Transaktionen mit Backoff und Jitter. |
| [SQL-Schemareferenz](schema-sql/README.md) | Beschreibt die nummerierten SQL-Dateien als Spiegel für den Aufbau eines leeren Schemas. |

## Schnittstellen nach außen

[`index.ts`](index.ts) exportiert `getPool`, `getHintergrundPool`, `imHintergrund`, `istImHintergrund`, `verbindeListenClient`, `testDatabaseConnection` und `closePool`. Es exportiert außerdem `ensureSchema`, `pruefeSchema`, `stelleSchemaSicher`, `schemaModus`, `leereSchemaWarnung` und `SCHEMA_KENNUNG` sowie die Schema-Typen. Datenbanknahe Core-Module verwenden die Funktionen aus diesem Ordner für Abfragen und Schema-Verfügbarkeit.

[`transient-retry.ts`](transient-retry.ts) stellt `inTransaktionMitRetry` und die Fehlerklassifizierung bereit. [`parse-failures.ts`](parse-failures.ts) nimmt einen `Pool` sowie Projekt- und Dateidaten entgegen.

## Abhängigkeiten

Der Pool verwendet `pg` und bezieht die Datenbank-URL über [`config.ts`](../config.ts). `client.ts` nutzt außerdem Node.js `AsyncLocalStorage`, um Lese- und Hintergrundkontexte einem Pool zuzuordnen. `schema.ts` greift auf [`shell-altbestand-schema.ts`](shell-altbestand-schema.ts) zurück. Die Datenbankschemata liegen zur Laufzeit in PostgreSQL; die aufgeteilte SQL-Referenz ist in [`schema-sql/`](schema-sql/README.md) eingeordnet.

## Siehe auch

- [Core-Quellcode](../README.md)
- [Core-Paket](../../README.md)
- [Datenbank-SQL-Referenz](schema-sql/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
