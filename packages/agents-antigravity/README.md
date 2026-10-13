# Antigravity-Spezialisten

[Synapse](../../README.md) › [Übergeordneter Ordner](../README.md) › Antigravity-Spezialisten

## Zweck

Dieses Paket stellt einen gesonderten Spezialisten-Adapter für die Antigravity-CLI bereit. Die Paketdefinition trennt diesen Provider vom Gemini-API-Adapter.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Definiert den Provider-Adapter, Runtime-Exports und den Binärnamen synapse-antigravity. |
| [`tsconfig.json`](tsconfig.json) | Ordnet die TypeScript-Quellen und Ausgabe auf Grundlage der gemeinsamen Konfiguration zu. |
| [`src/`](src/README.md) | Enthält die Antigravity-Runtime. |

## Schnittstellen nach außen

Die Exporte `.` und `./runtime` sowie `synapse-antigravity` zeigen auf die gebaute Runtime. Der Provider verwendet laut Paketdefinition die `agy`-CLI mit deren Session-Anbindung.

## Abhängigkeiten

Das Paket hängt vom gemeinsamen [Agenten-Paket](../agents/README.md) ab. Die Antigravity-CLI und ihre lokale Session sind eine separate Provider-Voraussetzung.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Gemini-Adapter](../agents-gemini/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
