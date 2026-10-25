/**
 * P22-T44: Agenten-Ausweis fuer mehrere Projekte - Heimat ('Nationalitaet'), Visum, Arbeitsfreigabe ('Einwanderung').
 * Konzept thought cde685a9 Fassung 7, User-Entscheidungen c4ba1673 (Punkt 9 massgeblich), 8076a319 (Anzeige, 24 h), e6fe8628.
 *
 * HEIMAT = agent_identitaeten.project. Aufrufe OHNE project gehen IMMER dorthin (Bestand in agent-token-tools.ts).
 * FREMDES PROJEKT B (Aufruf mit Ausweis und project=B != Heimat), nur bei wirksamem Produkt-Schalter 'mehrprojekt' nach dem
 * Stand im HEIMATprojekt (Standard AUS = Bestand: Abweisung agent_token_fremdes_projekt):
 *   - B wird beim ersten Aufruf dauerhaft im Ausweis eingetragen (agent_ausweis_projekte, Schema 118, je Identitaet+Projekt).
 *   - B ohne aktive Koordinator-Identitaet: 'frei' = alles erlaubt (wie Legacy heute).
 *   - B mit Koordinator: 'visum' (automatisch, Frist visum_minuten von B, Standard 30; nach Ablauf bei der naechsten Anfrage
 *     neu) = nur lesende Aktionen + Channels (VISUM_ZUSCHNITT, Positivliste); sonst Abweisung visum_nur_lesen mit Aufruf.
 *   - 'arbeitsfreigabe' (Einwanderung): vom Koordinator VON B (Identitaet in B) oder dem User erteilt, befristet
 *     (arbeitsfreigabe_stunden von B, Standard 24). Solange Rechte laut Profil/Rolle wie in der Heimat; danach wieder Visum.
 *   In B arbeitet der Agent im Legacy-Namensraum von B (Principal legacy, Projekt B); der Profilzuschnitt der Heimat gilt weiter.
 * ANZEIGE: einmal je Lauf und bei Aenderung (agent_identitaet_laeufe.zugestellt_projekte_stand) im Antwortfeld
 *   ausweis_projekte_hinweis (haengeAusweisHinweiseAn, REST und stdio ueber mitAgentToolAufruf).
 * REGELN VON B: einmal je Lauf (regeln_lauf_id); der Aufrufer vergisst dafuer den Onboarding-Nachweis des Namens in B, das
 *   Bestands-Onboarding liefert die Regeln von B mit der Antwort.
 * SCHALTER (memory regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter agent_profil_schalter funktion 'mehrprojekt'
 *   (projekt > global; 'alle' schliesst ihn bewusst NICHT ein), intern-Override 'mehrprojekt' (nur SYNAPSE_INTERN_TOOL=1,
 *   befristet), wirksam nur zusammen mit dem Ausweis-Kern der Heimat. Fristen: EINE Lesestelle agent-ausweis-fristen.ts.
 * DEBUG: chat(identitaet).ausweis_projekte (Schalter mit Quelle, Eintraege, Zugang, Ablauf), admin ausweis_visa.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { leseAusweisKern, leseProfilProduktSchalter, kernTtlMs, registriereSchalterGeschrieben } from './agent-profil-schalter.js';
import { leseAusweisFristen } from './agent-ausweis-fristen.js';
import { aktionRegel, type ToolZuschnitt } from './tool-gate.js';

export const MEHRPROJEKT_FUNKTION = 'mehrprojekt' as const;
export type FremdZugang = 'frei' | 'visum' | 'arbeitsfreigabe';
/** Antwortfeld der Anzeige (Visum/Einwanderung). */
export const AUSWEIS_HINWEIS_FELD = 'ausweis_projekte_hinweis';

/** Geheimnisfreier Fachfehler (code + optionale details) fuer admin/REST. */
export class AusweisProjektFehler extends Error {
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}

