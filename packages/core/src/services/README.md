# Services

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Core](../../README.md) › [Quellcode](../README.md) › Services

## Zweck

Dieser Ordner enthält die fachlichen Core-Services für Code, Wissen, Dateien, Agenten und Ausführung. Die Dienste werden über die Paket-Exports von REST-API, MCP-Server, Daemon und weiteren Komponenten verwendet.

## Inhalt

Die Inhaltsübersicht ist in drei getrennte Abschnitte aufgeteilt. Jeder Abschnitt nennt die zugehörigen Dateien mit relativen Links und beschreibt deren belegte Aufgabe.

<!-- P19-T4:ANFANG -->
### Teil A (a–i)

#### Dateien und Unterordner

Der T4-Bestand reicht von `agent-id-resolver.ts` bis `intern-warteschlangen.ts`; der separate Syntax-Prüfer liegt unter [syntax-pruefer](syntax-pruefer/README.md).

##### Agenten, Kommunikation und Assets

| Datei | Aufgabe |
|---|---|
| [`agent-id-resolver.ts`](agent-id-resolver.ts) | Löst Agent-IDs für gemeinsame Core-Aufrufe auf. |
| [`agent-meta-yaml.ts`](agent-meta-yaml.ts) | Liest und serialisiert Agenten-Metadaten im YAML-Format. |
| [`agent-onboarding.ts`](agent-onboarding.ts) | Baut den gemeinsamen Onboarding-Datensatz für Agenten auf. |
| [`agent-rollen.ts`](agent-rollen.ts) | Ordnet Agenten Rollen zu und bereitet sichtbare Projektregeln auf. |
| [`agent-wissen.ts`](agent-wissen.ts) | Verwaltet agentenbezogenes Wissen und dessen Zuordnung. |
| [`artefakt.ts`](artefakt.ts) | Validiert und speichert Artefakt-Metadaten und Pfade. |
| [`asset-intel-abfragen.ts`](asset-intel-abfragen.ts) | Führt Asset-Abfragen für Baum, Objekte, Verweise, Suche und Graph aus. |
| [`asset-intel-store.ts`](asset-intel-store.ts) | Speichert Asset-Inspektionen und pflegt Pfade sowie Verweisziele. |
| [`asset-intel-sync.ts`](asset-intel-sync.ts) | Verarbeitet Asset-Dateiänderungen und gleicht den Index mit dem Dateisystem ab. |
| [`asset-intel-tool.ts`](asset-intel-tool.ts) | Definiert und dispatcht das gemeinsame Asset-Intel-Tool. |
| [`asset-weiche.ts`](asset-weiche.ts) | Ergänzt Code-Intel-Ergebnisse um Asset-Daten und Hinweise. |
| [`backup.ts`](backup.ts) | Erstellt und liest JSONL-Sicherungen für Projekt-Collections. |
| [`channels.ts`](channels.ts) | Verwaltet Channels, Mitgliedschaften, Nachrichten und Sichtungsstände. |
| [`channel-unread.ts`](channel-unread.ts) | Erfasst gelesene Channel-Nachrichten und ungelesene Hinweise. |
| [`channelverwalter-regel.ts`](channelverwalter-regel.ts) | Stellt die Regel für Channel-Verwalter bereit. |
| [`chat.ts`](chat.ts) | Registriert Agentensitzungen und verwaltet Broadcasts sowie Direktnachrichten. |
| [`chat-unread.ts`](chat-unread.ts) | Initialisiert den Chat-Lesestand und liefert Hinweise auf neue Nachrichten. |
| [`code-check-tool.ts`](code-check-tool.ts) | Dispatcht Prüfungen bekannter Code- und Fehlermuster. |

##### Code-Intelligence, Dokumentation und Embeddings

