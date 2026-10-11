/**
 * MODUL: Parser Worker Pool
 * ZWECK: Verteilt Parse-Calls auf N node:worker_threads Worker, off-thread.
 *
 * PROTOKOLL (siehe worker-runner.ts):
 *   In:  { filePath, fileType, content }
 *   Out: { ok: true; result: ParseResult | null } | { ok: false; error: string }
 *
 * VERHALTEN:
 *   - size via PARSER_WORKER_THREADS (Default 4).
 *   - PARSER_WORKER_THREADS === '0'  =>  Pool deaktiviert: getParserPool() => null.
 *   - parse(): findet freien Worker oder queued; ein Worker bearbeitet
 *     zu einem Zeitpunkt genau einen Request.
 *   - Fehlerhafte Worker (error/exit) werden bis zu MAX_RETRIES neu gespawned.
 *     Ein Erfolg setzt den Zaehler zurueck. Absichtlich beendete Worker (Reissleine)
 *     zaehlen NICHT als Ausfall und werden nicht ein zweites Mal ersetzt (P15-T19).
 *   - Nach MAX_RETRIES Ausfaellen in Folge ist der Slot stillgelegt. Sind ALLE Slots
 *     stillgelegt, werden wartende und neue Auftraege sofort mit
 *     ParserPoolStillgelegtError abgelehnt (nie ewig pending); nach
 *     PARSER_POOL_WIEDERBELEBUNG_MS (Standard 60 s) belebt der naechste parse() sie neu.
 */

import { Worker } from 'node:worker_threads';
import type { ParseResult } from './types.js';

export interface ParseArgs {
  filePath: string;
  fileType: string;
  content: string;
}

type WorkerResponse =
  | { ok: true; result: ParseResult | null }
  | { ok: false; error: string };

interface PendingResolver {
  resolve: (result: ParseResult | null) => void;
  reject: (err: Error) => void;
}

interface QueueItem {
  args: ParseArgs;
  resolver: PendingResolver;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  current: PendingResolver | null;
  retries: number;
  timer: NodeJS.Timeout | null;
  /** Laufender Auftrag — fuer die Fortschritts-Abfrage (siehe getParserActivity). */
  laufendeDatei: string | null;
  startedAt: number | null;
  zeichen: number;
  /** P15-T19: Zeitpunkt der Stilllegung (MAX_RETRIES Ausfaelle in Folge), sonst null. */
  stillgelegtSeit: number | null;
}

/** Momentaufnahme eines laufenden Parse-Vorgangs. */
export interface ParserAktivitaet {
  slot: number;
  filePath: string;
  /** Bisherige Laufzeit in Millisekunden. */
  laufzeitMs: number;
  /** Groesse des Inhalts in Zeichen — grosse Dateien duerfen lange brauchen. */
  zeichen: number;
  /** Zeitlimit dieses Parses; 0 = ohne Reissleine (laeuft bis fertig). */
  limitMs: number;
}

const MAX_RETRIES = 3;

/**
 * Fehler der Reissleine: der Parse einer Datei wurde hart abgebrochen.
 * Der Aufrufer MUSS diesen Fall von einem normalen Pool-Fehler unterscheiden —
 * ein Fallback auf parser.parse() im Main-Thread wuerde den Prozess sicher
 * aufhaengen, denn genau dort kommt der Parse ja nicht zurueck.
 */
export class ParseTimeoutError extends Error {
  readonly filePath: string;
  readonly limitMs: number;
  constructor(filePath: string, limitMs: number) {
    super(`Parse von ${filePath} nach ${limitMs} ms abgebrochen (Reissleine)`);
    this.name = 'ParseTimeoutError';
    this.filePath = filePath;
    this.limitMs = limitMs;
  }
}

/**
 * P15-T19: Kein Slot des Pools lebt mehr (alle nach MAX_RETRIES Ausfaellen in Folge stillgelegt).
 * Vorher blieb ein Auftrag in diesem Zustand fuer immer in der Queue (thought 07ac26de). Jetzt
 * wird er sofort abgelehnt: der Aufrufer (services/code.ts) behandelt das wie jeden Pool-Fehler
 * und parst synchron im Main-Thread - die dokumentierte Rueckfallebene, wenn der Pool wirft.
 * Anders als ParseTimeoutError ist das kein Hinweis auf eine haengende Datei.
 */
