# Gemini-Spezialisten

[Synapse](../../README.md) › [Übergeordneter Ordner](../README.md) › Gemini-Spezialisten

## Zweck

Dieses Paket stellt eine Gemini-basierte Spezialisten-Runtime bereit. Es verbindet die Google-API mit der gemeinsamen Agenteninfrastruktur und einer lokalen Monitor-Oberfläche.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Definiert Runtime-Exports, Binäreinstieg, Abhängigkeiten und die Einbindung der öffentlichen Monitor-Dateien. |
| [`tsconfig.json`](tsconfig.json) | Ordnet TypeScript-Quellen und Ausgabe zu und nimmt die öffentlichen Web-Dateien aus der TypeScript-Kompilierung aus. |
| [`src/`](src/README.md) | Enthält Runtime, Werkzeugbrücke, Schema-Konvertierung und Monitor-Server. |

## Schnittstellen nach außen

Die Exporte `.` und `./runtime` sowie der Binärname `synapse-gemini` zeigen auf die gebaute Runtime. Die Runtime unterstützt Standalone- und Wrapper-Modus; der [Quellcode](src/runtime.ts) definiert die beiden Anbindungen.

## Abhängigkeiten

Das Paket verwendet @google/genai, Fastify sowie [Agenten](../agents/README.md), [Core](../core/README.md) und [MCP-Adapter](../mcp-server/README.md). Der Build übernimmt die [Monitor-Webdateien](src/public/README.md) in die Ausgabe. Laufzeitlogs sind keine Produkt-Dokumentation und hier nicht inventarisiert.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Agenten-Wrapper](../agents/src/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