// ---- Schalter -----------------------------------------------------------------------------------
export interface MehrprojektStand {
  aktiv: boolean;
  project: string | null;
  quelle: 'standard' | 'intern' | 'produkt-schalter';
  bis: string | null;
  /** Ausweis-Kern der Heimat (Voraussetzung) */
  ausweis_kern: boolean;
  letzter_fehler: string | null;
}
const PUFFER = new Map<string, { bis: number; stand: MehrprojektStand }>();
/** Puffer verwerfen (Tests; automatisch nach jedem Schreiben eines Produkt-Schalters im eigenen Prozess). */
export function leereMehrprojektCache(): void { PUFFER.clear(); }
// Erst beim ersten Lesen anmelden: auf Modulebene liefe der Aufruf bei manchen Ladereihenfolgen in die TDZ von
// agent-profil-schalter.ts (Importzyklus ueber agent-anmeldung -> agent-ausweis-projekte).
let pufferAngemeldet = false;
function meldePufferAn(): void {
  if (pufferAngemeldet) return;
  pufferAngemeldet = true;
  registriereSchalterGeschrieben(leereMehrprojektCache);
}

async function leseMehrprojektRoh(p: string | null): Promise<MehrprojektStand> {
  let fehler: string | null = null;
  let roh: { aktiv: boolean; quelle: MehrprojektStand['quelle']; bis: string | null } = { aktiv: false, quelle: 'standard', bis: null };
  let gefunden = false;
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [MEHRPROJEKT_FUNKTION],
        query_timeout: 2000,
      } as import('pg').QueryConfig & { query_timeout: number });
      const z = r.rows[0];
      if (z) { roh = { aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? new Date(z.bis).toISOString() : null }; gefunden = true; }
    } catch { fehler = 'schalter_nicht_erreichbar'; }
  }
  if (!gefunden) {
    const s = await leseProfilProduktSchalter(MEHRPROJEKT_FUNKTION, p);
    if (s.letzter_fehler) fehler = fehler ?? s.letzter_fehler;
    else if (s.quelle === 'produkt-schalter') roh = { aktiv: s.aktiv, quelle: 'produkt-schalter', bis: null };
  }
  const kern = await leseAusweisKern(p);
  return {
    aktiv: roh.aktiv && kern.aktiv, project: p, quelle: roh.quelle, bis: roh.bis, ausweis_kern: kern.aktiv,
    letzter_fehler: fehler ?? (roh.aktiv && !kern.aktiv ? 'ausweis_kern_aus' : null),
  };
}

/**
 * Wirksamer Stand des Schalters 'mehrprojekt' fuer das HEIMATprojekt (intern-Override > Produkt-Schalter projekt > global >
 * Standard AUS; nur mit Ausweis-Kern). Kurz gepuffert wie der Kern (SYNAPSE_W1B_GATE_TTL_MS). Wirft nie.
 */
export async function leseMehrprojektSchalter(heimat: string | null): Promise<MehrprojektStand> {
  meldePufferAn();
  const p = typeof heimat === 'string' && heimat.trim() ? heimat.trim() : null;
  const ttl = kernTtlMs();
  const schluessel = p ?? '';
  const jetzt = Date.now();
  const c = ttl > 0 ? PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) return c.stand;
  try {
    const stand = await leseMehrprojektRoh(p);
    if (ttl > 0 && !stand.letzter_fehler) PUFFER.set(schluessel, { bis: jetzt + ttl, stand });
    return stand;
  } catch {
    return { aktiv: false, project: p, quelle: 'standard', bis: null, ausweis_kern: false, letzter_fehler: 'mehrprojekt_nicht_lesbar' };
  }
}

