/**
 * MODUL: Google Gemini Embedding Provider
 * ZWECK: Vektorisierung von Text und Medien via Google Gemini API — Text, Batch, Multimodal.
 *
 * INPUT:
 *   - apiKey: string - Google API Key (GOOGLE_API_KEY)
 *   - model?: string - Modellname (Standard: gemini-embedding-2-preview)
 *   - text: string - Zu embeddender Text
 *   - texts: string[] - Batch-Texte
 *   - data: Buffer + mimeType: string - Medien-Datei fuer Multimodal-Embedding
 *
 * OUTPUT:
 *   - number[]: Embedding-Vektor fuer einen Text
 *   - number[][]: Embedding-Vektoren fuer Batch
 *   - boolean: Verbindungstest-Ergebnis
 *
 * NEBENEFFEKTE:
 *   - Netzwerk: Ruft generativelanguage.googleapis.com auf
 *   - Kein lokaler State; kein PostgreSQL; kein Qdrant
 */

import { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'gemini-embedding-2-preview';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'google';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const url = `${BASE_URL}/models/${this.model}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!response.ok) {
      throw new Error(`Google Embedding fehlgeschlagen: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embedding: { values: number[] } };
    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const url = `${BASE_URL}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`Google Batch-Embedding fehlgeschlagen: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { embeddings: Array<{ values: number[] }> };
    return data.embeddings.map(e => e.values);
  }

  async embedMedia(data: Buffer, mimeType: string): Promise<number[]> {
    const url = `${BASE_URL}/models/${this.model}:embedContent?key=${this.apiKey}`;
    const base64Data = data.toString('base64');

    console.error(`[Synapse] Google Multimodal-Embedding: ${mimeType} (${(data.length / 1024 / 1024).toFixed(2)}MB)`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: {
          parts: [{
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          }],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Multimodal-Embedding fehlgeschlagen (${mimeType}): ${response.status} ${errorText}`);
    }

    const result = await response.json() as { embedding: { values: number[] } };
    console.error(`[Synapse] Multimodal-Embedding erstellt: ${result.embedding.values.length} Dimensionen`);
    return result.embedding.values;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.embed('test');
      console.error(`[Synapse] Google verbunden, Model: ${this.model}`);
      return true;
    } catch (error) {
      console.error('[Synapse] Google nicht erreichbar:', error);
      return false;
    }
  }
}
