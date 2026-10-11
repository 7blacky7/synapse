/**
 * MODUL: ParserWorker
 * ZWECK: Server-seitiges Background-Parsing fuer Files die via REST/Web-KI in
 *        code_files landen. Schliesst die Luecke, wenn KEIN lokaler FileWatcher-
 *        Daemon laeuft — sonst wuerde code_intel (symbols, statements, ...) auf
 *        neue Files nichts zeigen.
 *
 * INPUT:  intervalMs (Default 30s), enabled-Flag
 * OUTPUT: ruft parseUnparsedFiles(project) fuer alle Projekte mit offenem
 *         Backlog — welche das sind, beantwortet projekteMitBacklog() in core.
 *         Optional: konsumiert project-init-queue Jobs (TODO Phase B).
 *         Stoesst je Tick die Context7-Automatik an (P12-T17, eigener Takt/Drosselung in core).
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: SELECT auf code_files, parseAndEmbed-Aufrufe (DELETE+INSERT
 *     auf code_symbols/code_references/code_statements/code_call_edges/code_chunks)
 *   - Optional Embeddings (wenn SYNAPSE_SKIP_EMBEDDINGS nicht gesetzt)
 *
 * RACE-SAFETY: parseAndEmbed hat pg_advisory_xact_lock pro File → parallele
 *   Aufrufe (z.B. lokaler Daemon + dieser Worker) werden serialisiert, keine
 *   Duplikate. Bedeutet: dieser Worker kann auch laufen wenn ein lokaler
 *   Daemon existiert — Doppel-Arbeit, aber kein Schaden.
 */

import {
  claimEmbeddingChunks,
  completeEmbeddingClaims,
  embedBatch,
  embeddeOffeneEintraege,
  expirePendingProjectInitJobs,
  getPool,
  parseUnparsedFiles,
  projekteMitBacklog,
  context7AutomatikTick,
  initContext7Automatik,
  imHintergrund,
  schalterHaeltAn,
  registriereInternQuelle,
} from '@synapse/core';
import { listEmbeddingNodes } from './embedding-nodes.js';

/**
 * Gibt einen selbst gehaltenen Claim frei. Wirkt nur auf die Claim-Spalten und
 * nur solange der Chunk nicht fertig ist; das claim_token verhindert, dass ein
 * Nachzuegler den Claim eines anderen Knotens aufhebt.
 */
async function gibClaimFrei(chunkId: string, claimToken: string): Promise<void> {
  await getPool().query(
    `UPDATE code_chunks
        SET claimed_by = NULL, claim_token = NULL, lease_until = NULL
      WHERE id = $1 AND claim_token = $2 AND embedded_at IS NULL`,
    [chunkId, claimToken],
  );
}

export interface ParserWorkerConfig {
  intervalMs?: number;       // default 30_000
  maxPerTick?: number;       // max Projekte pro Tick (Default 20, schuetzt vor Spitzenlast)
}

const DEFAULTS = {
  intervalMs: 30_000,
  maxPerTick: 20,
};

/**
 * Wie viele Chunks der Server GLEICHZEITIG selbst einbettet.
 *
 * Zwei Werte, weil es zwei verschiedene Lagen sind: arbeitet ein externer
 * GPU-Knoten mit, soll der Server nur mitschieben und den interaktiven
 * Anfragen nicht beide Slots der Embedding-Queue wegnehmen. Ist er allein,
 * darf er sich ausbreiten.
 * 0 schaltet die Mitarbeit des Servers ganz ab.
 */
function envGanzzahl(name: string, ersatz: number): number {
  const wert = Number(process.env[name]);
  return Number.isInteger(wert) && wert >= 0 ? wert : ersatz;
}

