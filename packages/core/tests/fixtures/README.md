# Core-Testfixtures

[Synapse](../../../../README.md) › [Core-Paket](../../README.md) › [Core-Tests](../README.md) › Fixtures

## Zweck

Dieser Ordner enthält feste Eingabedaten und gespeicherte Vergleichswerte für ausgewählte Core-Test-Suites. Die Daten machen Antworten und Testzustände reproduzierbar; sie sind keine Laufzeitkonfiguration des Produkts.

## Inhalt

| Gruppe | Dateien |
|---|---|
| Codeindex-, Datei- und Shell-Goldenwerte | [`code-intel-schatten-p6-t27.golden.json`](code-intel-schatten-p6-t27.golden.json), [`file-task-p6-t26.golden.json`](file-task-p6-t26.golden.json), [`file-version-task-id-p6-t24.golden.json`](file-version-task-id-p6-t24.golden.json), [`shell-inline-p10-t47.golden.json`](shell-inline-p10-t47.golden.json), [`shell-sicherung-e1.golden.json`](shell-sicherung-e1.golden.json) |
| Aufgezeichnete ältere Antworten und Zustände | [`memory-semantik-p5-t17-alt.json`](memory-semantik-p5-t17-alt.json), [`onboarding-rollen-alt.json`](onboarding-rollen-alt.json), [`onboarding-verzeichnis-p7-t49-alt.json`](onboarding-verzeichnis-p7-t49-alt.json), [`shell-history-p10-t54-alt.json`](shell-history-p10-t54-alt.json), [`tool-antwort-p10-t51-alt.json`](tool-antwort-p10-t51-alt.json) |
| Gesprächsprotokolle als Testeingabe | [`p10-t44-claude.jsonl`](p10-t44-claude.jsonl), [`p10-t44-codex.jsonl`](p10-t44-codex.jsonl) |
| Kleines Shell-Paketfixture | [`shell-lage-e2-package.json`](shell-lage-e2-package.json) |

## Schnittstellen nach außen

Die Fixtures werden von Suites im [Core-Testordner](../README.md) als Eingaben oder erwartete Werte gelesen. Die konkrete Zuordnung ergibt sich aus den jeweiligen Testdateien; produktive Module exportieren diese Fixture-Dateien nicht.

## Abhängigkeiten

Die Dateien sind statische JSON- und JSONL-Daten. Testcode und gemeinsame Hilfen liegen im [Core-Testordner](../README.md) und in dessen [Hilfsfunktionen](../_helfer/README.md).

## Siehe auch

- [Core-Tests](../README.md)
- [Testhilfen](../_helfer/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
