# Konsolidierte Werkzeuge

[Synapse](../../../../../README.md) › [Übergeordneter Ordner](../README.md) › Konsolidierte Werkzeuge

## Zweck

Dieser Ordner beschreibt Multi-Action-Werkzeuge mit Eingabeschema und Handler. Er verbindet die öffentliche MCP-Oberfläche mit den Fachadaptern und gemeinsam verwendeten Core-Dispatchern.

## Inhalt

Die Tabelle nennt Werkzeugadapter sowie Verträge und Hilfen; die registrierte Oberfläche wird durch den Server bestimmt.

### Code, Dateien und Ausführung

| Datei / Unterordner | Aufgabe |
|---|---|
| [`code-intel.ts`](code-intel.ts) | `codeIntelTool` definiert strukturierte Code-Abfragen und die lexikalischen beziehungsweise semantischen Suchwege. |
| [`asset-intel.ts`](asset-intel.ts) | `assetIntelTool` bindet die gemeinsame Core-Definition und den Dispatcher für Asset-Abfragen ein. |
| [`code-check.ts`](code-check.ts) | `codeCheckTool` bindet die gemeinsame Core-Definition für Syntax- und Fehlermusterprüfung ein. |
| [`files.ts`](files.ts) | `filesTool` definiert versionierte Dateibearbeitung, Plan-/Co-Edit-Aktionen und Versionsabrufe. |
| [`shell.ts`](shell.ts) | `shellTool` definiert Shell-Ausführung und Job-/Log-/Aktivitätsabrufe mit Core-Sicherung und Anzeige. |
| [`ignore.ts`](ignore.ts) | `ignoreTool` definiert die Verwaltung und Prüfung projektbezogener Ignore-Regeln. |

### Projektwissen

| Datei / Unterordner | Aufgabe |
|---|---|
| [`project.ts`](project.ts) | `projectTool` definiert Projekt-Lifecycle, Status und Setup-Aktionen. |
| [`plan.ts`](plan.ts) | `planTool` definiert Plan- und Task-Verwaltung einschließlich Listen und Zuordnung. |
| [`memory.ts`](memory.ts) | `memoryTool` definiert Memory-Pflege, Abrufe, Suche und dateispezifisches Wissen. |
| [`thought.ts`](thought.ts) | `thoughtTool` definiert Thought-Verwaltung, ID-Abrufe und Suchvorschauen. |
| [`proposal.ts`](proposal.ts) | `proposalTool` definiert Proposal-Verwaltung, Statusänderung und Such-/Batchabrufe. |
| [`search.ts`](search.ts) | `searchTool` definiert Suchaktionen für Code, Pfade, Memories, Thoughts, Proposals, Tech-Doku und Medien. |
| [`docs.ts`](docs.ts) | `docsTool` definiert Tech-Doku-Pflege, Suche und dateispezifische Doku-Abfragen. |

### Agenten und Kommunikation

| Datei / Unterordner | Aufgabe |
|---|---|
| [`chat.ts`](chat.ts) | `chatTool` definiert Registrierung, Nachrichten und Inbox-Aktionen für Agenten. |
| [`channel.ts`](channel.ts) | `channelTool` definiert die Channel-Aktionen mit Nachrichten- und Mitgliedschaftsverwaltung. |
| [`event.ts`](event.ts) | `eventTool` definiert Auslösung, Bestätigung und Abfrage von Agenten-Events. |
| [`specialist.ts`](specialist.ts) | `specialistTool` definiert den Spezialisten-Lifecycle und die agentenbezogenen Bedien-Schnittstellen. |

### Verwaltung und Verträge

| Datei / Unterordner | Aufgabe |
|---|---|
| [`admin.ts`](admin.ts) | `adminTool` definiert das Wartungswerkzeug mit Statistik-, Ideen- und Jev-Verwaltungsaktionen. |
| [`jev.ts`](jev.ts) | `jevTool` definiert Jev-Rückfragen, Protokoll und die Aktionen des Entscheidungs-Topfs. |
| [`free-models.ts`](free-models.ts) | `freeModelsTool` definiert Abfragen des Modell-Pools und unterstützte Modell-Operationen. |
| [`guide.ts`](guide.ts) | `guideTool` definiert die Übersicht und Detailabfragen der gemeinsamen Werkzeug-Dokumentation. |
| [`watcher.ts`](watcher.ts) | `watcherTool` enthält die Definition und Handler des gesonderten Watcher-Werkzeugs. |
| [`types.ts`](types.ts) | `ConsolidatedTool` verbindet Definition und Handler; `reqStr`, `num` und `strArray` konvertieren Parameter. |
| [`index.ts`](index.ts) | Bündelt die Exporte der konsolidierten Werkzeuge. |
| [`utils/`](utils/README.md) | Enthält Hilfen für Einzel- und Batchoperationen. |

## Schnittstellen nach außen

Der Vertrag in [types.ts](types.ts) verbindet `definition` mit `handler`. [index.ts](index.ts) bietet die Definitionen an; die tatsächliche Registrierung bestimmt [server.ts](../../server.ts). `watcher.ts` ist vorhanden und exportiert, steht aber nicht in der dortigen Liste `ALLE_DEFINITIONEN`; vorhandene Dateien sind daher keine vollständige Aussage über `tools/list`.

## Abhängigkeiten

Die Handler nutzen [Fachadapter](../README.md), [Core](../../../../core/README.md) und [Agenten](../../../../agents/README.md). Asset- und Code-Check-Definitionen stammen direkt aus Core; Parametertypisierung und Konvertierung stehen in [types.ts](types.ts).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Server-Registry](../../server.ts)
- [REST-Registry](../../../../rest-api/src/routes/mcp.ts)
- [Zusammenhang und Betriebsvarianten](../../../../../docs/README.md)
