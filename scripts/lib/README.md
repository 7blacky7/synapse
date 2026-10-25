# Skriptbibliothek

[Synapse](../../README.md) › [Skripte](../README.md) › Hilfsbibliothek

## Zweck

Dieser Ordner enthält gemeinsame Datenbankschutz-Helfer für Skripte, die eine Datenbankverbindung öffnen. Die Module prüfen die Verbindungskonfiguration, bevor ein Test oder eine Schema-Probe auf sie zugreift. Dazu kommt die gemeinsame Screenshot-Ablage der KI-Browser-Tests (P25-T7).

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`test-db-schutz.mjs`](test-db-schutz.mjs) | Prüft Test-DB-URLs auf ungültige oder produktive Ziele und liefert den passenden Schutzstatus. |
| [`test-db-schutz-aktiv.mjs`](test-db-schutz-aktiv.mjs) | Seiteneffekt-Import, der den Datenbankschutz als ersten Import eines Testskripts aktiviert. |
| [`ui-screenshots.mjs`](ui-screenshots.mjs) | Screenshots der Browser-Tests je Lauf unter `ui-screenshots/<anlass>/<lauf-id>/`, ohne Überschreiben; Aufräumen auf die letzten N Läufe (P25-T7). |

## Schnittstellen nach außen

[`test-db-schutz.mjs`](test-db-schutz.mjs) stellt `bewerteTestDb`, `bewerteSchemaProbeDb` und `testDbOderSkip` bereit. Der Seiteneffekt-Import in [`test-db-schutz-aktiv.mjs`](test-db-schutz-aktiv.mjs) ruft `testDbOderSkip` mit dem Skriptnamen auf.

[`ui-screenshots.mjs`](ui-screenshots.mjs) stellt `screenshotAblage(repo, anlass)` (liefert `speichere(name, daten)`), `screenshotOrdner`, `laufIdFuerScreenshots` und `raeumeScreenshotLaeufeAuf` bereit. Die Lauf-ID kommt aus `TESTLAUF_ID` des Gesamtläufers [`../test-alle.mjs`](../test-alle.mjs), im Einzelaufruf aus einem Zeitstempel; `TESTLAUF_NACHLAUF=1` legt den Unterordner `nachlauf/` an. Der Läufer löscht am Ende ältere Lauf-Ordner (Standard: 3 je Anlass behalten, `--screenshots-behalten <n>`).

## Abhängigkeiten

Die Module verwenden Node.js-Umgebungsvariablen und Laufzeitfunktionen. Die Schutzprüfung setzt `TEST_DATABASE_URL` voraus; sie gibt keine Zugangsdaten aus. Datenbanktests innerhalb von Synapse verwenden ausschließlich `synapse_test` auf Port 5433.

## Siehe auch

- [Skripte](../README.md)
- [Core-Tests](../../packages/core/tests/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