const PARALLEL_GETEILT = envGanzzahl('SYNAPSE_SERVER_EMBED_PARALLEL_SHARED', 1);
const PARALLEL_ALLEIN = envGanzzahl('SYNAPSE_SERVER_EMBED_PARALLEL_SOLO', 2);
/** P12-T14: Chunks je Slot und Runde, als EIN Ollama-Aufruf eingebettet (vorher 1). */
const STAPEL = Math.max(1, envGanzzahl('SYNAPSE_SERVER_EMBED_BATCH', 16));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ParserWorker {
  private cfg: Required<ParserWorkerConfig>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;          // Re-Entrancy-Schutz
  private stopped = false;
  private ticksDone = 0;
  private filesDone = 0;
  private chunksEmbedded = 0;
  private leerlaufZyklen = 0;

  constructor(cfg: ParserWorkerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...cfg } as Required<ParserWorkerConfig>;
  }

  init(): void {
    if (this.timer) return;
    this.stopped = false;
    console.error(
      `[parser-worker] aktiv (interval=${this.cfg.intervalMs}ms, maxPerTick=${this.cfg.maxPerTick})`
    );
    // Erster Tick gleich nach 2s (nicht beim Boot, damit Schema/Init durch sind).
    setTimeout(() => this.fire(), 2_000);
    this.timer = setInterval(() => this.fire(), this.cfg.intervalMs);
    void imHintergrund(() => this.embeddingLoop());
    // P12-T17: Context7-Automatik (eigener Takt, eigene Drosselung — siehe context7-automatik.ts)
    initContext7Automatik();
    // P14-T4: Stats fuer intern(action:'status')
    registriereInternQuelle('parser_worker', () => this.getStats());
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStats(): { ticksDone: number; filesDone: number; chunksEmbedded: number; running: boolean } {
    return {
      ticksDone: this.ticksDone,
      filesDone: this.filesDone,
      chunksEmbedded: this.chunksEmbedded,
      running: this.running,
    };
  }

  private fire(): void {
    if (this.running) return;       // vorheriger Tick noch aktiv → ueberspringen
    this.running = true;
    // P5-T15: alles im Tick ist Hintergrundarbeit -> Hintergrund-Pool (getPool liefert ihn darin)
    imHintergrund(() => this.tick())
      .catch(err => console.error(`[parser-worker] tick error: ${(err as Error).message}`))
      .finally(() => { this.running = false; });
  }

  /**
   * Der Server als MITARBEITER, nicht als Ersatzmann.
   *
   * ⚠️ BIS ZUM 01.08.2026 STAND HIER EIN AUSSTIEG: sobald irgendein externer
   * Knoten usable war, hat der Server das Embedding KOMPLETT eingestellt und
   * nur noch geschlafen. Das war keine Aufteilung, sondern eine Umschaltung —
   * es rechnete dann immer genau eine GPU, waehrend das Ollama der anderen
   * Seite unbenutzt danebenstand. Gemessen am 01.08.2026: bei totem lokalen
   * Agenten arbeitete ausschliesslich der Server (5 Chunks/min), bei lebendem
   * ausschliesslich der Agent.
   *
   * Jetzt claimt der Server dauerhaft mit, nur gedrosselt: mit fremder Hilfe
   * PARALLEL_GETEILT, allein PARALLEL_ALLEIN. Die Drosselung ist noetig, weil
   * EMBED_MAX_CONCURRENT im Server-Prozess auch die interaktiven Anfragen
   * bedient — der Bulk darf ihm nicht beide Slots wegnehmen.
   */
  private async embeddingLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        // P14-T2: Schalter embedding -> ruhig warten (claimEmbeddingChunks liefert dann ohnehin []),
        // statt in den Leerlauf-Backoff zu laufen, der nach der Freigabe bis zu 30 s nachhinkt.
        if (await schalterHaeltAn('embedding', 'parser-worker/embedding-claims')) {
          await sleep(5_000);
          continue;
        }
        const externeAktiv = (await listEmbeddingNodes(getPool())).some((node) => node.usable);
        const parallel = externeAktiv ? PARALLEL_GETEILT : PARALLEL_ALLEIN;
        if (parallel === 0) {
          await sleep(5_000);
          continue;
        }

        const claims = await claimEmbeddingChunks('unraid-local', {
          limit: parallel * STAPEL,
          maxConcurrent: parallel * STAPEL,
          leaseSeconds: 900,
        });

        if (claims.length === 0) {
          // Leerlauf ist der NORMALFALL, nicht die Ausnahme: sind alle Projekte
          // fertig oder deaktiviert, gibt es dauerhaft nichts zu holen. Ohne
          // Backoff fragt der Server dann jede Sekunde eine Transaktion mit
          // advisory_lock an, rund um die Uhr. Zurueck auf 1 s, sobald wieder
          // Arbeit da ist.
          this.leerlaufZyklen = Math.min(this.leerlaufZyklen + 1, 30);
          await sleep(1_000 * this.leerlaufZyklen);
          continue;
        }
        this.leerlaufZyklen = 0;

        // P12-T14: alle Claims dieser Runde als Stapel einbetten (embedBatch teilt in Scheiben je
        // Queue-Slot); scheitert der Stapel, werden alle Claims freigegeben.
        let vektoren: number[][];
        try {
          vektoren = await embedBatch(claims.map((c) => c.content), {
            priority: 'background',
            strictOllama: true,
          });
        } catch (err) {
          await Promise.all(claims.map((c) => gibClaimFrei(c.chunkId, c.claimToken).catch(() => undefined)));
          console.error('[parser-worker] Stapel mit ' + claims.length + ' Chunks fehlgeschlagen, Claims freigegeben: ' + (err as Error).message);
          await sleep(2_000);
          continue;
        }
        // P12-T14: Stapel-Abschluss (eine Transaktion, ein Upsert je Projekt). Abgelehnte und bei
        // einem Fehler alle Claims SOFORT freigeben statt sie 15 Minuten ablaufen zu lassen — ein
        // liegengebliebener Claim sieht aus wie ein haengender Knoten und blockiert den Chunk.
        const nachId = new Map(claims.map((c) => [String(c.chunkId), c]));
        try {
          const erg = await completeEmbeddingClaims('unraid-local', claims.map((c, idx) => ({
            chunkId: c.chunkId,
            claimToken: c.claimToken,
            contentHash: c.contentHash,
            vector: vektoren[idx],
          })));
          this.chunksEmbedded += erg.abgeschlossen.length;
          for (const a of erg.abgelehnt) {
            const c = nachId.get(String(a.chunkId));
            if (c) await gibClaimFrei(c.chunkId, c.claimToken).catch(() => undefined);
          }
          if (erg.abgelehnt.length > 0) {
            console.error('[parser-worker] ' + erg.abgelehnt.length + ' Claims abgelehnt und freigegeben (z. B. ' + erg.abgelehnt[0].grund + ')');
          }
        } catch (err) {
          await Promise.all(claims.map((c) => gibClaimFrei(c.chunkId, c.claimToken).catch(() => undefined)));
          console.error('[parser-worker] Stapel-Abschluss fehlgeschlagen, ' + claims.length + ' Claims freigegeben: ' + (err as Error).message);
          await sleep(2_000);
        }
      } catch (err) {
        console.error(`[parser-worker] Embedding-Schleife fehlgeschlagen: ${(err as Error).message}`);
        await sleep(2_000);
      }
    }
  }

  private async tick(): Promise<void> {
    this.ticksDone++;

    // EMBEDDING-BACKLOG (EMBED-1) — bewusst VOR der Projektauswahl unten.
    // Die Schreibpfade von memories stossen ihr Embedding seit EMBED-1 nebenlaeufig an; faellt
    // es aus, bleibt embedded_at NULL und der Eintrag ist fuer die semantische Suche unsichtbar,
    // ohne dass irgendetwas fehlschlaegt. Hier wird er nachgeholt.
    // WARUM NICHT WEITER UNTEN: projekteMitBacklog() liefert nur Projekte mit CODE-Rueckstand,
    // und bei leerer Liste kehrt tick() sofort zurueck. Ein Aufruf dahinter wuerde also genau
    // dann nie laufen, wenn sonst nichts zu tun ist — dem Normalfall.
    // Klein gedrosselt: der Nachzug darf die zwei Slots der Embedding-Queue nicht selbst
    // belegen, sonst bremst er die interaktiven Schreibvorgaenge aus, fuer die EMBED-1 gebaut ist.
    try {
      const nachtrag = await embeddeOffeneEintraege(10);
      if (nachtrag.nachgetragen > 0) {
        console.error(`[parser-worker] Embedding-Backlog: ${nachtrag.nachgetragen} nachgetragen`);
      }
    } catch (err) {
      console.error(`[parser-worker] Embedding-Backlog fehlgeschlagen: ${(err as Error).message}`);
    }

    // CONTEXT7-AUTOMATIK (P12-T17) — ebenfalls VOR der Projektauswahl, aus demselben Grund wie
    // der Backlog oben. Fire-and-forget: Context7-Aufrufe mit Pausen duerfen das Parsen nicht
    // aufhalten. Ob ein Lauf faellig ist und dass er nie doppelt laeuft, entscheidet das Modul.
    void context7AutomatikTick();

    // WELCHE PROJEKTE FAELLIG SIND, ENTSCHEIDET CORE — nicht dieser Worker.
    // Hier stand bis zum 28.07.2026 eine eigene Query, die nur parsed_at und
    // indexed_at kannte. Ein Projekt, dessen Dateien ausschliesslich VERALTET
    // waren (Parser-Version erhoeht, Inhalt unveraendert), tauchte darin nie auf.
    // parseUnparsedFiles kannte den Fall bereits, wurde fuer solche Projekte aber
    // nie gerufen — der Nachziehmechanismus war dadurch wirkungslos, obwohl beide
    // Haelften einzeln richtig aussahen. Eine zweite Formulierung derselben Regel
    // laeuft frueher oder spaeter wieder auseinander; deshalb genau eine.
    // Der Registry- und enabled-Guard steckt ebenfalls in projekteMitBacklog().
    // P14-T2: Schalter parser -> das Parsen ruht. Backlog-Embedding und Context7 oben haben eigene Schalter.
    if (await schalterHaeltAn('parser', 'parser-worker')) return;

    const projekte = await projekteMitBacklog(this.cfg.maxPerTick);

    if (projekte.length === 0) {
      // Stale init-jobs aufraeumen (15 Min-Cutoff) — kostet nichts wenn nichts da.
      await expirePendingProjectInitJobs(900).catch(() => 0);
      return;
    }

    for (const row of projekte) {
      try {
        const n = await parseUnparsedFiles(row.project);
        if (n > 0) {
          this.filesDone += n;
          console.error(`[parser-worker] ${row.project}: ${n} files geparst (Backlog war ${row.faellig})`);
        }
      } catch (err) {
        console.error(`[parser-worker] ${row.project} fehlgeschlagen: ${(err as Error).message}`);
      }
    }
  }
}

// ─── Singleton fuer Server-Lifecycle ─────────────────────────────────────────
let _instance: ParserWorker | null = null;

export function initParserWorker(cfg?: ParserWorkerConfig): ParserWorker {
  if (_instance) return _instance;
  _instance = new ParserWorker(cfg);
  _instance.init();
  return _instance;
}

export function getParserWorker(): ParserWorker | null {
  return _instance;
}

export function shutdownParserWorker(): void {
  if (_instance) { _instance.shutdown(); _instance = null; }
}