| Datei | Aufgabe |
|---|---|
| [`code-intel-schatten.ts`](code-intel-schatten.ts) | Führt optionale Schattenabfragen für Code-Intel aus und misst sie. |
| [`code-intel.ts`](code-intel.ts) | Liefert Projektbaum, Symbole, Referenzen, Volltextsuche und Dateiinhalt. |
| [`code-rename.ts`](code-rename.ts) | Berechnet einen Umbenennungsplan für Code-Symbole. |
| [`code.ts`](code.ts) | Speichert, parst und indexiert Projektdateien und steuert Embedding-Aufträge. |
| [`code-write.ts`](code-write.ts) | Bietet zeilenbasierte Änderungen und PostgreSQL-Dateioperationen. |
| [`context7-automatik.ts`](context7-automatik.ts) | Plant und verarbeitet automatische Context7-Dokumentationsabfragen. |
| [`context7-kontingent.ts`](context7-kontingent.ts) | Reserviert Context7-Aufrufe und verwaltet Kontingentpausen. |
| [`context7.ts`](context7.ts) | Stellt den Context7-Client und die Bewertung von Bibliotheksnamen bereit. |
| [`daemon-bruecke.ts`](daemon-bruecke.ts) | Übermittelt Befehle und Statusmeldungen zwischen Core und lokalem Daemon. |
| [`daemon-heartbeat.ts`](daemon-heartbeat.ts) | Speichert und prüft Daemon-Heartbeats pro Projekt. |
| [`docs-indexer.ts`](docs-indexer.ts) | Indiziert Framework-Dokumentation und hält Suchtreffer im Cache. |
| [`docs.ts`](docs.ts) | Cached und durchsucht Framework-Dokumentation. |
| [`documents.ts`](documents.ts) | Extrahiert Text aus PDF-, Word- und Excel-Dateien und indexiert ihn. |
| [`effort.ts`](effort.ts) | Validiert und wählt eine Aufwandsstufe für Modellaufrufe. |
| [`embed-backlog.ts`](embed-backlog.ts) | Arbeitet ausstehende Embeddings nach und zählt offene Einträge. |
| [`embedding-chunk-id.ts`](embedding-chunk-id.ts) | Erzeugt Inhalts-Hashes und stabile IDs für Embedding-Chunks. |
| [`embedding-claims.ts`](embedding-claims.ts) | Beansprucht Embedding-Chunks und speichert Vektoren samt Claim-Status. |
| [`embed-nachzug.ts`](embed-nachzug.ts) | Schreibt einzelne oder gebündelte Embeddings nach Qdrant zurück. |
| [`embed-prioritaet.ts`](embed-prioritaet.ts) | Bestimmt die Priorität von Embedding-Aufträgen. |
| [`entscheidungstopf.ts`](entscheidungstopf.ts) | Verwaltet Entscheidungsoptionen und deren Auswahlstatus. |

##### Events, Fehlermuster und Dateiverwaltung

| Datei | Aufgabe |
|---|---|
| [`env-maske.ts`](env-maske.ts) | Maskiert .env-Werte in Ausgaben und erhält Platzhalter beim Zurückschreiben. |
| [`erklaerungen.ts`](erklaerungen.ts) | Verarbeitet Erklärungsfälle und bindet Jev-Auswahl sowie Fehlermuster ein. |
| [`error-patterns.ts`](error-patterns.ts) | Verwaltet Fehlermuster und prüft Code gegen bekannte Muster. |
| [`event-sichtbarkeit.ts`](event-sichtbarkeit.ts) | Baut SQL-Bedingungen für Sichtbarkeit und Offenstatus von Events. |
| [`events.ts`](events.ts) | Erstellt Events, quittiert sie und liefert offene Events und Hinweise. |
| [`fehlermuster-auslieferung.ts`](fehlermuster-auslieferung.ts) | Stellt passende Fehlermuster- und Syntaxbefunde bereit. |
| [`fehlermuster-erkennung.ts`](fehlermuster-erkennung.ts) | Validiert und prüft erkannte Muster gegen ihre Erkennungsregeln. |
| [`fehlermuster-pflege.ts`](fehlermuster-pflege.ts) | Normalisiert, findet und pflegt Fehlermuster und Verweise. |
| [`fehlermuster-pruefung.ts`](fehlermuster-pruefung.ts) | Prüft Schreibvorgänge auf Syntaxbefunde und Signaturmuster. |
| [`file-batch.ts`](file-batch.ts) | Plant, prüft und committet Dateiänderungen samt Co-Edit-Status. |
| [`file-diff.ts`](file-diff.ts) | Erzeugt zeilenbezogene Änderungen, Hunks und Diff-Text. |
| [`file-fs-drift.ts`](file-fs-drift.ts) | Erkennt Abweichungen zwischen PostgreSQL-Dateistand und Dateisystem. |
| [`file-reservations.ts`](file-reservations.ts) | Reserviert Datei-Pfade und verwaltet Ablauf, Freigabe und Warteschlangen. |
| [`file-steckbrief.ts`](file-steckbrief.ts) | Erzeugt einen strukturierten Steckbrief zu einer Datei. |
| [`file-task-zuordnung.ts`](file-task-zuordnung.ts) | Ordnet Datei-Versionen Plan-Tasks zu und ergänzt Task-Hinweise. |
| [`file-versions.ts`](file-versions.ts) | Liest Versionshistorien und stellt Versionen oder Batches wieder her. |
| [`free-model-pool-errors.ts`](free-model-pool-errors.ts) | Klassifiziert Anbieterfehler und bewertet weitere Pool-Versuche. |
| [`free-model-pool-store.ts`](free-model-pool-store.ts) | Liest und speichert Anbieter, Modelle, Freigaben, Zugänge und Protokolle. |
| [`free-model-pool.ts`](free-model-pool.ts) | Ermittelt externe Modelle, verwaltet Zugänge und führt Anbieterproben aus. |
| [`global-search.ts`](global-search.ts) | Durchsucht Collections mehrerer Projekte und bündelt Treffer. |

