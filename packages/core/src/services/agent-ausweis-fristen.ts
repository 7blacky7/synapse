/**
 * P22-T45 (User 19.10.2026 'alles einstellbar, nie Hardcode', memory regel-neue-funktionen-mit-schalter-und-debug Punkt 7,
 * Entscheidung c4ba1673 Punkt 6, Konzept cde685a9 Punkt 7): Fristen des Agenten-Ausweises als EINSTELLUNG.
 *
 * WERTE (Code-Wert = nur Standard, entspricht dem Verhalten vor P22-T45):
 *   schatten_stunden     Schattenprofil Weg A: Frist bis zur Bestaetigung (Standard 24 h)
 *   erstnutzung_minuten  vorbereiteter Ausweis Weg B / Daemon-Start: Frist bis zur ersten Nutzung (Standard 10 min)
 *   visum_minuten        Visum (P22-T44): automatisches Visum eines Agenten aus einem anderen Projekt, Frist des besuchten Projekts (Standard 30 min)
 *   arbeitsfreigabe_stunden  Arbeitsfreigabe (P22-T44): Freigabe durch Koordinator/User des besuchten Projekts (Standard 24 h)
 *   anmeldung_plaene_minuten  chat(anmelden) (P22-T50): Zeitfenster fuer EIGENE offene files-Plaene der Identitaet in der
 *                        Anmeldeantwort (Standard 30 min); aeltere/fremde/beendete Plaene erscheinen nicht
 *   files_plan_stunden   files-Plaene (P6-T49, User 19.10.2026 'nach 2 Tagen auf jeden Fall abgeschlossen'): offener Plan
 *                        ohne Aktivitaet laenger als diese Frist wird vom REST-Worker files_plan_ablauf abgeschlossen
 *                        (Status expired, nichts geschrieben; Standard 48 h). Laufende Plaene messen gegen den aktuellen Wert.
 *   shell_hinweis_minuten  shell_activity (P23-T3, User 20.10.2026): beendete Shell-Jobs ALLER Agenten werden bis so viele
 *                        Minuten nach Abschluss als Fertig-Hinweis zugestellt, laufende immer (Standard 60; vorher fest 8).
 * QUELLE: PG-Tabelle agent_ausweis_fristen (Schema 117), je Wert projekt > global > Standard. KEINE Env (die fruehere
 *   Env-Variable fuer die Erstnutzung entfaellt). Lesefehler (z. B. vor Schema 117) -> Standard mit letzter_fehler.
 * EINE LESESTELLE: leseAusweisFristen (und die Kurzformen schattenFristMs/erstnutzungFristMs). Diese Datei importiert
 *   nur db/client und agent-profil-schalter (Puffer-TTL) und loest so den frueheren Importzyklus Vertrag/Identitaet.
 *   Kurz gepuffert je Prozess wie der Ausweis-Kern (SYNAPSE_W1B_GATE_TTL_MS, Standard 5 s); Schreiben leert den Puffer
 *   im schreibenden Prozess sofort.
 * WIRKUNG: Neue Werte gelten fuer neu beginnende Fristen (Schatten-Anlage, Ausweis-Ausstellung); laufende Fristen
 *   (ablauf_am / gueltig_bis) bleiben unveraendert.
 * RECHTE: prueft der Aufrufer (admin ausweis_fristen in agent-profil-admin.ts): Projekt- und globale Ebene User oder
 *   Koordinator (auch Legacy-Koordinator, Grundsatz 3a); Subagent/Spezialist/Daemon nie. Diese Datei schreibt nur und protokolliert gesetzt_von.
 */
import { getPool } from '../db/client.js';
import { kernTtlMs } from './agent-profil-schalter.js';

export const AUSWEIS_FRIST_NAMEN = ['schatten_stunden', 'erstnutzung_minuten', 'visum_minuten', 'arbeitsfreigabe_stunden', 'anmeldung_plaene_minuten', 'files_plan_stunden', 'shell_hinweis_minuten'] as const;
export type AusweisFristName = typeof AUSWEIS_FRIST_NAMEN[number];
export type AusweisFristQuelle = 'standard' | 'global' | 'projekt';
type Einheit = 'stunden' | 'minuten';

