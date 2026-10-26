/**
 * P22-T8 (W2-API): kostenpflichtiger API-Agent (Claude per API-Key) - Schalter, Budget, Einstellwerte, Reservierung, Kosten.
 * Vertrag thought a099a205, Koordinator-Entscheid (Channel w2): Schalter = Produkt-Schalter hauptagent, Funktion 'api';
 * EIN globales Budget mit Grenze, Zeitraum und erlaubten Modellen (Muster jev_budget). User 58d2c6cb, ca755410 (U10), bf473136.
 *
 * SCHALTER: wirksam = hauptagent (hauptagent-dienst.ts) UND Funktion 'hauptagent_api'. Die Funktion liest wie hauptagent:
 *   intern-Override 'hauptagent_api' (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (agent_profil_schalter, ebene
 *   global, funktion 'hauptagent_api') > Env SYNAPSE_HAUPTAGENT_API=1 > AUS. Setzen NUR der User.
 * BUDGET (api_agent_budget, Schema 120): genau eine Zeile; fehlt sie, gibt es KEINEN kostenpflichtigen Aufruf. Ein Modell
 *   muss in erlaubte_modelle stehen UND einen Preis in model_registry haben (provider 'anthropic-api'); unbekannter Preis ->
 *   preis_unbekannt, nie kostenlos. Kein bezahlter Ersatz: wer ablehnt, lehnt ab.
 * RESERVIERUNG vor jedem Anbieter-Aufruf (obere Schranke: Eingabe-Tokens geschaetzt Zeichen/3 x Eingabepreis x
 *   cache_schreib_faktor + max_tokens x Ausgabepreis), atomar unter FOR UPDATE auf der Budgetzeile: verbraucht im Zeitraum
 *   (gebucht + offen + verfallen) + neu <= grenze. Nebenlaeufige Worker koennen denselben Rest nicht doppelt ausgeben.
 * ABSCHLUSS: echte Kosten aus usage (input, cache_creation x faktor, cache_read zum Cachepreis, output) -> gebucht, in
 *   derselben Transaktion in agent_verbrauch (T7, zugang 'api', quelle 'api_worker'). Ohne usage nach einer Antwort: volle
 *   Reservierung (usd_quelle 'reservierung'). Nur ein Fehler VOR der Antwort gibt frei (usd 0). Offene Reservierungen nach
 *   reservierung_minuten verfallen und zaehlen voll.
 * EINSTELLWERTE (api_agent_einstellungen): Code-Standard + PG-Wert, Antwort nennt die Quelle (Regel 7).
 * RECHTE: Setzen (Schalter, Budget, Einstellwerte) nur der User. Lesen: User und der Hauptagent selbst (Rolle main im
 *   reservierten Bereich, in PG gegengeprueft). Der Transport (Ausweis) liest nur seinen eigenen Rahmen.
 * Der API-Key steht NIE hier: er liegt als Infrastruktur-Geheimnis beim Transport (rest-api, Env SYNAPSE_ANTHROPIC_API_KEY).
 * P22-T179: zugang 'agent' (Arbeitsagent/Koordinator) - statt hauptagent gilt die Funktion api plus Schalter api_agenten im Projekt
 *   und die Freigabe JE IDENTITAET (api-agent-freigabe.ts, Gate pruefeAgentFreigabeTx unter derselben Budgetsperre). admin api_freigabe.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { abrechnungsmonat } from './context7-kontingent.js';
import { leseHauptagentSchalter } from './hauptagent-dienst.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { ProfilVerwaltungFehler, aktuellerW1bAkteur, pflichtText } from './agent-profil-verwalter.js';
import { bucheAgentVerbrauch } from './agent-verbrauch.js';
import { leseApiKeyStand } from './api-schluessel-dienst.js';
import {
  pruefeApiAgentenSchalter, pruefeAgentFreigabeTx, apiAgentenStand, setzeApiFreigabe, entferneApiFreigabe, pruefeApiFreigabeLeser,
} from './api-agent-freigabe.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { apiLaeufeStand, steuereApiLauf, setzeApiLaufEinstellungen, API_LAUF_EINSTELLUNG_NAMEN, API_LAUF_STEUERUNG } from './api-agent-lauf-dienst.js';
import { rolleFuerAgent } from './agent-rollen.js';

export const HAUPTAGENT_API_FUNKTION = 'hauptagent_api' as const;
/** Provider der API-Modelle in model_registry (getrennt von den Abo-CLIs 'anthropic', User 88f80455 Punkt 2). */
export const API_ANBIETER = 'anthropic-api' as const;
/** P22-T183: OpenRouter (OpenAI-Format, z. B. DeepSeek). Budget/Buchung wie Anthropic hier, strikt getrennt von der Jev-Bremse. */
export const API_ANBIETER_OPENROUTER = 'openrouter-api' as const;
/** P22-T183: alle Provider mit Budget, Freigabe und Reservierung (model_registry.provider). */
export const API_ANBIETER_ALLE = [API_ANBIETER, API_ANBIETER_OPENROUTER] as const;
export type ApiAnbieter = typeof API_ANBIETER_ALLE[number];
export const API_ZEITRAEUME = ['tag', 'woche', 'monat'] as const;
export type ApiZeitraum = typeof API_ZEITRAEUME[number];

type Q = QueryConfig & { query_timeout: number };
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }
const zahl = (x: unknown): number => (x === null || x === undefined ? 0 : Number(x));
const rund = (x: number): number => Math.round(x * 1e8) / 1e8;

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface ApiFunktionStand {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  standard: boolean;
  bis: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}
export interface ApiSchalterStand {
  /** wirksam: hauptagent EIN und Funktion api EIN */
  aktiv: boolean;
  hauptagent: { aktiv: boolean; quelle: string };
  api: ApiFunktionStand;
}