// ---- Visum-Umfang -------------------------------------------------------------------------------
const VISUM_AKTIONEN: Record<string, readonly string[]> = {
  memory: ['read', 'read_with_code', 'list', 'find_for_file'],
  thought: ['get', 'search'],
  plan: ['get', 'list', 'search', 'passende_tasks'],
  docs: ['search', 'get_for_file', 'get'],
  skills: ['search', 'list', 'get_section', 'get_full'],
  // User c4ba1673 Punkt 2: Channels beitreten und schreiben ist im Visum erlaubt.
  channel: ['join', 'leave', 'post', 'feed', 'get', 'list', 'mark_read'],
  chat: ['get', 'list', 'inbox_check', 'quittieren'],
  event: ['pending', 'get', 'ack'],
  files: ['read', 'versions', 'get_version', 'history', 'plan_status', 'shared_plan_status', 'reservation_list'],
  files_batch: ['plan_status', 'shared_plan_status', 'history', 'reservation_list'],
  shell: ['history', 'get', 'log', 'activity'],
  project: ['status', 'list'],
  admin: ['detailed_stats'],
  hex: ['adressen', 'entschluesseln', 'format_liste', 'format_anwenden', 'deuten', 'hex', 'status', 'suchen', 'vergleichen'],
};
/**
 * Positivliste des Visums (lesen + Channels). Nicht genannte Tools/Aktionen sind verweigert (fail-closed). Anmelde-/Sitzungs-
 * aktionen bleiben nach tool-gate NICHT_SPERRBARE_AKTIONEN erlaubt. intern gilt hier ausdruecklich (intern_user_festgelegt).
 */
export const VISUM_ZUSCHNITT: ToolZuschnitt = {
  revision: 'visum-p22-t44',
  quelle: 'visum',
  standard: 'verweigert',
  intern_user_festgelegt: true,
  tools: { code_intel: 'erlaubt', search: 'erlaubt', asset_intel: 'erlaubt', guide: 'erlaubt' },
  aktionen: Object.fromEntries(Object.entries(VISUM_AKTIONEN).flatMap(([t, as]) => as.map(a => [t + '.' + a, 'erlaubt' as const]))),
};
export function visumErlaubt(tool: string, action: string | undefined): boolean {
  return aktionRegel(tool, action, VISUM_ZUSCHNITT) === 'erlaubt';
}
export function arbeitsfreigabeAufruf(project: string, identityId: string): string {
  return `admin(action:"arbeitsfreigabe_erteilen", project:"${project}", ziel_identity_id:"${identityId}", grund:"<Grund>")`;
}
/** Abweisung eines schreibenden Aufrufs unter Visum (Wortlaut Konzept 3b) mit konkretem Freigabe-Aufruf. */
export function visumAblehnung(tool: string, action: string | undefined, project: string, heimat: string, identityId: string, visumBis: string | null): Record<string, unknown> {
  return {
    success: false, error: 'visum_nur_lesen', tool, ...(action ? { action } : {}), project, heimat,
    ...(visumBis ? { visum_bis: visumBis } : {}),
    message: `Im Projekt "${project}" hast du nur ein Visum (lesen und Channels). "${tool}${action ? '.' + action : ''}" braucht eine `
      + `Freigabe durch den Koordinator von "${project}" (oder den User): ${arbeitsfreigabeAufruf(project, identityId)}. Nichts wurde ausgefuehrt.`,
  };
}

// ---- Eintrag / Zugang je Aufruf -----------------------------------------------------------------
export interface FremdprojektStand {
  project: string;
  heimat: string;
  identity_id: string;
  zugang: FremdZugang;
  koordinator_vorhanden: boolean;
  neu_eingetragen: boolean;
  visum_bis: string | null;
  visum_neu: boolean;
  arbeitsfreigabe_bis: string | null;
  /** erster Aufruf in B im aktuellen Lauf -> Pflichtregeln von B zustellen */
  regeln_neu: boolean;
}
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

async function koordinatorVorhanden(db: Pick<PoolClient, 'query'>, project: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator' AND status='aktiv' LIMIT 1", [project]);
  return r.rows.length > 0;
}
async function audit(c: Pick<PoolClient, 'query'>, identityId: string, wer: string, aktion: string, alt: unknown, neu: unknown, grund: string | null): Promise<void> {
  await c.query(`INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,(SELECT id FROM agent_identitaeten WHERE id=$2))`,
  [identityId, wer, aktion, JSON.stringify(alt), JSON.stringify(neu), grund]);
}
async function transaktion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (e instanceof AusweisProjektFehler) throw e;
    // DB-Fehler nicht weiterreichen (koennen Werte enthalten).
    throw new AusweisProjektFehler('ausweis_projekt_speicher_fehler');
  } finally { c.release(); }
}

