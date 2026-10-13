# Core-Tests

[Synapse](../../../README.md) › [Core-Paket](../README.md) › Tests

## Zweck

Dieser Ordner enthält Tests für interne Core-Funktionen und Paketverhalten. Die Suites decken unter anderem Datei- und Planänderungen, Parser und Codeindex, Asset-Analyse, Shell-Läufe, Datenbankzugriffe und Agentenwissen ab. Die Test-Fixtures und die gemeinsame Bereinigungslogik sind in eigenen Unterordnern gesammelt.

## Inhalt

Die 160 direkten Test- und Messdateien sind nach Themen gruppiert; einzelne Dateinamen führen direkt zur jeweiligen Suite.

### Asset-Intelligence

- [`asset-intel-3d.test.mjs`](asset-intel-3d.test.mjs)
- [`asset-intel-abfragen.test.mjs`](asset-intel-abfragen.test.mjs)
- [`asset-intel-archiv.test.mjs`](asset-intel-archiv.test.mjs)
- [`asset-intel-db.test.mjs`](asset-intel-db.test.mjs)
- [`asset-intel-dcc.test.mjs`](asset-intel-dcc.test.mjs)
- [`asset-intel-exe.test.mjs`](asset-intel-exe.test.mjs)
- [`asset-intel-medien.test.mjs`](asset-intel-medien.test.mjs)
- [`asset-intel-reader.test.mjs`](asset-intel-reader.test.mjs)
- [`asset-intel-registry.test.mjs`](asset-intel-registry.test.mjs)
- [`asset-intel-run.test.mjs`](asset-intel-run.test.mjs)
- [`asset-intel-standard.test.mjs`](asset-intel-standard.test.mjs)
- [`asset-intel-sync.test.mjs`](asset-intel-sync.test.mjs)
- [`asset-intel-textur.test.mjs`](asset-intel-textur.test.mjs)
- [`asset-intel-unreal.test.mjs`](asset-intel-unreal.test.mjs)

### Codeindex und Parser

- [`code-intel-alias-kommentar.test.mjs`](code-intel-alias-kommentar.test.mjs)
- [`code-intel-referenzen.test.mjs`](code-intel-referenzen.test.mjs)
- [`code-intel-schatten-commit-p6-t29.test.mjs`](code-intel-schatten-commit-p6-t29.test.mjs)
- [`code-intel-schatten-p6-t27.test.mjs`](code-intel-schatten-p6-t27.test.mjs)
- [`code-intel-schatten-performance-p6-t27.test.mjs`](code-intel-schatten-performance-p6-t27.test.mjs)
- [`code-intel-search-zeilen.test.mjs`](code-intel-search-zeilen.test.mjs)
- [`fixture-zeilennummern.test.mjs`](fixture-zeilennummern.test.mjs)
- [`parser-aufrufkanten.test.mjs`](parser-aufrufkanten.test.mjs)
- [`parser-felder-strings.test.mjs`](parser-felder-strings.test.mjs)
- [`parser-kommentare.test.mjs`](parser-kommentare.test.mjs)
- [`parser-pool-timeout.test.mjs`](parser-pool-timeout.test.mjs)

### Dateien, Versionen und gemeinsame Pläne