/** Frisch je Aufruf (kein Cache). Lesefehler -> Produktionsstandard, letzter_fehler sichtbar. */
export async function leseApiFunktion(): Promise<ApiFunktionStand> {
  const standard = process.env.SYNAPSE_HAUPTAGENT_API === '1';
  const basis: ApiFunktionStand = { aktiv: standard, quelle: 'standard', standard, bis: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  let letzter: string | null = null;
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [HAUPTAGENT_API_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  try {
    const r = await getPool().query<{ aktiv: boolean; grund: string | null; gesetzt_von: string; gesetzt_am: Date }>({
      text: `SELECT aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter WHERE ebene = 'global' AND project IS NULL AND funktion = $1`,
      values: [HAUPTAGENT_API_FUNKTION], query_timeout: 2000,
    } as Q);
    const z = r.rows[0];
    if (z) return { ...basis, aktiv: z.aktiv, quelle: 'produkt-schalter', gesetzt_von: z.gesetzt_von, gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund, letzter_fehler: letzter };
  } catch { letzter = letzter ?? 'produkt_schalter_nicht_lesbar'; }
  return { ...basis, letzter_fehler: letzter };
}

export async function leseApiSchalter(): Promise<ApiSchalterStand> {
  const [haupt, api] = await Promise.all([leseHauptagentSchalter(), leseApiFunktion()]);
  return { aktiv: haupt.aktiv && api.aktiv, hauptagent: { aktiv: haupt.aktiv, quelle: haupt.quelle }, api };
}

/** Nur der User. Schreibt die globale Zeile funktion 'hauptagent_api'. Die Wahl eines API-Modells ist keine Budgetfreigabe. */
export async function setzeApiSchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): Promise<ApiSchalterStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Funktion api des Hauptagenten setzt nur der User' });
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await getPool().query(
    `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ('global', NULL, $1, $2, $3, 'user', NULL, NOW())
     ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
       gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=NULL, gesetzt_am=EXCLUDED.gesetzt_am`,
    [HAUPTAGENT_API_FUNKTION, e.aktiv, grund]);
  return leseApiSchalter();
}

// ---------------------------------------------------------------------------------------------
// Einstellwerte
// ---------------------------------------------------------------------------------------------
export const API_EINSTELLUNG_NAMEN = ['max_tokens_obergrenze', 'reservierung_minuten', 'toolrunden_max', 'laufzeit_minuten', 'cache_schreib_faktor'] as const;
export type ApiEinstellungName = typeof API_EINSTELLUNG_NAMEN[number];
/** Code-Standard je Wert; [min, max] und ob ganzzahlig. */
export const API_EINSTELLUNG_STANDARD: Record<ApiEinstellungName, { standard: number; min: number; max: number; ganz: boolean }> = {
  max_tokens_obergrenze: { standard: 32_000, min: 256, max: 128_000, ganz: true },
  reservierung_minuten: { standard: 15, min: 1, max: 240, ganz: true },
  toolrunden_max: { standard: 50, min: 1, max: 500, ganz: true },
  laufzeit_minuten: { standard: 30, min: 1, max: 720, ganz: true },
  cache_schreib_faktor: { standard: 1.25, min: 1, max: 4, ganz: false },
};
export type ApiEinstellungen = Record<ApiEinstellungName, { wert: number; quelle: 'standard' | 'einstellung'; gesetzt_am: string | null }>;

export async function leseApiEinstellungen(db: Pick<PoolClient, 'query'> = getPool()): Promise<ApiEinstellungen> {
  const r = await db.query<{ name: ApiEinstellungName; wert: string; gesetzt_am: Date }>('SELECT name, wert, gesetzt_am FROM api_agent_einstellungen');
  const aus = {} as ApiEinstellungen;
  for (const n of API_EINSTELLUNG_NAMEN) aus[n] = { wert: API_EINSTELLUNG_STANDARD[n].standard, quelle: 'standard', gesetzt_am: null };
  for (const z of r.rows) {
    if ((API_EINSTELLUNG_NAMEN as readonly string[]).includes(z.name)) aus[z.name] = { wert: Number(z.wert), quelle: 'einstellung', gesetzt_am: z.gesetzt_am.toISOString() };
  }
  return aus;
}

