# Oberflächenkomponenten

[Synapse](../../../../README.md) › [Pakete](../../../README.md) › [Web-Oberfläche](../../README.md) › [Quellcode](../README.md) › Komponenten

## Zweck

Die Komponenten bilden die Anmeldemaske, Projektarbeitsfläche, Dashboards, Wissens- und Infrastrukturansichten sowie Graph- und Agentendarstellungen. Einige Ansichten sind live mit API-Adaptern verbunden; andere verwenden Beispieldaten. [StatusKennzeichnung.tsx](StatusKennzeichnung.tsx) stellt dafür die Stufen „live“, „teilweise“ und „demo“ samt Planungshinweisen bereit.

## Inhalt

### Arbeitsfläche und Kommunikation

| Datei | Aufgabe |
|---|---|
| [SynapseWorkspaceMock.tsx](SynapseWorkspaceMock.tsx) | Setzt die Arbeitsfläche zusammen und verwaltet Navigation, Projektkontext sowie eingebettete Ansichten. Der Name kennzeichnet den Mock-Charakter dieser übergeordneten Arbeitsfläche. |
| [Dashboard.tsx](Dashboard.tsx) | Zeigt Projektaktivitäten wie Agenten, Channels, Watcher-Ereignisse und Datei-Versionen. |
| [Chat.tsx](Chat.tsx) | Stellt den projektbezogenen Chat mit Nachrichtenverlauf und REST-Aufruf dar. |
| [ChannelProjectSurface.tsx](ChannelProjectSurface.tsx) | Bündelt projektbezogene Bereiche wie Agenten, Plan, Workspaces, Graph und Wissen. |
| [ChannelAgentChatWindow.tsx](ChannelAgentChatWindow.tsx) | Stellt ein verschiebbares Chatfenster für einen Agenten in einem Channel dar. |
| [ChatAttachments.tsx](ChatAttachments.tsx) | Verwaltet Auswahl, Ablegen und Vorschau von Chat-Anhängen. |
| [chat-attachments.css](chat-attachments.css) | Stile für Auswahl, Ablegen und Vorschau von Chat-Anhängen. |
| [Login.tsx](Login.tsx) | Bildet Einrichtung und Anmeldung mit TOTP-Code ab. |

### Control Plane und Projektkoordination

| Datei | Aufgabe |
|---|---|
| [ControlPlaneSettingsView.tsx](ControlPlaneSettingsView.tsx) | Zeigt Control-Plane-Einstellungen für Agenten, Hosts, Laufzeiten, Workspaces, Ressourcen und Darstellung. |
| [CoordinatorInspector.tsx](CoordinatorInspector.tsx) | Zeigt Detailbereiche des Koordinators; die Einträge im Inspektor sind lokale Beispieldaten. |
| [ProjectCoordinatorDock.tsx](ProjectCoordinatorDock.tsx) | Stellt das projektbezogene Koordinatorfenster mit Verlauf, Team, Channels, Plänen und Wissen dar. |
| [ProjectKnowledgePanel.tsx](ProjectKnowledgePanel.tsx) | Ordnet Wissensbereiche eines Projekts als Detailpanel. |
| [coordinator-inspector.css](coordinator-inspector.css) | Stile des Koordinator-Inspektors. |
| [project-coordinator-dock.css](project-coordinator-dock.css) | Stile des Koordinatorfensters. |

### Hauptagent und Infrastruktur

| Datei | Aufgabe |
|---|---|
| [MainAgentDashboard.tsx](MainAgentDashboard.tsx) | Zeigt Aktivität, Artefakte und weitere Bereiche des Hauptagenten anhand übergebener View-Daten. |
| [MainAgentAssistantDock.tsx](MainAgentAssistantDock.tsx) | Stellt ein Assistentenfenster mit Nachrichten und Anhängen dar. |
| [main-agent-assistant-dock.css](main-agent-assistant-dock.css) | Stile des Assistentenfensters. |
| [InfrastructureView.tsx](InfrastructureView.tsx) | Gruppiert Ansichten zu Agent-Hosts, Runtimes, Workspaces und Testsystemen. |
| [CodexRuntimeControl.tsx](CodexRuntimeControl.tsx) | Zeigt die Steuerung der Hauptagenten-Runtime und bindet Status- und Kontrollaufrufe ein. |
| [CodexTerminal.tsx](CodexTerminal.tsx) | Stellt Terminalsitzungen mit xterm dar. |
| [ModelPoolTable.tsx](ModelPoolTable.tsx) | Listet Modelle und Provider und bietet Pool-Aktionen. |
| [main-agent-dashboard.css](../main-agent-dashboard.css) | Stile des Hauptagenten-Dashboards. |
| [infrastructure-control-plane.css](../infrastructure-control-plane.css) | Stile der Infrastrukturansicht. |
| [control-plane-settings.css](../control-plane-settings.css) | Stile der Einstellungsansicht. |
| [codex-runtime.css](../codex-runtime.css) | Stile für Runtime-Steuerung und Terminal. |
| [model-pool.css](../model-pool.css) | Stile der Modellpool-Tabelle. |

### Wissen und Graph

| Datei | Aufgabe |
|---|---|
| [KnowledgeView.tsx](KnowledgeView.tsx) | Zeigt persönliche Memories oder Artefakte und verwendet die zugehörigen lokalen Beispieldaten. |
| [PersonalArtifactsControl.tsx](PersonalArtifactsControl.tsx) | Filtert und bearbeitet Artefakt- und Memory-Zustände der Wissensansicht. |
| [MemorySearch.tsx](MemorySearch.tsx) | Sucht projektbezogene Memories über den API-Client. |
| [GraphView.tsx](GraphView.tsx) | Bindet die Graph-Engine in einen React-Container ein. |
| [personal-artifacts-control.css](personal-artifacts-control.css) | Stile der persönlichen Artefaktverwaltung. |
| [personal-knowledge.css](../personal-knowledge.css) | Stile der persönlichen Wissensansicht. |
| [project-knowledge.css](../project-knowledge.css) | Stile des Projektwissenspanels. |
| [channel-project-surface.css](../channel-project-surface.css) | Stile der Projekt- und Channel-Oberfläche. |

### Status

| Datei | Aufgabe |
|---|---|
| [StatusKennzeichnung.tsx](StatusKennzeichnung.tsx) | Kennzeichnet eine Ansicht als live, teilweise angebunden oder Demo und zeigt Planungshinweise. |

## Schnittstellen nach außen

[SynapseWorkspaceMock.tsx](SynapseWorkspaceMock.tsx) verbindet Oberflächenkomponenten mit Funktionen aus [api](../api/README.md), View-Modellen aus [control-plane](../control-plane/README.md) und Beispieldaten aus [mock](../mock/README.md). [GraphView.tsx](GraphView.tsx) nutzt die eigenständige [Graph-Engine](../graph/README.md); [AgentRenderingSurface](../kios/README.md) stellt HTML-Artefakte dar.

## Abhängigkeiten

Die Komponenten verwenden React. API-Daten kommen über [api](../api/README.md), während [mock](../mock/README.md) statische Datensätze für ausgewählte Control-Plane- und Wissensansichten bereitstellt. [CodexTerminal.tsx](CodexTerminal.tsx) nutzt xterm; die Graph-Ansicht verwendet Cytoscape über den Graph-Unterordner.

## Siehe auch

- [API-Adapter](../api/README.md)
- [Beispieldaten](../mock/README.md)
- [Graph](../graph/README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