- [`file-batch-befund-ursache.test.mjs`](file-batch-befund-ursache.test.mjs)
- [`file-batch-coedit-befunde.test.mjs`](file-batch-coedit-befunde.test.mjs)
- [`file-batch-commit-auth-p6-t35.test.mjs`](file-batch-commit-auth-p6-t35.test.mjs)
- [`file-batch-commit-rebase-p6-t37.test.mjs`](file-batch-commit-rebase-p6-t37.test.mjs)
- [`file-batch-diff.test.mjs`](file-batch-diff.test.mjs)
- [`file-batch-eigener-plan.test.mjs`](file-batch-eigener-plan.test.mjs)
- [`file-batch-fix-693bbf48.test.mjs`](file-batch-fix-693bbf48.test.mjs)
- [`file-batch-fix-875d6a8c.test.mjs`](file-batch-fix-875d6a8c.test.mjs)
- [`file-batch-fix-acc82f49.test.mjs`](file-batch-fix-acc82f49.test.mjs)
- [`file-batch-grenzen.test.mjs`](file-batch-grenzen.test.mjs)
- [`file-batch-grundidee.test.mjs`](file-batch-grundidee.test.mjs)
- [`file-batch-inactive-waits-p6-t39.test.mjs`](file-batch-inactive-waits-p6-t39.test.mjs)
- [`file-batch-konflikt-p6-t34.test.mjs`](file-batch-konflikt-p6-t34.test.mjs)
- [`file-batch-nichts-geschrieben.test.mjs`](file-batch-nichts-geschrieben.test.mjs)
- [`file-batch-op-ansehen.test.mjs`](file-batch-op-ansehen.test.mjs)
- [`file-batch-plaene-ohne-ablauf.test.mjs`](file-batch-plaene-ohne-ablauf.test.mjs)
- [`file-batch-pruefbefunde-messung.mjs`](file-batch-pruefbefunde-messung.mjs)
- [`file-batch-pruefbefunde.test.mjs`](file-batch-pruefbefunde.test.mjs)
- [`file-batch-reservierung-ablauf.test.mjs`](file-batch-reservierung-ablauf.test.mjs)
- [`file-batch-runde3.test.mjs`](file-batch-runde3.test.mjs)
- [`file-batch-status-views.golden.test.mjs`](file-batch-status-views.golden.test.mjs)
- [`file-batch-v2-ohne-grenze.test.mjs`](file-batch-v2-ohne-grenze.test.mjs)
- [`file-batch-wait-isolation-p6-t38.test.mjs`](file-batch-wait-isolation-p6-t38.test.mjs)
- [`file-batch-wait-ohne-ziel-p6-t31.test.mjs`](file-batch-wait-ohne-ziel-p6-t31.test.mjs)
- [`file-batch-wait-sync-p6-t33.test.mjs`](file-batch-wait-sync-p6-t33.test.mjs)
- [`file-fs-drift-p6-t3.test.mjs`](file-fs-drift-p6-t3.test.mjs)
- [`files-treffer-p15-t34-t35.test.mjs`](files-treffer-p15-t34-t35.test.mjs)
- [`file-task-p6-t26.test.mjs`](file-task-p6-t26.test.mjs)
- [`file-version-task-id-p6-t24.test.mjs`](file-version-task-id-p6-t24.test.mjs)
- [`pgfs-commit-race-p6-t41.test.mjs`](pgfs-commit-race-p6-t41.test.mjs)
- [`pgfs-skip-einmal.test.mjs`](pgfs-skip-einmal.test.mjs)
- [`search-replace-crlf.test.mjs`](search-replace-crlf.test.mjs)
- [`search-replace-mehrdeutig.test.mjs`](search-replace-mehrdeutig.test.mjs)

### Shell, Tool-Antworten und Ausführungsumgebung

