# Skripte

[Synapse](../README.md) › Skripte

## Zweck

Dieser Ordner sammelt wiederverwendbare Wartungs-, Mess- und Prüfscripte für das Synapse-Monorepo. Direkte Skripte ergänzen die paketbezogenen Tests; größere Hilfsbereiche liegen in eigenen Unterordnern.

## Inhalt

| Gruppe | Dateien / Unterordner | Aufgabe |
|---|---|---|
| Wartung und Datenpflege | [`apply-string-extraction.mjs`](apply-string-extraction.mjs), [`backfill-flow.mjs`](backfill-flow.mjs), [`cutoffs-nachtragen.mjs`](cutoffs-nachtragen.mjs), [`fehlermuster-migration.mjs`](fehlermuster-migration.mjs), [`fehlermuster-migration-plan.mjs`](fehlermuster-migration-plan.mjs), [`modelle-2026-09-aktualisieren.mjs`](modelle-2026-09-aktualisieren.mjs), [`p15-t8-modellprofile-startwerte.sql`](p15-t8-modellprofile-startwerte.sql), [`plaene-kurz-ids.mjs`](plaene-kurz-ids.mjs), [`relink-refs.mjs`](relink-refs.mjs), [`reparse-project.mjs`](reparse-project.mjs) | Hilfen für Migrationen, Backfills, Modell- und Plan-Daten sowie Reindexierung. |
| Messung und Auswertung | [`bench-wissen-stuecke-p12-t10.py`](bench-wissen-stuecke-p12-t10.py), [`index-moo-files.mjs`](index-moo-files.mjs), [`messe-tool-schemas.mjs`](messe-tool-schemas.mjs), [`messung-claim-explain.mjs`](messung-claim-explain.mjs), [`parser-massentest.mjs`](parser-massentest.mjs), [`pgfs-hash-benchmark.mjs`](pgfs-hash-benchmark.mjs), [`shell-altbestand-probe.mjs`](shell-altbestand-probe.mjs) | Benchmarks und Auswertungen für Parser, Dateien, Wissen und Werkzeugschemata. |
| Agenten- und API-Einstiegspunkte | [`build-workspace-image.sh`](build-workspace-image.sh), [`chat-send.mjs`](chat-send.mjs), [`codex-kontext-hook.mjs`](codex-kontext-hook.mjs), [`synapse-api.mjs`](synapse-api.mjs), [`synapse-chat.sh`](synapse-chat.sh) | Kleine Kommunikations- und Build-Helfer sowie API-/Chat-Skripte. |
| Weitere eigenständige Tests | [`chat-send.test.mjs`](chat-send.test.mjs), [`synapse-api.test.mjs`](synapse-api.test.mjs) | Ergänzende Tests neben den nachfolgend gruppierten Prüfsuiten. |
| Agenten, Rechenagenten und Warteschlangen | [`test-agent-meta-yaml.mjs`](test-agent-meta-yaml.mjs), [`test-agents-zyklus.mjs`](test-agents-zyklus.mjs), [`test-claims-t24-t25.mjs`](test-claims-t24-t25.mjs), [`test-compute-node-pull.mjs`](test-compute-node-pull.mjs), [`test-compute-node-vorlauf.mjs`](test-compute-node-vorlauf.mjs), [`test-heartbeat-abgeschaltet.mjs`](test-heartbeat-abgeschaltet.mjs), [`test-intern-daemon-bruecke.mjs`](test-intern-daemon-bruecke.mjs), [`test-intern-diagnose-daemon.mjs`](test-intern-diagnose-daemon.mjs), [`test-intern-diagnose.mjs`](test-intern-diagnose.mjs), [`test-intern-modellprofil-t18.mjs`](test-intern-modellprofil-t18.mjs), [`test-p7-t39-onboarding.mjs`](test-p7-t39-onboarding.mjs), [`test-spawn-args.mjs`](test-spawn-args.mjs), [`test-spawn-heartbeat.mjs`](test-spawn-heartbeat.mjs), [`test-specialist-p7-t34.mjs`](test-specialist-p7-t34.mjs), [`test-specialist-selbst.mjs`](test-specialist-selbst.mjs), [`test-specialist-stop-prozess.mjs`](test-specialist-stop-prozess.mjs), [`test-spezialisten-status-filter.mjs`](test-spezialisten-status-filter.mjs), [`test-status-pid-tokens.mjs`](test-status-pid-tokens.mjs), [`test-warteschlangen-e4.mjs`](test-warteschlangen-e4.mjs), [`test-warteschlangen-pg.mjs`](test-warteschlangen-pg.mjs), [`test-worker-pause-claims.mjs`](test-worker-pause-claims.mjs), [`test-werkzeuge-laden.mjs`](test-werkzeuge-laden.mjs) | Testskripte für agenten, rechenagenten und warteschlangen. |
| Channels und Ereignisse | [`test-channel-push.mjs`](test-channel-push.mjs), [`test-channel-skill-hook.mjs`](test-channel-skill-hook.mjs), [`test-channel-unread-integration.mjs`](test-channel-unread-integration.mjs), [`test-pending-event-response-hooks.mjs`](test-pending-event-response-hooks.mjs) | Testskripte für channels und ereignisse. |
| Codeindex und Embeddings | [`test-embedding-claims.mjs`](test-embedding-claims.mjs), [`test-embedding-claims-pg.mjs`](test-embedding-claims-pg.mjs), [`test-embedding-nodes.mjs`](test-embedding-nodes.mjs), [`test-embedding-nodes-stapel.mjs`](test-embedding-nodes-stapel.mjs), [`test-embedding-priority.mjs`](test-embedding-priority.mjs) | Testskripte für codeindex und embeddings. |
| Fehlermuster und Schreibprüfung | [`test-code-check-muster.mjs`](test-code-check-muster.mjs), [`test-fehlermuster-auslieferung.mjs`](test-fehlermuster-auslieferung.mjs), [`test-fehlermuster-erkennung.mjs`](test-fehlermuster-erkennung.mjs), [`test-fehlermuster-migration.mjs`](test-fehlermuster-migration.mjs), [`test-fehlermuster-rest.mjs`](test-fehlermuster-rest.mjs), [`test-fehlermuster-signatur.mjs`](test-fehlermuster-signatur.mjs) | Testskripte für fehlermuster und schreibprüfung. |
| Dateien, Pläne, Gedanken und Versionen | [`test-files-batch-schema.mjs`](test-files-batch-schema.mjs), [`test-files-update-anker.mjs`](test-files-update-anker.mjs), [`test-plaene-mehrere.mjs`](test-plaene-mehrere.mjs), [`test-plan-einordnen.mjs`](test-plan-einordnen.mjs), [`test-plan-get-task-id.mjs`](test-plan-get-task-id.mjs), [`test-plan-prioritaeten.mjs`](test-plan-prioritaeten.mjs), [`test-plan-verschieben.mjs`](test-plan-verschieben.mjs), [`test-plan-zurueckstellen.mjs`](test-plan-zurueckstellen.mjs), [`test-plan-zuweisung.mjs`](test-plan-zuweisung.mjs), [`test-proposal-kurz-ids.mjs`](test-proposal-kurz-ids.mjs), [`test-task-zurueckstellen.mjs`](test-task-zurueckstellen.mjs), [`test-thought-kurz-ids.mjs`](test-thought-kurz-ids.mjs), [`test-thought-schema-rest.mjs`](test-thought-schema-rest.mjs), [`test-versions-einzelweg.mjs`](test-versions-einzelweg.mjs) | Testskripte für dateien, pläne, gedanken und versionen. |
| Modelle, JEV und Laufzeit | [`test-effort.mjs`](test-effort.mjs), [`test-jev-empfehlung.mjs`](test-jev-empfehlung.mjs), [`test-jev-entscheidung.mjs`](test-jev-entscheidung.mjs), [`test-jev-modus-hinweis.mjs`](test-jev-modus-hinweis.mjs), [`test-kontext-korridor.mjs`](test-kontext-korridor.mjs), [`test-leerlauf-entscheidung.mjs`](test-leerlauf-entscheidung.mjs), [`test-modelle-cutoffs.mjs`](test-modelle-cutoffs.mjs), [`test-modell-registry-db.mjs`](test-modell-registry-db.mjs), [`test-rotations-marker.mjs`](test-rotations-marker.mjs), [`test-sitzung-seit.mjs`](test-sitzung-seit.mjs), [`test-skill-hinweisgeber.mjs`](test-skill-hinweisgeber.mjs), [`test-token-stand.mjs`](test-token-stand.mjs) | Testskripte für modelle, jev und laufzeit. |
| DB, Schema, Shell und Diagnose | [`test-codex-kontext-hook.mjs`](test-codex-kontext-hook.mjs), [`test-db-schutz.mjs`](test-db-schutz.mjs), [`test-logpflege.mjs`](test-logpflege.mjs), [`test-schema-pruefen.mjs`](test-schema-pruefen.mjs), [`test-schema-spiegel-agenten.mjs`](test-schema-spiegel-agenten.mjs), [`test-shell-channel-unterbrechung.mjs`](test-shell-channel-unterbrechung.mjs) | Testskripte für db, schema, shell und diagnose. |
| [`context-handoff/`](context-handoff/README.md) | Lokale Einstiegspunkte für Kontextübergaben. |
| [`erklaerungen/`](erklaerungen/README.md) | Korpus, Gold-Erklärungen und Sprachmessung. |
| [`lib/`](lib/README.md) | Gemeinsame Skripthelfer, darunter der Datenbankschutz. |

## Schnittstellen nach außen

Die Skripte rufen Paketcode, Datenbank- und Indexfunktionen oder externe Werkzeuge für ihre jeweiligen Mess- und Wartungsaufgaben auf. [`lib/test-db-schutz.mjs`](lib/test-db-schutz.mjs) stellt gemeinsame Prüfungen für Datenbankziele bereit. Die drei fachlichen Unterordner sind über eigene Übersichten verlinkt.

## Abhängigkeiten

Die Ausführungsumgebung richtet sich nach dem jeweiligen Skript: Node.js, Python, Shell, SQL oder C++-Werkzeuge. Datenbankgestützte Tests prüfen den Schutz in [`lib/test-db-schutz.mjs`](lib/test-db-schutz.mjs); Testläufe dürfen ausschließlich die Testdatenbank `synapse_test` auf Port 5433 verwenden.

## Siehe auch

- [Projektwurzel](../README.md)
- [Core-Paket](../packages/core/README.md)
- [Core-Tests](../packages/core/tests/README.md)
- [Zusammenhang und Betriebsvarianten](../docs/README.md)
