/**
 * Synapse Core - Ollama Embedding Provider
 * Lokale Embeddings mit GPU-Beschleunigung
 *
 * STUECKGROESSE (P12-T14, 11.10.2026): Ein Embedding-Modell muss jede Eingabe in EINEM physischen
 * Batch verarbeiten (Ollama n_batch/n_ubatch, Standard 2048 Token). Die Stueckgroesse richtete sich
 * frueher nach num_ctx (8192 -> ~16.000 Zeichen); qwen kam damit zurecht, Nemotron lehnte jeden
 * laengeren Text ab ("input (5671 tokens) is too large to process ... batch size 2048", 209 Fehler
 * in 30 Minuten). Jetzt: Stuecke von hoechstens EMBEDDING_NUM_BATCH * 1,6 Zeichen (2048 -> 3276),
 * Vektoren wie bisher gemittelt. num_batch wird bewusst NICHT vergroessert (User-Vorgabe).
 * ENDPUNKT: /api/embed statt /api/embeddings - nimmt Listen (echte Stapel) und kuerzt ein doch zu
 * langes Stueck ab, statt den ganzen Eintrag scheitern zu lassen.
 */

import { getConfig } from '../config.js';
import { EmbeddingProvider } from './types.js';

interface OllamaEmbedAntwort {
  embeddings: number[][];
}

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
    // liefert immer die native Dim (Nemotron-3-Embed-1B = 2048); mit
    // EMBEDDING_TARGET_DIM=1024 passen die Vektoren in die 1024er-Collections.
    // 0/unset = unveraendert.
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

  /** num_ctx der Anfrage (Default 8192) - Kontextfenster des geladenen Modells. */
  private numCtx(): number {
    return Number(process.env.EMBEDDING_NUM_CTX) || 8192;
  }

  /**
   * Groesstes Stueck in Zeichen. Massgeblich ist der physische Batch (EMBEDDING_NUM_BATCH, Standard
   * 2048 Token wie bei Ollama), nicht num_ctx. Faktor 1,6 Zeichen/Token ist vorsichtig (gemessen:
   * 3300 Zeichen TypeScript = 981 Token). EMBEDDING_MAX_INPUT_CHARS uebersteuert.
   */
  private maxChars(): number {
    const numBatch = Number(process.env.EMBEDDING_NUM_BATCH) || 2048;
    return Number(process.env.EMBEDDING_MAX_INPUT_CHARS) || Math.floor(numBatch * 1.6);
  }

  /**
   * Generiert Embedding fuer einen Text
   */
  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (!this.modelEnsured) {
      await this.ensureModel();
    }
    const maxChars = this.maxChars();

    // Passt in ein Stueck -> direkt embedden.
    if (text.length <= maxChars) {
      return this.applyTargetDim((await this.embedRaw([text], signal))[0]);
    }

    // Zu lang -> in Stuecke teilen, alle in EINEM Aufruf einbetten, Vektoren mitteln
    // (mean-pooling) + renormalisieren. So geht kein Inhalt verloren und kein Stueck
    // sprengt den Batch des Modells.
    const stuecke: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) stuecke.push(text.slice(i, i + maxChars));
    const vectors = await this.embedRaw(stuecke, signal);
    const dim = vectors[0].length;
    const mean = new Array<number>(dim).fill(0);
    for (const v of vectors) {
      for (let j = 0; j < dim; j++) mean[j] += v[j];
    }
    for (let j = 0; j < dim; j++) mean[j] /= vectors.length;
    return this.applyTargetDim(mean);
  }

  /** Ein Aufruf an /api/embed fuer eine Liste von Texten. Ohne Dim-Truncation. */
  private async embedRaw(texte: string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      // P5-T15: verdraengter Hintergrund-Aufruf -> fetch bricht ab (Ollama rechnet ggf. kurz zu Ende)
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texte,
        options: { num_ctx: this.numCtx() },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Ollama Fehler: ${response.status} ${response.statusText} ${detail}`.trim());
    }
    const data = (await response.json()) as OllamaEmbedAntwort;
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texte.length) {
      throw new Error(`Ollama lieferte ${data.embeddings?.length ?? 0} statt ${texte.length} Vektoren`);
    }
    return data.embeddings;
  }

  /**
   * MRL-Truncation: kuerzt den Vektor auf targetDim (die ersten N Dimensionen —
   * bei MRL-trainierten Modellen die informationsdichtesten) und normalisiert auf
   * Laenge 1 (korrekte Cosine-Similarity). No-op wenn targetDim unset/0 oder der
   * Vektor bereits <= targetDim ist.
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
   * Embeddings fuer mehrere Texte. Kurze Texte gehen in EINEM /api/embed-Aufruf durch (gemessen:
   * 16 Code-Chunks, 3749 Token, 0,85 s); zu lange werden einzeln ueber embed() gestueckelt.
   */
  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (!this.modelEnsured) {
      await this.ensureModel();
    }
    const maxChars = this.maxChars();
    const ergebnis: number[][] = new Array(texts.length);
    const kurzIdx: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].length <= maxChars) kurzIdx.push(i);
      else ergebnis[i] = await this.embed(texts[i], signal);
    }
    if (kurzIdx.length > 0) {
      const vektoren = await this.embedRaw(kurzIdx.map((i) => texts[i]), signal);
      kurzIdx.forEach((i, k) => { ergebnis[i] = this.applyTargetDim(vektoren[k]); });
    }
    return ergebnis;
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