- [`env-maske-p15-t36.test.mjs`](env-maske-p15-t36.test.mjs)
- [`hinweis-drossel-p10-t43.test.mjs`](hinweis-drossel-p10-t43.test.mjs)
- [`shell-altbestand-kontext-p10-t42.test.mjs`](shell-altbestand-kontext-p10-t42.test.mjs)
- [`shell-altbestand-p10-t42.test.mjs`](shell-altbestand-p10-t42.test.mjs)
- [`shell-altbestand-persistenz-p10-t42.test.mjs`](shell-altbestand-persistenz-p10-t42.test.mjs)
- [`shell-ergebnis-p10-t46.test.mjs`](shell-ergebnis-p10-t46.test.mjs)
- [`shell-gemischt-p10-t33.test.mjs`](shell-gemischt-p10-t33.test.mjs)
- [`shell-hints-seen-p10-t48.test.mjs`](shell-hints-seen-p10-t48.test.mjs)
- [`shell-history-p10-t54.test.mjs`](shell-history-p10-t54.test.mjs)
- [`shell-inline-bestand-p10-t47.mjs`](shell-inline-bestand-p10-t47.mjs)
- [`shell-inline-p10-t47.test.mjs`](shell-inline-p10-t47.test.mjs)
- [`shell-inline-start-p10-t47.test.mjs`](shell-inline-start-p10-t47.test.mjs)
- [`shell-job-anzeige-p10-t51.test.mjs`](shell-job-anzeige-p10-t51.test.mjs)
- [`shell-job-hinweis-p10-t40.test.mjs`](shell-job-hinweis-p10-t40.test.mjs)
- [`shell-job-pfad.test.mjs`](shell-job-pfad.test.mjs)
- [`shell-job-umgebung.test.mjs`](shell-job-umgebung.test.mjs)
- [`shell-kennungen-p10-t33.test.mjs`](shell-kennungen-p10-t33.test.mjs)
- [`shell-key-uebermaskierung-p10-t50.test.mjs`](shell-key-uebermaskierung-p10-t50.test.mjs)
- [`shell-lage-e2-bestand.mjs`](shell-lage-e2-bestand.mjs)
- [`shell-lage-e2-hook.test.mjs`](shell-lage-e2-hook.test.mjs)
- [`shell-lage-e2.test.mjs`](shell-lage-e2.test.mjs)
- [`shell-lage-e2-windows.test.mjs`](shell-lage-e2-windows.test.mjs)
- [`shell-lage-e2-workspace.test.mjs`](shell-lage-e2-workspace.test.mjs)
- [`shell-literal-quellen-p10-t33.test.mjs`](shell-literal-quellen-p10-t33.test.mjs)
- [`shell-masken-diagnose-p10-t50.test.mjs`](shell-masken-diagnose-p10-t50.test.mjs)
- [`shell-maske-p10-t33.test.mjs`](shell-maske-p10-t33.test.mjs)
- [`shell-puffer-p10-t33.test.mjs`](shell-puffer-p10-t33.test.mjs)
- [`shell-sicherung-e1-bestand.mjs`](shell-sicherung-e1-bestand.mjs)
- [`shell-sicherung-e1-db.test.mjs`](shell-sicherung-e1-db.test.mjs)
- [`shell-sicherung-e1-golden.test.mjs`](shell-sicherung-e1-golden.test.mjs)
- [`shell-sicherung-e1.test.mjs`](shell-sicherung-e1.test.mjs)
- [`shell-sicherung-e3-queue.test.mjs`](shell-sicherung-e3-queue.test.mjs)
- [`shell-sicherung-e3-rest.test.mjs`](shell-sicherung-e3-rest.test.mjs)
- [`shell-sicherung-e3-rollen.test.mjs`](shell-sicherung-e3-rollen.test.mjs)
- [`shell-sicherung-e3-start.test.mjs`](shell-sicherung-e3-start.test.mjs)
- [`shell-sicherung-e3-stdio.test.mjs`](shell-sicherung-e3-stdio.test.mjs)
- [`shell-sicherung-e3.test.mjs`](shell-sicherung-e3.test.mjs)
- [`shell-sicherung-e3-windows.test.mjs`](shell-sicherung-e3-windows.test.mjs)
- [`shell-sicherung-e3-worker.test.mjs`](shell-sicherung-e3-worker.test.mjs)
- [`shell-sicherung-e3-workspace.test.mjs`](shell-sicherung-e3-workspace.test.mjs)
- [`shell-t76-a.test.mjs`](shell-t76-a.test.mjs)
- [`shell-t76-a-zaehlung.test.mjs`](shell-t76-a-zaehlung.test.mjs)
- [`shell-t76-b.test.mjs`](shell-t76-b.test.mjs)
- [`shell-t76-c.test.mjs`](shell-t76-c.test.mjs)
- [`shell-t76-d.test.mjs`](shell-t76-d.test.mjs)
- [`mcp-json-maske-p15-t41.test.mjs`](mcp-json-maske-p15-t41.test.mjs)
- [`tool-antwort-anhaenge-p10-t53.test.mjs`](tool-antwort-anhaenge-p10-t53.test.mjs)
- [`tool-antwort-huelle-p10-t55.test.mjs`](tool-antwort-huelle-p10-t55.test.mjs)
- [`tool-antwort-kompakt-p10-t51.golden.test.mjs`](tool-antwort-kompakt-p10-t51.golden.test.mjs)
- [`tool-groessen-p10-t60.test.mjs`](tool-groessen-p10-t60.test.mjs)
- [`tool-hinweise-p10-t62.test.mjs`](tool-hinweise-p10-t62.test.mjs)

### Wissen, Entscheidungen und Onboarding

- [`context7-bibliothekswahl.test.mjs`](context7-bibliothekswahl.test.mjs)
- [`docs-get-for-file-golden.test.mjs`](docs-get-for-file-golden.test.mjs)
- [`embed-vorrang.test.mjs`](embed-vorrang.test.mjs)
- [`entscheidung-durchsicht-zeile.test.mjs`](entscheidung-durchsicht-zeile.test.mjs)
- [`entscheidungstopf.test.mjs`](entscheidungstopf.test.mjs)
- [`erklaerungen-e2.test.mjs`](erklaerungen-e2.test.mjs)
- [`erklaerungen-generik.test.mjs`](erklaerungen-generik.test.mjs)
- [`erklaerungen-topf.test.mjs`](erklaerungen-topf.test.mjs)
- [`erklaerung-hinweis-status.test.mjs`](erklaerung-hinweis-status.test.mjs)
- [`erklaerungstopf-seed-v2.test.mjs`](erklaerungstopf-seed-v2.test.mjs)
- [`jev-schalter.test.mjs`](jev-schalter.test.mjs)
- [`memory-dateipfade-p10-t45.test.mjs`](memory-dateipfade-p10-t45.test.mjs)
- [`memory-pg-p5-t17.test.mjs`](memory-pg-p5-t17.test.mjs)
- [`memory-race-p10-t12.test.mjs`](memory-race-p10-t12.test.mjs)
- [`modellpool-fehlerklassifikation.test.mjs`](modellpool-fehlerklassifikation.test.mjs)
- [`modellprofil.test.mjs`](modellprofil.test.mjs)
- [`onboarding-rollen.test.mjs`](onboarding-rollen.test.mjs)
- [`onboarding-sitzung-p7-t40.test.mjs`](onboarding-sitzung-p7-t40.test.mjs)
- [`onboarding-verzeichnis-p7-t49.test.mjs`](onboarding-verzeichnis-p7-t49.test.mjs)
- [`skills-pg-first.test.mjs`](skills-pg-first.test.mjs)
- [`topf-id-p10-t63.test.mjs`](topf-id-p10-t63.test.mjs)
- [`topf-vergleich-p10-t60.test.mjs`](topf-vergleich-p10-t60.test.mjs)
- [`wissen-stuecke-p12-t10.test.mjs`](wissen-stuecke-p12-t10.test.mjs)

