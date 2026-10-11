/**
 * MODUL: Jev-Schalter (P15-T33 E0.5, 11.10.2026, User-Vorgabe f13335dd)
 * ZWECK: Jev dauerhaft an/aus - global, je Projekt, je Funktion. Gelesen an EINER Stelle
 *        (jevWirksam), die der Jev-Client vor jedem Aufruf und alle Hinweis-Stellen fragen.
 *
 * TABELLE jev_schalter (project, funktion) -> aktiv. project '*' = global, funktion '*' = alle.
 *   Keine Zeile = an (Verhalten wie vor E0.5). Schalter sind dauerhaft (keine Hoechstdauer wie
 *   intern-schalter.ts).
 * VORRANG: wirksam(project, f) ist AUS, wenn global '*' aus ODER global f aus ODER Projekt '*' aus
 *   ODER Projekt f aus ODER das Budget pausiert (jev-kosten.ts). Ein "an" auf einer unteren Ebene
 *   hebt ein "aus" darueber nicht auf: global aus = ueberall aus.
 * FUNKTIONEN: empfehlung (plan empfehlen), entscheidung (jev entscheiden + Hinweise jev_modus,
 *   jev_hinweis, jev_entscheidet), plan_einordnen (plan einordnen), erklaerungstopf (E1),
 *   entscheidungstopf (P15 E1: Praezedenz-Schritt vor jev entscheiden; aus = alter Weg, Erfassung laeuft weiter),
 *   tool (das MCP-Tool jev selbst; global aus -> verschwindet aus tools/list).
 * CACHE: die ganze (kleine) Tabelle je Prozess, hoechstens alle JEV_SCHALTER_CACHE_MS (Standard
 *   5000) gelesen; setzeJevSchalter aktualisiert den Cache dieses Prozesses sofort. Andere Prozesse
 *   (stdio-MCP-Server, API) sehen eine Aenderung spaetestens nach Ablauf ihres Caches.
 * LESEFEHLER (DB weg, 2 s Zeitlimit, Tabelle fehlt): letzter bekannter Stand, ohne einen solchen an.
 *   Gemeldet einmal je Wechsel.
 */

import { getPool } from '../db/client.js';
import { jevBudgetPause } from './jev-kosten.js';

export const JEV_FUNKTIONEN = ['empfehlung', 'entscheidung', 'plan_einordnen', 'erklaerungstopf', 'entscheidungstopf', 'tool'] as const;
export type JevFunktion = (typeof JEV_FUNKTIONEN)[number];
/** Platzhalter fuer "global" (project) bzw. "alle Funktionen" (funktion) */
export const JEV_ALLE = '*';

export class JevSchalterFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface JevSchalterZeile {
  ebene: 'global' | 'projekt';
  project: string | null;
  funktion: string;
  aktiv: boolean;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
}

export interface JevWirkung {
  an: boolean;
  /** Wer abschaltet (nur bei an:false) */
  ebene?: 'global' | 'projekt' | 'budget';
  /** Abgeschaltete Funktion ('alle' oder Name) */
  funktion?: string;
  grund?: string | null;
  text?: string;
}

interface Roh {
  project: string;
  funktion: string;
  aktiv: boolean;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: Date | null;
}

const LESE_ZEITLIMIT_MS = 2000;
let cache: { zeilen: Map<string, Roh>; geholt: number } | null = null;
let laufend: Promise<Map<string, Roh>> | null = null;
let schreibStand = 0;
let lesefehlerGemeldet = false;

function cacheMs(): number {
  const n = Number(process.env.JEV_SCHALTER_CACHE_MS);
  return Number.isFinite(n) && n >= 0 && process.env.JEV_SCHALTER_CACHE_MS?.trim() ? n : 5000;
}

const schluessel = (project: string, funktion: string) => `${project}\u0000${funktion}`;

/** Nur fuer Tests / nach Fremdaenderung: Cache dieses Prozesses leeren. */
export function leereJevSchalterCache(): void {
  cache = null;
}