interface FristDefinition { standard: number; einheit: Einheit; min: number; max: number; wirkung: string }
/** Code-Standard und zulaessiger Bereich je Wert. Der Standard gilt nur, wenn weder Projekt- noch globaler Wert gesetzt ist. */
export const AUSWEIS_FRIST_DEFINITIONEN: Readonly<Record<AusweisFristName, FristDefinition>> = {
  schatten_stunden: { standard: 24, einheit: 'stunden', min: 1, max: 720,
    wirkung: 'Schattenprofil (Weg A): Frist bis zur Bestaetigung, danach erloschen' },
  erstnutzung_minuten: { standard: 10, einheit: 'minuten', min: 1, max: 1440,
    wirkung: 'Vorbereiteter Ausweis (Weg B, Daemon-Start): Frist bis zur ersten Nutzung, danach verfallen' },
  visum_minuten: { standard: 30, einheit: 'minuten', min: 1, max: 1440,
    wirkung: 'Visum (P22-T44): Agent mit Ausweis eines anderen Projekts darf hier lesen und Channels nutzen; nach Ablauf bei der naechsten Anfrage neu' },
  arbeitsfreigabe_stunden: { standard: 24, einheit: 'stunden', min: 1, max: 720,
    wirkung: 'Arbeitsfreigabe (P22-T44): vom Koordinator/User dieses Projekts erteilt, Agent darf hier arbeiten; danach wieder Visum' },
  anmeldung_plaene_minuten: { standard: 30, einheit: 'minuten', min: 1, max: 1440,
    wirkung: 'chat(anmelden) (P22-T50): eigene offene files-Plaene, die juenger als dieses Fenster sind, als eine Zeile in der Anmeldung' },
  files_plan_stunden: { standard: 48, einheit: 'stunden', min: 1, max: 720,
    wirkung: 'files-Plaene (P6-T49): offener Plan ohne Aktivitaet laenger als diese Frist wird automatisch abgeschlossen (Status expired, nichts geschrieben, Ops bleiben lesbar)' },
  shell_hinweis_minuten: { standard: 60, einheit: 'minuten', min: 1, max: 1440,
    wirkung: 'shell_activity (P23-T3): beendete Shell-Jobs aller Agenten erscheinen bis so viele Minuten nach Abschluss als Fertig-Hinweis (laufende immer); aeltere fallen weg' },
};
const EINHEIT_MS: Readonly<Record<Einheit, number>> = { stunden: 3_600_000, minuten: 60_000 };

export interface AusweisFristWert {
  name: AusweisFristName;
  /** wirksamer Wert in der Einheit */
  wert: number;
  einheit: Einheit;
  /** wirksamer Wert in Millisekunden */
  ms: number;
  quelle: AusweisFristQuelle;
  standard: number;
  global: number | null;
  projekt: number | null;
  bereich: { min: number; max: number };
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  wirkung: string;
}
export interface AusweisFristenStand {
  project: string | null;
  fristen: Record<AusweisFristName, AusweisFristWert>;
  letzter_fehler: string | null;
  hinweis: string;
}

/** Geheimnisfreier Fachfehler (code + optionale details); die admin-Fehlerantwort gibt beides weiter. */
export class AusweisFristenFehler extends Error {
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}

const HINWEIS = 'Rangfolge projekt > global > standard. Neue Werte gelten fuer neu beginnende Fristen; laufende Fristen bleiben unveraendert.';

interface Zeile { ebene: 'global' | 'projekt'; name: string; wert: number; grund: string | null; gesetzt_von: string; gesetzt_am: Date | string }

function baueStand(project: string | null, zeilen: Zeile[], fehler: string | null): AusweisFristenStand {
  const fristen = {} as Record<AusweisFristName, AusweisFristWert>;
  for (const name of AUSWEIS_FRIST_NAMEN) {
    const d = AUSWEIS_FRIST_DEFINITIONEN[name];
    const g = zeilen.find(z => z.name === name && z.ebene === 'global');
    const p = project === null ? undefined : zeilen.find(z => z.name === name && z.ebene === 'projekt');
    const w = p ?? g;
    const wert = w ? Number(w.wert) : d.standard;
    fristen[name] = {
      name, wert, einheit: d.einheit, ms: wert * EINHEIT_MS[d.einheit], quelle: p ? 'projekt' : g ? 'global' : 'standard',
      standard: d.standard, global: g ? Number(g.wert) : null, projekt: p ? Number(p.wert) : null, bereich: { min: d.min, max: d.max },
      gesetzt_von: w?.gesetzt_von ?? null, gesetzt_am: w ? new Date(w.gesetzt_am).toISOString() : null, grund: w?.grund ?? null,
      wirkung: d.wirkung,
    };
  }
  return { project, fristen, letzter_fehler: fehler, hinweis: HINWEIS };
}

const PUFFER = new Map<string, { bis: number; stand: AusweisFristenStand }>();
/** Puffer verwerfen (Tests; automatisch nach jedem Setzen im eigenen Prozess). */
export function leereAusweisFristenCache(): void { PUFFER.clear(); }

/**
 * EINE Lesestelle fuer alle Ausweis-Fristen. project null = nur global/Standard. frisch:true umgeht den Puffer
 * (Status-Antworten). Lesefehler -> Standardwerte mit letzter_fehler 'ausweis_fristen_nicht_lesbar' (nicht gepuffert).
 */