/** Nur der User. werte = {name: zahl}; entfernen = Namen, deren PG-Wert entfaellt (Rueckfall Code-Standard). */
export async function setzeApiEinstellungen(
  akteur: AusweisAkteur | null, e: { werte?: unknown; entfernen?: unknown; grund: unknown },
): Promise<ApiEinstellungen> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Einstellwerte des API-Agenten setzt nur der User' });
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const werte = e.werte === undefined || e.werte === null ? {} : e.werte;
  if (typeof werte !== 'object' || Array.isArray(werte)) fehler('einstellung_ungueltig');
  const entfernen = e.entfernen === undefined || e.entfernen === null ? [] : e.entfernen;
  if (!Array.isArray(entfernen)) fehler('einstellung_ungueltig');
  const setzen: Array<[ApiEinstellungName, number]> = [];
  for (const [name, wert] of Object.entries(werte as Record<string, unknown>)) {
    if (!(API_EINSTELLUNG_NAMEN as readonly string[]).includes(name)) fehler('einstellung_unbekannt', { name });
    const d = API_EINSTELLUNG_STANDARD[name as ApiEinstellungName];
    if (typeof wert !== 'number' || !Number.isFinite(wert) || wert < d.min || wert > d.max || (d.ganz && !Number.isInteger(wert))) {
      fehler('einstellung_ungueltig', { name, min: d.min, max: d.max, ganzzahlig: d.ganz });
    }
    setzen.push([name as ApiEinstellungName, wert]);
  }
  for (const name of entfernen) if (!(API_EINSTELLUNG_NAMEN as readonly string[]).includes(name as string)) fehler('einstellung_unbekannt', { name });
  if (!setzen.length && !entfernen.length) fehler('einstellung_fehlt');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    for (const [name, wert] of setzen) {
      await c.query(
        `INSERT INTO api_agent_einstellungen (name, wert, grund, gesetzt_von, setter_identity_id, gesetzt_am) VALUES ($1,$2,$3,'user',NULL,NOW())
         ON CONFLICT (name) DO UPDATE SET wert=EXCLUDED.wert, grund=EXCLUDED.grund, gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=NULL, gesetzt_am=EXCLUDED.gesetzt_am`,
        [name, wert, grund]);
    }
    if (entfernen.length) await c.query('DELETE FROM api_agent_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return leseApiEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Modelle und Preise (model_registry, provider 'anthropic-api')
// ---------------------------------------------------------------------------------------------
export interface ApiModellPreis {
  alias: string;
  /** P22-T183: Provider der Zeile (anthropic-api | openrouter-api); bestimmt Format und Transport. */
  anbieter: ApiAnbieter;
  anbieter_modell: string;
  context_window: number;
  output_limit: number | null;
  /** USD je 1 Mio. Tokens; null = unbekannt (dann kein Aufruf) */
  eingabe: number | null;
  ausgabe: number | null;
  cache_lesen: number | null;
}

/** Frisch aus PG (kein Prozess-Cache): ein geaenderter Preis wirkt sofort. */
export async function leseApiModelle(): Promise<ApiModellPreis[]> {
  const r = await getPool().query<{ alias: string; provider: ApiAnbieter; full_id: string; context_window: number; output_limit: number | null;
    pi: string | null; po: string | null; pc: string | null }>(
    `SELECT alias, provider, full_id, context_window, output_limit, pricing_input_usd_per_mtok AS pi, pricing_output_usd_per_mtok AS po,
            pricing_cache_usd_per_mtok AS pc
       FROM model_registry WHERE enabled = true AND provider = ANY($1::text[]) ORDER BY alias`, [[...API_ANBIETER_ALLE]]);
  return r.rows.map(z => ({ alias: z.alias, anbieter: z.provider, anbieter_modell: z.full_id, context_window: z.context_window, output_limit: z.output_limit,
    eingabe: z.pi === null ? null : Number(z.pi), ausgabe: z.po === null ? null : Number(z.po), cache_lesen: z.pc === null ? null : Number(z.pc) }));
}

function preisBekannt(m: ApiModellPreis | undefined): m is ApiModellPreis & { eingabe: number; ausgabe: number } {
  return !!m && m.eingabe !== null && m.ausgabe !== null && m.eingabe > 0 && m.ausgabe > 0;
}

// ---------------------------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------------------------
interface BudgetZeile {
  grenze_usd: string; zeitraum: ApiZeitraum; reset_tag: number; erlaubte_modelle: string[]; grund: string;
  gesetzt_von: string; gesetzt_am: Date;
}
export interface ApiBudgetStand {
  gesetzt: boolean;
  grenze_usd: number | null;
  zeitraum: ApiZeitraum | null;
  reset_tag: number | null;
  erlaubte_modelle: string[];
  /** Beginn des laufenden Zeitraums (YYYY-MM-DD, Ortszeit des Servers) */
  beginn: string | null;
  gebucht_usd: number;
  offen_usd: number;
  verfallen_usd: number;
  verbraucht_usd: number;
  rest_usd: number | null;
  erschoepft: boolean;
  grund: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  hinweis?: string;
}

const tagText = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Beginn des Zeitraums, in dem jetzt liegt: tag = heute, woche = Montag, monat = Abrechnungsmonat ab reset_tag. */
export function apiZeitraumBeginn(zeitraum: ApiZeitraum, resetTag: number, jetzt = new Date()): string {
  if (zeitraum === 'tag') return tagText(jetzt);
  if (zeitraum === 'woche') {
    const d = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return tagText(d);
  }
  return abrechnungsmonat(jetzt, resetTag);
}

/** Abgelaufene offene Reservierungen verfallen und zaehlen VOLL (unbekannte Kosten sind nie kostenlos). */
async function verfalleAbgelaufene(db: Pick<PoolClient, 'query'>): Promise<void> {
  await db.query(
    `UPDATE api_agent_reservierungen SET status='verfallen', usd=reserviert_usd, usd_quelle='reservierung', abgeschlossen_am=NOW(),
            fehler=COALESCE(fehler, 'ohne Abschluss abgelaufen')
      WHERE status='offen' AND frist_bis <= NOW()`);
}

async function verbrauchImZeitraum(db: Pick<PoolClient, 'query'>, beginn: string): Promise<{ gebucht: number; offen: number; verfallen: number }> {
  const r = await db.query<{ gebucht: string | null; offen: string | null; verfallen: string | null }>(
    `SELECT COALESCE(SUM(usd) FILTER (WHERE status='gebucht'),0) AS gebucht,
            COALESCE(SUM(reserviert_usd) FILTER (WHERE status='offen'),0) AS offen,
            COALESCE(SUM(usd) FILTER (WHERE status='verfallen'),0) AS verfallen
       FROM api_agent_reservierungen WHERE erstellt_am >= $1::date`, [beginn]);
  return { gebucht: zahl(r.rows[0]?.gebucht), offen: zahl(r.rows[0]?.offen), verfallen: zahl(r.rows[0]?.verfallen) };
}

function budgetAus(z: BudgetZeile | undefined, v: { gebucht: number; offen: number; verfallen: number } | null, beginn: string | null): ApiBudgetStand {
  if (!z) {
    return { gesetzt: false, grenze_usd: null, zeitraum: null, reset_tag: null, erlaubte_modelle: [], beginn: null, gebucht_usd: 0, offen_usd: 0,
      verfallen_usd: 0, verbraucht_usd: 0, rest_usd: null, erschoepft: true, grund: null, gesetzt_von: null, gesetzt_am: null,
      hinweis: 'Kein API-Budget gesetzt: keine kostenpflichtigen Aufrufe (admin api_budget modus setzen, nur User).' };
  }
  const grenze = Number(z.grenze_usd);
  const verbraucht = rund((v?.gebucht ?? 0) + (v?.offen ?? 0) + (v?.verfallen ?? 0));
  const erschoepft = verbraucht >= grenze;
  return {
    gesetzt: true, grenze_usd: grenze, zeitraum: z.zeitraum, reset_tag: z.reset_tag, erlaubte_modelle: z.erlaubte_modelle ?? [], beginn,
    gebucht_usd: rund(v?.gebucht ?? 0), offen_usd: rund(v?.offen ?? 0), verfallen_usd: rund(v?.verfallen ?? 0), verbraucht_usd: verbraucht,
    rest_usd: Math.max(0, rund(grenze - verbraucht)), erschoepft, grund: z.grund, gesetzt_von: z.gesetzt_von, gesetzt_am: z.gesetzt_am.toISOString(),
    ...(erschoepft ? { hinweis: `API-Budget erreicht (${verbraucht} von ${grenze} USD seit ${beginn}). Weiter ab dem naechsten Zeitraum oder per admin api_budget (nur User).` } : {}),
  };
}

export async function leseApiBudget(): Promise<ApiBudgetStand> {
  await verfalleAbgelaufene(getPool());
  const r = await getPool().query<BudgetZeile>('SELECT grenze_usd, zeitraum, reset_tag, erlaubte_modelle, grund, gesetzt_von, gesetzt_am FROM api_agent_budget WHERE id = 1');
  const z = r.rows[0];
  if (!z) return budgetAus(undefined, null, null);
  const beginn = apiZeitraumBeginn(z.zeitraum, z.reset_tag);
  return budgetAus(z, await verbrauchImZeitraum(getPool(), beginn), beginn);
}

/** Nur der User. Modelle muessen API-Modelle mit bekanntem Preis sein. */
export async function setzeApiBudget(
  akteur: AusweisAkteur | null,
  e: { grenze_usd: unknown; zeitraum?: unknown; reset_tag?: unknown; erlaubte_modelle?: unknown; grund: unknown },
): Promise<ApiBudgetStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'API-Budget setzt nur der User' });
  if (typeof e.grenze_usd !== 'number' || !Number.isFinite(e.grenze_usd) || e.grenze_usd <= 0) fehler('grenze_ungueltig', { grund: 'grenze_usd muss eine Zahl > 0 sein' });
  const zeitraum = e.zeitraum === undefined || e.zeitraum === null ? 'monat' : e.zeitraum;
  if (typeof zeitraum !== 'string' || !(API_ZEITRAEUME as readonly string[]).includes(zeitraum)) fehler('zeitraum_ungueltig', { erlaubt: [...API_ZEITRAEUME] });
  const resetTag = e.reset_tag === undefined || e.reset_tag === null ? 1 : e.reset_tag;
  if (typeof resetTag !== 'number' || !Number.isInteger(resetTag) || resetTag < 1 || resetTag > 28) fehler('reset_tag_ungueltig', { min: 1, max: 28 });
  if (!Array.isArray(e.erlaubte_modelle) || !e.erlaubte_modelle.every(m => typeof m === 'string' && m.trim())) {
    fehler('erlaubte_modelle_fehlen', { grund: 'Liste der erlaubten API-Modelle (Aliase aus model_registry, provider anthropic-api)' });
  }
  const gewaehlt = [...new Set((e.erlaubte_modelle as string[]).map(m => m.trim()))];
  const modelle = await leseApiModelle();
  for (const alias of gewaehlt) {
    const m = modelle.find(x => x.alias === alias);
    if (!m) fehler('modell_unbekannt', { modell: alias, verfuegbar: modelle.map(x => x.alias) });
    if (!preisBekannt(m)) fehler('preis_unbekannt', { modell: alias });
  }
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await getPool().query(
    `INSERT INTO api_agent_budget (id, grenze_usd, zeitraum, reset_tag, erlaubte_modelle, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES (1, $1, $2, $3, $4::text[], $5, 'user', NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET grenze_usd=EXCLUDED.grenze_usd, zeitraum=EXCLUDED.zeitraum, reset_tag=EXCLUDED.reset_tag,
       erlaubte_modelle=EXCLUDED.erlaubte_modelle, grund=EXCLUDED.grund, gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=NULL, gesetzt_am=EXCLUDED.gesetzt_am`,
    [e.grenze_usd, zeitraum, resetTag, gewaehlt, grund]);
  return leseApiBudget();
}