async function holeZeilen(): Promise<Map<string, Roh>> {
  const abfrage = getPool()
    .query<Roh>('SELECT project, funktion, aktiv, grund, gesetzt_von, gesetzt_am FROM jev_schalter')
    .then((r) => new Map(r.rows.map((z) => [schluessel(z.project, z.funktion), z])));
  abfrage.catch(() => undefined);
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      abfrage,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(`Zeitlimit ${LESE_ZEITLIMIT_MS} ms`)), LESE_ZEITLIMIT_MS);
        t.unref?.();
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Alle Schalterzeilen, gecacht. Wirft nie. */
async function leseZeilen(): Promise<Map<string, Roh>> {
  const jetzt = Date.now();
  if (cache && jetzt - cache.geholt < cacheMs()) return cache.zeilen;
  const standVorher = schreibStand;
  if (!laufend) laufend = holeZeilen().finally(() => { laufend = null; });
  let zeilen: Map<string, Roh>;
  try {
    zeilen = await laufend;
    if (lesefehlerGemeldet) {
      console.error('[jev-schalter] Lesen geht wieder.');
      lesefehlerGemeldet = false;
    }
  } catch (err) {
    if (!lesefehlerGemeldet) {
      console.error(`[jev-schalter] Lesen fehlgeschlagen, es gilt der letzte bekannte Stand (ohne: an): ${(err as Error).message}`);
      lesefehlerGemeldet = true;
    }
    zeilen = cache?.zeilen ?? new Map();
  }
  if (schreibStand !== standVorher && cache) return cache.zeilen;
  cache = { zeilen, geholt: Date.now() };
  return zeilen;
}

function istFunktion(f: string): f is JevFunktion {
  return (JEV_FUNKTIONEN as readonly string[]).includes(f);
}

const funktionsName = (f: string) => (f === JEV_ALLE ? 'alle' : f);

function wirkungsText(ebene: 'global' | 'projekt', project: string | null, funktion: string, grund: string | null): string {
  const wo = ebene === 'global' ? 'global' : `fuer Projekt ${project}`;
  const was = funktion === JEV_ALLE ? 'Jev ist' : `Jev-Funktion ${funktion} ist`;
  return `${was} ${wo} abgeschaltet${grund ? ` (Grund: ${grund})` : ''}. Einschalten nur durch User/Koordinator: ` +
    `admin(action:"jev_schalten", ebene:"${ebene}"${ebene === 'projekt' ? `, project:"${project}"` : ''}, funktion:"${funktionsName(funktion)}", aktiv:true).`;
}

/** Ist Jev fuer (project, funktion) an? project null = nur globale Ebene. Wirft nie. */
export async function jevWirksam(project: string | null | undefined, funktion: JevFunktion): Promise<JevWirkung> {
  const zeilen = await leseZeilen();
  const pruefe: Array<[string, string, 'global' | 'projekt']> = [
    [JEV_ALLE, JEV_ALLE, 'global'],
    [JEV_ALLE, funktion, 'global'],
  ];
  if (project) pruefe.push([project, JEV_ALLE, 'projekt'], [project, funktion, 'projekt']);
  for (const [p, f, ebene] of pruefe) {
    const z = zeilen.get(schluessel(p, f));
    if (z && !z.aktiv) {
      return { an: false, ebene, funktion: funktionsName(f), grund: z.grund, text: wirkungsText(ebene, ebene === 'projekt' ? p : null, f, z.grund) };
    }
  }
  const pause = await jevBudgetPause();
  if (pause) return { an: false, ebene: 'budget', funktion: 'alle', grund: 'budget', text: pause };
  return { an: true };
}

/** Duerfen Jev-Hinweise zu Rueckfragen (jev_modus, jev_hinweis, jev_entscheidet) erscheinen? */
export async function jevEntscheidungsHinweiseAn(project: string | null | undefined): Promise<boolean> {
  return (await jevWirksam(project, 'tool')).an && (await jevWirksam(project, 'entscheidung')).an;
}

/**
 * Fuer tools/list (REST und stdio): entfernt das Tool 'jev', wenn es GLOBAL abgeschaltet ist
 * (global '*' oder global 'tool'). Ein Projekt-Schalter wirkt hier nicht, weil tools/list kein
 * Projekt kennt; die Budget-Pause ebenfalls nicht (dann antwortet das Tool mit dem Budget-Hinweis).
 */
export async function filtereJevTool<T extends { name: string }>(tools: readonly T[]): Promise<T[]> {
  const zeilen = await leseZeilen();
  const aus = (f: string) => zeilen.get(schluessel(JEV_ALLE, f))?.aktiv === false;
  if (!aus(JEV_ALLE) && !aus('tool')) return [...tools];
  return tools.filter((t) => t.name !== 'jev');
}

