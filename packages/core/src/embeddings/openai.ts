/**
 * Synapse Core - OpenAI Embedding Provider
 * Cloud-basierte Embeddings als Fallback
 */

import OpenAI from 'openai';
import { getConfig } from '../config.js';
import { EmbeddingProvider } from './types.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor() {
    const config = getConfig();

    if (!config.embeddings.openai.apiKey) {
      throw new Error('OpenAI API Key nicht konfiguriert (OPENAI_API_KEY)');
    }

    this.client = new OpenAI({
      apiKey: config.embeddings.openai.apiKey,
    });
    this.model = config.embeddings.openai.model;
  }

  /**
   * Generiert Embedding fuer einen Text
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });

    return response.data[0].embedding;
  }

  /**
   * Generiert Embeddings fuer mehrere Texte (Batch)
   * OpenAI unterstuetzt natives Batch-Embedding
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    // Sortiere nach Index, da OpenAI die Reihenfolge nicht garantiert
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map(item => item.embedding);
  }

  /**
   * Testet die Verbindung zu OpenAI
   */
  async testConnection(): Promise<boolean> {
    try {
      // Einfacher Test mit kurzem Text
      await this.embed('test');
      console.log(`[Synapse] OpenAI verbunden, Model: ${this.model}`);
      return true;
    } catch (error) {
      console.error('[Synapse] OpenAI nicht erreichbar:', error);
      return false;
    }
  }
}
