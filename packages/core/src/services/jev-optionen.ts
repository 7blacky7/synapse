/**
 * MODUL: Jev-Optionen (P15-T33 E0.5 Folge, 11.10.2026, User-Entscheidung a5fd30ea)
 * ZWECK: globale, dauerhafte Einstellungen fuer den Erklaerungstopf (wirken ab E1), schon jetzt ueber
 *        admin(action:"jev_optionen") setzbar und abfragbar.
 *   1) erklaerung_sprachen {de, en}: gepflegte Sprachen der Erklaerungen. Unabhaengig voneinander,
 *      mindestens eine an. Alle eingeschalteten sind beim Ablegen Pflicht (E1). Standard: beide an.
 *   2) jev_sprache 'en' | 'de' | 'mix': welche Sprache Jev angeboten bekommt. Standard 'en'. Nur aus
 *      den gepflegten Sprachen wirksam ('mix' braucht beide); sonst gilt ein Rueckfall auf eine
 *      gepflegte Sprache (en vor de) mit Hinweis - gespeichert bleibt der Wunsch.
 *   3) entscheidung_ohne_praezedenz (P15 E1, User e7b013c2): true = Jev waehlt auch ohne passende Praezedenz aus
 *      dem Entscheidungs-Topf unter den Optionen (markiert, Durchsicht zuerst); false = offene Frage. Standard true.
 *   Die gepflegten Sprachen gelten fuer BEIDE Toepfe (Erklaerungen und Entscheidungen).
 *   4) skill_rerank_tor (P23-T1): Mindest-Wahrscheinlichkeit (0..1), ab der Jev einen semantischen
 *      Skill-Vorschlag als sinnvoll bestaetigt. Standard 0.5.
 *   5) skill_rerank_max (P23-T1): hoechstens so viele semantische Kandidaten je Text gehen an Jev
 *      (1..30), der Rest wird bei aktiver Sinnpruefung nicht ausgeliefert. Standard 8.
 *   6) skill_rerank_budget_tokens (P23-T4): Eingabe-Budget der Sinnpruefung in Tokens (1.000..60.000,
 *      Obergrenze unter Jevs 64k-Eingabegrenze, memory wissen-jev-eingabegrenze-64k). Standard 10.000.
 *   7) skill_rerank_timeout_ms (P23-T4): Timeout des Jev-Aufrufs der Sinnpruefung (1.000..120.000 ms).
 *      Standard 20.000 (mehr Kontext, laeuft im Hintergrund).
 * TABELLE jev_optionen (name PK, wert JSONB). Fehlt eine Zeile, gilt der Standard. Lesefehler:
 *   Standardwerte mit Hinweis (wirft nicht).
 */

import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
import { getPool } from '../db/client.js';

export const JEV_SPRACHEN = ['en', 'de', 'mix'] as const;
export type JevSprache = (typeof JEV_SPRACHEN)[number];

export interface JevErklaerungSprachen { de: boolean; en: boolean }

export interface JevOptionen {
  erklaerung_sprachen: JevErklaerungSprachen;
  /** gesetzter Wunsch */
  jev_sprache: JevSprache;
  /** was tatsaechlich gilt (nach Rueckfall) */
  jev_sprache_wirksam: JevSprache;
  /** Anzeige fuer Agenten/User: die gepflegten Sprachen */
  gepflegte_sprachen: Array<'de' | 'en'>;
  /** P15 E1: Jev entscheidet auch ohne Praezedenz aus dem Entscheidungs-Topf (Standard true) */
  entscheidung_ohne_praezedenz: boolean;
  /** P23-T1: Tor der Skill-Sinnpruefung (0..1) */
  skill_rerank_tor: number;
  /** P23-T1: Hoechstzahl semantischer Kandidaten je Text fuer die Sinnpruefung */
  skill_rerank_max: number;
  /** P23-T4: Eingabe-Budget der Sinnpruefung in Tokens */
  skill_rerank_budget_tokens: number;
  /** P23-T4: Timeout des Jev-Aufrufs der Sinnpruefung in ms */
  skill_rerank_timeout_ms: number;
  hinweis?: string;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
}

