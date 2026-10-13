# MCP-Fachadapter

[Synapse](../../../../README.md) › [Übergeordneter Ordner](../README.md) › MCP-Fachadapter

## Zweck

Dieser Ordner bildet die Adapterebene zwischen Core-/Agentenfunktionen und lokalen MCP-Antworten. Die öffentlichen Multi-Action-Definitionen sind im Unterordner consolidated gebündelt.

## Inhalt

### Projekt und Anbindung

| Datei / Unterordner | Aufgabe |
|---|---|
| [`init.ts`](init.ts) | `initProjekt` und `getProjectStatusWithStats` verbinden Initialisierung und Watcher-Zustand mit Statusstatistik. |
| [`setup.ts`](setup.ts) | `buildSetupWizard` und `completeSetupTool` beschreiben und aktualisieren die Projekt-Setup-Phasen. |
| [`onboarding.ts`](onboarding.ts) | `checkAgentOnboarding` ermittelt rollenbezogene Projektregeln und den Onboarding-Zustand. |
| [`mcp-bruecke.ts`](mcp-bruecke.ts) | `bereiteMcpBrueckeVor` und `holeWrapperToken` stellen die authentifizierte MCP-HTTP-Brücke für Wrapper bereit. |

### Wissen und Suche

| Datei / Unterordner | Aufgabe |
|---|---|
| [`memory.ts`](memory.ts) | `writeMemory`, `searchMemory` und `findMemoriesForFile` bedienen Wissen und seinen Dateibezug. |
| [`thoughts.ts`](thoughts.ts) | `addThought`, `getThoughtsByIdsTool` und `searchThoughts` bedienen Notizen, ID-Abrufe und Suchvorschauen. |
| [`plans.ts`](plans.ts) | `getProjectPlan`, `addPlanTask` und `updatePlanTask` bedienen Plan- und Task-Operationen. |
| [`proposals.ts`](proposals.ts) | `updateProposalTool` und `searchProposalsWrapper` verbinden Proposal-Pflege mit Suchabrufen. |
| [`search.ts`](search.ts) | `semanticCodeSearch`, `searchDocumentsWrapper` und `searchMediaWrapper` liefern Code-, Dokument- und Mediensuchen. |
| [`tech-docs.ts`](tech-docs.ts) | `addTechDocTool` und `getDocsForFileTool` bedienen Tech-Doku-Pflege und dateispezifische Abfragen. |
| [`tech.ts`](tech.ts) | `detectProjectTechnologies` und `indexTechDocs` verbinden Technologie-Erkennung mit Doku-Indexierung. |

### Agenten und Kommunikation

| Datei / Unterordner | Aufgabe |
|---|---|
| [`chat.ts`](chat.ts) | `registerChatAgent` und `sendChatMessage` bedienen Agentenregistrierung und Nachrichtenversand. |
| [`events.ts`](events.ts) | `emitEventTool`, `acknowledgeEventTool` und `getPendingEventsTool` bedienen Agentensignale. |
| [`specialists.ts`](specialists.ts) | `spawnSpecialistTool`, `wakeSpecialistTool` und `postToChannelTool` bedienen Spezialisten und ihre Kommunikation. |

### Wartung und Exports

| Datei / Unterordner | Aufgabe |
|---|---|
| [`ideas.ts`](ideas.ts) | `saveProjectIdea` merkt Projektideen vor; `confirmIdea` übernimmt bestätigte Ideen als Wissen. |
| [`migration.ts`](migration.ts) | `migrateEmbeddings` und `restoreFromBackup` bieten Datenmigration und Wiederherstellung an. |
| [`stats.ts`](stats.ts) | `getIndexStats` und `getDetailedStats` bereiten Index- und Detailstatistik auf. |
| [`index.ts`](index.ts) | Bündelt die Exporte der Fachadapter. |
| [`consolidated/`](consolidated/README.md) | Definiert die öffentlich registrierten Multi-Action-Werkzeuge und ihre Dispatcher. |

## Schnittstellen nach außen

[index.ts](index.ts) re-exportiert die Adapter für [server.ts](../server.ts) und die konsolidierten Werkzeuge. Die Adapter nehmen fachliche Parameter entgegen und liefern strukturierte Ergebnisse; [mcp-bruecke.ts](mcp-bruecke.ts) stellt die Wrapper-HTTP-Anbindung bereit.

## Abhängigkeiten

Die Fachlogik kommt aus [Core](../../../core/README.md) und [Agenten](../../../agents/README.md); projektspezifische Dateisystem-/Daemon-Funktionen verwenden Node und die lokale [Daemon-Anbindung](../daemon-client.ts).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Werkzeugdefinitionen](consolidated/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
