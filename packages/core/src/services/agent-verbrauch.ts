/**
 * P22-T7 (W2d): Verbrauch der Agenten (User bf473136 Teil 13, 523133e6 Teil 8). Abo-CLIs (claude, codex): nur Token-ANZEIGE,
 * keine Grenze. API-Zugaenge: zusaetzlich USD; gebucht vom T8-Transport in dieselbe Tabelle (quelle api_worker), Budget dort.
 * Tabelle agent_verbrauch (Schema 119). Eine Buchungsstelle bucheAgentVerbrauch, eine Lesestelle leseAgentVerbrauch.
 *
 * SCHALTER 'verbrauch' (Produkt-Schalter I im Katalog PROFIL_PRODUKT_FUNKTIONEN, Standard AUS, nur ausdruecklich - 'alle' schaltet
 *   ihn nicht): wirksam = intern-Override 'verbrauch' (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (projekt > global,
 *   leseProfilProduktSchalter; setzen wie alle Produkt-Schalter ueber admin profil_schalter_setzen bzw. Web-UI, User/Koordinator)
 *   > Env SYNAPSE_VERBRAUCH=1 > AUS. Er schaltet nur die ZAEHLUNG der Abo-Quellen (main_chat, wrapper). Buchungen des API-Transports
 *   (api_worker) haengen NICHT daran, weil das Budget (T8) sonst ohne Grundlage waere; die schaltet T8 selbst.
 * RECHTE Lesen: User alles; bestaetigter Koordinator (mit Ausweis oder Legacy) nur sein Projekt; alle anderen recht_fehlt.
 * MONAT: Kalendermonat in DB-Zeit (wie jev_kosten), Parameter 'YYYY-MM', Standard aktueller Monat.
 */
import type { PoolClient, QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import { leseProfilProduktSchalter, setzeProfilProduktSchalter } from './agent-profil-schalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const VERBRAUCH_FUNKTION = 'verbrauch' as const;
export const VERBRAUCH_ZUGAENGE = ['abo', 'api'] as const;
export const VERBRAUCH_QUELLEN = ['main_chat', 'wrapper', 'api_worker'] as const;
export type VerbrauchZugang = typeof VERBRAUCH_ZUGAENGE[number];
export type VerbrauchQuelle = typeof VERBRAUCH_QUELLEN[number];

type Q = QueryConfig & { query_timeout: number };
type Db = Pick<PoolClient, 'query'>;
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface VerbrauchSchalterStand {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  /** Ebene der wirksamen Produkt-Schalter-Zeile (projekt vor global). */
  ebene: 'global' | 'projekt' | null;
  standard: boolean;
  bis: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache). project: Projekt der Buchung (Projektzeile vor globaler). Lesefehler -> Standard, letzter_fehler sichtbar. */
export async function leseVerbrauchSchalter(project?: string | null): Promise<VerbrauchSchalterStand> {
  const standard = process.env.SYNAPSE_VERBRAUCH === '1';
  const basis: VerbrauchSchalterStand = { aktiv: standard, quelle: 'standard', ebene: null, standard, bis: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  let letzter: string | null = null;
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [VERBRAUCH_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  // Eine Lesestelle: der Produkt-Schalter-Katalog (projekt > global, 'alle' zaehlt hier nicht).
  const p = await leseProfilProduktSchalter(VERBRAUCH_FUNKTION, project ?? null);
  if (p.quelle === 'produkt-schalter') {
    return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', ebene: p.ebene, gesetzt_von: p.gesetzt_von, gesetzt_am: p.gesetzt_am,
      grund: p.grund, letzter_fehler: letzter };
  }
  return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
}

/** REST-Weg der Web-UI (nur User, ebene global). Gleicher Speicher wie admin profil_schalter_setzen. */
export async function setzeVerbrauchSchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): Promise<VerbrauchSchalterStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Dieser Weg ist der User-Eingang; Koordinatoren nutzen admin profil_schalter_setzen' });
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await setzeProfilProduktSchalter({ ebene: 'global', funktion: VERBRAUCH_FUNKTION, aktiv: e.aktiv, grund }, { system: 'user' });
  return leseVerbrauchSchalter();
}

