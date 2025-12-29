/**
 * Synapse Core - Embedding Typen
 */

export interface EmbeddingProvider {
  /** Name des Providers */
  readonly name: string;

  /** Generiert Embedding fuer einen Text */
  embed(text: string): Promise<number[]>;

  /** Generiert Embeddings fuer mehrere Texte (Batch) */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Testet die Verbindung zum Provider */
  testConnection(): Promise<boolean>;
}

export interface OllamaEmbeddingResponse {
  embedding: number[];
}

export interface OllamaGenerateEmbeddingRequest {
  model: string;
  prompt: string;
}