export class ParserPoolStillgelegtError extends Error {
  readonly wiederbelebungMs: number;
  constructor(size: number, wiederbelebungMs: number) {
    super(`Parser-Pool stillgelegt: alle ${size} Worker nach ${MAX_RETRIES} Ausfaellen in Folge nicht neu gestartet; Wiederbelebung fruehestens nach ${wiederbelebungMs} ms`);
    this.name = 'ParserPoolStillgelegtError';
    this.wiederbelebungMs = wiederbelebungMs;
  }
}

/**
 * Pause, nach der ein stillgelegter Slot beim naechsten parse() einen neuen Worker bekommt.
 * Warum Wiederbelebung statt endgueltig tot: der Pool lebt so lange wie der Daemon bzw. die
 * REST-API. Ein voruebergehender Grund (Speicherdruck, kaputter Zustand) wuerde sonst den
 * Off-Thread-Parse bis zum Neustart abschalten. Die Pause begrenzt die Kosten eines dauerhaften
 * Fehlers auf hoechstens MAX_RETRIES+1 Worker-Starts je Pause.
 */
function wiederbelebungMs(): number {
  const roh = process.env.PARSER_POOL_WIEDERBELEBUNG_MS;
  const wert = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : 60_000;
}

/**
 * Zeitlimit fuer einen einzelnen Parse.
 *
 * Warum Zeit und kein Iterationszaehler: der Fehlerfall ist katastrophales
 * Backtracking innerhalb EINES regex.exec()-Aufrufs. Die Regex-Engine kehrt nie
 * zurueck, es gibt zwischen zwei Schritten nichts, was sich zaehlen liesse, und
 * JavaScript kennt keinen Interrupt fuer laufende Regexe. Abbrechen laesst sich
 * nur der Worker-Thread als Ganzes.
 *
 * Das Limit ist bewusst grosszuegig und waechst mit der Dateigroesse, damit es
 * auf einer langsamen oder ausgelasteten Maschine nicht faelschlich zuschlaegt:
 * es soll Haenger fangen, nicht langsame Rechner bestrafen.
 */
function parseTimeoutFor(contentLength: number): number {
  const roh = process.env.PARSER_TIMEOUT_MS;
  // Leerstring bewusst nicht als 0 werten — Number('') waere 0 und wuerde die
  // Reissleine still abschalten, sobald die Variable nur gesetzt-aber-leer ist.
  const ausEnv = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  // Ausdrueckliche 0 = Reissleine aus: der Parse laeuft, bis er fertig ist.
  // Preis: ein echter Haenger (Backtracking) belegt seinen Worker dauerhaft.
  // Die uebrigen Worker des Pools arbeiten weiter.
  if (Number.isFinite(ausEnv) && ausEnv === 0) return 0;
  if (Number.isFinite(ausEnv) && ausEnv > 0) return ausEnv;
  return Math.min(30_000 + Math.floor(contentLength / 100_000) * 15_000, 180_000);
}

function workerRunnerUrl(): URL {
  // Compiled JS-Pfad neben worker-pool.js
  return new URL('./worker-runner.js', import.meta.url);
}

export class ParserWorkerPool {
  readonly size: number;
  private slots: WorkerSlot[] = [];
  private queue: QueueItem[] = [];
  private initialized = false;
  private shuttingDown = false;
  /**
   * P15-T15: beendete Worker, deren 'exit' noch aussteht, und Zaehler aller Beendigungen.
   * Nur Buchfuehrung fuer intern(parser_pool) - PTZ-24 (Thought 07ac26de) mass je Timeout einen
   * Thread mehr, der nach dem Abbruch weiterlebte; slots.length zeigt das nicht.
   */
  private beendend = new Set<Worker>();
  private beendetGesamt = 0;
  private timeoutsGesamt = 0;

  /** terminate() mit Buchfuehrung; Fehler beim Beenden werden wie bisher ignoriert. */
  private beende(worker: Worker): void {
    this.beendetGesamt++;
    this.beendend.add(worker);
    worker.once('exit', () => { this.beendend.delete(worker); });
    try { void worker.terminate(); } catch { /* ignore */ }
  }

