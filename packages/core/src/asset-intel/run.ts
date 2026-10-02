/**
 * MODUL: Asset Run
 * ZWECK: inspectAsset(filePath, opts) — oeffnet ein Asset NUR LESEND, ordnet es einem Inspektor
 *        zu, setzt harte Grenzen durch und liefert IMMER ein vollstaendiges AssetResult.
 *
 * ZUSAGEN:
 *  - wirft nie: jeder Fehler (auch im Inspektor) wird zu einer Warnung mit Code.
 *  - liest nie die ganze Datei auf Verdacht: der Inspektor bekommt eine AssetSource, deren
 *    Lesungen auf maxReadBytes begrenzt sind. Nur der sha256 liest die Datei komplett, und
 *    nur bis maxHashBytes.
 *  - Quelle fehlt: Ergebnis mit Status 'quelle_nicht_gefunden' (der Eintrag soll in der DB
 *    bleiben, nicht verschwinden).
 *
 * GRENZE DER ZEITSPERRE: timeoutMs bricht auf der Ereignisschleife ab. Eine Inspektor-Schleife
 * OHNE await kann von aussen nicht unterbrochen werden — dafuer ruft sie ctx.pruefeAbbruch() auf
 * (prueft auch die Uhr). Haerter wird es erst im Parser-Worker-Pool (spaetere Task).
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import { AssetLimitError, AssetReadError } from './errors.js';
import type { AssetGrenze } from './errors.js';
import { standardRegistry } from './registry.js';
import type { AssetRegistry } from './registry.js';
import { erzeugeAssetResult } from './types.js';
import type { AssetContext, AssetLimits, AssetResult, AssetSource } from './types.js';

/** Standardgrenzen. Bewusst grosszuegig fuer die Dateigroesse, knapp bei Lesungen und Zeit. */
export const STANDARD_GRENZEN: Readonly<AssetLimits> = Object.freeze({
  maxFileBytes: 256 * 1024 * 1024,
  maxReadBytes: 64 * 1024 * 1024,
  maxObjects: 10_000,
  timeoutMs: 30_000,
  maxDepth: 8,
  maxHashBytes: 256 * 1024 * 1024,
});

/** Optionen von inspectAsset: jede Grenze einzeln ueberschreibbar. */
export interface InspectAssetOptions extends Partial<AssetLimits> {
  /** Eigene Registry (Tests); Standard ist die gemeinsame standardRegistry. */
  registry?: AssetRegistry;
}

/** So viel vom Dateianfang sieht die Formaterkennung. */
const KOPF_BYTES = 4096;
/** Blockgroesse beim Hashen. */
const HASH_BLOCK = 1024 * 1024;

function loeseGrenzen(opts?: InspectAssetOptions): AssetLimits {
  const g: AssetLimits = { ...STANDARD_GRENZEN };
  for (const k of Object.keys(g) as Array<keyof AssetLimits>) {
    const v = opts?.[k];
    // Unsinnige Werte (NaN, negativ, Text) fallen auf den Standard zurueck; timeoutMs 0 gaebe sofortigen Abbruch.
    if (typeof v === 'number' && Number.isFinite(v) && v >= (k === 'timeoutMs' ? 1 : 0)) g[k] = v;
  }
  return g;
}

/** Quelle, die Lesungen zaehlt und Zeit/Abbruch prueft. */
class DateiQuelle implements AssetSource {
  private gelesen = 0;
  constructor(
    readonly filePath: string,
    readonly size: number,
    private readonly handle: fs.promises.FileHandle,
    private readonly grenzen: AssetLimits,
    private readonly signal: AbortSignal,
    private readonly frist: number
  ) {}

  async readRange(offset: number, length: number): Promise<Buffer> {
    pruefeZeit(this.signal, this.frist);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new AssetReadError('ungueltiges_argument', `readRange(${offset}, ${length}): Argumente ungueltig`, 0, 0, 0);
    }
    if (offset >= this.size || length === 0) return Buffer.alloc(0);
    const soll = Math.min(length, this.size - offset);
    if (this.gelesen + soll > this.grenzen.maxReadBytes) {
      throw new AssetLimitError('maxReadBytes', `Lesegrenze ${this.grenzen.maxReadBytes} Bytes ueberschritten (gelesen ${this.gelesen}, angefordert ${soll})`);
    }
    const buf = Buffer.alloc(soll);
    let got = 0;
    while (got < soll) {
      const { bytesRead } = await this.handle.read(buf, got, soll - got, offset + got);
      if (bytesRead === 0) break; // Datei kuerzer geworden
      got += bytesRead;
    }
    this.gelesen += got;
    return got === soll ? buf : buf.subarray(0, got);
  }
}

function pruefeZeit(signal: AbortSignal, frist: number): void {
  if (signal.aborted || Date.now() > frist) {
    throw new AssetLimitError('timeoutMs', 'Zeitgrenze ueberschritten');
  }
}

