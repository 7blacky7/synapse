/**
 * MODUL: Embedding Typen
 * ZWECK: Gemeinsame Interfaces fuer alle Embedding-Provider und deren Anfrage-/Antwort-Strukturen.
 *
 * INPUT:  — (nur Typdefinitionen, kein Runtime-Code)
 * OUTPUT: — (nur Typdefinitionen, kein Runtime-Code)
 *
 * NEBENEFFEKTE: keine
 */

export interface EmbeddingProvider {
  /** Name des Providers */
  readonly name: string;

  /** Generiert Embedding fuer einen Text */
  embed(text: string): Promise<number[]>;

  /** Generiert Embeddings fuer mehrere Texte (Batch) */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Generiert Embedding fuer Medien-Dateien (Bild/Video) - nur multimodale Provider */
  embedMedia?(data: Buffer, mimeType: string): Promise<number[]>;

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
