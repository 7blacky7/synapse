/**
 * MODUL: Intern-Schalter (P14-T1, 11.10.2026)
 * ZWECK: Anhalte-Schalter fuer interne Ablaeufe (embedding, parser, context7) in PG, statt Pausen
 *        per SQL von Hand zu setzen. Gesetzt ueber das Tool 'intern' (nur bei SYNAPSE_INTERN_TOOL=1),
 *        gelesen von den Workern je Tick ueber leseSchalter() mit kurzem Cache.
 *
 * BEDEUTUNG: aktiv=true heisst "der Eingriff wirkt" (Ablauf angehalten). modus verfeinert das je
 *   Schalter: embedding 'hintergrund' | 'alle', parser und context7 'pause'.
 *   AUSNAHME tray_token_weiterleitung/freigegeben: aktiv=true/false ist ein befristeter
 *   EIN/AUS-Testoverride des Produktionsstandards; auch AUS bekommt eine Dauer.
 * HOECHSTDAUER: jeder Schalter laeuft ab (bis). Default und Obergrenze SYNAPSE_INTERN_MAX_STUNDEN
 *   (Default 12). Ohne Ablauf (bis NULL) nur mit dauerhaft:true. Abgelaufene Schalter gelten als aus;
 *   die Zeile bleibt zur Einsicht stehen.
 * CACHE: leseSchalter() fragt PG hoechstens alle SYNAPSE_INTERN_CACHE_MS (Default 5000) je Schalter.
 *   Der Ablauf wird bei jedem Lesen gegen die Uhr geprueft, nicht erst beim naechsten PG-Zugriff.
 *   setzeSchalter() setzt den Cache dieses Prozesses sofort auf den neuen Stand. Gleichzeitige Leser
 *   teilen sich eine Abfrage.
 * LESEFEHLER: Ist PG nicht erreichbar, antwortet nicht binnen 2 s oder fehlt die Tabelle, gilt der
 *   letzte bekannte Stand, ohne einen solchen "aus" — ein Worker laeuft lieber weiter, als an einem Lesefehler stehenzubleiben.
 *   Gemeldet wird das einmal, bis wieder ein Lesen gelingt.
 * NEBENEFFEKTE: nur Upsert in intern_schalter. Nichts wird beendet oder geloescht.
 */

import { getPool } from '../db/client.js';

/** Bekannte Schalter und ihre Modi; der erste Modus ist der Standard. */
export const INTERN_SCHALTER = {
  embedding: ['hintergrund', 'alle'],
  parser: ['pause'],
  context7: ['pause'],
  // Freigabe statt Pause: aktiv=true erlaubt ausschliesslich die lokale Tray-Token-Einsetzung.
  tray_token_weiterleitung: ['freigegeben'],
  // P22-T2: Hauptagent nur Synapse-MCP, kein eingebautes CLI-Werkzeug.
  main_synapse: ['freigegeben'],
} as const;
export type InternSchalterName = keyof typeof INTERN_SCHALTER;

export interface InternSchalterStand {
  name: string;
  /** wirksam: gesetzt UND nicht abgelaufen */
  aktiv: boolean;
  /** Wert in PG, unabhaengig vom Ablauf */
  gesetzt: boolean;
  abgelaufen: boolean;
  modus: string | null;
  bis: string | null;
  dauerhaft: boolean;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
}

export interface SetzeSchalterOptionen {
  aktiv: boolean;
  modus?: string;
  /** ISO-Zeitpunkt */
  bis?: string;
  dauer_min?: number;
  dauerhaft?: boolean;
  grund?: string;
  agent?: string;
}

export class InternSchalterFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface SchalterZeile {
  name: string;
  aktiv: boolean;
  modus: string | null;
  bis: Date | null;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: Date | null;
}

const SPALTEN = 'name, aktiv, modus, bis, grund, gesetzt_von, gesetzt_am';

/** Hoechstdauer eines Schalters in ms (SYNAPSE_INTERN_MAX_STUNDEN, Default 12). */
export function hoechstdauerMs(): number {
  const stunden = Number(process.env.SYNAPSE_INTERN_MAX_STUNDEN);
  return (Number.isFinite(stunden) && stunden > 0 ? stunden : 12) * 3_600_000;
}

function cacheMs(): number {
  const wert = Number(process.env.SYNAPSE_INTERN_CACHE_MS);
  return Number.isFinite(wert) && wert >= 0 ? wert : 5000;
}

const cache = new Map<string, { zeile: SchalterZeile | null; geholt: number }>();
/** Schreibzaehler je Schalter: ein Lesen, das vor einem Schreiben begann, ueberschreibt den Cache nicht. */
const schreibStand = new Map<string, number>();
/** Laufende PG-Abfragen je Schalter — viele gleichzeitige Leser teilen sich eine. */
const laufend = new Map<string, Promise<SchalterZeile | null>>();
/** Hoechstens so lange wartet ein Worker auf das Lesen eines Schalters (volle Pools, haengende DB). */
const LESE_ZEITLIMIT_MS = 2000;
let lesefehlerGemeldet = false;

