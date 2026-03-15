/**
 * Synapse Core - Cohere Embedding Provider
 * Nutzt die Cohere API v2 per fetch (kein SDK noetig)
 */

import { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'embed-v3.0';
const BASE_URL = 'https://api.cohere.com/v2';

export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'cohere';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${BASE_URL}/embed`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        texts,
        input_type: 'search_document',
        embedding_types: ['float'],
      }),
    });

    if (!response.ok) {
      throw new Error(`Cohere Embedding fehlgeschlagen: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: { float: number[][] } };
    return data.embeddings.float;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.embed('test');
      console.error(`[Synapse] Cohere verbunden, Model: ${this.model}`);
      return true;
    } catch (error) {
      console.error('[Synapse] Cohere nicht erreichbar:', error);
      return false;
    }
  }
}
