/**
 * Synapse Core - Ollama Embedding Provider
 * Lokale Embeddings mit GPU-Beschleunigung
 *
 * STUECKGROESSE (P12-T14, 11.10.2026): Ein Embedding-Modell muss jede Eingabe in EINEM physischen
 * Batch verarbeiten (Ollama n_batch/n_ubatch). Die Stueckgroesse richtete sich frueher nach num_ctx;
 * qwen kam damit zurecht, Nemotron lehnte jeden laengeren Text ab ("input (5671 tokens) is too large
 * to process ... batch size 2048", 209 Fehler in 30 Minuten). Vektoren der Stuecke werden gemittelt.
 * num_batch wird bewusst NICHT vergroessert (User-Vorgabe).
 * ENDPUNKT: /api/embed statt /api/embeddings - nimmt Listen (echte Stapel).
 *
 * KEINE MODELLWERTE IM CODE (P15-T7, Regel regel-keine-festverdrahteten-modellwerte): hier standen
 * 8192 (num_ctx) und 2048 (num_batch) als Rueckfall. Jetzt:
 *   num_ctx      EMBEDDING_NUM_CTX -> Modellprofil num_ctx -> weglassen (Ollama-Standard des Modells)
 *   Stueck       EMBEDDING_MAX_INPUT_CHARS -> Profil max_stueck_zeichen -> EMBEDDING_NUM_BATCH bzw.
 *                Profil num_batch als Zeichenzahl (1 Zeichen >= 1 Token: vorsichtig) -> ungeteilt.
 *                Lehnt Ollama trotzdem ab ("current batch size: N"), lernt der Provider die Grenze
 *                aus der Meldung und versucht es geteilt erneut (Obergrenze fuer den Prozess).
 * Das Profil laedt embed()/embedBatch() in embeddings/index.ts vorher (sichereModellprofil).
 */

import { getConfig } from '../config.js';
import { EmbeddingProvider } from './types.js';
import { geladenesModellprofil } from './modell-profil.js';

interface OllamaEmbedAntwort {
  embeddings: number[][];
}

/** Ollama hat eine Eingabe abgelehnt, weil sie nicht in den physischen Batch passt. */
class BatchZuKleinFehler extends Error {
  constructor(readonly batchToken: number, meldung: string) {
    super(meldung);
    this.name = 'BatchZuKleinFehler';
  }
}

/** So oft wird nach einer Batch-Ablehnung mit kleineren Stuecken neu versucht. */
const LERN_VERSUCHE = 3;

