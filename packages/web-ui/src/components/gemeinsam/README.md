# Gemeinsame Web-UI-Bausteine

[Synapse](../../../../../README.md) › [Pakete](../../../../README.md) › [Web-Oberfläche](../../../README.md) › [Quellcode](../../README.md) › [Gemeinsam]

## Zweck

Dieser Ordner enthält gemeinsam verwendete, unabhängige Typen und UI-Bausteine der Web-Oberfläche. Die Module importieren keine Ansicht und keine Workspace-Hülle.

## Inhalt

| Datei | Zweck |
|---|---|
| [agent-nachrichten-typen.ts](agent-nachrichten-typen.ts) | Gemeinsame Typen für HTML-Blöcke, Layouts und Agent-Nachrichten |

## Funktionsweise und Schnittstellen

[agent-nachrichten-typen.ts](agent-nachrichten-typen.ts) exportiert `AgentHtmlBlock`, `AgentHtmlLayout` und `AgentMessage` als Typen. Die Typen bleiben inhaltlich 1:1 aus der bisherigen Workspace-Quelle übernommen; ergänzt wurden ausschließlich die für das eigenständige Modul erforderlichen Typimporte und Exporte.

## Abhängigkeiten

Die Nachrichtentypen verwenden bestehende Typen aus `ChatAttachments`, `control-plane/view-model` und `zitat-logik`. Es gibt keine Rückabhängigkeit zu einer Ansicht oder zur Workspace-Hülle.

## Siehe auch

- [Workspace-Module](../workspace/README.md)
- [Ansichten](../../views/README.md)