// ---------------------------------------------------------------------------------------------
// Buchung
// ---------------------------------------------------------------------------------------------
export interface VerbrauchBuchung {
  project: string;
  identity_id?: string | null;
  agent_id: string;
  runtime: string;
  zugang: VerbrauchZugang;
  modell?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  /** Nur zugang 'api'. */
  usd?: number | null;
  usd_quelle?: 'antwort' | 'listenpreis' | 'reservierung' | null;
  quelle: VerbrauchQuelle;
  lauf_id?: string | null;
  /** Idempotenz je Quelle: dieselbe Referenz bucht nur einmal. */
  referenz?: string | null;
  /** P22-T63: 'berechnet' = eigene Token-Zaehlung, wenn die CLI fuer den Zug keine usage geliefert hat (Standard gemessen). */
  messart?: 'gemessen' | 'berechnet';
}

export type VerbrauchBuchungsErgebnis =
  | { gebucht: true; id: string }
  | { gebucht: false; grund: 'funktion_aus' | 'leer' | 'doppelt' | 'ungueltig' | 'fehler'; details?: string };

function tokens(v: unknown): number | null {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function text(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * Die EINE Buchungsstelle. Wirft nie (Verbrauchszaehlung darf keinen Turn scheitern lassen); das Ergebnis sagt, ob und warum
 * nicht gebucht wurde. Mit db (PoolClient einer offenen Transaktion) bucht sie atomar mit dem Aufrufer (T8: Buchung +
 * Reservierungsabschluss); Fehler werden dann WEITERGEWORFEN, damit der Aufrufer zurueckrollen kann.
 */
export async function bucheAgentVerbrauch(b: VerbrauchBuchung, db?: Db): Promise<VerbrauchBuchungsErgebnis> {
  const werte = {
    project: text(b?.project, 256), agent_id: text(b?.agent_id, 256), runtime: text(b?.runtime, 64),
    input: tokens(b?.input_tokens), output: tokens(b?.output_tokens), cread: tokens(b?.cache_read_tokens), ccreate: tokens(b?.cache_creation_tokens),
  };
  if (!werte.project || !werte.agent_id || !werte.runtime || !(VERBRAUCH_ZUGAENGE as readonly string[]).includes(b?.zugang)
    || !(VERBRAUCH_QUELLEN as readonly string[]).includes(b?.quelle) || werte.input === null || werte.output === null || werte.cread === null || werte.ccreate === null) {
    return { gebucht: false, grund: 'ungueltig' };
  }
  const usd = b.zugang === 'api' && typeof b.usd === 'number' && Number.isFinite(b.usd) && b.usd >= 0 ? b.usd : null;
  if (werte.input + werte.output + werte.cread + werte.ccreate === 0 && usd === null) return { gebucht: false, grund: 'leer' };
  if (b.quelle !== 'api_worker') {
    const s = await leseVerbrauchSchalter(werte.project).catch(() => null);
    if (!s?.aktiv) return { gebucht: false, grund: 'funktion_aus' };
  }
  try {
    // P22-T63: messart (Schema 124) nur, wenn berechnet gebucht wird; gemessen bleibt der unveraenderte Standard der Spalte.
    const berechnet = b.messart === 'berechnet';
    const r = await (db ?? getPool()).query<{ id: string }>(
      `INSERT INTO agent_verbrauch (project, identity_id, agent_id, runtime, zugang, modell, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, usd, usd_quelle, quelle, lauf_id, referenz${berechnet ? ', messart' : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15${berechnet ? ", 'berechnet'" : ''})
       ON CONFLICT (quelle, referenz) WHERE referenz IS NOT NULL DO NOTHING RETURNING id::text AS id`,
      [werte.project, text(b.identity_id, 64), werte.agent_id, werte.runtime, b.zugang, text(b.modell, 128), werte.input, werte.output,
        werte.cread, werte.ccreate, usd, usd !== null ? (b.usd_quelle ?? null) : null, b.quelle, text(b.lauf_id, 64), text(b.referenz, 200)]);
    return r.rows[0] ? { gebucht: true, id: r.rows[0].id } : { gebucht: false, grund: 'doppelt' };
  } catch (err) {
    if (db) throw err;
    return { gebucht: false, grund: 'fehler', details: (err as { code?: string })?.code ?? 'unbekannt' };
  }
}

// ---------------------------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------------------------
const MONAT = /^(\d{4})-(0[1-9]|1[0-2])$/;

interface Summe {
  buchungen: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
  tokens_gesamt: number; usd: number | null;
}
function summeAus(z: Record<string, unknown>): Summe {
  const n = (k: string) => Number(z[k] ?? 0);
  return {
    buchungen: n('buchungen'), input_tokens: n('input_tokens'), output_tokens: n('output_tokens'), cache_read_tokens: n('cache_read_tokens'),
    cache_creation_tokens: n('cache_creation_tokens'),
    tokens_gesamt: n('input_tokens') + n('output_tokens') + n('cache_read_tokens') + n('cache_creation_tokens'),
    usd: z.usd === null || z.usd === undefined ? null : Number(z.usd),
  };
}
const SUMMEN = `COUNT(*) AS buchungen, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens, SUM(usd) AS usd`;

/**
 * Verbrauch eines Kalendermonats je Agent und je Projekt, getrennt nach Zugang (abo: Tokens ohne Grenze; api: Tokens + USD).
 * project: User optional (ohne = alle Projekte), Koordinator Pflicht und nur das eigene.
 */
export async function leseAgentVerbrauch(
  akteur: AusweisAkteur | null, e: { monat?: unknown; project?: unknown } = {},
): Promise<Record<string, unknown>> {
  if (!akteur) fehler('recht_fehlt');
  const project = typeof e.project === 'string' && e.project.trim() ? e.project.trim() : null;
  if (akteur.art !== 'user') {
    if (!project) fehler('project_fehlt');
    await pruefeProfilVerwalter(akteur, project);
  }
  let monat: string;
  if (e.monat === undefined || e.monat === null || e.monat === '') {
    monat = (await getPool().query<{ m: string }>("SELECT to_char(NOW(), 'YYYY-MM') AS m")).rows[0].m;
  } else if (typeof e.monat === 'string' && MONAT.test(e.monat)) {
    monat = e.monat;
  } else {
    return fehler('monat_ungueltig', { format: 'YYYY-MM' });
  }
  const filter = `zeit >= to_date($1,'YYYY-MM') AND zeit < (to_date($1,'YYYY-MM') + INTERVAL '1 month')${project ? ' AND project = $2' : ''}`;
  const werte = project ? [monat, project] : [monat];
  const pool = getPool();
  const [jeAgent, jeProjekt, gesamt] = await Promise.all([
    pool.query(`SELECT project, identity_id, agent_id, zugang, array_agg(DISTINCT runtime) AS runtimes, array_agg(DISTINCT modell) FILTER (WHERE modell IS NOT NULL) AS modelle,
        MAX(zeit) AS zuletzt, ${SUMMEN}
      FROM agent_verbrauch WHERE ${filter} GROUP BY project, identity_id, agent_id, zugang ORDER BY project, agent_id, zugang`, werte),
    pool.query(`SELECT project, zugang, ${SUMMEN} FROM agent_verbrauch WHERE ${filter} GROUP BY project, zugang ORDER BY project, zugang`, werte),
    pool.query(`SELECT zugang, ${SUMMEN} FROM agent_verbrauch WHERE ${filter} GROUP BY zugang`, werte),
  ]);
  const summe: Record<string, Summe> = {};
  for (const z of gesamt.rows) summe[z.zugang as string] = summeAus(z);
  return {
    monat, project, schalter: await leseVerbrauchSchalter(project),
    hinweis: 'abo = CLI mit Abo-Login: nur Tokens, keine Grenze. api = kostenpflichtiger Zugang: Tokens und USD (Budget in P22-T8). Kalendermonat in DB-Zeit.',
    summe: { abo: summe.abo ?? summeAus({}), api: summe.api ?? summeAus({}) },
    je_projekt: jeProjekt.rows.map(z => ({ project: z.project, zugang: z.zugang, ...summeAus(z) })),
    je_agent: jeAgent.rows.map(z => ({
      project: z.project, identity_id: z.identity_id ?? null, agent_id: z.agent_id, zugang: z.zugang,
      runtimes: z.runtimes ?? [], modelle: z.modelle ?? [], zuletzt: z.zuletzt ? new Date(z.zuletzt).toISOString() : null, ...summeAus(z),
    })),
  };
}