/**
 * Je Aufruf in B: Eintrag sichern (erster Aufruf traegt B dauerhaft ein), Zugang bestimmen, Visum bei Bedarf (neu) ausstellen,
 * Regel-Zustellung je Lauf vormerken. Eine Transaktion; Audit 'projekt_eingetragen' / 'visum_ausgestellt' (ohne Ausweiswert).
 * P22-T79: nur_lesen (Main) = Zugang IMMER 'visum', auch ohne Koordinator und trotz Arbeitsfreigabe.
 */
export async function sichereFremdprojektZugang(e: { identity_id: string; heimat: string; project: string; lauf_id: string | null; nur_lesen?: boolean }): Promise<FremdprojektStand> {
  const visumMs = (await leseAusweisFristen(e.project)).fristen.visum_minuten.ms;
  return transaktion(async (c) => {
    const koord = await koordinatorVorhanden(c, e.project);
    const ins = await c.query('INSERT INTO agent_ausweis_projekte (identity_id, project) VALUES ($1,$2) ON CONFLICT (identity_id, project) DO NOTHING', [e.identity_id, e.project]);
    const z = (await c.query<{ visum_bis: Date | null; arbeitsfreigabe_bis: Date | null; regeln_lauf_id: string | null; freigabe_aktiv: boolean; visum_aktiv: boolean }>(
      `SELECT visum_bis, arbeitsfreigabe_bis, regeln_lauf_id,
         (arbeitsfreigabe_bis IS NOT NULL AND arbeitsfreigabe_bis > NOW()) AS freigabe_aktiv,
         (visum_bis IS NOT NULL AND visum_bis > NOW()) AS visum_aktiv
       FROM agent_ausweis_projekte WHERE identity_id=$1 AND project=$2 FOR UPDATE`, [e.identity_id, e.project])).rows[0];
    if (!z) throw new AusweisProjektFehler('ausweis_projekt_speicher_fehler');
    const zugang: FremdZugang = e.nur_lesen ? 'visum' : !koord ? 'frei' : z.freigabe_aktiv ? 'arbeitsfreigabe' : 'visum';
    let visumNeu = false;
    if (zugang === 'visum' && !z.visum_aktiv) {
      visumNeu = true;
      const r = await c.query<{ visum_bis: Date }>(`UPDATE agent_ausweis_projekte SET visum_ausgestellt_am=NOW(),
          visum_bis=NOW() + ($3::double precision * INTERVAL '1 millisecond'), visa_anzahl=visa_anzahl+1
        WHERE identity_id=$1 AND project=$2 RETURNING visum_bis`, [e.identity_id, e.project, visumMs]);
      await audit(c, e.identity_id, e.identity_id, 'visum_ausgestellt', { project: e.project, visum_bis: iso(z.visum_bis) },
        { project: e.project, visum_bis: iso(r.rows[0]?.visum_bis) }, 'P22-T44: automatisches Visum (lesen + Channels)');
    }
    const regelnNeu = !!e.lauf_id && z.regeln_lauf_id !== e.lauf_id;
    const nach = (await c.query<{ visum_bis: Date | null; arbeitsfreigabe_bis: Date | null }>(
      `UPDATE agent_ausweis_projekte SET zuletzt_aufruf=NOW(), zugang_zuletzt=$3, regeln_lauf_id=COALESCE($4, regeln_lauf_id)
       WHERE identity_id=$1 AND project=$2 RETURNING visum_bis, arbeitsfreigabe_bis`,
      [e.identity_id, e.project, zugang, e.lauf_id])).rows[0];
    if (ins.rowCount) {
      await audit(c, e.identity_id, e.identity_id, 'projekt_eingetragen', null, { project: e.project, heimat: e.heimat, zugang },
        'P22-T44: erster Aufruf mit Ausweis in einem anderen Projekt');
    }
    return {
      project: e.project, heimat: e.heimat, identity_id: e.identity_id, zugang, koordinator_vorhanden: koord,
      neu_eingetragen: (ins.rowCount ?? 0) > 0, visum_bis: zugang === 'visum' ? iso(nach?.visum_bis) : null, visum_neu: visumNeu,
      arbeitsfreigabe_bis: zugang === 'arbeitsfreigabe' ? iso(nach?.arbeitsfreigabe_bis) : null, regeln_neu: regelnNeu,
    };
  });
}

