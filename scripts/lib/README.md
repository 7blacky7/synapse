# Skriptbibliothek

[Synapse](../../README.md) › [Skripte](../README.md) › Hilfsbibliothek

## Zweck

Dieser Ordner enthält gemeinsame Datenbankschutz-Helfer für Skripte, die eine Datenbankverbindung öffnen. Die Module prüfen die Verbindungskonfiguration, bevor ein Test oder eine Schema-Probe auf sie zugreift.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`test-db-schutz.mjs`](test-db-schutz.mjs) | Prüft Test-DB-URLs auf ungültige oder produktive Ziele und liefert den passenden Schutzstatus. |
| [`test-db-schutz-aktiv.mjs`](test-db-schutz-aktiv.mjs) | Seiteneffekt-Import, der den Datenbankschutz als ersten Import eines Testskripts aktiviert. |

## Schnittstellen nach außen

[`test-db-schutz.mjs`](test-db-schutz.mjs) stellt `bewerteTestDb`, `bewerteSchemaProbeDb` und `testDbOderSkip` bereit. Der Seiteneffekt-Import in [`test-db-schutz-aktiv.mjs`](test-db-schutz-aktiv.mjs) ruft `testDbOderSkip` mit dem Skriptnamen auf.

## Abhängigkeiten

Die Module verwenden Node.js-Umgebungsvariablen und Laufzeitfunktionen. Die Schutzprüfung setzt `TEST_DATABASE_URL` voraus; sie gibt keine Zugangsdaten aus. Datenbanktests innerhalb von Synapse verwenden ausschließlich `synapse_test` auf Port 5433.

## Siehe auch

- [Skripte](../README.md)
- [Core-Tests](../../packages/core/tests/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
