# Datenbankmigrationen

[Synapse](../../../../README.md) › [Core](../../README.md) › [Quellcode](../README.md) › Migrationen

## Zweck

Dieser Ordner enthält einzelne SQL- und TypeScript-Migrationen für gezielte Datenbankänderungen und Datenübernahmen. Die Dateien behandeln konkrete Altbestände oder Schema-Ergänzungen; die allgemeine Laufzeitdefinition des Schemas liegt im [Datenbankordner](../db/README.md).

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`001_shell_jobs.sql`](001_shell_jobs.sql) | Ergänzt die Shell-Job-Queue mit Status, Benachrichtigungstrigger und Stream-Chunks. |
| [`backfill-setup-phase.ts`](backfill-setup-phase.ts) | Übernimmt vorhandene Setup-Phasen aus Projektstatusdateien in `project_setup_status`, ohne bereits vorhandene Datenbankwerte zu ersetzen. |
| [`migrate-to-relative-paths.ts`](migrate-to-relative-paths.ts) | Überführt absolute Codepfade in Datenbanktabellen und Qdrant in projektbezogene relative Pfade. |

## Schnittstellen nach außen

[`backfill-setup-phase.ts`](backfill-setup-phase.ts) exportiert `backfillSetupPhaseFromStatusFiles`; die Rückgabe enthält geprüfte Projekte, migrierte Einträge und übersprungene Fälle. [`migrate-to-relative-paths.ts`](migrate-to-relative-paths.ts) exportiert `migrateToRelativePaths` und liefert Zähler zu betroffenen Projekten, Datenbankzeilen und Qdrant-Punkten. Die SQL-Datei definiert `shell_jobs`, den Trigger `notify_shell_job_created` und `shell_stream_chunks`.

## Abhängigkeiten

Die TypeScript-Migrationen beziehen PostgreSQL-Zugriff über [`db/client.ts`](../db/client.ts). Die Setup-Übernahme nutzt [`project-status.ts`](../services/project-status.ts); die Pfad-Migration arbeitet zusätzlich mit dem Qdrant-Client, [`collections.ts`](../qdrant/collections.ts) und [`types/index.ts`](../types/index.ts). Die SQL-Datei verwendet PostgreSQL-Funktionen und -Typen, darunter UUIDs und Trigger.

## Siehe auch

- [Core-Quellcode](../README.md)
- [Datenbankzugriff und Schema](../db/README.md)
- [Typen und Sammlungen](../types/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
