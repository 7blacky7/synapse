/**
 * Synapse Core - Ollama Embedding Provider
 * Lokale Embeddings mit GPU-Beschleunigung
 */

import { getConfig } from '../config.js';
import { EmbeddingProvider, OllamaEmbeddingResponse } from './types.js';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;
  private modelEnsured = false;

  constructor() {
    const config = getConfig();
    this.baseUrl = config.embeddings.ollama.url;
    this.model = config.embeddings.ollama.model;
  }

  /**
   * Prueft ob das Model verfuegbar ist
   */
  async isModelAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return false;

      const data = (await response.json()) as { models: Array<{ name: string }> };
      return data.models.some(m =>
        m.name === this.model ||
        m.name.startsWith(`${this.model}:`) ||
        m.name.includes(this.model)
      );
    } catch {
      return false;
    }
  }

  /**
   * Laedt das Model automatisch wenn nicht vorhanden
   */
  async pullModel(): Promise<boolean> {
    console.log(`[Synapse] Lade Ollama Model "${this.model}"...`);
    console.log(`[Synapse] Dies kann beim ersten Mal einige Minuten dauern.`);

    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.model, stream: false }),
      });

      if (!response.ok) {
        console.error(`[Synapse] Model Pull fehlgeschlagen: ${response.status}`);
        return false;
      }

      // Stream verarbeiten (Ollama sendet Fortschritt)
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let lastStatus = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          try {
            const lines = chunk.split('\n').filter(l => l.trim());
            for (const line of lines) {
              const data = JSON.parse(line);
              if (data.status && data.status !== lastStatus) {
                lastStatus = data.status;
                console.log(`[Synapse] ${data.status}`);
              }
            }
          } catch {
            // Ignoriere Parse-Fehler bei Stream
          }
        }
      }

      console.log(`[Synapse] Model "${this.model}" erfolgreich geladen!`);
      return true;
    } catch (error) {
      console.error('[Synapse] Fehler beim Laden des Models:', error);
      return false;
    }
  }

  /**
   * Stellt sicher dass das Model verfuegbar ist
   * Laedt es automatisch wenn nicht vorhanden
   */
  async ensureModel(): Promise<boolean> {
    if (this.modelEnsured) return true;

    const available = await this.isModelAvailable();

    if (!available) {
      console.log(`[Synapse] Model "${this.model}" nicht gefunden.`);
      const pulled = await this.pullModel();
      if (!pulled) return false;
    }

    this.modelEnsured = true;
    return true;
  }

  /**
   * Generiert Embedding fuer einen Text
   */
  async embed(text: string): Promise<number[]> {
    // Sicherstellen dass Model verfuegbar ist
    if (!this.modelEnsured) {
      await this.ensureModel();
    }

    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama Fehler: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaEmbeddingResponse;
    return data.embedding;
  }

  /**
   * Generiert Embeddings fuer mehrere Texte (sequenziell)
   * Ollama unterstuetzt kein natives Batch-Embedding
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const embedding = await this.embed(text);
      embeddings.push(embedding);
    }

    return embeddings;
  }

  /**
   * Testet die Verbindung zu Ollama und stellt Model bereit
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        console.error(`[Synapse] Ollama nicht erreichbar: ${this.baseUrl}`);
        return false;
      }

      console.log(`[Synapse] Ollama verbunden: ${this.baseUrl}`);

      // Model sicherstellen (automatisch laden wenn noetig)
      const modelReady = await this.ensureModel();
      if (!modelReady) {
        console.error(`[Synapse] Model "${this.model}" konnte nicht bereitgestellt werden`);
        return false;
      }

      console.log(`[Synapse] Ollama Model bereit: ${this.model}`);
      return true;
    } catch (error) {
      console.error('[Synapse] Ollama nicht erreichbar:', error);
      return false;
    }
  }
}