##### Suche, Regeln und interne Werkzeuge

| Datei | Aufgabe |
|---|---|
| [`hinweis-drossel.ts`](hinweis-drossel.ts) | Drosselt wiederholte optionale Projekthinweise. |
| [`ignore-rules.ts`](ignore-rules.ts) | Verwaltet Indexierungsregeln und prüft, ob Pfade ignoriert werden. |
| [`inbox.ts`](inbox.ts) | Sendet und liest Agenten-Inbox-Nachrichten samt Verlauf. |
| [`index.ts`](index.ts) | Bündelt die öffentlichen Re-Exports der Service-Module. |
| [`intern-diagnose-code.ts`](intern-diagnose-code.ts) | Liefert Code- und Parserbefunde für interne Diagnosen. |
| [`intern-diagnose-daemon.ts`](intern-diagnose-daemon.ts) | Führt lokale und per Daemon vermittelte Diagnoseabfragen aus. |
| [`intern-diagnose.ts`](intern-diagnose.ts) | Dispatcht lesende Diagnoseaktionen des internen Tools. |
| [`intern-diagnose-welle2.ts`](intern-diagnose-welle2.ts) | Ergänzt interne Diagnosen um Vektoren, Claims, Events und Pipeline-Spuren. |
| [`intern-einblick.ts`](intern-einblick.ts) | Liefert interne Status- und Datenbankeinblicke. |
| [`intern-modellprofil.ts`](intern-modellprofil.ts) | Liest, ändert und kalibriert Modellprofile. |
| [`intern-nutzung-daemon.ts`](intern-nutzung-daemon.ts) | Liest Skill-Nutzungsdaten über den lokalen Daemon. |
| [`intern-nutzung.ts`](intern-nutzung.ts) | Erstellt Nutzungsstatistiken für Skills. |
| [`intern-ollama.ts`](intern-ollama.ts) | Prüft und steuert lokale Ollama-Modelle und misst Embeddings. |
| [`intern-schalter.ts`](intern-schalter.ts) | Liest und ändert interne Funktionsschalter. |
| [`intern-shell-alt.ts`](intern-shell-alt.ts) | Maskiert und dispatcht Aktionen des älteren Shell-Bestands. |
| [`intern-tool.ts`](intern-tool.ts) | Definiert das optionale interne Diagnose- und Steuerungstool. |
| [`intern-waits.ts`](intern-waits.ts) | Ermittelt und bereinigt veraltete Wait-Zustände. |
| [`intern-warteschlangen.ts`](intern-warteschlangen.ts) | Liefert Diagnosen zu lokalen und daemonbasierten Warteschlangen. |