export class JevOptionenFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const STANDARD_SPRACHEN: JevErklaerungSprachen = { de: true, en: true };
const STANDARD_JEV_SPRACHE: JevSprache = 'en';
const STANDARD_OHNE_PRAEZEDENZ = true;
export const STANDARD_SKILL_RERANK_TOR = 0.5;
export const STANDARD_SKILL_RERANK_MAX = 8;
const SKILL_RERANK_MAX_GRENZE = 30;
export const STANDARD_SKILL_RERANK_BUDGET_TOKENS = 10_000;
/** Obergrenze des Budgets: unter Jevs 64k-Eingabegrenze (Puffer fuer Schaetzfehler). */
export const SKILL_RERANK_BUDGET_GRENZE = 60_000;
const SKILL_RERANK_BUDGET_MIN = 1_000;
export const STANDARD_SKILL_RERANK_TIMEOUT_MS = 20_000;
const SKILL_RERANK_TIMEOUT_MIN = 1_000;
const SKILL_RERANK_TIMEOUT_MAX = 120_000;

function istTor(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}
function istRerankMax(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= SKILL_RERANK_MAX_GRENZE;
}
function istRerankBudget(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= SKILL_RERANK_BUDGET_MIN && x <= SKILL_RERANK_BUDGET_GRENZE;
}
function istRerankTimeout(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= SKILL_RERANK_TIMEOUT_MIN && x <= SKILL_RERANK_TIMEOUT_MAX;
}

function istSprache(x: unknown): x is JevSprache {
  return typeof x === 'string' && (JEV_SPRACHEN as readonly string[]).includes(x);
}

/** Wirksame Jev-Sprache: der Wunsch, wenn gepflegt; sonst Rueckfall (en vor de) mit Hinweis. */
export function wirksameJevSprache(sprachen: JevErklaerungSprachen, wunsch: JevSprache): { sprache: JevSprache; hinweis?: string } {
  const passt = wunsch === 'mix' ? sprachen.de && sprachen.en : sprachen[wunsch];
  if (passt) return { sprache: wunsch };
  const rueckfall: JevSprache = sprachen.en ? 'en' : 'de';
  const gepflegt = [sprachen.de ? 'de' : null, sprachen.en ? 'en' : null].filter(Boolean).join(', ');
  return {
    sprache: rueckfall,
    hinweis: `jev_sprache "${wunsch}" ist nicht aus den gepflegten Sprachen (${gepflegt}) - Rueckfall auf "${rueckfall}". ` +
      'Aendern mit admin(action:"jev_optionen", modus:"setzen", jev_sprache | erklaerung_de | erklaerung_en).',
  };
}

function baue(sprachen: JevErklaerungSprachen, wunsch: JevSprache, von: string | null, am: Date | null, zusatz?: string, ohnePraezedenz = STANDARD_OHNE_PRAEZEDENZ,
  rerankTor = STANDARD_SKILL_RERANK_TOR, rerankMax = STANDARD_SKILL_RERANK_MAX,
  rerankBudget = STANDARD_SKILL_RERANK_BUDGET_TOKENS, rerankTimeout = STANDARD_SKILL_RERANK_TIMEOUT_MS): JevOptionen {
  const w = wirksameJevSprache(sprachen, wunsch);
  const hinweis = [zusatz, w.hinweis].filter(Boolean).join(' ');
  return {
    erklaerung_sprachen: { ...sprachen },
    jev_sprache: wunsch,
    jev_sprache_wirksam: w.sprache,
    gepflegte_sprachen: (['de', 'en'] as const).filter((s) => sprachen[s]),
    entscheidung_ohne_praezedenz: ohnePraezedenz,
    skill_rerank_tor: rerankTor,
    skill_rerank_max: rerankMax,
    skill_rerank_budget_tokens: rerankBudget,
    skill_rerank_timeout_ms: rerankTimeout,
    ...(hinweis ? { hinweis } : {}),
    gesetzt_von: von,
    gesetzt_am: am ? new Date(am).toISOString() : null,
  };
}

function leseSprachen(wert: unknown): JevErklaerungSprachen | null {
  if (!wert || typeof wert !== 'object') return null;
  const { de, en } = wert as { de?: unknown; en?: unknown };
  if (typeof de !== 'boolean' || typeof en !== 'boolean' || (!de && !en)) return null;
  return { de, en };
}

