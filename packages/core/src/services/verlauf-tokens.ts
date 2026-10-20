/**
 * P22-T63 Stufe 2 B (Nachtrag 823715c5): eigene Token-Zaehlung aus dem vollstaendigen Verlauf des Hauptagenten. Die CLI-usage
 * ist Abgleich und Kontrolle, nicht die einzige Quelle.
 *
 * VERFAHREN je Modellfamilie (Kennzeichnung in tokens.berechnet.verfahren):
 *   openai (Codex, gpt-*):   Tokenizer o200k_base (Paket gpt-tokenizer, lokal)         -> 'o200k_exakt'
 *   anthropic (Claude):      kein oeffentlicher Tokenizer. Zeichen / Faktor; der Faktor wird je Familie aus der gemessenen
 *                            Ausgabe der CLI kalibriert (Zeichen der Ausgabe / output_tokens, gleitender Mittelwert in
 *                            hauptagent_verlauf_stand.kalibrierung), Startwert ANTHROPIC_START_FAKTOR -> 'zeichen_kalibriert'
 *   sonstige / Tokenizer fehlt: Zeichen / 4                                                       -> 'zeichen_4'
 * KONTEXT eines Laufs = Grundlast + Summe tokens.berechnet.gesamt aller zaehlenden Eintraege mit dieser lauf_id. Die Grundlast
 *   (Systemprompt, Werkzeugliste, CLI-Eigenanteil) kalibriert der erste gemessene Zug des Laufs: gemessen - Summe.
 * KORRIDOR: max(gemessen, berechnet) (der sichere Wert). Abweichung ueber ABWEICHUNG_BEFUND_PROZENT wird als Befund sichtbar.
 *
 * SCHALTER 'verlauf_token_zaehlung' (Produkt-Schalter I im Katalog PROFIL_PRODUKT_FUNKTIONEN, Standard AUS, nur ausdruecklich):
 *   wirksam = intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (ebene global) > AUS. AUS = Stufe 1:
 *   nur gemessene Werte, keine berechnete Buchung.
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';

export const VERLAUF_TOKEN_FUNKTION = 'verlauf_token_zaehlung' as const;
export const ANTHROPIC_START_FAKTOR = 3.5;
export const ZEICHEN_JE_TOKEN_SONST = 4;
export const ABWEICHUNG_BEFUND_PROZENT = 15;
/** Gewicht eines neuen Messwerts im gleitenden Mittel des Kalibrierfaktors. */
const KALIBRIER_GEWICHT = 0.2;
/** Unter so vielen gemessenen Ausgabe-Tokens ist ein Zug als Kalibrier-Messung zu ungenau. */
const KALIBRIER_MIN_TOKENS = 200;

type Q = QueryConfig & { query_timeout: number };
export type ModellFamilie = 'openai' | 'anthropic' | 'sonstige';
export type ZaehlVerfahren = 'o200k_exakt' | 'zeichen_kalibriert' | 'zeichen_4';

export interface TokenZaehlSchalter { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; bis: string | null; letzter_fehler: string | null }

/** Schalter der Stufe 2 (alle Standard AUS, nur ausdruecklich): eine Lesestelle fuer alle. */
export const VERLAUF_STUFE2_FUNKTIONEN = ['verlauf_token_zaehlung', 'verlauf_alle_richtungen', 'main_korridor', 'verlauf_uebergabe'] as const;
export type VerlaufStufe2Funktion = typeof VERLAUF_STUFE2_FUNKTIONEN[number];

/** Frisch je Aufruf. Standard AUS; Lesefehler -> AUS mit letzter_fehler. */
export async function leseTokenZaehlSchalter(): Promise<TokenZaehlSchalter> {
  return leseVerlaufStufe2Schalter(VERLAUF_TOKEN_FUNKTION);
}

/** intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (ebene global) > AUS. */
export async function leseVerlaufStufe2Schalter(funktion: VerlaufStufe2Funktion): Promise<TokenZaehlSchalter> {
  const basis: TokenZaehlSchalter = { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  const { internToolAktiv } = await import('./intern-tool.js');
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [funktion], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  const p = await leseProfilProduktSchalter(funktion, null);
  if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', letzter_fehler: letzter };
  return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
}

/** Modellfamilie aus Runtime und Modell (Codex-Runtime bzw. codex/gpt-Modelle = openai; Claude-Aliase = anthropic). */
export function modellFamilie(runtime: string | null | undefined, modell: string | null | undefined): ModellFamilie {
  const m = (modell ?? '').toLowerCase();
  if (runtime === 'codex' || /^(codex|gpt|o\d)/.test(m)) return 'openai';
  if (runtime === 'claude' || /(claude|opus|sonnet|haiku|fable)/.test(m)) return 'anthropic';
  return 'sonstige';
}

type ZaehlFn = (text: string) => number;
let o200k: ZaehlFn | null | undefined;
/** Tokenizer einmal laden; fehlt das Paket, faellt die Zaehlung sichtbar auf 'zeichen_4' zurueck. */
async function ladeO200k(): Promise<ZaehlFn | null> {
  if (o200k !== undefined) return o200k;
  try {
    const m = await import('gpt-tokenizer/encoding/o200k_base') as { countTokens: ZaehlFn };
    o200k = (text: string) => m.countTokens(text);
  } catch {
    o200k = null;
  }
  return o200k;
}

export interface TokenZaehlung { tokens: number; verfahren: ZaehlVerfahren; familie: ModellFamilie; faktor: number | null; zeichen: number }

/** Zaehlt einen Text fuer eine Modellfamilie. faktor = Kalibrierfaktor (Zeichen je Token) fuer anthropic. */
export async function zaehleTokens(text: string, familie: ModellFamilie, faktor?: number | null): Promise<TokenZaehlung> {
  const zeichen = text.length;
  if (!zeichen) return { tokens: 0, verfahren: familie === 'openai' ? 'o200k_exakt' : familie === 'anthropic' ? 'zeichen_kalibriert' : 'zeichen_4', familie, faktor: null, zeichen };
  if (familie === 'openai') {
    const z = await ladeO200k();
    if (z) return { tokens: z(text), verfahren: 'o200k_exakt', familie, faktor: null, zeichen };
  }
  if (familie === 'anthropic') {
    const f = faktor && faktor > 0 ? faktor : ANTHROPIC_START_FAKTOR;
    return { tokens: Math.ceil(zeichen / f), verfahren: 'zeichen_kalibriert', familie, faktor: f, zeichen };
  }
  return { tokens: Math.ceil(zeichen / ZEICHEN_JE_TOKEN_SONST), verfahren: 'zeichen_4', familie, faktor: null, zeichen };
}

/** Zaehltext eines Eintrags: Inhalt plus vollstaendige Werkzeug-Ein-/Ausgaben (Kontext); Denkphasen zaehlen nicht zum Kontext. */
export function zaehltextEintrag(e: { text: string; werkzeuge?: { calls?: Array<{ name?: string; input?: unknown; output?: unknown }> } | null }): string {
  const teile = [e.text ?? ''];
  for (const c of e.werkzeuge?.calls ?? []) {
    teile.push(c.name ?? '');
    if (c.input !== undefined) teile.push(typeof c.input === 'string' ? c.input : JSON.stringify(c.input));
    if (c.output !== undefined && c.output !== null) teile.push(typeof c.output === 'string' ? c.output : JSON.stringify(c.output));
  }
  return teile.filter(Boolean).join('\n');
}

/** Text, den das Modell als Ausgabe erzeugt hat (fuer die Kalibrierung gegen output_tokens). */
export function ausgabetextEintrag(e: { text: string; werkzeuge?: { calls?: Array<{ name?: string; input?: unknown }> } | null; meta?: Record<string, unknown> }): string {
  const teile = [e.text ?? ''];
  for (const c of e.werkzeuge?.calls ?? []) if (c.input !== undefined) teile.push((c.name ?? '') + (typeof c.input === 'string' ? c.input : JSON.stringify(c.input)));
  const denk = Array.isArray(e.meta?.denkphasen) ? (e.meta!.denkphasen as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return [...teile, ...denk].filter(Boolean).join('\n');
}

export interface Kalibrierung { faktor: number; messungen: number; aktualisiert_am: string }

export async function leseKalibrierung(identity_id: string, familie: ModellFamilie): Promise<Kalibrierung | null> {
  const r = await getPool().query<{ k: Kalibrierung | null }>(
    `SELECT kalibrierung -> $2 AS k FROM hauptagent_verlauf_stand WHERE identity_id = $1`, [identity_id, familie]);
  return r.rows[0]?.k ?? null;
}

/** Neuer Messwert (Zeichen der Ausgabe / gemessene output_tokens) ins gleitende Mittel; nur anthropic, nur ausreichend grosse Zuege. */
export async function kalibriere(identity_id: string, familie: ModellFamilie, zeichen: number, outputTokens: number): Promise<Kalibrierung | null> {
  if (familie !== 'anthropic' || outputTokens < KALIBRIER_MIN_TOKENS || zeichen <= 0) return null;
  const messung = zeichen / outputTokens;
  const alt = await leseKalibrierung(identity_id, familie);
  const faktor = alt ? alt.faktor * (1 - KALIBRIER_GEWICHT) + messung * KALIBRIER_GEWICHT : messung;
  const neu: Kalibrierung = { faktor: Math.round(faktor * 1000) / 1000, messungen: (alt?.messungen ?? 0) + 1, aktualisiert_am: new Date().toISOString() };
  await getPool().query(
    `INSERT INTO hauptagent_verlauf_stand (identity_id, kalibrierung) VALUES ($1, jsonb_build_object($2::text, $3::jsonb))
     ON CONFLICT (identity_id) DO UPDATE SET kalibrierung = hauptagent_verlauf_stand.kalibrierung || jsonb_build_object($2::text, $3::jsonb)`,
    [identity_id, familie, JSON.stringify(neu)]);
  return neu;
}

/** Summe der berechneten Tokens eines Laufs (zaehlende Eintraege) und die kalibrierte Grundlast des Laufs. */
export async function laufSumme(identity_id: string, lauf_id: string): Promise<{ summe: number; grundlast: number | null }> {
  const r = await getPool().query<{ summe: string; grundlast: string | null }>(
    `SELECT COALESCE(SUM((tokens->'berechnet'->>'tokens')::bigint) FILTER (WHERE zaehlt), 0)::text AS summe,
            (SELECT kalibrierung -> 'grundlast' ->> $2 FROM hauptagent_verlauf_stand WHERE identity_id = $1) AS grundlast
       FROM hauptagent_verlauf WHERE identity_id = $1 AND lauf_id = $2`, [identity_id, lauf_id]);
  const z = r.rows[0];
  return { summe: Number(z?.summe ?? 0), grundlast: z?.grundlast != null ? Number(z.grundlast) : null };
}

/** Grundlast eines Laufs aus dem ersten gemessenen Zug festhalten (gemessen - Summe der berechneten Eintraege). */
export async function setzeGrundlast(identity_id: string, lauf_id: string, grundlast: number): Promise<void> {
  await getPool().query(
    `INSERT INTO hauptagent_verlauf_stand (identity_id, kalibrierung) VALUES ($1, jsonb_build_object('grundlast', jsonb_build_object($2::text, $3::bigint)))
     ON CONFLICT (identity_id) DO UPDATE SET kalibrierung = jsonb_set(hauptagent_verlauf_stand.kalibrierung, '{grundlast}',
       COALESCE(hauptagent_verlauf_stand.kalibrierung -> 'grundlast', '{}'::jsonb) || jsonb_build_object($2::text, $3::bigint))`,
    [identity_id, lauf_id, Math.max(0, Math.round(grundlast))]);
}
