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

## Siehe auch

- [Chunking](../chunking/README.md)
- [Qdrant](../qdrant/README.md)
- [Core-Quellcode](../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