  constructor(size?: number) {
    const fromEnv = Number(process.env.PARSER_WORKER_THREADS);
    const resolved = size ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4);
    this.size = Math.max(1, Math.floor(resolved));
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (let i = 0; i < this.size; i++) {
      this.spawnSlot(i);
    }
  }

  private spawnSlot(index: number, retries = 0): void {
    const worker = new Worker(workerRunnerUrl());
    const slot: WorkerSlot = {
      worker,
      busy: false,
      current: null,
      retries,
      timer: null,
      laufendeDatei: null,
      startedAt: null,
      zeichen: 0,
      stillgelegtSeit: null,
    };
    this.slots[index] = slot;
    // P15-T19: ein Worker wird hoechstens EINMAL als ausgefallen behandelt. Nach 'error'
    // folgt noch ein 'exit' mit code != 0 - ohne diese Sperre gab es zwei Neustarts.
    let abgehandelt = false;

    worker.on('message', (msg: WorkerResponse) => {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      const resolver = slot.current;
      slot.current = null;
      slot.busy = false;
      slot.retries = 0;
      slot.laufendeDatei = null;
      slot.startedAt = null;
      if (resolver) {
        if (msg.ok) resolver.resolve(msg.result);
        else resolver.reject(new Error(msg.error));
      }
      this.drainQueue();
    });

    const handleFailure = (cause: unknown) => {
      if (this.shuttingDown || abgehandelt) return;
      abgehandelt = true;
      // P15-T19: Absichtlich beendet (Reissleine im Timer, beende() hier unten) oder der Slot
      // ist laengst neu besetzt: der Nachfolger laeuft schon. Ein zweiter spawnSlot wuerde ihn
      // ueberschreiben und als ungetrackten Thread zuruecklassen - gemessen +1 Thread je
      // Timeout und Stilllegung nach 4 Timeouts (thought 07ac26de). Das 'exit' des beendeten
      // Workers kommt, solange er noch in beendend steht (beende() entfernt ihn erst danach).
      if (this.beendend.has(worker) || this.slots[index] !== slot) return;
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      const resolver = slot.current;
      slot.current = null;
      slot.busy = false;
      slot.laufendeDatei = null;
      slot.startedAt = null;
      this.beende(worker);

      if (resolver) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        resolver.reject(new Error(`parser worker failed: ${msg}`));
      }

      // P15-T19: der Zaehler kommt aus dem Slot, nicht aus der Closure von spawnSlot - nur
      // slot.retries wird bei Erfolg (message) zurueckgesetzt. Vorher zaehlte die Closure
      // ueber Erfolge hinweg weiter.
      const nextRetries = slot.retries + 1;
      if (nextRetries > MAX_RETRIES) {
        const pause = wiederbelebungMs();
        // eslint-disable-next-line no-console
        console.error(`[parser-worker-pool] slot ${index} exceeded ${MAX_RETRIES} retries; stillgelegt, Wiederbelebung fruehestens nach ${pause} ms`);
        // Slot gilt als busy, findFreeSlot ueberspringt ihn; parse() belebt ihn nach der Pause.
        this.slots[index] = {
          worker, busy: true, current: null, retries: nextRetries, timer: null,
          laufendeDatei: null, startedAt: null, zeichen: 0, stillgelegtSeit: Date.now(),
        };
        if (this.alleStillgelegt()) {
          for (const item of this.queue.splice(0)) {
            item.resolver.reject(new ParserPoolStillgelegtError(this.size, pause));
          }
        }
        return;
      }
      this.spawnSlot(index, nextRetries);
      this.drainQueue();
    };

    worker.on('error', handleFailure);
    worker.on('exit', (code) => {
      if (code !== 0) handleFailure(new Error(`worker exited with code ${code}`));
    });
  }

  parse(args: ParseArgs): Promise<ParseResult | null> {
    if (!this.initialized) this.init();
    if (this.shuttingDown) {
      return Promise.reject(new Error('ParserWorkerPool is shutting down'));
    }
    this.belebeStillgelegte();
    if (this.alleStillgelegt()) {
      return Promise.reject(new ParserPoolStillgelegtError(this.size, wiederbelebungMs()));
    }
    return new Promise<ParseResult | null>((resolve, reject) => {
      const resolver: PendingResolver = { resolve, reject };
      const free = this.findFreeSlot();
      if (free) {
        this.dispatch(free, args, resolver);
      } else {
        this.queue.push({ args, resolver });
      }
    });
  }

  /** P15-T19: true, wenn kein Slot mehr einen lebenden Worker hat. */
  private alleStillgelegt(): boolean {
    return this.slots.length > 0 && this.slots.every((s) => !!s && s.stillgelegtSeit !== null);
  }

  /** P15-T19: stillgelegte Slots nach Ablauf der Pause mit frischem Worker (Zaehler 0) neu besetzen. */
  private belebeStillgelegte(): void {
    const pause = wiederbelebungMs();
    const jetzt = Date.now();
    this.slots.forEach((slot, i) => {
      if (!slot || slot.stillgelegtSeit === null || jetzt - slot.stillgelegtSeit < pause) return;
      // eslint-disable-next-line no-console
      console.error(`[parser-worker-pool] slot ${i} nach ${pause} ms Pause wiederbelebt`);
      this.spawnSlot(i, 0);
    });
  }

  private findFreeSlot(): WorkerSlot | null {
    for (const slot of this.slots) {
      if (slot && !slot.busy && slot.retries <= MAX_RETRIES) return slot;
    }
    return null;
  }

  private dispatch(slot: WorkerSlot, args: ParseArgs, resolver: PendingResolver): void {
    slot.busy = true;
    slot.current = resolver;
    slot.laufendeDatei = args.filePath;
    slot.startedAt = Date.now();
    slot.zeichen = args.content.length;

    // REISSLEINE: haengt der Worker (typisch: Backtracking in einer Regex), wird
    // er hart beendet und der Slot neu aufgesetzt. Die Datei faellt aus, der Lauf
    // laeuft weiter. Ohne das blockiert eine einzige Datei den gesamten Bestand —
    // real passiert an spine_mem_pool.cpp, die deshalb zwei Monate lang mit null
    // Symbolen im Index stand, ohne dass es irgendwo aufgefallen waere.
    const index = this.slots.indexOf(slot);
    const limitMs = parseTimeoutFor(args.content.length);
    // limitMs === 0 => keine Reissleine, der Parse laeuft bis zum Ergebnis durch.
    if (limitMs > 0) {
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const wartender = slot.current;
      slot.current = null;
      slot.busy = false;
      slot.laufendeDatei = null;
      slot.startedAt = null;
      // eslint-disable-next-line no-console
      console.error(`[parser-worker-pool] PARSE-TIMEOUT nach ${limitMs} ms: ${args.filePath} — Worker wird beendet, Datei uebersprungen`);
      this.timeoutsGesamt++;
      this.beende(slot.worker);
      if (wartender) wartender.reject(new ParseTimeoutError(args.filePath, limitMs));
      if (index >= 0 && !this.shuttingDown) this.spawnSlot(index);
      this.drainQueue();
    }, limitMs);
      // Der Timer darf den Prozess nicht am Leben halten.
      if (typeof slot.timer.unref === 'function') slot.timer.unref();
    }

    try {
      slot.worker.postMessage(args);
    } catch (err) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      slot.busy = false;
      slot.current = null;
      resolver.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Momentaufnahme aller gerade laufenden Parses.
   *
   * Beantwortet die Frage "arbeitet er noch oder haengt er?" NICHT abschliessend:
   * ein Worker, der in einem einzigen regex.exec() feststeckt, ist von aussen
   * nicht von einem langsam arbeitenden zu unterscheiden — er kann nichts melden,
   * weil sein Thread blockiert ist. Was die Laufzeit aber zeigt: WELCHE Datei wie
   * lange belegt, gemessen an ihrer Groesse. Eine 7-MB-Datei nach 20 s ist normal,
   * eine 3-KB-Datei nach 20 s ist ein Haenger.
   */
  aktivitaet(): ParserAktivitaet[] {
    const jetzt = Date.now();
    const laufende: ParserAktivitaet[] = [];
    this.slots.forEach((slot, i) => {
      if (!slot || !slot.busy || !slot.laufendeDatei || slot.startedAt === null) return;
      laufende.push({
        slot: i,
        filePath: slot.laufendeDatei,
        laufzeitMs: jetzt - slot.startedAt,
        zeichen: slot.zeichen,
        limitMs: parseTimeoutFor(slot.zeichen),
      });
    });
    return laufende;
  }

  /** Wartende Auftraege, die noch keinen freien Worker bekommen haben. */
  warteschlange(): number {
    return this.queue.length;
  }

  /**
   * P15-T15: Zustand JEDES Slots fuer intern(parser_pool) - nur lesen.
   * stillgelegt = Slot nach MAX_RETRIES Ausfaellen in Folge nicht neu gestartet: er gilt als busy,
   * findFreeSlot ueberspringt ihn. Seit P15-T19 werden Auftraege abgelehnt, wenn ALLE Slots
   * stillgelegt sind, und parse() belebt den Slot nach PARSER_POOL_WIEDERBELEBUNG_MS neu.
   * retries ist der einzige Ausfall-Zaehler; ein Erfolg setzt ihn auf 0, Timeouts zaehlen nicht.
   */
  slotZustand(): Record<string, unknown> {
    const jetzt = Date.now();
    const slots = this.slots.map((slot, i) => {
      if (!slot) return { slot: i, fehlt: true };
      return {
        slot: i,
        thread_id: slot.worker.threadId,
        busy: slot.busy,
        retries: slot.retries,
        stillgelegt: slot.stillgelegtSeit !== null || slot.retries > MAX_RETRIES,
        stillgelegt_seit: slot.stillgelegtSeit === null ? null : new Date(slot.stillgelegtSeit).toISOString(),
        laufende_datei: slot.laufendeDatei,
        laufzeit_ms: slot.startedAt === null ? null : jetzt - slot.startedAt,
        zeichen: slot.laufendeDatei ? slot.zeichen : null,
        limit_ms: slot.laufendeDatei ? parseTimeoutFor(slot.zeichen) : null,
      };
    });
    return {
      groesse: this.size,
      initialisiert: this.initialized,
      warteschlange: this.queue.length,
      max_retries: MAX_RETRIES,
      slots,
      beendet_gesamt: this.beendetGesamt,
      timeouts_gesamt: this.timeoutsGesamt,
      beendet_exit_ausstehend: this.beendend.size,
    };
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const free = this.findFreeSlot();
      if (!free) break;
      const item = this.queue.shift()!;
      this.dispatch(free, item.args, item.resolver);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.resolver.reject(new Error('ParserWorkerPool shutting down'));
    }
    await Promise.all(
      this.slots.map(async (slot) => {
        if (!slot) return;
        if (slot.current) {
          slot.current.reject(new Error('ParserWorkerPool shutting down'));
          slot.current = null;
        }
        try {
          await slot.worker.terminate();
        } catch {
          /* ignore */
        }
      }),
    );
    this.slots = [];
    this.initialized = false;
  }
}