/** Nur der User. Ohne Budget gibt es keine kostenpflichtigen Aufrufe mehr; die Historie bleibt. */
export async function entferneApiBudget(akteur: AusweisAkteur | null, e: { grund: unknown }): Promise<ApiBudgetStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'API-Budget entfernt nur der User' });
  pflichtText(e.grund, 'grund_fehlt');
  await getPool().query('DELETE FROM api_agent_budget WHERE id = 1');
  return leseApiBudget();
}

// ---------------------------------------------------------------------------------------------
// Reservierung und Abschluss (nur der Transport ruft das)
// ---------------------------------------------------------------------------------------------
export interface ApiReservierungEingabe {
  identity_id: string;
  project: string;
  agent_id: string;
  /** Registry-Alias (z. B. api-opus) */
  modell: string;
  /** Zeichen der gesamten Eingabe (system + messages + tools), fuer die konservative Schaetzung */
  eingabe_zeichen: number;
  max_tokens: number;
  /** P22-T179: 'main' (Standard, Bestand P22-T8) oder 'agent' (Arbeitsagent/Koordinator mit Freigabe je Identitaet). */
  zugang?: 'main' | 'agent';
}
export interface ApiReservierung {
  reservierung_id: string;
  modell: string;
  /** P22-T183: Provider des Modells; der Transport waehlt danach Anthropic oder OpenRouter. */
  anbieter: ApiAnbieter;
  anbieter_modell: string;
  reserviert_usd: number;
  /** max_tokens nach Kappung an max_tokens_obergrenze */
  max_tokens: number;
  rest_usd_vorher: number;
  frist_bis: string;
}