// ---- Anzeige (einmal je Lauf und bei Aenderung) ---------------------------------------------------
interface ProjektZeile {
  project: string; visum_bis: Date | null; arbeitsfreigabe_bis: Date | null; arbeitsfreigabe_von: string | null;
  erster_aufruf: Date; zuletzt_aufruf: Date; zugang_zuletzt: string | null; visa_anzahl: number; koordinator: boolean;
}
async function leseProjektZeilen(identityId: string): Promise<ProjektZeile[]> {
  const r = await getPool().query<ProjektZeile>(
    `SELECT a.project, a.visum_bis, a.arbeitsfreigabe_bis, a.arbeitsfreigabe_von, a.erster_aufruf, a.zuletzt_aufruf, a.zugang_zuletzt,
       a.visa_anzahl, EXISTS (SELECT 1 FROM agent_identitaeten k WHERE k.project=a.project AND k.rolle='koordinator' AND k.status='aktiv') AS koordinator
     FROM agent_ausweis_projekte a WHERE a.identity_id=$1 AND a.project <> '*' ORDER BY a.project`, [identityId]);
  return r.rows;
}
type Einordnung = FremdZugang | 'abgelaufen';
function einordnen(z: ProjektZeile, jetzt = Date.now()): Einordnung {
  if (!z.koordinator) return 'frei';
  if (z.arbeitsfreigabe_bis && new Date(z.arbeitsfreigabe_bis).getTime() > jetzt) return 'arbeitsfreigabe';
  if (z.visum_bis && new Date(z.visum_bis).getTime() > jetzt) return 'visum';
  return 'abgelaufen';
}
const liste = (xs: string[]): string => xs.map(x => `"${x}"`).join(', ');
/** Wortlaut nach User-Entscheidung 8076a319 (Visum, Einwanderung) plus Hinweis fuer Projekte ohne Koordinator. */
export function ausweisProjekteTexte(heimat: string, visa: string[], einwanderung: string[], frei: string[]): string[] {
  const t: string[] = [];
  if (visa.length) {
    t.push(`Du hast ein Visum ${visa.length === 1 ? `im Projekt "${visa[0]}"` : `in den Projekten ${liste(visa)}`}. `
      + 'Wenn du dort schauen willst, musst du den project-Parameter mit angeben.');
  }
  if (einwanderung.length) {
    t.push(`Du bist Einwanderer ${einwanderung.length === 1 ? `im Projekt "${einwanderung[0]}"` : `in den Projekten: ${liste(einwanderung)}`}. `
      + `Wenn du dort etwas ändern willst, musst du den project-Parameter benutzen. Deine Nationalität kommt aus dem Projekt "${heimat}" – `
      + 'dort musst du keine Zusatzparameter angeben.');
  }
  if (frei.length) {
    t.push(`${frei.length === 1 ? `Im Projekt "${frei[0]}" gibt` : `In den Projekten ${liste(frei)} gibt`} es keinen Koordinator; dort darfst du `
      + `alles, mit dem project-Parameter. Deine Nationalität kommt aus dem Projekt "${heimat}" – dort musst du keine Zusatzparameter angeben.`);
  }
  return t;
}

/**
 * Anzeige je Lauf: liefert die Hinweiszeilen, wenn sich der Stand (Visa, Einwanderungen, freie Projekte) im aktuellen Lauf
 * geaendert hat bzw. im Lauf noch nicht gezeigt wurde; vermerkt den Stand am Lauf. Sonst null. Ohne Lauf nichts.
 */
export async function ausweisProjekteHinweis(e: { identity_id: string; heimat: string; lauf_id: string | null }): Promise<string[] | null> {
  if (!e.lauf_id) return null;
  const zeilen = await leseProjektZeilen(e.identity_id);
  const jetzt = Date.now();
  const nach = (art: Einordnung) => zeilen.filter(z => z.project !== e.heimat && einordnen(z, jetzt) === art).map(z => z.project);
  const visa = nach('visum'), einwanderung = nach('arbeitsfreigabe'), frei = nach('frei');
  const stand = JSON.stringify({ v: visa, e: einwanderung, f: frei });
  const r = await getPool().query(
    'UPDATE agent_identitaet_laeufe SET zugestellt_projekte_stand=$2 WHERE id=$1 AND zugestellt_projekte_stand IS DISTINCT FROM $2 RETURNING id',
    [e.lauf_id, stand]);
  if (!r.rowCount) return null;
  const texte = ausweisProjekteTexte(e.heimat, visa, einwanderung, frei);
  return texte.length ? texte : null;
}