#### Schnittstellen nach außen

[`index.ts`](index.ts) bündelt die Service-Re-Exports; [`../index.ts`](../index.ts) stellt ausgewählte Services am Core-Einstieg bereit. Die Oberfläche umfasst Agenten-Onboarding und Rollen, Channels und Chat, Code-Intel und Dateiänderungen, Asset-Intel, Embedding-Aufträge, Events sowie interne Diagnose. [`asset-intel-tool.ts`](asset-intel-tool.ts) stellt Definition und Dispatcher des Asset-Intel-Tools gemeinsam für REST und MCP bereit; [`intern-tool.ts`](intern-tool.ts) bündelt das optionale interne Tool.

#### Abhängigkeiten

- PostgreSQL und gemeinsame Datenformen: [`../db/client.ts`](../db/client.ts) und [`../types/index.ts`](../types/index.ts); [`channels.ts`](channels.ts) verwendet den Pool und `ChannelMessage`.
- Code-Index und Dateiänderungen: [`code.ts`](code.ts), [`code-intel.ts`](code-intel.ts), [`code-write.ts`](code-write.ts) und [`file-batch.ts`](file-batch.ts) verbinden Dateiinhalte mit Parsing, Suche und Änderungsplänen.
- Vektorsuche und Embeddings: [`docs.ts`](docs.ts) nutzt [`../qdrant/index.ts`](../qdrant/index.ts) und [`../embeddings/index.ts`](../embeddings/index.ts); [`embedding-claims.ts`](embedding-claims.ts) greift zusätzlich auf Qdrant-Operationen und interne Schalter zu.
- Externe Bibliotheken und Paketgrenzen sind in [`../../package.json`](../../package.json) deklariert. Dazu gehören die hier verwendeten PostgreSQL-, Qdrant-, UUID-, YAML- und Dokumentparser-Bibliotheken.

#### Siehe auch

- [Core-Quellcode](../README.md)
- [Core-Paket](../../README.md)
- [Services: Teil B (j–r)](#teil-b-jr)
- [Services: Teil C (s–z)](#teil-c-sz)
- [Syntax-Prüfer](syntax-pruefer/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
<!-- P19-T4:ENDE -->

<!-- P19-T5:ANFANG -->
### Teil B (j–r)

#### Dateien und Unterordner

| Datei / Unterordner | Aufgabe |
|---|---|
| — | Dieser Abschnitt wird in P19-T5 anhand des Codebestands ergänzt. |

#### Schnittstellen nach außen

Wird in P19-T5 anhand der Exporte und Aufrufer ergänzt.

#### Abhängigkeiten

Wird in P19-T5 anhand der Imports ergänzt.

#### Siehe auch

- [Core-Quellcode](../README.md)
- [Zusammenhang](../../../../docs/README.md)
<!-- P19-T5:ENDE -->

<!-- P19-T6:ANFANG -->
### Teil C (s–z)

#### Dateien und Unterordner

| Datei / Unterordner | Aufgabe |
|---|---|
| — | Dieser Abschnitt wird in P19-T6 anhand des Codebestands ergänzt. |

#### Schnittstellen nach außen

Wird in P19-T6 anhand der Exporte und Aufrufer ergänzt.

#### Abhängigkeiten

Wird in P19-T6 anhand der Imports ergänzt.

#### Siehe auch

- [Core-Quellcode](../README.md)
- [Zusammenhang](../../../../docs/README.md)
<!-- P19-T6:ENDE -->

## Schnittstellen nach außen

Die öffentlichen Paket-Exports werden in [`../index.ts`](../index.ts) und die Service-Exports in [`index.ts`](index.ts) gebündelt. Die abschnittsbezogenen Schnittstellen stehen jeweils bei Teil A, B und C.

## Abhängigkeiten

Die konkreten internen und externen Abhängigkeiten stehen bei den jeweiligen Teilbereichen. Die gemeinsamen Paketabhängigkeiten definiert [`../../package.json`](../../package.json).

## Siehe auch

- [Core-Paket](../../README.md)
- [Core-Quellcode](../README.md)
- [Tests](../../tests/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