function alsStand(name: string, z: SchalterZeile | null, jetzt = Date.now()): InternSchalterStand {
  if (!z) {
    return {
      name, aktiv: false, gesetzt: false, abgelaufen: false, modus: null, bis: null,
      dauerhaft: false, grund: null, gesetzt_von: null, gesetzt_am: null,
    };
  }
  const abgelaufen = (z.aktiv || name === 'tray_token_weiterleitung' || name === 'main_synapse') && z.bis !== null && z.bis.getTime() <= jetzt;
  return {
    name,
    aktiv: z.aktiv && !abgelaufen,
    gesetzt: z.aktiv,
    abgelaufen,
    modus: z.modus,
    bis: z.bis ? z.bis.toISOString() : null,
    dauerhaft: (z.aktiv || ((name === 'tray_token_weiterleitung' || name === 'main_synapse') && z.modus === 'freigegeben')) && z.bis === null,
    grund: z.grund,
    gesetzt_von: z.gesetzt_von,
    gesetzt_am: z.gesetzt_am ? z.gesetzt_am.toISOString() : null,
  };
}

export function istSchalterName(name: string): name is InternSchalterName {
  return Object.prototype.hasOwnProperty.call(INTERN_SCHALTER, name);
}

/**
 * Setzt einen Schalter (Upsert). aktiv:true braucht hoechstens EINE Dauerangabe (bis | dauer_min |
 * dauerhaft); ohne Angabe gilt die Hoechstdauer, laengere Angaben werden auf sie gekappt (hinweis).
 */
export async function setzeSchalter(
  name: string,
  opt: SetzeSchalterOptionen,
): Promise<InternSchalterStand & { hinweis?: string }> {
  if (!istSchalterName(name)) {
    throw new InternSchalterFehler(
      'unbekannter_schalter',
      `Unbekannter Schalter "${name}". Erlaubt: ${Object.keys(INTERN_SCHALTER).join(', ')}.`,
    );
  }
  const erlaubt: readonly string[] = INTERN_SCHALTER[name];
  let modus: string | null = null;
  let bis: Date | null = null;
  let hinweis: string | undefined;

  // Der Freigabeschalter braucht auch fuer einen AUS-Override einen Ablauf.
  if (opt.aktiv || name === 'tray_token_weiterleitung' || name === 'main_synapse') {
    modus = opt.modus ?? erlaubt[0];
    if (!erlaubt.includes(modus)) {
      throw new InternSchalterFehler('modus_ungueltig', `Modus "${modus}" passt nicht zu "${name}". Erlaubt: ${erlaubt.join(', ')}.`);
    }
    const angaben = [opt.bis !== undefined, opt.dauer_min !== undefined, opt.dauerhaft === true].filter(Boolean).length;
    if (angaben > 1) {
      throw new InternSchalterFehler('dauer_mehrdeutig', 'Hoechstens eines von bis, dauer_min, dauerhaft angeben.');
    }
    if (opt.dauerhaft !== true) {
      const jetzt = Date.now();
      const max = hoechstdauerMs();
      let ziel: number;
      if (opt.bis !== undefined) {
        ziel = Date.parse(opt.bis);
        if (!Number.isFinite(ziel)) throw new InternSchalterFehler('bis_ungueltig', `bis "${opt.bis}" ist kein Zeitpunkt (ISO, z. B. 2026-10-11T18:00:00+02:00).`);
        if (ziel <= jetzt) throw new InternSchalterFehler('bis_vergangen', `bis "${opt.bis}" liegt nicht in der Zukunft.`);
      } else if (opt.dauer_min !== undefined) {
        if (!Number.isFinite(opt.dauer_min) || opt.dauer_min <= 0) {
          throw new InternSchalterFehler('dauer_ungueltig', 'dauer_min muss eine Zahl > 0 sein.');
        }
        ziel = jetzt + opt.dauer_min * 60_000;
      } else {
        ziel = jetzt + max;
        hinweis = `Ohne Dauerangabe gilt die Hoechstdauer (${max / 3_600_000} h).`;
      }
      if (ziel - jetzt > max) {
        ziel = jetzt + max;
        hinweis = `Auf die Hoechstdauer gekappt (${max / 3_600_000} h, SYNAPSE_INTERN_MAX_STUNDEN). Ohne Ablauf nur mit dauerhaft:true.`;
      }
      bis = new Date(ziel);
    }
  }

  const { rows } = await getPool().query<SchalterZeile>(
    `INSERT INTO intern_schalter (name, aktiv, modus, bis, grund, gesetzt_von, gesetzt_am)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (name) DO UPDATE SET aktiv = EXCLUDED.aktiv, modus = EXCLUDED.modus, bis = EXCLUDED.bis,
       grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am
     RETURNING ${SPALTEN}`,
    [name, opt.aktiv, modus, bis, opt.grund ?? null, opt.agent ?? null],
  );
  schreibStand.set(name, (schreibStand.get(name) ?? 0) + 1);
  cache.set(name, { zeile: rows[0] ?? null, geholt: Date.now() });
  return { ...alsStand(name, rows[0] ?? null), ...(hinweis ? { hinweis } : {}) };
}