/**
 * Haengt die Anzeige an eine Tool-Antwort: MCP-Ergebnis ({content:[{type:'text', text:JSON}]}, structuredContent) oder
 * einfaches Objekt. Andere Formen bleiben unveraendert. Wirft nie.
 */
export function haengeAusweisHinweiseAn<T>(ergebnis: T, hinweise: string[] | string, feld: string = AUSWEIS_HINWEIS_FELD): T {
  try {
    if (!hinweise.length || !ergebnis || typeof ergebnis !== 'object' || Array.isArray(ergebnis)) return ergebnis;
    const r = ergebnis as unknown as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
    if (Array.isArray(r.content)) {
      const b = r.content[0];
      if (!b || b.type !== 'text' || typeof b.text !== 'string') return ergebnis;
      const roh: unknown = JSON.parse(b.text);
      if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return ergebnis;
      (roh as Record<string, unknown>)[feld] = hinweise;
      b.text = /^\{\n\s/.test(b.text) ? JSON.stringify(roh, null, 2) : JSON.stringify(roh);
      if (r.structuredContent && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent)) {
        r.structuredContent = { ...(r.structuredContent as Record<string, unknown>), [feld]: hinweise };
      }
      return ergebnis;
    }
    if ('content' in r) return ergebnis;
    return { ...(ergebnis as unknown as Record<string, unknown>), [feld]: hinweise } as unknown as T;
  } catch {
    return ergebnis;
  }
}

// ---- Debug / Verwaltung ---------------------------------------------------------------------------
/** chat(identitaet): Heimat, Schalter (Quelle), Eintraege mit Zugang und Ablauf. Wirft nie. */
export async function ausweisProjekteStatus(identityId: string, heimat: string): Promise<Record<string, unknown>> {
  const schalter = await leseMehrprojektSchalter(heimat);
  try {
    const jetzt = Date.now();
    const zeilen = await leseProjektZeilen(identityId);
    return {
      heimat, schalter,
      projekte: zeilen.map(z => ({
        project: z.project, zugang: einordnen(z, jetzt), koordinator_vorhanden: z.koordinator,
        visum_bis: iso(z.visum_bis), visa_anzahl: Number(z.visa_anzahl), arbeitsfreigabe_bis: iso(z.arbeitsfreigabe_bis),
        arbeitsfreigabe_von: z.arbeitsfreigabe_von, erster_aufruf: iso(z.erster_aufruf), zuletzt_aufruf: iso(z.zuletzt_aufruf),
      })),
    };
  } catch {
    return { heimat, schalter, projekte: [], letzter_fehler: 'ausweis_projekte_nicht_lesbar' };
  }
}

