/**
 * P22-T199 (Freigabe bf31526a, Zusatz Koordinator; memory regel-neue-funktionen-mit-schalter-und-debug Punkt 7):
 * Werte der automatischen Plan-Pruefung (kleine Pruefung je Plan/Op, plan-befunde.ts) als EINSTELLUNG in PG.
 *
 * WERTE (Code-Wert = nur Standard, entspricht dem Verhalten vorher):
 *   aktiv       Pruefung und commit-Sperre der Plaene an/aus (Notaus; vorher nur Env FEHLERPRUEFUNG_PLAN, '0' = aus). Standard an.
 *   typen_ms    Zeitbudget der Typstufe je Pruefung in ms (vorher nur Env FEHLERPRUEFUNG_TYPEN_MS). Standard 5000.
 *   gueltig_ms  so lange wird eine gespeicherte Pruefung bei unveraendertem Endstand wiederverwendet (vorher nur Env
 *               FEHLERPRUEFUNG_GUELTIG_MS). Standard 60000.
 *   schatten_puffer_mb         P22-T201: Grenze des Schattenstand-Puffers je Prozess fuer Co-Edit ohne Gate in MB
 *                              (coedit-schatten-puffer.ts). 0 = Puffer aus (Notaus, Bewertung wie vorher). Standard 64. Kein Env.
 *   schatten_puffer_min_zeilen P22-T201: Puffer erst ab dieser Zeilenzahl der Basis (kleine Dateien baut der Schatten
 *                              schneller neu auf, als der Puffer kostet). Standard 2000. Kein Env.
 * QUELLE je Wert: build_pruefung_einstellungen (keine neue Tabelle), bereich 'plan_pruefung:projekt:<name>' > 'plan_pruefung'
 *   > Env (nur noch Rueckfall, gleiche Auswertung wie vorher) > Code-Standard. Die Antwort nennt die Quelle je Wert.
 * SETZEN: code_check(build_einstellungen, modus 'setzen', plan_pruefung_aktiv | plan_pruefung_typen_ms | plan_pruefung_gueltig_ms
 *   | plan_pruefung_schatten_puffer_mb | plan_pruefung_schatten_puffer_min_zeilen,
 *   project fuer die Projektebene), nur Koordinator/User (Rechtepruefung in build-pruefung.ts); zuruecksetzen 'plan_pruefung'.
 * EINE LESESTELLE: lesePlanPruefEinstellungen. Importiert nur db/client und agent-profil-schalter (Puffer-TTL), damit
 *   typen-pruefung.ts und file-batch.ts sie ohne Importzyklus nutzen. Kurz gepuffert je Prozess (kernTtlMs); Setzen leert
 *   den Puffer im schreibenden Prozess. Lesefehler -> Env/Standard mit letzter_fehler. Wirft nie.
 */
import { getPool } from '../db/client.js';
import { kernTtlMs } from './agent-profil-schalter.js';

export const PLAN_PRUEF_BEREICH = 'plan_pruefung';
export type PlanPruefQuelle = 'projekt' | 'global' | 'env' | 'standard';
export interface PlanPruefWert<T> { wert: T; quelle: PlanPruefQuelle }
export interface PlanPruefStand {
  project: string | null;
  aktiv: PlanPruefWert<boolean>;
  typen_ms: PlanPruefWert<number>;
  gueltig_ms: PlanPruefWert<number>;
  schatten_puffer_mb: PlanPruefWert<number>;
  schatten_puffer_min_zeilen: PlanPruefWert<number>;
  letzter_fehler: string | null;
}

/** Code-Standard und zulaessiger Bereich der Zahlenwerte (ms). */
export const PLAN_PRUEF_ZAHLEN = {
  typen_ms: { standard: 5_000, min: 0, max: 120_000, env: 'FEHLERPRUEFUNG_TYPEN_MS' },
  gueltig_ms: { standard: 60_000, min: 0, max: 3_600_000, env: 'FEHLERPRUEFUNG_GUELTIG_MS' },
  // P22-T201: Schattenstand-Puffer (Co-Edit ohne Gate); bewusst ohne Env (Freigabe T2).
  schatten_puffer_mb: { standard: 64, min: 0, max: 4096, env: null },
  schatten_puffer_min_zeilen: { standard: 2_000, min: 0, max: 10_000_000, env: null },
} as const;

/** bereich-Schluessel der Projektebene in build_pruefung_einstellungen. */
export function planPruefBereich(project: string | null): string {
  return project ? PLAN_PRUEF_BEREICH + ':projekt:' + project : PLAN_PRUEF_BEREICH;
}