/**
 * Atomar: Schalter, Budget, erlaubtes Modell, bekannter Preis, Restbudget. Wirft Fachfehler (funktion_aus, budget_fehlt,
 * modell_nicht_erlaubt, preis_unbekannt, budget_erschoepft) - es gibt keinen Ersatzweg.
 */
export async function reserviereApiAufruf(e: ApiReservierungEingabe): Promise<ApiReservierung> {
  const schalter = await leseApiSchalter();
  if (e.zugang === 'agent') {
    // P22-T179: fuer Nicht-Main gilt der globale Hauptschalter 'Funktion api' (nicht hauptagent) und api_agenten im Projekt.
    if (!schalter.api.aktiv) fehler('funktion_aus', { funktion: 'hauptagent_api', api: false });
    await pruefeApiAgentenSchalter(e.project);
  } else if (!schalter.aktiv) fehler('funktion_aus', { funktion: 'hauptagent_api', hauptagent: schalter.hauptagent.aktiv, api: schalter.api.aktiv });
  if (!Number.isInteger(e.max_tokens) || e.max_tokens < 1) fehler('max_tokens_ungueltig');
  const modelle = await leseApiModelle();
  const m = modelle.find(x => x.alias === e.modell);
  if (!m) fehler('modell_unbekannt', { modell: e.modell });
  if (!preisBekannt(m)) fehler('preis_unbekannt', { modell: e.modell });
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const b = (await c.query<BudgetZeile>(
      'SELECT grenze_usd, zeitraum, reset_tag, erlaubte_modelle, grund, gesetzt_von, gesetzt_am FROM api_agent_budget WHERE id = 1 FOR UPDATE')).rows[0];
    if (!b) fehler('budget_fehlt', { grund: 'Ohne API-Budget keine kostenpflichtigen Aufrufe' });
    if (!(b.erlaubte_modelle ?? []).includes(e.modell)) fehler('modell_nicht_erlaubt', { modell: e.modell, erlaubte_modelle: b.erlaubte_modelle ?? [] });
    const einst = await leseApiEinstellungen(c);
    const maxTokens = Math.min(e.max_tokens, einst.max_tokens_obergrenze.wert, m.output_limit ?? Number.MAX_SAFE_INTEGER);
    const eingabeTokens = Math.ceil(Math.max(0, e.eingabe_zeichen) / 3);
    const reserve = rund((eingabeTokens * m.eingabe * einst.cache_schreib_faktor.wert + maxTokens * m.ausgabe) / 1e6);
    await verfalleAbgelaufene(c);
    const beginn = apiZeitraumBeginn(b.zeitraum, b.reset_tag);
    // P22-T179: Freigabe dieses Agenten (Modell, eigene Grenze) unter derselben Sperre wie das globale Budget.
    if (e.zugang === 'agent') await pruefeAgentFreigabeTx(c, { identity_id: e.identity_id, modell: e.modell, reserve_usd: reserve, beginn });
    const v = await verbrauchImZeitraum(c, beginn);
    const grenze = Number(b.grenze_usd);
    const verbraucht = rund(v.gebucht + v.offen + v.verfallen);
    if (verbraucht + reserve > grenze) {
      fehler('budget_erschoepft', { grenze_usd: grenze, verbraucht_usd: verbraucht, benoetigt_usd: reserve, rest_usd: Math.max(0, rund(grenze - verbraucht)), beginn, zeitraum: b.zeitraum });
    }
    const id = randomUUID();
    const frist = await c.query<{ frist_bis: Date }>(
      `INSERT INTO api_agent_reservierungen (id, identity_id, project, modell, anbieter_modell, reserviert_usd, status, frist_bis)
       VALUES ($1,$2,$3,$4,$5,$6,'offen', NOW() + make_interval(mins => $7::int)) RETURNING frist_bis`,
      [id, e.identity_id, e.project, e.modell, m.anbieter_modell, reserve, einst.reservierung_minuten.wert]);
    await c.query('COMMIT');
    return { reservierung_id: id, modell: e.modell, anbieter: m.anbieter, anbieter_modell: m.anbieter_modell, reserviert_usd: reserve, max_tokens: maxTokens,
      rest_usd_vorher: Math.max(0, rund(grenze - verbraucht)), frist_bis: frist.rows[0].frist_bis.toISOString() };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** P22-T183: vom Anbieter gemeldete Kosten in USD (OpenRouter usage.cost). Vorrang vor der Rechnung aus Registry-Preisen. */
  kosten_usd?: number | null;
}
export interface ApiAbschlussEingabe {
  reservierung_id: string;
  agent_id: string;
  /** usage der Anbieter-Antwort; null = Antwort ohne usage (dann volle Reservierung) */
  usage: ApiUsage | null;
  /** true NUR wenn der Anbieter nachweislich nichts berechnet hat (HTTP-Fehler vor jeder Antwort) */
  nichts_berechnet?: boolean;
  stop_reason?: string | null;
  fehler?: string | null;
}
export interface ApiAbschluss { usd: number; usd_quelle: 'antwort' | 'reservierung' | 'keine'; status: 'gebucht' | 'freigegeben' }

const tok = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : 0);

/** Kosten aus usage (USD): Eingabe, Cache-Schreiben (Faktor), Cache-Lesen (Cachepreis, sonst Eingabepreis), Ausgabe. */
export function apiKostenAusUsage(u: ApiUsage, p: { eingabe: number; ausgabe: number; cache_lesen: number | null }, cacheFaktor: number): number {
  return rund((tok(u.input_tokens) * p.eingabe + tok(u.cache_creation_input_tokens) * p.eingabe * cacheFaktor
    + tok(u.cache_read_input_tokens) * (p.cache_lesen ?? p.eingabe) + tok(u.output_tokens) * p.ausgabe) / 1e6);
}