function baueKontext(
  format: string | null,
  grenzen: AssetLimits,
  signal: AbortSignal,
  frist: number,
  tiefe: number,
  warn: (code: string, message: string) => void
): AssetContext {
  return {
    format,
    limits: grenzen,
    depth: tiefe,
    signal,
    pruefeAbbruch: () => pruefeZeit(signal, frist),
    warn,
    tiefer: () => {
      if (tiefe + 1 > grenzen.maxDepth) {
        throw new AssetLimitError('maxDepth', `Tiefengrenze ${grenzen.maxDepth} ueberschritten`);
      }
      return baueKontext(format, grenzen, signal, frist, tiefe + 1, warn);
    },
  };
}

const GRENZ_CODE: Record<AssetGrenze, string> = {
  maxFileBytes: 'datei_zu_gross',
  maxReadBytes: 'lesegrenze_ueberschritten',
  maxObjects: 'objektgrenze_ueberschritten',
  timeoutMs: 'zeitgrenze',
  maxDepth: 'tiefengrenze_ueberschritten',
};

async function berechneHash(handle: fs.promises.FileHandle, size: number, signal: AbortSignal, frist: number): Promise<string | null> {
  const h = createHash('sha256');
  const buf = Buffer.alloc(Math.min(HASH_BLOCK, Math.max(size, 1)));
  let pos = 0;
  while (pos < size) {
    pruefeZeit(signal, frist);
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
    if (bytesRead === 0) break;
    h.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  // Weniger gelesen als erwartet = Datei wurde waehrend des Laufs gekuerzt: kein Hash ist ehrlicher als ein falscher.
  return pos === size ? h.digest('hex') : null;
}

function klone(res: AssetResult): AssetResult {
  try {
    return structuredClone(res);
  } catch {
    return JSON.parse(JSON.stringify(res)) as AssetResult;
  }
}

/**
 * Inspiziert eine Datei. Wirft nie.
 *
 * @param filePath Pfad der Datei (nur lesend geoeffnet).
 * @param opts Grenzen ueberschreiben, optional eigene Registry.
 */
export async function inspectAsset(filePath: string, opts?: InspectAssetOptions): Promise<AssetResult> {
  const pfad = typeof filePath === 'string' ? filePath : String(filePath);
  const res = erzeugeAssetResult(pfad, 0);
  const warn = (code: string, message: string): void => {
    res.warnings.push({ code, message });
  };
  let handle: fs.promises.FileHandle | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const grenzen = loeseGrenzen(opts);
    const registry = opts?.registry ?? standardRegistry;

    // stat zuerst: blockiert nicht (open auf eine FIFO ohne Gegenstelle taete es).
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(pfad);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        warn('quelle_nicht_gefunden', `Quelle nicht gefunden: ${pfad}`);
        res.status = 'quelle_nicht_gefunden';
      } else {
        warn('quelle_nicht_lesbar', `Quelle nicht lesbar (${code ?? 'unbekannt'}): ${pfad}`);
        res.status = 'fehler';
      }
      return res;
    }
    if (!st.isFile()) {
      warn('keine_datei', `Kein regulaeres Datei-Objekt: ${pfad}`);
      res.status = 'fehler';
      return res;
    }
    res.size = st.size;

    try {
      handle = await fs.promises.open(pfad, 'r');
    } catch (e) {
      warn('quelle_nicht_lesbar', `Quelle nicht lesbar (${(e as NodeJS.ErrnoException).code ?? 'unbekannt'}): ${pfad}`);
      res.status = 'fehler';
      return res;
    }
    const h = handle;

    const abbruch = new AbortController();
    const frist = Date.now() + grenzen.timeoutMs;

    const arbeit = (async (): Promise<void> => {
      try {
        // Dateikopf fuer die Formaterkennung.
        const kopfLen = Math.min(st.size, KOPF_BYTES);
        let kopf = Buffer.alloc(kopfLen);
        if (kopfLen > 0) {
          const { bytesRead } = await h.read(kopf, 0, kopfLen, 0);
          kopf = kopf.subarray(0, bytesRead);
        }
        const erkennung = registry.detect(pfad, kopf);
        for (const w of erkennung.warnings) res.warnings.push(w);
        const inspektor = erkennung.inspector;
        if (inspektor) {
          res.format = erkennung.format;
          res.inspector = inspektor.id;
          res.parser_version = inspektor.version;
        }

        // Hash (nur bis zur Grenze).
        if (st.size <= grenzen.maxHashBytes) {
          try {
            res.sha256 = await berechneHash(h, st.size, abbruch.signal, frist);
            if (res.sha256 === null) warn('hash_fehlgeschlagen', 'Datei wurde waehrend des Lesens kuerzer; kein sha256.');
          } catch (e) {
            if (e instanceof AssetLimitError) throw e;
            warn('hash_fehlgeschlagen', `sha256 nicht berechenbar: ${(e as Error)?.message ?? String(e)}`);
          }
        } else {
          warn('hash_uebersprungen', `Datei (${st.size} Bytes) ueber maxHashBytes (${grenzen.maxHashBytes}); kein sha256.`);
        }

        if (st.size === 0) {
          warn('datei_leer', 'Datei ist leer (0 Bytes); nichts zu inspizieren.');
          res.status = inspektor ? 'teilweise' : 'nicht_erkannt';
          return;
        }
        if (st.size > grenzen.maxFileBytes) {
          warn('datei_zu_gross', `Datei (${st.size} Bytes) ueber maxFileBytes (${grenzen.maxFileBytes}); nur Erkennung, keine Inspektion.`);
          res.status = inspektor ? 'teilweise' : 'nicht_erkannt';
          return;
        }
        if (!inspektor) {
          warn('kein_inspektor', 'Kein Asset-Inspektor zustaendig (weder Magic noch Endung passt eindeutig).');
          res.status = 'nicht_erkannt';
          return;
        }

        const quelle = new DateiQuelle(pfad, st.size, h, grenzen, abbruch.signal, frist);
        const ctx = baueKontext(erkennung.format, grenzen, abbruch.signal, frist, 0, warn);
        const roh = await inspektor.inspect(quelle, ctx);
        if (!roh || typeof roh !== 'object') {
          warn('inspektor_fehler', `Inspektor "${inspektor.id}" lieferte kein Ergebnis.`);
          res.status = 'fehler';
          return;
        }

        // Uebernehmen, was der Inspektor weiss; die Kernfelder der Quelle bleiben unsere.
        res.asset_type = typeof roh.asset_type === 'string' ? roh.asset_type : res.asset_type;
        res.format = typeof roh.format === 'string' ? roh.format : res.format;
        res.status = roh.status ?? 'ok';
        // Die Version gehoert dem Inspektor, nicht seinem Rueckgabewert: erzeugeAssetResult liefert 0 als Vorgabe.
        res.parser_version = inspektor.version;
        res.metadata = roh.metadata && typeof roh.metadata === 'object' ? roh.metadata : {};
        res.format_specific = roh.format_specific && typeof roh.format_specific === 'object' ? roh.format_specific : {};
        res.objects = Array.isArray(roh.objects) ? roh.objects : [];
        res.references = Array.isArray(roh.references) ? roh.references : [];
        if (Array.isArray(roh.warnings)) for (const w of roh.warnings) res.warnings.push(w);
        if (res.objects.length > grenzen.maxObjects) {
          warn('objekte_gekappt', `${res.objects.length} Objekte, behalten werden ${grenzen.maxObjects}.`);
          res.objects = res.objects.slice(0, grenzen.maxObjects);
          if (res.status === 'ok') res.status = 'teilweise';
        }
        if (res.references.length > grenzen.maxObjects) {
          warn('referenzen_gekappt', `${res.references.length} Referenzen, behalten werden ${grenzen.maxObjects}.`);
          res.references = res.references.slice(0, grenzen.maxObjects);
          if (res.status === 'ok') res.status = 'teilweise';
        }
      } catch (e) {
        res.status = 'fehler';
        if (e instanceof AssetLimitError) {
          warn(GRENZ_CODE[e.grenze] ?? 'grenze_ueberschritten', e.message);
        } else if (e instanceof AssetReadError) {
          warn('lesefehler', `Datei abgeschnitten oder beschaedigt: ${e.message}`);
        } else {
          warn('inspektor_fehler', `Inspektion fehlgeschlagen: ${(e as Error)?.message ?? String(e)}`);
        }
      }
    })();
    // Laeuft die Arbeit nach dem Timeout noch weiter, darf ihr spaeterer Ausgang nichts mehr anrichten.
    arbeit.catch(() => undefined);

    const zeit = new Promise<'zeit'>(resolve => {
      timer = setTimeout(() => {
        abbruch.abort();
        resolve('zeit');
      }, grenzen.timeoutMs);
    });
    const ausgang = await Promise.race([arbeit.then(() => 'fertig' as const), zeit]);
    if (ausgang === 'zeit') {
      // Schnappschuss: die weiterlaufende Arbeit schreibt noch in res, nicht in das Rueckgabeobjekt.
      const kopie = klone(res);
      kopie.status = 'fehler';
      if (!kopie.warnings.some(w => w.code === 'zeitgrenze')) {
        kopie.warnings.push({ code: 'zeitgrenze', message: `Zeitgrenze ${grenzen.timeoutMs} ms ueberschritten.` });
      }
      return kopie;
    }
    return res;
  } catch (e) {
    warn('interner_fehler', `Unerwarteter Fehler: ${(e as Error)?.message ?? String(e)}`);
    res.status = 'fehler';
    return res;
  } finally {
    if (timer) clearTimeout(timer);
    if (handle) await handle.close().catch(() => undefined);
  }
}
