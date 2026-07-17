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
  private targetDim: number;

  constructor() {
    const config = getConfig();
    this.baseUrl = config.embeddings.ollama.url;
    this.model = config.embeddings.ollama.model;
    // MRL-Truncation (optional): wenn EMBEDDING_TARGET_DIM gesetzt ist, wird der
    // Embedding-Vektor auf diese Dimension gekuerzt + renormalisiert. Ollama
    // liefert immer die native Dim (qwen3-embedding:8b = 4096); mit
    // EMBEDDING_TARGET_DIM=3072 passen die Vektoren in bestehende 3072-Collections
    // (Drop-in fuer gemini-embedding-2). 0/unset = unveraendert.
    this.targetDim = Number(process.env.EMBEDDING_TARGET_DIM) || 0;
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
    console.error(`[Synapse] Lade Ollama Model "${this.model}"...`);
    console.error(`[Synapse] Dies kann beim ersten Mal einige Minuten dauern.`);

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
                console.error(`[Synapse] ${data.status}`);
              }
            }
          } catch {
            // Ignoriere Parse-Fehler bei Stream
          }
        }
      }

      console.error(`[Synapse] Model "${this.model}" erfolgreich geladen!`);
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
      console.error(`[Synapse] Model "${this.model}" nicht gefunden.`);
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

    // num_ctx anheben: Ollama laedt Embedding-Modelle per Default mit nur 4096
    // Token. Lange Memories/Thoughts/Chunks sprengen das ("input length exceeds
    // the context length" -> HTTP 500). Wir setzen num_ctx (Default 8192) direkt
    // in der Anfrage, damit auch langer Text KOMPLETT embedded wird statt zu failen.
    const numCtx = Number(process.env.EMBEDDING_NUM_CTX) || 8192;
    // Sichere Stueckgroesse: garantiert < numCtx Token selbst bei sehr dichtem
    // Text (~2 Zeichen/Token), mit Marge.
    const maxChars = Number(process.env.EMBEDDING_MAX_INPUT_CHARS) || (numCtx * 2 - 384);

    // Passt in einen Pass → direkt embedden.
    if (text.length <= maxChars) {
      return this.applyTargetDim(await this.embedRaw(text, numCtx));
    }

    // Zu lang → in Stuecke splitten, jedes embedden, Vektoren mitteln (mean-pooling)
    // + renormalisieren. So geht KEIN Content verloren (statt zu truncaten) und der
    // Kontext wird nie gesprengt — egal wie lang der Text ist (Memory/Thoughts/Docs).
    const vectors: number[][] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      vectors.push(await this.embedRaw(text.slice(i, i + maxChars), numCtx));
    }
    const dim = vectors[0].length;
    const mean = new Array<number>(dim).fill(0);
    for (const v of vectors) {
      for (let j = 0; j < dim; j++) mean[j] += v[j];
    }
    for (let j = 0; j < dim; j++) mean[j] /= vectors.length;
    return this.applyTargetDim(mean);
  }

  /** Ein einzelner Embed-Call an Ollama (mit num_ctx). Ohne Dim-Truncation. */
  private async embedRaw(text: string, numCtx: number): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
        options: { num_ctx: numCtx },
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama Fehler: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as OllamaEmbeddingResponse;
    return data.embedding;
  }

  /**
   * MRL-Truncation: kuerzt den Vektor auf targetDim (die ersten N Dimensionen —
   * bei MRL-trainierten Modellen wie Qwen3 die informationsdichtesten) und
   * normalisiert auf Laenge 1 (korrekte Cosine-Similarity). No-op wenn targetDim
   * unset/0 oder der Vektor bereits <= targetDim ist.
   */
  private applyTargetDim(vec: number[]): number[] {
    if (!this.targetDim || this.targetDim <= 0 || vec.length <= this.targetDim) {
      return vec;
    }
    const truncated = vec.slice(0, this.targetDim);
    let sumSq = 0;
    for (const x of truncated) sumSq += x * x;
    const norm = Math.sqrt(sumSq);
    if (norm === 0) return truncated;
    return truncated.map(x => x / norm);
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

      console.error(`[Synapse] Ollama verbunden: ${this.baseUrl}`);

      // Model sicherstellen (automatisch laden wenn noetig)
      const modelReady = await this.ensureModel();
      if (!modelReady) {
        console.error(`[Synapse] Model "${this.model}" konnte nicht bereitgestellt werden`);
        return false;
      }

      console.error(`[Synapse] Ollama Model bereit: ${this.model}`);
      return true;
    } catch (error) {
      console.error('[Synapse] Ollama nicht erreichbar:', error);
      return false;
    }
  }
}