/** Schliesst eine Reservierung ab und bucht in agent_verbrauch (T7) - beides in EINER Transaktion. Idempotent je Reservierung. */
export async function schliesseApiAufrufAb(e: ApiAbschlussEingabe): Promise<ApiAbschluss> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = (await c.query<{ id: string; identity_id: string | null; project: string | null; modell: string; anbieter_modell: string; reserviert_usd: string; status: string; usd: string | null; usd_quelle: string | null }>(
      'SELECT id, identity_id, project, modell, anbieter_modell, reserviert_usd, status, usd, usd_quelle FROM api_agent_reservierungen WHERE id = $1 FOR UPDATE', [e.reservierung_id])).rows[0];
    if (!r) fehler('reservierung_unbekannt');
    if (r.status !== 'offen' && r.status !== 'verfallen') {
      await c.query('COMMIT');
      return { usd: zahl(r.usd), usd_quelle: (r.usd_quelle ?? 'keine') as ApiAbschluss['usd_quelle'], status: r.status === 'freigegeben' ? 'freigegeben' : 'gebucht' };
    }
    if (e.nichts_berechnet && !e.usage) {
      await c.query(`UPDATE api_agent_reservierungen SET status='freigegeben', usd=0, usd_quelle='keine', abgeschlossen_am=NOW(), fehler=$2 WHERE id=$1`,
        [r.id, e.fehler ? e.fehler.slice(0, 500) : null]);
      await c.query('COMMIT');
      return { usd: 0, usd_quelle: 'keine', status: 'freigegeben' };
    }
    const modell = (await leseApiModelle()).find(x => x.alias === r.modell);
    const einst = await leseApiEinstellungen(c);
    let usd: number;
    let quelle: 'antwort' | 'reservierung';
    const gemeldet = e.usage?.kosten_usd;
    if (e.usage && typeof gemeldet === 'number' && Number.isFinite(gemeldet) && gemeldet >= 0) {
      // P22-T183: Kosten laut Anbieter (OpenRouter usage.cost) - Quelle 'antwort' wie bei Jev (CHECK der Tabellen unveraendert).
      usd = rund(gemeldet);
      quelle = 'antwort';
    } else if (e.usage && preisBekannt(modell)) {
      usd = apiKostenAusUsage(e.usage, modell, einst.cache_schreib_faktor.wert);
      quelle = 'antwort';
    } else {
      usd = Number(r.reserviert_usd);
      quelle = 'reservierung';
    }
    const u = e.usage ?? {};
    await c.query(
      `UPDATE api_agent_reservierungen SET status='gebucht', usd=$2, usd_quelle=$3, input_tokens=$4, output_tokens=$5, cache_creation_tokens=$6,
              cache_read_tokens=$7, stop_reason=$8, fehler=$9, abgeschlossen_am=NOW() WHERE id=$1`,
      [r.id, usd, quelle, tok(u.input_tokens), tok(u.output_tokens), tok(u.cache_creation_input_tokens), tok(u.cache_read_input_tokens),
        e.stop_reason ? String(e.stop_reason).slice(0, 64) : null, e.fehler ? e.fehler.slice(0, 500) : null]);
    await bucheAgentVerbrauch({
      project: r.project ?? HAUPTAGENT_PROJEKT, identity_id: r.identity_id, agent_id: e.agent_id,
      runtime: modell?.anbieter === API_ANBIETER_OPENROUTER ? 'openrouter-api' : 'claude-api', zugang: 'api',
      modell: r.anbieter_modell, input_tokens: tok(u.input_tokens), output_tokens: tok(u.output_tokens),
      cache_read_tokens: tok(u.cache_read_input_tokens), cache_creation_tokens: tok(u.cache_creation_input_tokens),
      usd, usd_quelle: quelle, quelle: 'api_worker', referenz: 'api-reservierung:' + r.id,
    }, c);
    await c.query('COMMIT');
    return { usd, usd_quelle: quelle, status: 'gebucht' };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Kosten und Status
// ---------------------------------------------------------------------------------------------
export interface ApiKostenZeile { aufrufe: number; usd: number; input_tokens: number; output_tokens: number }

/** Kosten je Monat, Agent (Identitaet), Projekt und Modell aus den abgeschlossenen Reservierungen. Standard: letzte 365 Tage. */
export async function apiKostenUebersicht(o: { seit?: unknown; bis?: unknown } = {}): Promise<Record<string, unknown>> {
  const bis = typeof o.bis === 'string' && o.bis ? new Date(o.bis) : new Date(Date.now() + 60_000);
  const seit = typeof o.seit === 'string' && o.seit ? new Date(o.seit) : new Date(Date.now() - 365 * 86_400_000);
  if (Number.isNaN(bis.getTime()) || Number.isNaN(seit.getTime())) fehler('zeitpunkt_ungueltig', { grund: 'seit/bis muessen ISO-Zeitpunkte sein' });
  const SUMMEN = `count(*)::int AS aufrufe, COALESCE(sum(r.usd),0) AS usd, COALESCE(sum(r.input_tokens),0)::bigint AS input_tokens,
    COALESCE(sum(r.output_tokens),0)::bigint AS output_tokens`;
  const wo = `FROM api_agent_reservierungen r LEFT JOIN agent_identitaeten i ON i.id = r.identity_id
    WHERE r.status IN ('gebucht','verfallen') AND r.erstellt_am >= $1 AND r.erstellt_am < $2`;
  const q = async (sql: string) => (await getPool().query(sql, [seit, bis])).rows as Array<Record<string, unknown>>;
  const alsZeile = (z: Record<string, unknown>): Record<string, unknown> => ({ ...z, aufrufe: Number(z.aufrufe), usd: rund(zahl(z.usd)),
    input_tokens: Number(z.input_tokens), output_tokens: Number(z.output_tokens) });
  const [gesamt, monat, agent, projekt, modell] = await Promise.all([
    q(`SELECT ${SUMMEN} ${wo}`),
    q(`SELECT to_char(date_trunc('month', r.erstellt_am), 'YYYY-MM') AS monat, ${SUMMEN} ${wo} GROUP BY 1 ORDER BY 1 DESC`),
    q(`SELECT r.identity_id, i.agent_id, ${SUMMEN} ${wo} GROUP BY 1, 2 ORDER BY 4 DESC`),
    q(`SELECT r.project, ${SUMMEN} ${wo} GROUP BY 1 ORDER BY 3 DESC`),
    q(`SELECT r.modell, ${SUMMEN} ${wo} GROUP BY 1 ORDER BY 3 DESC`),
  ]);
  return {
    seit: seit.toISOString(), bis: bis.toISOString(),
    gesamt: alsZeile(gesamt[0] ?? { aufrufe: 0, usd: 0, input_tokens: 0, output_tokens: 0 }),
    je_monat: monat.map(alsZeile), je_agent: agent.map(alsZeile), je_projekt: projekt.map(alsZeile), je_modell: modell.map(alsZeile),
    hinweis: 'USD aus usage der Anbieter-Antwort x Preis der model_registry; ohne usage oder verfallen = volle Reservierung. Kalendermonate in Server-Zeit.',
  };
}

