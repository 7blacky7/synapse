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

// Retry-Konfiguration fuer 429 (Quota) + transiente 5xx (Service-Unavailable):
// Bis zu MAX_ATTEMPTS Versuche, exponentielles Backoff (1s, 2s, 4s, 8s, 16s)
// mit Jitter, cap 30s. Honoriert Googles "retryDelay" aus dem Error-Body
// (google.rpc.RetryInfo), wenn vorhanden.
const MAX_ATTEMPTS = 5;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parst Googles retryDelay ("16s") aus dem Fehler-Body in Millisekunden. */
function parseRetryDelayMs(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { details?: Array<{ '@type'?: string; retryDelay?: string }> } };
    const details = parsed?.error?.details ?? [];
    for (const d of details) {
      if (typeof d?.retryDelay === 'string') {
        const m = d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
  } catch { /* nicht-JSON Body, ignorieren */ }
  return null;
}

async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  let lastBody = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) return response;
    lastStatus = response.status;
    lastBody = await response.text();
    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
      throw new Error(`${label} fehlgeschlagen: ${response.status} ${lastBody}`);
    }
    // Wartezeit: Googles retryDelay-Hinweis bevorzugen, sonst exponential mit Jitter.
    const hinted = parseRetryDelayMs(lastBody);
    const expo = Math.min(2 ** attempt * 1000, 30000);
    const jitter = Math.floor(Math.random() * 500);
    const waitMs = (hinted ?? expo) + jitter;
    console.error(
      `[Synapse] ${label}: ${response.status} (Versuch ${attempt + 1}/${MAX_ATTEMPTS}), warte ${waitMs}ms${hinted ? ' (hint)' : ' (expo)'}…`
    );
    await sleep(waitMs);
  }
  throw new Error(`${label} nach ${MAX_ATTEMPTS} Versuchen: ${lastStatus} ${lastBody}`);
}

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
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
    }, 'Google Embedding');

    const data = await response.json() as { embedding: { values: number[] } };
    return data.embedding.values;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 100; // Google API Limit
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const url = `${BASE_URL}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map(text => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
          })),
        }),
      }, 'Google Batch-Embedding');

      const data = await response.json() as { embeddings: Array<{ values: number[] }> };
      allEmbeddings.push(...data.embeddings.map(e => e.values));
    }

    return allEmbeddings;
  }

  async embedMedia(data: Buffer, mimeType: string): Promise<number[]> {
    const url = `${BASE_URL}/models/${this.model}:embedContent?key=${this.apiKey}`;
    const base64Data = data.toString('base64');

    console.error(`[Synapse] Google Multimodal-Embedding: ${mimeType} (${(data.length / 1024 / 1024).toFixed(2)}MB)`);

    const response = await fetchWithRetry(url, {
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
    }, `Google Multimodal-Embedding (${mimeType})`);

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