type Zeilenwerte = { aktiv?: unknown; typen_ms?: unknown; gueltig_ms?: unknown; schatten_puffer_mb?: unknown; schatten_puffer_min_zeilen?: unknown };

function envZahl(name: keyof typeof PLAN_PRUEF_ZAHLEN): PlanPruefWert<number> {
  const d = PLAN_PRUEF_ZAHLEN[name];
  const roh = d.env ? process.env[d.env] : undefined;
  // t223-Nachbesserung: Env-Rueckfall exakt wie vorher je Wert. typen_ms wertete Leer als nicht gesetzt, gueltig_ms nahm
  // Number(roh) direkt (Leer = 0). Ohne PG-Zeile bleibt so jedes Verhalten wie live.
  const n = roh === undefined ? NaN : name === 'gueltig_ms' ? Number(roh) : roh.trim() === '' ? NaN : Number(roh);
  return Number.isFinite(n) && n >= 0 ? { wert: n, quelle: 'env' } : { wert: d.standard, quelle: 'standard' };
}

function gueltigeZahl(name: keyof typeof PLAN_PRUEF_ZAHLEN, v: unknown): number | null {
  const d = PLAN_PRUEF_ZAHLEN[name];
  return typeof v === 'number' && Number.isInteger(v) && v >= d.min && v <= d.max ? v : null;
}

function baueStand(project: string | null, projekt: Zeilenwerte | undefined, global: Zeilenwerte | undefined, fehler: string | null): PlanPruefStand {
  const envAktiv = process.env.FEHLERPRUEFUNG_PLAN;
  let aktiv: PlanPruefWert<boolean> = envAktiv !== undefined && envAktiv !== ''
    ? { wert: envAktiv !== '0', quelle: 'env' } : { wert: true, quelle: 'standard' };
  if (typeof global?.aktiv === 'boolean') aktiv = { wert: global.aktiv, quelle: 'global' };
  if (typeof projekt?.aktiv === 'boolean') aktiv = { wert: projekt.aktiv, quelle: 'projekt' };
  const zahl = (name: keyof typeof PLAN_PRUEF_ZAHLEN): PlanPruefWert<number> => {
    const p = gueltigeZahl(name, projekt?.[name]);
    if (p !== null) return { wert: p, quelle: 'projekt' };
    const g = gueltigeZahl(name, global?.[name]);
    if (g !== null) return { wert: g, quelle: 'global' };
    return envZahl(name);
  };
  return { project, aktiv, typen_ms: zahl('typen_ms'), gueltig_ms: zahl('gueltig_ms'),
    schatten_puffer_mb: zahl('schatten_puffer_mb'), schatten_puffer_min_zeilen: zahl('schatten_puffer_min_zeilen'), letzter_fehler: fehler };
}

// Gepuffert werden nur die PG-Zeilen; der Env-Rueckfall wird je Aufruf gelesen (wie vorher, Tests/Notaus wirken sofort).
const PUFFER = new Map<string, { bis: number; projekt: Zeilenwerte | undefined; global: Zeilenwerte | undefined }>();
/** Puffer verwerfen (nach dem Setzen im eigenen Prozess; Tests). */
export function leerePlanPruefCache(): void { PUFFER.clear(); }

/** EINE Lesestelle der Plan-Pruefwerte. project null = nur global/Env/Standard. frisch:true umgeht den Puffer. Wirft nie. */
export async function lesePlanPruefEinstellungen(project?: string | null, opt: { frisch?: boolean } = {}): Promise<PlanPruefStand> {
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const ttl = opt.frisch ? 0 : kernTtlMs();
  const schluessel = p ?? '';
  const jetzt = Date.now();
  const c = ttl > 0 ? PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) return baueStand(p, c.projekt, c.global, null);
  try {
    const r = await getPool().query<{ bereich: string; werte: Zeilenwerte | null }>({
      text: 'SELECT bereich, werte FROM build_pruefung_einstellungen WHERE bereich = $1 OR bereich = $2',
      values: [PLAN_PRUEF_BEREICH, planPruefBereich(p)],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const global = r.rows.find((z) => z.bereich === PLAN_PRUEF_BEREICH)?.werte ?? undefined;
    const projekt = p ? r.rows.find((z) => z.bereich === planPruefBereich(p))?.werte ?? undefined : undefined;
    if (ttl > 0) PUFFER.set(schluessel, { bis: jetzt + ttl, projekt, global });
    return baueStand(p, projekt, global, null);
  } catch {
    return baueStand(p, undefined, undefined, 'plan_pruefung_einstellungen_nicht_lesbar');
  }
}
