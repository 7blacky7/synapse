# Testhilfen

[Synapse](../../../../README.md) › [Core-Paket](../../README.md) › [Core-Tests](../README.md) › Testhilfen

## Zweck

Dieser Ordner bündelt Hilfen für isolierte Test-Fixtures. Die Module beschränken Testdateien auf eigens angelegte Wurzeln und unterstützen das Aufräumen auch bei Prozessfehlern oder Signalen.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`fixture-cleanup-checkpoint.mjs`](fixture-cleanup-checkpoint.mjs) | Erzeugt gezielte Fehler- und Signalzustände für Bereinigungstests. |
| [`fixture-test-home.mjs`](fixture-test-home.mjs) | Lenkt das Test-Home bei gesetzter Testumgebung in einen Fixture-Bereich unter `coedit-test` um. |
| [`test-fixture-cleanup.mjs`](test-fixture-cleanup.mjs) | Stellt `createTestFixtureCleanup` und `trackShellStreams` für das Verfolgen und Entfernen eigener temporärer Wurzeln und Streamdateien bereit. |

## Schnittstellen nach außen

[`test-fixture-cleanup.mjs`](test-fixture-cleanup.mjs) exportiert `createTestFixtureCleanup` und `trackShellStreams`; Core-Tests importieren diese Helfer für die Verwaltung eigener Fixture-Verzeichnisse und Shell-Streams. [`fixture-cleanup-checkpoint.mjs`](fixture-cleanup-checkpoint.mjs) exportiert einen Prüfpunkt für Fehler- und Signaltests. [`fixture-test-home.mjs`](fixture-test-home.mjs) wirkt beim Import auf `os.homedir()`, sofern `SYNAPSE_TEST_STREAM_HOME` gesetzt ist.

## Abhängigkeiten

Die Helfer verwenden Node.js-Module für Dateioperationen, Pfadauflösung, Prozesssignale und die Synchronisierung eingebauter ESM-Exports. Die Tests, die sie verwenden, liegen im [Core-Testordner](../README.md).

## Siehe auch

- [Core-Tests](../README.md)
- [Fixtures](../fixtures/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