### Planung, Ereignisse und interne Steuerung

- [`admin-kontextprofil-p7-t42.test.mjs`](admin-kontextprofil-p7-t42.test.mjs)
- [`channel-unread-hook.test.mjs`](channel-unread-hook.test.mjs)
- [`event-ack-scope-p10-t24.test.mjs`](event-ack-scope-p10-t24.test.mjs)
- [`id-lookup-p10-t30.integration.test.mjs`](id-lookup-p10-t30.integration.test.mjs)
- [`id-lookup-p10-t30.test.mjs`](id-lookup-p10-t30.test.mjs)
- [`intern-einblick.test.mjs`](intern-einblick.test.mjs)
- [`intern-eingriffe.test.mjs`](intern-eingriffe.test.mjs)
- [`intern-nutzung-p10-t44.test.mjs`](intern-nutzung-p10-t44.test.mjs)
- [`intern-ollama.test.mjs`](intern-ollama.test.mjs)
- [`intern-schalter.test.mjs`](intern-schalter.test.mjs)
- [`intern-schalter-wirkung.test.mjs`](intern-schalter-wirkung.test.mjs)
- [`intern-shell-alt-p10-t42.test.mjs`](intern-shell-alt-p10-t42.test.mjs)
- [`plan-git-branch-p3-t12.test.mjs`](plan-git-branch-p3-t12.test.mjs)
- [`plan-update-p3-t11.test.mjs`](plan-update-p3-t11.test.mjs)
- [`synapse-ordner-ignore.test.mjs`](synapse-ordner-ignore.test.mjs)
- [`worker-steuerung.test.mjs`](worker-steuerung.test.mjs)

### Datenbank, Projekt und Syntaxprüfung

- [`pg-projekt-registry.test.mjs`](pg-projekt-registry.test.mjs)
- [`pg-write-primary-p10-t11.test.mjs`](pg-write-primary-p10-t11.test.mjs)
- [`projekt-db.test.mjs`](projekt-db.test.mjs)
- [`projekt-pfad-p15-t36.test.mjs`](projekt-pfad-p15-t36.test.mjs)
- [`schema-ensure-neuversuch.test.mjs`](schema-ensure-neuversuch.test.mjs)
- [`schema-sql-ausfuehren.test.mjs`](schema-sql-ausfuehren.test.mjs)
- [`syntax-pool-workerzahl.test.mjs`](syntax-pool-workerzahl.test.mjs)
- [`syntax-pruefer-cmake.test.mjs`](syntax-pruefer-cmake.test.mjs)
- [`syntax-pruefer-fp.mjs`](syntax-pruefer-fp.mjs)
- [`syntax-pruefer.test.mjs`](syntax-pruefer.test.mjs)

### Fixture-Bereinigung

- [`test-fixture-cleanup-p9-t22.test.mjs`](test-fixture-cleanup-p9-t22.test.mjs)
- [`test-fixtures-p9-t24.test.mjs`](test-fixtures-p9-t24.test.mjs)

### Gemeinsame Testressourcen

- [Fixtures](fixtures/README.md) – feste Eingabedaten und erwartete Vergleichswerte für ausgewählte Suites.
- [Hilfsfunktionen](_helfer/README.md) – gemeinsame Testumgebung für Fixture- und Stream-Bereinigung.

## Schnittstellen nach außen

Die Tests laden Core-Module aus dem gebauten Paket, darunter Services, Parser und Asset-Intelligence. Sie prüfen die internen Verträge dieser Module; die eigentlichen Implementierungen und öffentlichen Paket-Exporte liegen im [Core-Quellcode](../src/README.md) und im [Services-Bereich](../src/services/README.md).

## Abhängigkeiten

Die Suites nutzen Node.js-Test- und Laufzeitmodule wie `node:test`, `node:assert`, Datei- und Prozesswerkzeuge sowie das gebaute Core-Paket. Datenbankgestützte Tests sind ausschließlich für die Testdatenbank `synapse_test` vorgesehen. Fixture-Inhalte und Bereinigungshelfer sind in [fixtures](fixtures/README.md) und [_helfer](_helfer/README.md) dokumentiert.

## Siehe auch

- [Core-Paket](../README.md)
- [Core-Quellcode](../src/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
