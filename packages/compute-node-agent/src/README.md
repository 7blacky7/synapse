# Compute-Node-Quellcode

[Synapse](../../../README.md) › [Übergeordneter Ordner](../README.md) › Compute-Node-Quellcode

## Zweck

Dieser Ordner implementiert den HTTP-Client eines verteilten Embedding-Knotens. Der Knoten übernimmt Modellparameter aus dem API-Referenzvertrag, meldet seine lokale Kapazität und verarbeitet beanspruchte Stapel.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | `holeReferenz` und `uebernehmeReferenz` übernehmen den Modellvertrag; `heartbeatLoop` und `claimLoop` steuern Kapazitätsmeldungen und Stapelverarbeitung. |
| [`probe.ts`](probe.ts) | `probeNodeCapabilities` erfasst die lokale Rechner-/GPU-Kapazität und `lokalerModellDigest` den installierten Ollama-Modellstand. |

## Schnittstellen nach außen

Die Client-Schleifen sprechen die [Embedding-Node-Routen](../../rest-api/src/routes/embedding-nodes.ts) an. `EmbeddingReference` und `NodeCapabilities` in [probe.ts](probe.ts) beschreiben Referenzvertrag und gemeldete Kapazität; Modell, Dimensionen, Kontextgröße und Präfixe stammen aus der API.

## Abhängigkeiten

Node stellt HTTP, Prozesse und Statusdateien bereit; Ollama liefert das lokale Modell, nvidia-smi die GPU-Probe. Die übernommenen Referenzparameter konfigurieren [Core-Embeddings](../../core/src/embeddings/README.md); direkte Datenbankzugriffe gehören nicht zu diesem Client.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [API-Paket](../../rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