/** Sicht fuer den Worker (eigener Ausweis): Schalter, Restbudget, erlaubte Modelle, Grenzen. Kein Key, keine fremden Daten. */
export async function apiRahmenFuerAgent(): Promise<Record<string, unknown>> {
  const [schalter, budget, einst] = await Promise.all([leseApiSchalter(), leseApiBudget(), leseApiEinstellungen()]);
  return {
    aktiv: schalter.aktiv, budget_gesetzt: budget.gesetzt, rest_usd: budget.rest_usd, zeitraum: budget.zeitraum, erschoepft: budget.erschoepft,
    erlaubte_modelle: budget.erlaubte_modelle,
    grenzen: { toolrunden_max: einst.toolrunden_max.wert, laufzeit_minuten: einst.laufzeit_minuten.wert, max_tokens_obergrenze: einst.max_tokens_obergrenze.wert },
  };
}

export async function apiAgentStatus(): Promise<Record<string, unknown>> {
  const [schalter, budget, einstellungen, modelle, api_key, agenten] = await Promise.all([leseApiSchalter(), leseApiBudget(), leseApiEinstellungen(), leseApiModelle(),
    leseApiKeyStand(), apiAgentenStand().catch((e: unknown) => ({ fehler: (e as { code?: string })?.code ?? 'nicht_lesbar' }))]);
  return {
    // P22-T179: agenten = Schalter api_agenten + Freigaben je Arbeitsagent/Koordinator mit Verbrauch im Zeitraum.
    schalter, budget, einstellungen, modelle, agenten,
    // Nur ja/nein (P22-T176: wirksamer Key, Web-UI vor Env) und der Stand ohne Wert: der Key selbst verlaesst den Transport nie.
    api_key_vorhanden: api_key.vorhanden, api_key,
  };
}

// ---------------------------------------------------------------------------------------------
// Rechte (Lesen: User + Hauptagent selbst)
// ---------------------------------------------------------------------------------------------
async function pruefeLeser(akteur: AusweisAkteur | null): Promise<void> {
  if (akteur?.art === 'user') return;
  if (akteur?.art === 'identitaet' && akteur.principal.project === HAUPTAGENT_PROJEKT && akteur.principal.rolle === 'main') {
    const r = await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",
      [akteur.principal.identity_id, HAUPTAGENT_PROJEKT]);
    if (r.rows[0]) return;
  }
  fehler('recht_fehlt');
}

// ---------------------------------------------------------------------------------------------
// admin-Aktionen (MCP admin, stdio und REST) - Akteur nur aus Transport/Tokenpruefung
// ---------------------------------------------------------------------------------------------
// P22-T179: api_freigabe (Freigabe je Arbeitsagent/Koordinator; setzen/entfernen nur User oder Main mit user_auftrag).
// P22-T183 B6: api_lauf (Laeufe IM API-Prozess: Stand, Steuerung, Einstellwerte, OpenRouter-Preisabgleich).
export const API_AGENT_ADMIN_ACTIONS = ['api_status', 'api_schalter', 'api_budget', 'api_einstellungen', 'api_kosten', 'api_freigabe', 'api_lauf'] as const;
export type ApiAgentAdminAction = typeof API_AGENT_ADMIN_ACTIONS[number];
/** Nur NEUE Parameternamen; aktiv, grund, modus, grenze_usd, reset_tag, seit, bis bestehen schon am admin-Tool. */
export const API_AGENT_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  api_zeitraum: { type: 'string', enum: [...API_ZEITRAEUME], description: 'api_budget setzen: Zeitraum der Grenze tag|woche|monat (Standard monat, ab reset_tag)' },
  erlaubte_modelle: { type: 'array', items: { type: 'string' }, description: 'api_budget setzen: erlaubte API-Modelle (Aliase aus model_registry, provider anthropic-api); api_freigabe setzen: API-Modelle dieses Agenten' },
  api_heartbeat: { type: 'boolean', description: 'api_freigabe setzen: Heartbeat des API-Agenten (Standard false - jeder Weckruf kostet)' },
  api_einstellungen: { type: 'object', additionalProperties: true, description: 'api_einstellungen setzen: {max_tokens_obergrenze, reservierung_minuten, toolrunden_max, laufzeit_minuten, cache_schreib_faktor}' },
  einstellung_namen: { type: 'array', items: { type: 'string', enum: [...API_EINSTELLUNG_NAMEN] }, description: 'api_einstellungen entfernen: Namen (Rueckfall Code-Standard)' },
  api_lauf_werte: { type: 'object', additionalProperties: true, description: `api_lauf einstellungen (nur User): {${API_LAUF_EINSTELLUNG_NAMEN.join(', ')}}` },
};

export function istApiAgentAdminAction(action: unknown): action is ApiAgentAdminAction {
  return typeof action === 'string' && (API_AGENT_ADMIN_ACTIONS as readonly string[]).includes(action);
}

