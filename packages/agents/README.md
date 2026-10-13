# Agenten-Paket

[Synapse](../../README.md) › [Übergeordneter Ordner](../README.md) › Agenten-Paket

## Zweck

Dieses Paket enthält die gemeinsame Infrastruktur für persistente Spezialisten und deren Wrapper-Prozesse. Es bündelt Prozesssteuerung, Modelle, Heartbeat, Status und Wissenstransporte.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Definiert Paket-Export, TypeScript-Build und den Binäreinstieg synapse-agent-wrapper. |
| [`tsconfig.json`](tsconfig.json) | Übernimmt die gemeinsame TypeScript-Konfiguration und ordnet src sowie dist zu. |
| [`src/`](src/README.md) | Enthält Wrapper, Steuerung, Wissenszugriff und Transportadapter. |

## Schnittstellen nach außen

Der Paket-Hauptexport liegt im gebauten `index.js`; `synapse-agent-wrapper` bezeichnet den gebauten Wrapper-Einstieg. MCP-Adapter und Daemon verwenden die Agentenfunktionen als Workspace-Paket.

## Abhängigkeiten

Das Paket hängt von [Core](../core/README.md) und pg ab; die Entwicklungstypen und Build-Werkzeuge stehen in [package.json](package.json).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [MCP-Adapter](../mcp-server/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