/** Wirksamer Stand eines Schalters, gecacht (fuer Worker je Tick). Wirft nie. */
export async function leseSchalter(name: string): Promise<InternSchalterStand> {
  const jetzt = Date.now();
  const gemerkt = cache.get(name);
  if (gemerkt && jetzt - gemerkt.geholt < cacheMs()) return alsStand(name, gemerkt.zeile, jetzt);
  const standVorher = schreibStand.get(name) ?? 0;
  let abfrage = laufend.get(name);
  if (!abfrage) {
    abfrage = holeZeile(name).finally(() => laufend.delete(name));
    laufend.set(name, abfrage);
  }
  let zeile: SchalterZeile | null;
  try {
    zeile = await abfrage;
    if (lesefehlerGemeldet) {
      console.error('[Intern-Schalter] Lesen geht wieder.');
      lesefehlerGemeldet = false;
    }
  } catch (err) {
    if (!lesefehlerGemeldet) {
      console.error(`[Intern-Schalter] Lesen fehlgeschlagen, es gilt der letzte bekannte Stand: ${(err as Error).message}`);
      lesefehlerGemeldet = true;
    }
    zeile = gemerkt?.zeile ?? null;
  }
  // Wurde waehrend des Lesens geschrieben, ist der Cache schon neuer als diese Abfrage.
  if ((schreibStand.get(name) ?? 0) !== standVorher) return alsStand(name, cache.get(name)?.zeile ?? zeile);
  cache.set(name, { zeile, geholt: Date.now() });
  return alsStand(name, zeile);
}

async function holeZeile(name: string): Promise<SchalterZeile | null> {
  const abfrage = getPool()
    .query<SchalterZeile>(`SELECT ${SPALTEN} FROM intern_schalter WHERE name = $1`, [name])
    .then((r) => r.rows[0] ?? null);
  abfrage.catch(() => undefined); // verliert sie das Rennen gegen das Zeitlimit, bleibt ihr Fehler unbehandelt
  let zeitlimit: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      abfrage,
      new Promise<never>((_, reject) => {
        zeitlimit = setTimeout(() => reject(new Error(`Zeitlimit ${LESE_ZEITLIMIT_MS} ms`)), LESE_ZEITLIMIT_MS);
        zeitlimit.unref?.();
      }),
    ]);
  } finally {
    if (zeitlimit) clearTimeout(zeitlimit);
  }
}

/** Alle bekannten Schalter (auch nie gesetzte) frisch aus PG, ohne Cache. */
export async function alleSchalter(): Promise<InternSchalterStand[]> {
  const { rows } = await getPool().query<SchalterZeile>(`SELECT ${SPALTEN} FROM intern_schalter`);
  const jetzt = Date.now();
  const nachName = new Map(rows.map((z) => [z.name, z]));
  return Object.keys(INTERN_SCHALTER).map((name) => alsStand(name, nachName.get(name) ?? null, jetzt));
}

/** Zuletzt gemeldeter Zustand je Ablauf — Beginn und Ende einer Pause stehen genau einmal im Log. */
const gemeldet = new Map<string, boolean>();

/**
 * Fuer Worker (P14-T2): haelt der Schalter `name` den Ablauf `ablauf` gerade an, optional nur in
 * bestimmten Modi? Liefert dann den Stand, sonst null. Beginn und Ende stehen je Ablauf einmal im Log.
 */
export async function schalterHaeltAn(
  name: InternSchalterName,
  ablauf: string,
  modi?: readonly string[],
): Promise<InternSchalterStand | null> {
  const stand = await leseSchalter(name);
  const haelt = stand.aktiv && (!modi || modi.includes(stand.modus ?? ''));
  if (haelt !== (gemeldet.get(ablauf) ?? false)) {
    gemeldet.set(ablauf, haelt);
    console.error(haelt
      ? `[intern] ${ablauf} angehalten (Schalter ${name}${stand.modus ? `/${stand.modus}` : ''}, ${stand.dauerhaft ? 'dauerhaft' : `bis ${stand.bis}`}${stand.grund ? `, Grund: ${stand.grund}` : ''})`
      : `[intern] ${ablauf} laeuft wieder (Schalter ${name} aus)`);
  }
  return haelt ? stand : null;
}

/**
 * Nebenlaeufige Embedding-Nachtraege (embedde*Nach) bei Schalter embedding (jeder Modus) auslassen:
 * embedded_at bleibt NULL, der Backlog holt den Eintrag nach der Freigabe nach.
 */
export async function embeddingNachtragAngehalten(): Promise<boolean> {
  return (await schalterHaeltAn('embedding', 'embedding-nachtrag')) !== null;
}
