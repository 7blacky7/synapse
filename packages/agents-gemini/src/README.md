# Gemini-Runtime-Quellcode

[Synapse](../../../README.md) › [Übergeordneter Ordner](../README.md) › Gemini-Runtime-Quellcode

## Zweck

Dieser Ordner verbindet Gemini Function Calling mit Synapse-Werkzeugen. Runtime und Monitor sind getrennt von der Schema-Konvertierung und dem Werkzeug-Dispatcher.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`runtime.ts`](runtime.ts) | Wählt in main den Standalone- oder Wrapper-Modus und verbindet GoogleGenAI mit buildToolBridge sowie MonitorServer. |
| [`monitor-server.ts`](monitor-server.ts) | Bietet MonitorServer mit GET /, GET /events und GET /run.jsonl an. |
| [`schema-convert.ts`](schema-convert.ts) | Konvertiert in convertSchema JSON-Schema in den vom Gemini-SDK verwendeten Schema-Teilbereich. |
| [`tool-bridge.ts`](tool-bridge.ts) | Erzeugt in buildToolBridge FunctionDeclarations und einen Dispatcher für die konsolidierten Synapse-Werkzeuge. |
| [`public/`](public/README.md) | Enthält den vom MonitorServer ausgelieferten Live-Viewer. |

## Schnittstellen nach außen

`buildToolBridge` liefert `declarations`, `warnings` und `dispatch`; Function-Namen tragen den Präfix `mcp__synapse__`. `MonitorServer` stellt die Viewer-, SSE- und JSONL-Endpunkte bereit. Die Runtime verwendet im Wrapper-Modus das Claude-CLI-kompatible Stream-JSON-Protokoll über stdin/stdout.

## Abhängigkeiten

Die Module verwenden @google/genai, Fastify, [Agenten](../../agents/README.md), [Core](../../core/README.md) und die [MCP-Werkzeugdefinitionen](../../mcp-server/src/tools/consolidated/README.md). Provider-Zugangsdaten werden separat aufgelöst; keine tatsächlichen Werte sind Bestandteil dieser README.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Monitor-Viewer](public/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