/** Aktuelle Optionen (frisch aus PG). Wirft nie: bei Fehler Standardwerte mit Hinweis. */
export async function leseJevOptionen(): Promise<JevOptionen> {
  try {
    const { rows } = await getPool().query<{ name: string; wert: unknown; gesetzt_von: string | null; gesetzt_am: Date | null }>(
      `SELECT name, wert, gesetzt_von, gesetzt_am FROM jev_optionen WHERE name IN ('erklaerung_sprachen', 'jev_sprache', 'entscheidung_ohne_praezedenz', 'skill_rerank_tor', 'skill_rerank_max', 'skill_rerank_budget_tokens', 'skill_rerank_timeout_ms')`,
    );
    const z = new Map(rows.map((r) => [r.name, r]));
    const sprachen = leseSprachen(z.get('erklaerung_sprachen')?.wert) ?? STANDARD_SPRACHEN;
    const roh = z.get('jev_sprache')?.wert;
    const wunsch = istSprache(roh) ? roh : STANDARD_JEV_SPRACHE;
    const juengste = [...z.values()].sort((a, b) => (b.gesetzt_am?.getTime() ?? 0) - (a.gesetzt_am?.getTime() ?? 0))[0];
    const ohneRoh = z.get('entscheidung_ohne_praezedenz')?.wert;
    const torRoh = z.get('skill_rerank_tor')?.wert;
    const maxRoh = z.get('skill_rerank_max')?.wert;
    const budgetRoh = z.get('skill_rerank_budget_tokens')?.wert;
    const timeoutRoh = z.get('skill_rerank_timeout_ms')?.wert;
    return baue(sprachen, wunsch, juengste?.gesetzt_von ?? null, juengste?.gesetzt_am ?? null, undefined,
      typeof ohneRoh === 'boolean' ? ohneRoh : STANDARD_OHNE_PRAEZEDENZ,
      istTor(torRoh) ? torRoh : STANDARD_SKILL_RERANK_TOR,
      istRerankMax(maxRoh) ? maxRoh : STANDARD_SKILL_RERANK_MAX,
      istRerankBudget(budgetRoh) ? budgetRoh : STANDARD_SKILL_RERANK_BUDGET_TOKENS,
      istRerankTimeout(timeoutRoh) ? timeoutRoh : STANDARD_SKILL_RERANK_TIMEOUT_MS);
  } catch (err) {
    return baue(STANDARD_SPRACHEN, STANDARD_JEV_SPRACHE, null, null,
      `Jev-Optionen nicht lesbar, es gelten die Standardwerte: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

/**
 * Setzt einzelne Optionen (nicht genannte bleiben). Validierung: jev_sprache aus en|de|mix;
 * mindestens eine gepflegte Sprache. Wirft JevOptionenFehler (nichts geschrieben).
 */
export async function setzeJevOptionen(o: { erklaerung_de?: boolean; erklaerung_en?: boolean; jev_sprache?: string; entscheidung_ohne_praezedenz?: boolean; skill_rerank_tor?: number; skill_rerank_max?: number; skill_rerank_budget_tokens?: number; skill_rerank_timeout_ms?: number; agent?: string | null }): Promise<JevOptionen> {
  if (o.erklaerung_de === undefined && o.erklaerung_en === undefined && o.jev_sprache === undefined && o.entscheidung_ohne_praezedenz === undefined
    && o.skill_rerank_tor === undefined && o.skill_rerank_max === undefined
    && o.skill_rerank_budget_tokens === undefined && o.skill_rerank_timeout_ms === undefined) {
    throw new JevOptionenFehler('nichts_zu_setzen', 'modus setzen braucht mindestens eines von erklaerung_de, erklaerung_en, jev_sprache, entscheidung_ohne_praezedenz, skill_rerank_tor, skill_rerank_max, skill_rerank_budget_tokens, skill_rerank_timeout_ms.');
  }
  if (o.skill_rerank_budget_tokens !== undefined && !istRerankBudget(o.skill_rerank_budget_tokens)) {
    throw new JevOptionenFehler('skill_rerank_budget_tokens_ungueltig', `skill_rerank_budget_tokens "${o.skill_rerank_budget_tokens}" ungueltig. Erlaubt: ganze Zahl ${SKILL_RERANK_BUDGET_MIN}..${SKILL_RERANK_BUDGET_GRENZE} (Jev verarbeitet hoechstens 64k Eingabe-Tokens).`);
  }
  if (o.skill_rerank_timeout_ms !== undefined && !istRerankTimeout(o.skill_rerank_timeout_ms)) {
    throw new JevOptionenFehler('skill_rerank_timeout_ms_ungueltig', `skill_rerank_timeout_ms "${o.skill_rerank_timeout_ms}" ungueltig. Erlaubt: ganze Zahl ${SKILL_RERANK_TIMEOUT_MIN}..${SKILL_RERANK_TIMEOUT_MAX}.`);
  }
  if (o.skill_rerank_tor !== undefined && !istTor(o.skill_rerank_tor)) {
    throw new JevOptionenFehler('skill_rerank_tor_ungueltig', `skill_rerank_tor "${o.skill_rerank_tor}" ungueltig. Erlaubt: Zahl 0..1.`);
  }
  if (o.skill_rerank_max !== undefined && !istRerankMax(o.skill_rerank_max)) {
    throw new JevOptionenFehler('skill_rerank_max_ungueltig', `skill_rerank_max "${o.skill_rerank_max}" ungueltig. Erlaubt: ganze Zahl 1..${SKILL_RERANK_MAX_GRENZE}.`);
  }
  if (o.jev_sprache !== undefined && !istSprache(o.jev_sprache)) {
    throw new JevOptionenFehler('jev_sprache_ungueltig', `jev_sprache "${o.jev_sprache}" ungueltig. Erlaubt: ${JEV_SPRACHEN.join(', ')}.`);
  }
  const alt = await leseJevOptionen();
  const sprachen: JevErklaerungSprachen = {
    de: o.erklaerung_de ?? alt.erklaerung_sprachen.de,
    en: o.erklaerung_en ?? alt.erklaerung_sprachen.en,
  };
  if (!sprachen.de && !sprachen.en) {
    throw new JevOptionenFehler('keine_sprache', 'Mindestens eine Erklaerungssprache muss an sein (erklaerung_de oder erklaerung_en).');
  }
  const wunsch = (o.jev_sprache as JevSprache | undefined) ?? alt.jev_sprache;
  await getPool().query(
    `INSERT INTO jev_optionen (name, wert, gesetzt_von, gesetzt_am, setter_identity_id)
     VALUES ('erklaerung_sprachen', $1::jsonb, $3, NOW(), $4), ('jev_sprache', $2::jsonb, $3, NOW(), $4)
     ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am, setter_identity_id=EXCLUDED.setter_identity_id`,
    [JSON.stringify(sprachen), JSON.stringify(wunsch), o.agent ?? null, aktuelleAgentAkteurIdentityId(o.agent)],
  );
  if (typeof o.entscheidung_ohne_praezedenz === 'boolean') {
    await getPool().query(
      `INSERT INTO jev_optionen (name, wert, gesetzt_von, gesetzt_am, setter_identity_id) VALUES ('entscheidung_ohne_praezedenz', $1::jsonb, $2, NOW(), $3)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am, setter_identity_id=EXCLUDED.setter_identity_id`,
      [JSON.stringify(o.entscheidung_ohne_praezedenz), o.agent ?? null, aktuelleAgentAkteurIdentityId(o.agent)],
    );
  }
  for (const [name, wert] of [['skill_rerank_tor', o.skill_rerank_tor], ['skill_rerank_max', o.skill_rerank_max],
    ['skill_rerank_budget_tokens', o.skill_rerank_budget_tokens], ['skill_rerank_timeout_ms', o.skill_rerank_timeout_ms]] as const) {
    if (wert === undefined) continue;
    await getPool().query(
      `INSERT INTO jev_optionen (name, wert, gesetzt_von, gesetzt_am, setter_identity_id) VALUES ($1, $2::jsonb, $3, NOW(), $4)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am, setter_identity_id=EXCLUDED.setter_identity_id`,
      [name, JSON.stringify(wert), o.agent ?? null, aktuelleAgentAkteurIdentityId(o.agent)],
    );
  }
  return leseJevOptionen();
}
