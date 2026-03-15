/**
 * Synapse Core - OpenAI-kompatibler Embedding Provider
 * Unterstuetzt alle APIs mit OpenAI-kompatiblem /v1/embeddings Format:
 * OpenAI, Mistral, Jina AI, Voyage AI
 */

import OpenAI from 'openai';
import { EmbeddingProvider } from './types.js';

export interface OpenAICompatibleConfig {
  name: string;
  apiKey: string;
  model: string;
  baseURL?: string;
}

export const PROVIDER_PRESETS: Record<string, { baseURL: string; defaultModel: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', defaultModel: 'text-embedding-3-small' },
  mistral: { baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-embed' },
  jina: { baseURL: 'https://api.jina.ai/v1', defaultModel: 'jina-embeddings-v3' },
  voyage: { baseURL: 'https://api.voyageai.com/v1', defaultModel: 'voyage-2' },
};

export class OpenAICompatibleProvider implements EmbeddingProvider {
  readonly name: string;
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map(item => item.embedding);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.embed('test');
      console.error(`[Synapse] ${this.name} verbunden, Model: ${this.model}`);
      return true;
    } catch (error) {
      console.error(`[Synapse] ${this.name} nicht erreichbar:`, error);
      return false;
    }
  }
}
