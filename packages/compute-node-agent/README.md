# Embedding-Rechenknoten

[Synapse](../../README.md) › [Übergeordneter Ordner](../README.md) › Embedding-Rechenknoten

## Zweck

Dieses Paket stellt einen HTTP-basierten Agenten für zusätzliche Ollama-Rechenknoten bereit. Es verbindet lokale Rechenkapazität mit der zentralen Synapse-Embedding-Verwaltung.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`package.json`](package.json) | Definiert das Paket, den Einstieg dist/index.js und den Binärnamen synapse-compute-node. |
| [`tsconfig.json`](tsconfig.json) | Ordnet die TypeScript-Quellen und Ausgabe auf Basis der gemeinsamen Konfiguration zu. |
| [`src/`](src/README.md) | Enthält den HTTP-Agenten und die Probe der lokalen Embedding-Fähigkeiten. |

## Schnittstellen nach außen

Der Paket-Haupteinstieg und `synapse-compute-node` zeigen auf den gebauten Agenten. Die API-Anbindung betrifft die Registrierung und Arbeit eines Rechenknotens, nicht den Spezialisten-Wrapper.

## Abhängigkeiten

Das Paket verwendet [Core](../core/README.md) und dotenv; seine Compute-Funktion benötigt einen lokalen Ollama-Dienst und die autorisierte API-Anbindung.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [Embedding-Verwaltung](../rest-api/src/services/embedding-nodes.ts)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