const CODE = /^[a-z][a-z0-9_]{2,80}$/;

export async function fuehreApiAgentAdminAus(
  action: ApiAgentAdminAction, args: Record<string, unknown>, akteurOpt?: W1bAkteur | null,
): Promise<Record<string, unknown>> {
  const akteur: AusweisAkteur | null = akteurOpt !== undefined ? akteurOpt : aktuellerW1bAkteur();
  const modus = typeof args.modus === 'string' && args.modus.trim() ? args.modus.trim() : 'status';
  try {
    switch (action) {
      case 'api_status':
        await pruefeLeser(akteur);
        return { success: true, action, ...(await apiAgentStatus()) };
      case 'api_schalter':
        if (modus === 'status') { await pruefeLeser(akteur); return { success: true, action, schalter: await leseApiSchalter() }; }
        if (modus !== 'setzen') fehler('modus_ungueltig', { erlaubt: ['status', 'setzen'] });
        return { success: true, action, schalter: await setzeApiSchalter(akteur, { aktiv: args.aktiv, grund: args.grund }) };
      case 'api_budget':
        if (modus === 'status') { await pruefeLeser(akteur); return { success: true, action, budget: await leseApiBudget() }; }
        if (modus === 'setzen') {
          return { success: true, action, budget: await setzeApiBudget(akteur, { grenze_usd: args.grenze_usd, zeitraum: args.api_zeitraum,
            reset_tag: args.reset_tag, erlaubte_modelle: args.erlaubte_modelle, grund: args.grund }) };
        }
        if (modus === 'entfernen') return { success: true, action, budget: await entferneApiBudget(akteur, { grund: args.grund }) };
        return fehler('modus_ungueltig', { erlaubt: ['status', 'setzen', 'entfernen'] });
      case 'api_einstellungen':
        if (modus === 'status') { await pruefeLeser(akteur); return { success: true, action, einstellungen: await leseApiEinstellungen() }; }
        if (modus === 'setzen') return { success: true, action, einstellungen: await setzeApiEinstellungen(akteur, { werte: args.api_einstellungen, grund: args.grund }) };
        if (modus === 'entfernen') return { success: true, action, einstellungen: await setzeApiEinstellungen(akteur, { entfernen: args.einstellung_namen, grund: args.grund }) };
        return fehler('modus_ungueltig', { erlaubt: ['status', 'setzen', 'entfernen'] });
      case 'api_kosten':
        await pruefeLeser(akteur);
        return { success: true, action, ...(await apiKostenUebersicht({ seit: args.seit, bis: args.bis })) };
      case 'api_freigabe': {
        // P22-T179: ziel_identity_id, erlaubte_modelle, grenze_usd, api_heartbeat, aktiv, grund, user_auftrag (Main: Pflicht).
        if (modus === 'status') {
          await pruefeApiFreigabeLeser(akteur);
          return { success: true, action, ...(await apiAgentenStand(typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null)) };
        }
        if (modus === 'setzen') {
          return { success: true, action, freigabe: await setzeApiFreigabe(akteur, { identity_id: args.ziel_identity_id, aktiv: args.aktiv,
            modelle: args.erlaubte_modelle, grenze_usd: args.grenze_usd, heartbeat: args.api_heartbeat, grund: args.grund, user_auftrag: args.user_auftrag }) };
        }
        if (modus === 'entfernen') {
          return { success: true, action, ...(await entferneApiFreigabe(akteur, { identity_id: args.ziel_identity_id, grund: args.grund, user_auftrag: args.user_auftrag })) };
        }
        return fehler('modus_ungueltig', { erlaubt: ['status', 'setzen', 'entfernen'] });
      }
      case 'api_lauf': {
        // P22-T183 B6: modus status | pausieren | fortsetzen | stoppen | neustart (ziel_identity_id, grund) | einstellungen (api_lauf_werte,
        // grund; nur User) | preise (OpenRouter-Preisabgleich aus dem Katalog, nur User).
        const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
        // Ohne Ausweis: Legacy-Koordinator wie bei den Verwaltungsaktionen (Rolle aus dem Namen, pruefeProfilVerwalter im Projekt).
        const legacy = !akteur && typeof args.agent_id === 'string' && rolleFuerAgent(args.agent_id.trim()).rolle === 'koordinator'
          ? { art: 'legacy_koordinator' as const, agent_id: args.agent_id.trim() } : null;
        const laufAkteur: AusweisAkteur | null = akteur ?? legacy;
        if (modus === 'status') return { success: true, action, ...(await apiLaeufeStand(laufAkteur, project)) };
        if ((API_LAUF_STEUERUNG as readonly string[]).includes(modus)) {
          return { success: true, action, ...(await steuereApiLauf(laufAkteur, { identity_id: args.ziel_identity_id, aktion: modus, grund: args.grund })) };
        }
        if (modus === 'einstellungen') return { success: true, action, einstellungen: await setzeApiLaufEinstellungen(akteur, { werte: args.api_lauf_werte, grund: args.grund }) };
        if (modus === 'preise') {
          if (akteur?.art !== 'user') fehler('recht_fehlt', { grund: 'Preisabgleich loest nur der User aus' });
          const { aktualisiereOpenRouterPreise } = await import('./api-anbieter-preise.js');
          return { success: true, action, preise: await aktualisiereOpenRouterPreise() };
        }
        return fehler('modus_ungueltig', { erlaubt: ['status', ...API_LAUF_STEUERUNG, 'einstellungen', 'preise'] });
      }
    }
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === 'string' && CODE.test(code)) {
      const d = (e as { details?: unknown }).details;
      return { success: false, action, error: code, ...(d && typeof d === 'object' ? { details: d } : {}) };
    }
    return { success: false, action, error: 'api_agent_fehler' };
  }
  return { success: false, action, error: 'aktion_unbekannt' };
}
