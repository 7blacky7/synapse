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

## Funktionsweise

Beim Start fragt der Knoten den API-Referenzvertrag ab. Er enthält Modell und Digest, native und Ziel-Dimension, Kontextgröße, VRAM-Anforderungen sowie die Präfixe und Stückgröße des Modellprofils. Der Client übernimmt diese Werte in die Embedding-Konfiguration, prüft das lokale Ollama-Modell und meldet Kapazität und Heartbeat an die API. Ohne abrufbaren oder passenden Vertrag startet er nicht mit eingebauten Modell-Standardwerten.

Die API vergibt Chunks aus PostgreSQL als Claims mit Token und Lease. Der Knoten hält offene Claims nach, damit ein SIGTERM sie freigeben kann, bildet Stapel und berechnet sie mit lokalem Ollama. Beim Abschluss vergleicht er den Modell-Digest erneut und sendet Vektoren, Claim-Tokens, Hashes und Modellparameter an die API. Der Server entscheidet, ob der Claim noch gültig ist, schreibt den Vektor in Qdrant und quittiert den Chunk in PostgreSQL.

Bei fehlender API-Verbindung oder Modellabweichung gibt der Knoten Claims frei und versucht es erneut. Der API-Endpunkt bleibt die Grenze zu Datenbank und Qdrant; der Client liest kein PostgreSQL. Der serverseitige Worker kann dieselben offenen Chunks bearbeiten, wenn kein externer Knoten sie beansprucht. Beide nutzen daher dieselbe Claim-Prüfung und konkurrieren nicht durch direkte Schreibzugriffe.

## Siehe auch

- [Übergeordneter Ordner](../README.md)
- [API-Paket](../../rest-api/README.md)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
- [Parser und Chunk-Erzeugung](../../core/src/parser/README.md)
- [Embedding-Service und Claim-Abschluss](../../core/src/embeddings/README.md)
- [Embedding-Datenfluss](../../../docs/bilder/embedding.svg)