/** Agenten aus anderen Projekten mit Eintrag in project (Visum/Einwanderung/frei) fuer Koordinator/User dieses Projekts. */
export async function listeAusweisVisa(project: string): Promise<Record<string, unknown>> {
  const koord = await koordinatorVorhanden(getPool(), project);
  const r = await getPool().query<{
    identity_id: string; heimat: string; agent_id: string; rolle: string; status: string; erster_aufruf: Date; zuletzt_aufruf: Date;
    visum_bis: Date | null; visa_anzahl: number; arbeitsfreigabe_bis: Date | null; arbeitsfreigabe_am: Date | null;
    arbeitsfreigabe_von: string | null; arbeitsfreigabe_grund: string | null;
  }>(
    `SELECT a.identity_id, i.project AS heimat, i.agent_id, i.rolle, i.status, a.erster_aufruf, a.zuletzt_aufruf, a.visum_bis, a.visa_anzahl,
       a.arbeitsfreigabe_bis, a.arbeitsfreigabe_am, a.arbeitsfreigabe_von, a.arbeitsfreigabe_grund
     FROM agent_ausweis_projekte a JOIN agent_identitaeten i ON i.id=a.identity_id
     WHERE a.project=$1 AND i.project<>$1 ORDER BY a.zuletzt_aufruf DESC`, [project]);
  const jetzt = Date.now();
  const fristen = await leseAusweisFristen(project);
  return {
    project, koordinator_vorhanden: koord,
    fristen: { visum_minuten: fristen.fristen.visum_minuten, arbeitsfreigabe_stunden: fristen.fristen.arbeitsfreigabe_stunden },
    agenten: r.rows.map(z => {
      const zugang: Einordnung = !koord ? 'frei'
        : z.arbeitsfreigabe_bis && new Date(z.arbeitsfreigabe_bis).getTime() > jetzt ? 'arbeitsfreigabe'
          : z.visum_bis && new Date(z.visum_bis).getTime() > jetzt ? 'visum' : 'abgelaufen';
      return { identity_id: z.identity_id, agent_id: z.agent_id, heimat: z.heimat, rolle: z.rolle, status: z.status, zugang,
        erster_aufruf: iso(z.erster_aufruf), zuletzt_aufruf: iso(z.zuletzt_aufruf), visum_bis: iso(z.visum_bis), visa_anzahl: Number(z.visa_anzahl),
        arbeitsfreigabe_bis: iso(z.arbeitsfreigabe_bis), arbeitsfreigabe_am: iso(z.arbeitsfreigabe_am), arbeitsfreigabe_von: z.arbeitsfreigabe_von,
        arbeitsfreigabe_grund: z.arbeitsfreigabe_grund };
    }),
    hinweis: 'Visum = lesen + Channels (automatisch, visum_minuten). Arbeitsfreigabe (Einwanderung) erteilt der Koordinator DIESES Projekts oder der User, befristet (arbeitsfreigabe_stunden); danach wieder Visum.',
  };
}

function pruefeGrund(grund: unknown): string {
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < 5 || g.length > 1000) throw new AusweisProjektFehler('grund_fehlt');
  return g;
}
async function fremdeIdentitaet(c: Pick<PoolClient, 'query'>, project: string, identityId: unknown): Promise<string> {
  if (typeof identityId !== 'string' || !identityId.trim()) throw new AusweisProjektFehler('ziel_identity_id_fehlt');
  const r = await c.query<{ project: string; status: string; rolle: string }>('SELECT project, status, rolle FROM agent_identitaeten WHERE id=$1', [identityId.trim()]);
  const i = r.rows[0];
  if (!i) throw new AusweisProjektFehler('identitaet_unbekannt');
  // P22-T79: der Main arbeitet nicht in Projekten (nur lesen + Channels), eine Arbeitsfreigabe waere wirkungslos.
  if (i.rolle === 'main') throw new AusweisProjektFehler('main_nur_lesen', { hinweis: 'Der Main liest in Projekten nur; Arbeit macht der Koordinator.' });
  if (i.project === project) throw new AusweisProjektFehler('identitaet_im_eigenen_projekt', { hinweis: 'Agenten dieses Projekts brauchen keine Arbeitsfreigabe.' });
  if (i.status !== 'aktiv') throw new AusweisProjektFehler('identitaet_nicht_aktiv');
  return identityId.trim();
}

/**
 * Arbeitsfreigabe (Einwanderung) fuer eine Identitaet eines ANDEREN Projekts in project. Rechte prueft der Aufrufer (User oder
 * Koordinator DIESES Projekts, pruefeProfilVerwalter). Frist arbeitsfreigabe_stunden von project. Legt den Eintrag an, falls die
 * Identitaet das Projekt noch nie besucht hat. Audit 'arbeitsfreigabe_erteilt'.
 */