export async function leseAusweisFristen(project?: string | null, opt: { frisch?: boolean } = {}): Promise<AusweisFristenStand> {
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const ttl = opt.frisch ? 0 : kernTtlMs();
  const schluessel = p ?? '';
  const jetzt = Date.now();
  const c = ttl > 0 ? PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) return c.stand;
  try {
    const r = await getPool().query<Zeile>({
      text: `SELECT ebene, name, wert, grund, gesetzt_von, gesetzt_am FROM agent_ausweis_fristen
        WHERE ebene = 'global' OR (ebene = 'projekt' AND project = $1)`,
      values: [p],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const stand = baueStand(p, r.rows, null);
    if (ttl > 0) PUFFER.set(schluessel, { bis: jetzt + ttl, stand });
    return stand;
  } catch {
    return baueStand(p, [], 'ausweis_fristen_nicht_lesbar');
  }
}

/** Schattenfrist (Weg A) in ms fuer das Projekt; Lesestelle leseAusweisFristen. */
export async function schattenFristMs(project: string | null): Promise<number> {
  return (await leseAusweisFristen(project)).fristen.schatten_stunden.ms;
}
/** Erstnutzungsfrist (Weg B, Daemon-Start) in ms fuer das Projekt; Lesestelle leseAusweisFristen. */
export async function erstnutzungFristMs(project: string | null): Promise<number> {
  return (await leseAusweisFristen(project)).fristen.erstnutzung_minuten.ms;
}
/** P6-T49: Ablauffrist offener files-Plaene (ohne Aktivitaet) in ms fuer das Projekt; Lesestelle leseAusweisFristen. */
export async function filesPlanFristMs(project: string | null): Promise<number> {
  return (await leseAusweisFristen(project)).fristen.files_plan_stunden.ms;
}

/**
 * Setzt (werte) und/oder entfernt (entfernen: Namen) Fristen auf EINER Ebene in einer Transaktion. Entfernen laesst den
 * Wert auf die naechste Ebene zurueckfallen. Rechte prueft der Aufrufer; wer/setter_identity_id landen in der Zeile.
 */
export async function setzeAusweisFristen(
  e: { ebene: unknown; project?: string | null; werte?: Partial<Record<AusweisFristName, unknown>>; entfernen?: unknown; grund: unknown },
  wer: { wer: string; setter_identity_id: string | null },
): Promise<AusweisFristenStand> {
  if (e.ebene !== 'global' && e.ebene !== 'projekt') throw new AusweisFristenFehler('ebene_ungueltig');
  const project = e.ebene === 'projekt' ? (typeof e.project === 'string' ? e.project.trim() : '') : null;
  if (e.ebene === 'projekt' && !project) throw new AusweisFristenFehler('project_fehlt');
  const grund = typeof e.grund === 'string' ? e.grund.trim() : '';
  if (grund.length < 5 || grund.length > 1000) throw new AusweisFristenFehler('grund_fehlt');
  const setzen: Array<[AusweisFristName, number]> = [];
  for (const name of AUSWEIS_FRIST_NAMEN) {
    const v = e.werte?.[name];
    if (v === undefined || v === null) continue;
    const d = AUSWEIS_FRIST_DEFINITIONEN[name];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < d.min || v > d.max) {
      throw new AusweisFristenFehler('frist_ungueltig', { name, min: d.min, max: d.max, einheit: d.einheit });
    }
    setzen.push([name, v]);
  }
  let entfernen: AusweisFristName[] = [];
  if (e.entfernen !== undefined && e.entfernen !== null) {
    if (!Array.isArray(e.entfernen) || e.entfernen.some(x => !(AUSWEIS_FRIST_NAMEN as readonly unknown[]).includes(x))) {
      throw new AusweisFristenFehler('frist_name_ungueltig', { erlaubt: [...AUSWEIS_FRIST_NAMEN] });
    }
    entfernen = [...new Set(e.entfernen as AusweisFristName[])];
  }
  if (!setzen.length && !entfernen.length) throw new AusweisFristenFehler('fristen_fehlen', { erlaubt: [...AUSWEIS_FRIST_NAMEN] });
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    if (entfernen.length) {
      await c.query(`DELETE FROM agent_ausweis_fristen WHERE ebene = $1 AND COALESCE(project, '') = COALESCE($2, '') AND name = ANY($3::text[])`,
        [e.ebene, project, entfernen]);
    }
    for (const [name, wert] of setzen) {
      await c.query(
        `INSERT INTO agent_ausweis_fristen (ebene, project, name, wert, grund, gesetzt_von, setter_identity_id, gesetzt_am)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (ebene, (COALESCE(project, '')), name) DO UPDATE SET wert=EXCLUDED.wert, grund=EXCLUDED.grund,
           gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=EXCLUDED.setter_identity_id, gesetzt_am=EXCLUDED.gesetzt_am`,
        [e.ebene, project, name, wert, grund, wer.wer, wer.setter_identity_id]);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    // DB-Fehler nicht weiterreichen (koennen Werte enthalten).
    throw new AusweisFristenFehler('ausweis_fristen_speicher_fehler');
  } finally { c.release(); }
  leereAusweisFristenCache();
  return leseAusweisFristen(project, { frisch: true });
}
