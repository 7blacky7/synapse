# Embeddings

[Synapse](../../../../README.md) › [Core-Paket](../../../README.md) › [Quellcode](../README.md) › Embeddings

## Zweck

Dieser Bereich vereinheitlicht die Erzeugung von Text- und Medien-Embeddings über mehrere Provider. Er wählt den konfigurierten Provider, liefert Vektoren und Dimensionen und stellt gemeinsame Modellprofilfunktionen bereit.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Wählt den aktiven Provider und bündelt die Einbettungsfunktionen. |
| [`types.ts`](types.ts) | Definiert die Provider-Schnittstelle und Optionen für Einbettungen. |
| [`modell-profil.ts`](modell-profil.ts) | Verwaltet Modellprofile und providerbezogene Präfixe. |
| [`ollama.ts`](ollama.ts) | Implementiert den Ollama-Embedding-Provider. |
| [`ollama-modell-info.ts`](ollama-modell-info.ts) | Ermittelt und cached Informationen zu Ollama-Modellen. |
| [`openai-compatible.ts`](openai-compatible.ts) | Implementiert Provider mit OpenAI-kompatibler API, darunter OpenAI, Mistral, Jina und Voyage. |
| [`openai.ts`](openai.ts) | Liegt als eigenes Provider-Modul im Ordner; die Provider-Auswahl erfolgt über `openai-compatible.ts`. |
| [`google.ts`](google.ts) | Implementiert den Google-Embedding-Provider. |
| [`cohere.ts`](cohere.ts) | Implementiert den Cohere-Embedding-Provider. |

## Schnittstellen nach außen

[`index.ts`](index.ts) exportiert unter anderem `getEmbeddingProvider`, `embed`, `embedBatch`, `embedMedia`, `supportsMultimodal` und die Provider-Implementierungen. Das [Core-Paket](../index.ts) stellt diese Funktionen den aufrufenden Komponenten zur Verfügung. Der aktive Provider und seine Dimension werden pro Prozess gecached.

## Abhängigkeiten

Die Auswahl basiert auf der gemeinsamen [Core-Konfiguration](../config.ts); Profilfunktionen liegen in [`modell-profil.ts`](modell-profil.ts). Cloud-Provider sprechen ihre jeweiligen externen APIs an, während der lokale Provider Ollama nutzt. Die erzeugten Vektoren werden unter anderem vom [Qdrant-Bereich](../qdrant/README.md) gespeichert.

## Funktionsweise

Der Parser speichert den Text eines Chunks samt Hash zunächst in PostgreSQL. Solange `embedded_at` fehlt, kann ein Server-Worker oder ein Compute-Node den Chunk mit einem eindeutigen Claim-Token, Knotenkennung und zeitlich begrenzter Lease beanspruchen. Der Claim begrenzt zugleich die aktive Arbeit je Knoten. Die Queue im [Embedding-Service](index.ts) bevorzugt interaktive Aufträge; Hintergrundarbeit wartet, wenn interaktive Arbeit läuft oder bereits ansteht.

Der Server berechnet Hintergrund-Chunks mit dem konfigurierten Provider. Ein [Compute-Node](../../../compute-node-agent/src/README.md) erhält Modell, Digest, Ziel-Dimension, Kontextgröße und Profilpräfixe über den API-Referenzvertrag, prüft sein lokales Ollama-Modell und sendet die Vektoren mit Claim-Token und Inhalts-Hash zurück. Er greift dabei nicht direkt auf PostgreSQL zu.

Beim Abschluss prüft der Server Vektorform und -dimension sowie Knoten, Token, Hash und Lease. Nur passende Rückgaben werden in die Projekt-Collection von Qdrant geschrieben und anschließend in PostgreSQL als erledigt markiert. Eine zwischenzeitliche Dateiänderung, abgelaufene Lease oder ungültiger Vektor wird abgelehnt; der Chunk bleibt offen oder wird freigegeben und kann erneut beansprucht werden. Nicht kalibrierte Modellprofile liefern keinen stillen Ersatzwert. Ein pausierter Hintergrundpfad lässt Daten in PostgreSQL nachholbar; dauerhafte interaktive Last kann den Hintergrund entsprechend verzögern.

Andere Inhalte folgen eigenen Wegen: [Wissens-Embeddings](../services/embed-backlog.ts) holen offene Einträge aus Memories, Thoughts und weiteren Wissens-Tabellen nach. Bilder und Videos werden über den expliziten Medien-Indexierungsweg in einer separaten Media-Collection eingebettet, sofern der Provider multimodale Eingaben unterstützt. Beides sind keine Code-Chunk-Claims. Die strukturierten Metadaten von Nicht-Quellcode-Dateien gehören zur separaten [Asset-Intel-Pipeline](../asset-intel/README.md).

## Siehe auch

- [Chunking](../chunking/README.md)
- [Qdrant](../qdrant/README.md)
- [Core-Quellcode](../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
- [Parser und Chunks](../parser/README.md)
- [Compute-Node-Client](../../../compute-node-agent/src/README.md)
- [Asset-Intel](../asset-intel/README.md)
- [Embedding-Datenfluss](../../../../docs/bilder/embedding.svg)