function positiveEnv(name: string): number | null {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

import {mitComputeAdmission} from '../services/compute-admission.js';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;
  private modelEnsured = false;
  private targetDim: number;
  /** Aus einer Ablehnung von Ollama gelernte Obergrenze in Zeichen (null = nichts gelernt). */
  private gelernteStueckZeichen: number | null = null;

  constructor() {
    const config = getConfig();
    this.baseUrl = config.embeddings.ollama.url;
    this.model = process.env.OLLAMA_MODEL || config.embeddings.ollama.model;
    if (!this.model) {
      throw new Error('Kein Ollama-Embedding-Modell konfiguriert: OLLAMA_MODEL setzen (kein Standardname im Code).');
    }
    // MRL-Truncation (optional): wenn EMBEDDING_TARGET_DIM gesetzt ist, wird der
    // Embedding-Vektor auf diese Dimension gekuerzt + renormalisiert. Ollama
    // liefert immer die native Dim; 0/unset = unveraendert.
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

  /** num_ctx der Anfrage: Env -> Modellprofil -> null (Feld weglassen, Ollama-Standard des Modells). */
  private numCtx(): number | null {
    return positiveEnv('EMBEDDING_NUM_CTX') ?? geladenesModellprofil()?.numCtx ?? null;
  }

  /**
   * Groesstes Stueck in Zeichen. Massgeblich ist der physische Batch des Modells, nicht num_ctx.
   * Reihenfolge siehe Dateikopf; eine gelernte Grenze deckelt jeden konfigurierten Wert.
   * Infinity = nicht teilen (bis Ollama eine Grenze nennt).
   */
  private maxChars(): number {
    const profil = geladenesModellprofil();
    const konfiguriert = positiveEnv('EMBEDDING_MAX_INPUT_CHARS')
      ?? profil?.maxStueckZeichen
      ?? positiveEnv('EMBEDDING_NUM_BATCH')
      ?? profil?.numBatch
      ?? Number.POSITIVE_INFINITY;
    return Math.min(konfiguriert, this.gelernteStueckZeichen ?? Number.POSITIVE_INFINITY);
  }

  /**
   * Lehnt Ollama wegen des physischen Batches ab, Grenze lernen und neu versuchen: erst die genannte
   * Token-Zahl als Zeichenzahl (1 Zeichen >= 1 Token), reicht das nicht, halbieren.
   */
  private async mitBatchLernen<T>(lauf: () => Promise<T>): Promise<T> {
    for (let versuch = 0; ; versuch++) {
      try {
        return await lauf();
      } catch (err) {
        if (!(err instanceof BatchZuKleinFehler) || versuch >= LERN_VERSUCHE) throw err;
        const vorher = this.gelernteStueckZeichen;
        this.gelernteStueckZeichen = vorher === null || vorher > err.batchToken
          ? err.batchToken
          : Math.max(1, Math.floor(vorher / 2));
        console.error(
          `[Synapse] Ollama lehnt Eingabe ab (physischer Batch ${err.batchToken} Token) - Stueckgroesse fuer diesen Prozess ` +
            `jetzt ${this.gelernteStueckZeichen} Zeichen. Dauerhaft: max_stueck_zeichen im Modellprofil setzen (intern modellprofil_setzen).`,
        );
      }
    }
  }

  /**
   * Generiert Embedding fuer einen Text
   */
  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (!this.modelEnsured) {
      await this.ensureModel();
    }
    return this.mitBatchLernen(() => this.embedEinmal(text, signal));
  }

  private async embedEinmal(text: string, signal?: AbortSignal): Promise<number[]> {
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
    return mitComputeAdmission(this.model,async ended=>{
    const numCtx = this.numCtx();
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      // P5-T15: verdraengter Hintergrund-Aufruf -> fetch bricht ab (Ollama rechnet ggf. kurz zu Ende)
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texte,
        ...(numCtx !== null ? { options: { num_ctx: numCtx } } : {}),
      }),
    });
    const text=await response.text();
    ended(); // Vollständige Antwort: HTTP-Rechnung beendet, auch bei fachlichem Fehler.
    if (!response.ok) {
      const detail = text.slice(0, 300);
      const meldung = `Ollama Fehler: ${response.status} ${response.statusText} ${detail}`.trim();
      const batch = /batch size:?\s*(\d+)/i.exec(detail);
      if (batch && Number(batch[1]) > 0) throw new BatchZuKleinFehler(Number(batch[1]), meldung);
      throw new Error(meldung);
    }
    const data = JSON.parse(text) as OllamaEmbedAntwort;
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texte.length) {
      throw new Error(`Ollama lieferte ${data.embeddings?.length ?? 0} statt ${texte.length} Vektoren`);
    }
    return data.embeddings;
    },this.baseUrl);
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
    return this.mitBatchLernen(async () => {
      const maxChars = this.maxChars();
      const ergebnis: number[][] = new Array(texts.length);
      const kurzIdx: number[] = [];
      for (let i = 0; i < texts.length; i++) {
        if (texts[i].length <= maxChars) kurzIdx.push(i);
        else ergebnis[i] = await this.embedEinmal(texts[i], signal);
      }
      if (kurzIdx.length > 0) {
        const vektoren = await this.embedRaw(kurzIdx.map((i) => texts[i]), signal);
        kurzIdx.forEach((i, k) => { ergebnis[i] = this.applyTargetDim(vektoren[k]); });
      }
      return ergebnis;
    });
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