let singleton: ParserWorkerPool | null = null;
let singletonDisabled = false;

export function getParserPool(): ParserWorkerPool | null {
  if (process.env.PARSER_WORKER_THREADS === '0') {
    singletonDisabled = true;
    return null;
  }
  if (singletonDisabled) return null;
  if (!singleton) {
    singleton = new ParserWorkerPool();
    singleton.init();
  }
  return singleton;
}

/**
 * Laufende Parses des aktiven Pools — fuer Tools/Diagnose abfragbar.
 * Liefert eine leere Liste, wenn der Pool deaktiviert ist oder nichts laeuft.
 */
export function getParserActivity(): { laufend: ParserAktivitaet[]; wartend: number; poolAktiv: boolean } {
  if (!singleton || singletonDisabled) {
    return { laufend: [], wartend: 0, poolAktiv: false };
  }
  return { laufend: singleton.aktivitaet(), wartend: singleton.warteschlange(), poolAktiv: true };
}

/**
 * P15-T15: Slot-Zustand des Pools dieses Prozesses fuer intern(parser_pool).
 * null, wenn der Pool deaktiviert (PARSER_WORKER_THREADS=0) oder noch nie benutzt wurde.
 */
export function getParserPoolZustand(): Record<string, unknown> | null {
  if (!singleton || singletonDisabled) return null;
  return singleton.slotZustand();
}

/** Test-Hook: setzt Singleton zurueck (nur fuer Tests / Reload-Szenarien). */
export async function resetParserPool(): Promise<void> {
  if (singleton) {
    await singleton.shutdown();
    singleton = null;
  }
  singletonDisabled = false;
}