export async function erteileArbeitsfreigabe(project: string, identityId: unknown, grund: unknown, wer: { wer: string; actor_identity_id: string | null }): Promise<Record<string, unknown>> {
  const g = pruefeGrund(grund);
  const ms = (await leseAusweisFristen(project)).fristen.arbeitsfreigabe_stunden.ms;
  return transaktion(async (c) => {
    const ziel = await fremdeIdentitaet(c, project, identityId);
    await c.query('INSERT INTO agent_ausweis_projekte (identity_id, project) VALUES ($1,$2) ON CONFLICT (identity_id, project) DO NOTHING', [ziel, project]);
    const alt = (await c.query<{ arbeitsfreigabe_bis: Date | null }>('SELECT arbeitsfreigabe_bis FROM agent_ausweis_projekte WHERE identity_id=$1 AND project=$2 FOR UPDATE', [ziel, project])).rows[0];
    const neu = (await c.query<{ arbeitsfreigabe_bis: Date }>(
      `UPDATE agent_ausweis_projekte SET arbeitsfreigabe_am=NOW(), arbeitsfreigabe_bis=NOW() + ($3::double precision * INTERVAL '1 millisecond'),
         arbeitsfreigabe_von=$4, arbeitsfreigabe_von_identity_id=$5, arbeitsfreigabe_grund=$6
       WHERE identity_id=$1 AND project=$2 RETURNING arbeitsfreigabe_bis`, [ziel, project, ms, wer.wer, wer.actor_identity_id, g])).rows[0];
    await audit(c, ziel, wer.wer, 'arbeitsfreigabe_erteilt', { project, arbeitsfreigabe_bis: iso(alt?.arbeitsfreigabe_bis) },
      { project, arbeitsfreigabe_bis: iso(neu?.arbeitsfreigabe_bis) }, g);
    return { project, ziel_identity_id: ziel, arbeitsfreigabe_bis: iso(neu?.arbeitsfreigabe_bis), erteilt_von: wer.wer };
  });
}

/** Entzieht eine Arbeitsfreigabe sofort (danach wieder Visum). Rechte prueft der Aufrufer. Audit 'arbeitsfreigabe_entzogen'. */
export async function entzieheArbeitsfreigabe(project: string, identityId: unknown, grund: unknown, wer: { wer: string; actor_identity_id: string | null }): Promise<Record<string, unknown>> {
  const g = pruefeGrund(grund);
  return transaktion(async (c) => {
    const ziel = await fremdeIdentitaet(c, project, identityId);
    const alt = (await c.query<{ arbeitsfreigabe_bis: Date | null }>('SELECT arbeitsfreigabe_bis FROM agent_ausweis_projekte WHERE identity_id=$1 AND project=$2 FOR UPDATE', [ziel, project])).rows[0];
    if (!alt) throw new AusweisProjektFehler('ausweis_eintrag_unbekannt');
    await c.query('UPDATE agent_ausweis_projekte SET arbeitsfreigabe_bis=NULL WHERE identity_id=$1 AND project=$2', [ziel, project]);
    await audit(c, ziel, wer.wer, 'arbeitsfreigabe_entzogen', { project, arbeitsfreigabe_bis: iso(alt.arbeitsfreigabe_bis) }, { project, arbeitsfreigabe_bis: null }, g);
    return { project, ziel_identity_id: ziel, arbeitsfreigabe_bis: null, entzogen_von: wer.wer };
  });
}

/** Koordinator-Hinweis: aktive Visa (ohne Arbeitsfreigabe) im Projekt; Fehler (z. B. vor Schema 118) -> leer. */
export async function offeneVisa(project: string): Promise<Array<{ identity_id: string; agent_id: string; heimat: string; visum_bis: string | null }>> {
  try {
    const r = await getPool().query<{ identity_id: string; agent_id: string; heimat: string; visum_bis: Date | null }>(
      `SELECT a.identity_id, i.agent_id, i.project AS heimat, a.visum_bis FROM agent_ausweis_projekte a JOIN agent_identitaeten i ON i.id=a.identity_id
        WHERE a.project=$1 AND i.project<>$1 AND a.visum_bis > NOW() AND (a.arbeitsfreigabe_bis IS NULL OR a.arbeitsfreigabe_bis <= NOW())
        ORDER BY a.zuletzt_aufruf DESC LIMIT 6`, [project]);
    return r.rows.map(z => ({ identity_id: z.identity_id, agent_id: z.agent_id, heimat: z.heimat, visum_bis: iso(z.visum_bis) }));
  } catch {
    return [];
  }
}
