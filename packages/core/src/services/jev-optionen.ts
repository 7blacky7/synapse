/**
 * MODUL: Jev-Optionen (P15-T33 E0.5 Folge, 11.10.2026, User-Entscheidung a5fd30ea)
 * ZWECK: globale, dauerhafte Einstellungen fuer den Erklaerungstopf (wirken ab E1), schon jetzt ueber
 *        admin(action:"jev_optionen") setzbar und abfragbar.
 *   1) erklaerung_sprachen {de, en}: gepflegte Sprachen der Erklaerungen. Unabhaengig voneinander,
 *      mindestens eine an. Alle eingeschalteten sind beim Ablegen Pflicht (E1). Standard: beide an.
 *   2) jev_sprache 'en' | 'de' | 'mix': welche Sprache Jev angeboten bekommt. Standard 'en'. Nur aus
 *      den gepflegten Sprachen wirksam ('mix' braucht beide); sonst gilt ein Rueckfall auf eine
 *      gepflegte Sprache (en vor de) mit Hinweis - gespeichert bleibt der Wunsch.
 * TABELLE jev_optionen (name PK, wert JSONB). Fehlt eine Zeile, gilt der Standard. Lesefehler:
 *   Standardwerte mit Hinweis (wirft nicht).
 */

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

function baue(sprachen: JevErklaerungSprachen, wunsch: JevSprache, von: string | null, am: Date | null, zusatz?: string): JevOptionen {
  const w = wirksameJevSprache(sprachen, wunsch);
  const hinweis = [zusatz, w.hinweis].filter(Boolean).join(' ');
  return {
    erklaerung_sprachen: { ...sprachen },
    jev_sprache: wunsch,
    jev_sprache_wirksam: w.sprache,
    gepflegte_sprachen: (['de', 'en'] as const).filter((s) => sprachen[s]),
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
      `SELECT name, wert, gesetzt_von, gesetzt_am FROM jev_optionen WHERE name IN ('erklaerung_sprachen', 'jev_sprache')`,
    );
    const z = new Map(rows.map((r) => [r.name, r]));
    const sprachen = leseSprachen(z.get('erklaerung_sprachen')?.wert) ?? STANDARD_SPRACHEN;
    const roh = z.get('jev_sprache')?.wert;
    const wunsch = istSprache(roh) ? roh : STANDARD_JEV_SPRACHE;
    const juengste = [...z.values()].sort((a, b) => (b.gesetzt_am?.getTime() ?? 0) - (a.gesetzt_am?.getTime() ?? 0))[0];
    return baue(sprachen, wunsch, juengste?.gesetzt_von ?? null, juengste?.gesetzt_am ?? null);
  } catch (err) {
    return baue(STANDARD_SPRACHEN, STANDARD_JEV_SPRACHE, null, null,
      `Jev-Optionen nicht lesbar, es gelten die Standardwerte: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

/**
 * Setzt einzelne Optionen (nicht genannte bleiben). Validierung: jev_sprache aus en|de|mix;
 * mindestens eine gepflegte Sprache. Wirft JevOptionenFehler (nichts geschrieben).
 */
export async function setzeJevOptionen(o: { erklaerung_de?: boolean; erklaerung_en?: boolean; jev_sprache?: string; agent?: string | null }): Promise<JevOptionen> {
  if (o.erklaerung_de === undefined && o.erklaerung_en === undefined && o.jev_sprache === undefined) {
    throw new JevOptionenFehler('nichts_zu_setzen', 'modus setzen braucht mindestens eines von erklaerung_de, erklaerung_en, jev_sprache.');
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
    `INSERT INTO jev_optionen (name, wert, gesetzt_von, gesetzt_am)
     VALUES ('erklaerung_sprachen', $1::jsonb, $3, NOW()), ('jev_sprache', $2::jsonb, $3, NOW())
     ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = EXCLUDED.gesetzt_am`,
    [JSON.stringify(sprachen), JSON.stringify(wunsch), o.agent ?? null],
  );
  return leseJevOptionen();
}