/** Ablehnung fuer das Tool jev, wenn 'tool' fuer das Projekt aus ist; sonst null. */
export async function jevToolSperre(project: string | null | undefined): Promise<Record<string, unknown> | null> {
  const w = await jevWirksam(typeof project === 'string' && project ? project : null, 'tool');
  if (w.an) return null;
  return { success: false, error: 'jev_aus', ebene: w.ebene, message: w.text ?? 'Jev ist abgeschaltet.' };
}

function alsZeile(z: Roh): JevSchalterZeile {
  return {
    ebene: z.project === JEV_ALLE ? 'global' : 'projekt',
    project: z.project === JEV_ALLE ? null : z.project,
    funktion: funktionsName(z.funktion),
    aktiv: z.aktiv,
    grund: z.grund,
    gesetzt_von: z.gesetzt_von,
    gesetzt_am: z.gesetzt_am ? new Date(z.gesetzt_am).toISOString() : null,
  };
}

export interface SetzeJevSchalterOptionen {
  ebene: string;
  project?: string | null;
  /** Funktionsname oder 'alle'/'*' (Standard alle) */
  funktion?: string | null;
  aktiv: boolean;
  grund?: string | null;
  agent?: string | null;
}

/** Setzt einen Schalter (Upsert). Wirft JevSchalterFehler bei ungueltiger Eingabe. */
export async function setzeJevSchalter(o: SetzeJevSchalterOptionen): Promise<JevSchalterZeile> {
  if (o.ebene !== 'global' && o.ebene !== 'projekt') {
    throw new JevSchalterFehler('ebene_ungueltig', 'ebene muss "global" oder "projekt" sein.');
  }
  const project = o.ebene === 'global' ? JEV_ALLE : (o.project ?? '').trim();
  if (!project || (o.ebene === 'projekt' && project === JEV_ALLE)) {
    throw new JevSchalterFehler('project_fehlt', 'ebene "projekt" braucht project.');
  }
  const roh = (o.funktion ?? 'alle').trim();
  const funktion = roh === 'alle' || roh === JEV_ALLE || roh === '' ? JEV_ALLE : roh;
  if (funktion !== JEV_ALLE && !istFunktion(funktion)) {
    throw new JevSchalterFehler('funktion_unbekannt', `Unbekannte Funktion "${roh}". Erlaubt: alle, ${JEV_FUNKTIONEN.join(', ')}.`);
  }
  if (typeof o.aktiv !== 'boolean') throw new JevSchalterFehler('aktiv_fehlt', 'aktiv (true = an, false = aus) ist Pflicht.');
  const { rows } = await getPool().query<Roh>(
    `INSERT INTO jev_schalter (project, funktion, aktiv, grund, gesetzt_von, gesetzt_am)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (project, funktion) DO UPDATE SET aktiv = EXCLUDED.aktiv, grund = EXCLUDED.grund,
       gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am
     RETURNING project, funktion, aktiv, grund, gesetzt_von, gesetzt_am`,
    [project, funktion, o.aktiv, o.grund ?? null, o.agent ?? null],
  );
  schreibStand++;
  const z = rows[0];
  const neu = new Map(cache?.zeilen ?? []);
  neu.set(schluessel(z.project, z.funktion), z);
  cache = { zeilen: neu, geholt: Date.now() };
  console.error(`[jev-schalter] ${z.project === JEV_ALLE ? 'global' : `Projekt ${z.project}`} ${funktionsName(z.funktion)} -> ${z.aktiv ? 'an' : 'aus'} (${o.agent ?? '?'}${o.grund ? `, ${o.grund}` : ''})`);
  return alsZeile(z);
}

/** Alle gesetzten Schalter (frisch aus PG), optional nur global + dieses Projekt. */
export async function jevSchalterListe(project?: string | null): Promise<JevSchalterZeile[]> {
  const { rows } = await getPool().query<Roh>(
    `SELECT project, funktion, aktiv, grund, gesetzt_von, gesetzt_am FROM jev_schalter
      WHERE $1::text IS NULL OR project = '*' OR project = $1 ORDER BY (project = '*') DESC, project, funktion`,
    [project ?? null],
  );
  return rows.map(alsZeile);
}
