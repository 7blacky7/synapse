# Lokaler MCP-Server

[Synapse](../../README.md) › [Übergeordneter Ordner](../README.md) › Lokaler MCP-Server

## Zweck

Dieses Paket stellt Synapse-Werkzeuge für lokale MCP-Clients über stdio bereit. Es verbindet die fachlichen Core-Services mit Agentenfunktionen und dem lokalen Prozess-Einstieg.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Definiert das Paket, den Binäreinstieg und die Exporte für Server, Tool-Adapter und konsolidierte Werkzeuge. |
| [`tsconfig.json`](tsconfig.json) | Legt Quell- und Ausgabeordner auf Basis der gemeinsamen TypeScript-Konfiguration fest. |
| [`src/`](src/README.md) | Enthält Server, Einstieg und lokale Daemon-Anbindung. |
| [`hooks/`](hooks/README.md) | Enthält Shell-Hooks für Onboarding und dateibezogene Tech-Dokumentation. |
| [`tests/`](tests/README.md) | Enthält Prüfungen der Shell-Werkzeuge und Proposal-Antworten. |

## Schnittstellen nach außen

Der Binärname `synapse-mcp` und der Paket-Hauptexport zeigen auf den gebauten stdio-Einstieg. Die Subpath-Exporte `./tools` und `./consolidated` bieten die zwei Adapterebenen an.

## Abhängigkeiten

Das Paket verwendet das [MCP-SDK](package.json), [Core](../core/README.md), [Agenten-Paket](../agents/README.md), dotenv und minimatch; die Build-Konfiguration erbt [tsconfig.base.json](../../tsconfig.base.json).

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Quellcode](src/README.md)
- [REST-Gegenstück](../rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
