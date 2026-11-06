/**
 * P27-T11 (User 01.11.2026 ~13:35 MEZ: "Ja, aber nichts löschen, sondern einfach nur nicht mehr anzeigen lassen."): Altbestand in
 * Warteschlangen AUSBLENDEN statt loeschen. Vorbild admin agenten_aufraeumen (agent-entfernung.ts).
 *
 * WAS (Bestand 01.11.2026 per db_lesen, Ansage #t128-team 34676):
 *   specialist_inbox  unverarbeitete Nachrichten aelter als die Schwelle an Empfaenger OHNE lebenden Wrapper (u. a. 'user' fuer
 *                     "Meine Inbox", laengst beendete Agenten). Ausblenden = processed=true + Markierung: jeder Leser unverarbeiteter
 *                     Nachrichten (chat inbox_check, Wrapper-Zustellung, Stau-Waechter specialist_inbox) sieht sie nicht mehr; die
 *                     Verlaufslisten (Meine Inbox user-inbox.ts, Inbox-Historie inbox.ts) filtern offene Markierungen (inboxNichtAusgeblendet).
 *                     P27-T10: mit aufraeumen_ausnahmen_einschliessen (nur warteschlange specialist_inbox UND aufraeumen_ids, nie pauschal)
 *                     auch genau benannte Empfaenger bzw. Inbox-IDs mit lebendem Wrapper und/oder juenger als die Schwelle; vorher.ausnahme
 *                     nennt den Grund, der Rueckweg ist derselbe. Ohne ids bleibt alles wie bisher (beides ausgenommen).
 *   zustellungen      agent_zustellungen 'pending' aelter als die Schwelle fuer Identitaeten ohne lebenden Wrapper (live: 142 an die
 *                     Test-Identitaet koordinator-test-t107). Ausblenden = eigener status 'ausgeblendet' (Schema 179, Koordinator 34681:
 *                     nicht 'fehler', das saehe wie ein echter Fehler aus); alle anderen Spalten bleiben unveraendert. Der Ledger
 *                     stellt nur 'pending' zu, Mod-Inbox und Stau-Waechter zaehlen nur 'pending' - kein Join im Hot-Path noetig.
 *   coedit_waits      (P27-T10, User 06.11.2026) abgelaufene, nicht geschlossene Co-Edit-Waits (file_batch_waits) - GENAU die Definition des
 *                     Stau-Waechters (warteschlangen-adapter.ts STAU_KOHORTEN coedit_waits faellig = WS_ALTBESTAND_COEDIT_FAELLIG), Schwelle ab
 *                     expires_at. NUR ausdruecklich (warteschlange:'coedit_waits'), nie im Lauf ohne warteschlange: es schliesst Waits und Traeger.
 *                     Ausblenden = Schliessen auf dem Weg von intern waits_tot (coedit-wait-schliessen.ts: Wait closed, dadurch leerer Traeger
 *                     cancelled). vorher haelt Status, updated_at, Ops samt Inhalt und den Traeger (Status, reason, verworfen); kein thought und
 *                     kein Event je Wait (Besitzer laengst weg, die Ops bleiben in der Wait-Zeile und in vorher). Der Stau-Waechter zaehlt nur
 *                     status <> 'closed' - geschlossene Waits sind damit ohne Join raus. Schluessel eintrag_uuid (Schema 180).
 *   work_jobs         NIE. Es sind Auftraege (live: 12 Reverse-Leser-Nachzuege fuer Siedler 3, gehalten von reverse_leser AUS und
 *                     reverse_pipeline_halt EIN). Die Vorschau nennt sie nur unter ausgenommen.
 * NICHTS wird geloescht. vorher (JSONB) haelt den Zustand vor dem Ausblenden; wiederherstellen setzt genau ihn zurueck, wenn der Eintrag
 * seitdem unveraendert ist (sonst bleibt die Markierung offen und die Antwort nennt ihn unter geaendert).
 *
 * SCHALTER (regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter warteschlangen_altbestand (global, Standard AUS, nur
 * ausdruecklich). AUS = ausfuehren wird abgewiesen, die Verlaufslisten filtern nicht (Altverhalten). vorschau, status, wiederherstellen und
 * einstellen gehen immer (der Rueckweg muss immer gehen). SCHWELLE: Einstellung schwelle_tage in PG (Standard 7, 1..3650), Quelle sichtbar.
 * DEBUG: status zeigt Schalter (Quelle/Fehler), Schwelle (Quelle), offene Markierungen je Warteschlange und die letzten Laeufe.
 *
 * admin(action:'warteschlangen_aufraeumen', aufraeumen_modus vorschau|ausfuehren|wiederherstellen|status|einstellen, warteschlange,
 *   aufraeumen_tage, aufraeumen_ids, aufraeumen_bestaetigung, aufraeumen_lauf_id, aufraeumen_alle, project, grund, user_auftrag):
 *   Rechte wie agenten_aufraeumen - vorschau/status User und Koordinator (Koordinator nur sein Projekt); ausfuehren/wiederherstellen/
 *   einstellen User, oder Koordinator mit Pflicht-Parameter user_auftrag (protokolliert). ausfuehren braucht die bestaetigung der Vorschau.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { oeffneWaitWieder, schliesseWaitUndLeerenTraeger } from './coedit-wait-schliessen.js';

export const WS_ALTBESTAND_FUNKTION = 'warteschlangen_altbestand' as const;
export const WS_ALTBESTAND_WARTESCHLANGEN = ['specialist_inbox', 'zustellungen', 'coedit_waits'] as const;
/** P27-T10: faellig-Bedingung des Stau-Waechters fuer coedit_waits (warteschlangen-adapter.ts STAU_KOHORTEN), Alias t - wortgleich halten. */
export const WS_ALTBESTAND_COEDIT_FAELLIG = "t.status <> 'closed' AND t.expires_at < now()";
const UUID_MUSTER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type WsAltbestandWarteschlange = typeof WS_ALTBESTAND_WARTESCHLANGEN[number];
export const WS_ALTBESTAND_STANDARD_TAGE = 7;
export const WS_ALTBESTAND_MIN_TAGE = 1;
export const WS_ALTBESTAND_MAX_TAGE = 3650;
const SCHWELLE_NAME = 'schwelle_tage';
const BEISPIELE_LIMIT = 50;
const GRUPPEN_LIMIT = 200;
export const WS_ALTBESTAND_AUSFUEHREN_LIMIT = 5000;
const ABFRAGE_MS = 60_000;

type Db = Pick<PoolClient, 'query'>;
type Q = QueryConfig & { query_timeout: number };
const q = (text: string, values: unknown[] = []): Q => ({ text, values, query_timeout: ABFRAGE_MS } as Q);
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

/** Lebender Wrapper eines Agentennamens - dieselbe Bedingung wie der Stau-Waechter (warteschlangen-adapter.ts specialist_inbox). */
const WRAPPER_LEBT = (agentSql: string): string =>
  `EXISTS (SELECT 1 FROM wrapper_status w WHERE w.agent_name = ${agentSql} AND w.status NOT IN ('stopped','gestoppt','exited','beendet','dead','offline'))`;
const OFFEN_MARKIERT = (ws: WsAltbestandWarteschlange, idSql: string): string =>
  `EXISTS (SELECT 1 FROM warteschlangen_ausblendungen a_ WHERE a_.warteschlange = '${ws}' AND a_.eintrag_id = ${idSql} AND a_.wiederhergestellt_am IS NULL)`;

// ---------------------------------------------------------------------------------------------
// Schalter, Schwelle, Filter der Verlaufslisten
// ---------------------------------------------------------------------------------------------
export interface WsAltbestandSchalter {
  name: typeof WS_ALTBESTAND_FUNKTION; aktiv: boolean; quelle: string; gesetzt_von: string | null; gesetzt_am: string | null;
  grund: string | null; letzter_fehler: string | null;
}
/** Produkt-Schalter warteschlangen_altbestand (Standard AUS, nur ausdruecklich). Frisch gelesen; Lesefehler -> AUS mit letzter_fehler. */
export async function leseWsAltbestandSchalter(): Promise<WsAltbestandSchalter> {
  const p = await leseProfilProduktSchalter(WS_ALTBESTAND_FUNKTION, null);
  return { name: WS_ALTBESTAND_FUNKTION, aktiv: p.aktiv && !p.letzter_fehler, quelle: p.quelle, gesetzt_von: p.gesetzt_von ?? null,
    gesetzt_am: p.gesetzt_am ?? null, grund: p.grund ?? null, letzter_fehler: p.letzter_fehler ?? null };
}

export interface WsAltbestandSchwelle { tage: number; quelle: 'standard' | 'einstellung'; standard: number; min: number; max: number; gesetzt_von: string | null; gesetzt_am: string | null }
export async function leseWsAltbestandSchwelle(db: Db = getPool()): Promise<WsAltbestandSchwelle> {
  const basis: WsAltbestandSchwelle = { tage: WS_ALTBESTAND_STANDARD_TAGE, quelle: 'standard', standard: WS_ALTBESTAND_STANDARD_TAGE,
    min: WS_ALTBESTAND_MIN_TAGE, max: WS_ALTBESTAND_MAX_TAGE, gesetzt_von: null, gesetzt_am: null };
  try {
    const r = await db.query<{ wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(q('SELECT wert, gesetzt_von, gesetzt_am FROM warteschlangen_altbestand_einstellungen WHERE name = $1', [SCHWELLE_NAME]));
    const z = r.rows[0];
    const n = Number(z?.wert);
    if (z && Number.isInteger(n) && n >= WS_ALTBESTAND_MIN_TAGE && n <= WS_ALTBESTAND_MAX_TAGE) {
      return { ...basis, tage: n, quelle: 'einstellung', gesetzt_von: z.gesetzt_von, gesetzt_am: new Date(z.gesetzt_am).toISOString() };
    }
  } catch { /* Tabelle fehlt noch (Schema alt): Standard */ }
  return basis;
}
export async function setzeWsAltbestandSchwelle(o: { tage: unknown; grund: string; wer: string }, db: Db = getPool()): Promise<WsAltbestandSchwelle> {
  const n = Number(o.tage);
  if (!Number.isInteger(n) || n < WS_ALTBESTAND_MIN_TAGE || n > WS_ALTBESTAND_MAX_TAGE) fehler('tage_ungueltig', { min: WS_ALTBESTAND_MIN_TAGE, max: WS_ALTBESTAND_MAX_TAGE });
  await db.query(q(`INSERT INTO warteschlangen_altbestand_einstellungen(name, wert, gesetzt_von, grund) VALUES ($1, $2::jsonb, $3, $4)
    ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW(), grund = EXCLUDED.grund`,
    [SCHWELLE_NAME, JSON.stringify(n), o.wer, o.grund]));
  return leseWsAltbestandSchwelle(db);
}

let filterCache: { bis: number; aktiv: boolean } | null = null;
/** Filter der Verlaufslisten: kurz gepuffert (Hot-Path). AUS/Lesefehler = nichts wird ausgeblendet (Altverhalten). */
export async function wsAltbestandFilterAktiv(): Promise<boolean> {
  if (filterCache && filterCache.bis > Date.now()) return filterCache.aktiv;
  let aktiv = false;
  try { aktiv = (await leseWsAltbestandSchalter()).aktiv; } catch { aktiv = false; }
  filterCache = { bis: Date.now() + 5000, aktiv };
  return aktiv;
}
export function leereWsAltbestandCache(): void { filterCache = null; }

/**
 * SQL-Fragment (WHERE-Teil) fuer Verlaufslisten der specialist_inbox: 'TRUE' bei Schalter AUS, sonst "keine offene Ausblendung".
 * Unverarbeitete Leser brauchen es nicht (ausgeblendete Zeilen sind processed=true). Spalte nur als fester Bezeichner.
 */
export async function inboxNichtAusgeblendet(idSpalte: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(idSpalte)) throw new Error('ungueltige Spalte');
  if (!(await wsAltbestandFilterAktiv())) return 'TRUE';
  return 'NOT ' + OFFEN_MARKIERT('specialist_inbox', idSpalte);
}

// ---------------------------------------------------------------------------------------------
// Kandidaten
// ---------------------------------------------------------------------------------------------
export interface WsAltbestandFilter { tage?: number; project?: string | null; warteschlange?: WsAltbestandWarteschlange | null; ids?: readonly string[] | null;
  /** P27-T10: nur specialist_inbox + ids - benannte Eintraege auch mit lebendem Wrapper / juenger als die Schwelle */
  ausnahmen_einschliessen?: boolean }
export interface WsAltbestandKandidat {
  warteschlange: WsAltbestandWarteschlange; id: string; project: string | null; empfaenger: string; absender: string | null;
  erstellt_am: string; vorher: Record<string, unknown>; /** coedit_waits: Wait-Status */ status?: string;
  /** P27-T10 specialist_inbox mit ausnahmen_einschliessen: warum der Eintrag sonst ausgenommen waere */ ausnahme?: string[];
}
export interface WsAltbestandErmittlung {
  tage: number; stichtag: string; kandidaten: WsAltbestandKandidat[]; gekappt: boolean; bestaetigung: string;
  ausgenommen: Record<string, unknown>;
}

export function wsAltbestandBestaetigung(f: { tage: number; project: string | null; warteschlange: string | null; ids: readonly string[] | null; ausnahmen?: boolean },
  kandidaten: ReadonlyArray<Pick<WsAltbestandKandidat, 'warteschlange' | 'id'>>): string {
  const kopf = [f.tage, f.project ?? '*', f.warteschlange ?? '*', (f.ids ?? []).slice().sort().join(',')].join('|') + (f.ausnahmen ? '|ausnahmen' : '');
  const zeilen = kandidaten.map((k) => k.warteschlange + ':' + k.id).sort();
  return createHash('sha256').update(kopf + '#' + zeilen.join(';')).digest('hex').slice(0, 16);
}

const iso = (d: unknown): string => (d instanceof Date ? d : new Date(String(d))).toISOString();

/** Kandidaten (hoechstens WS_ALTBESTAND_AUSFUEHREN_LIMIT je Warteschlange) und Ausnahmen. Nur lesend. */
export async function ermittleWsAltbestand(f: WsAltbestandFilter, db: Db = getPool()): Promise<WsAltbestandErmittlung> {
  const tage = f.tage ?? (await leseWsAltbestandSchwelle(db)).tage;
  const project = f.project ?? null, ws = f.warteschlange ?? null, ids = f.ids && f.ids.length ? [...f.ids] : null;
  const limit = WS_ALTBESTAND_AUSFUEHREN_LIMIT + 1;
  const mitAusnahmen = f.ausnahmen_einschliessen === true && ids !== null && ws === 'specialist_inbox';
  const kandidaten: WsAltbestandKandidat[] = [];
  let gekappt = false;
  if (ws === null || ws === 'specialist_inbox') {
    // P27-T10: $5 = ausnahmen_einschliessen (nur mit ids): Schwelle und lebender Wrapper gelten dann nicht, ids treffen Empfaenger ODER Inbox-ID.
    const r = await db.query<{ id: string; project: string | null; empfaenger: string; absender: string | null; erstellt_am: Date; processed: boolean | null; ausnahme: string | null }>(q(
      `SELECT t.id::text AS id, t.project, t.to_agent AS empfaenger, t.from_agent AS absender, t.created_at AS erstellt_am, t.processed,
              NULLIF(concat_ws(',', CASE WHEN ${WRAPPER_LEBT('t.to_agent')} THEN 'empfaenger_aktiv' END,
                                    CASE WHEN t.created_at >= NOW() - $1::int * interval '1 day' THEN 'juenger_als_schwelle' END), '') AS ausnahme
         FROM specialist_inbox t
        WHERE t.processed IS NOT TRUE
          AND ($5::boolean OR (t.created_at < NOW() - $1::int * interval '1 day' AND NOT ${WRAPPER_LEBT('t.to_agent')}))
          AND ($2::text IS NULL OR t.project = $2)
          AND ($3::text[] IS NULL OR t.to_agent = ANY($3::text[]) OR ($5::boolean AND t.id::text = ANY($3::text[])))
          AND NOT ${OFFEN_MARKIERT('specialist_inbox', 't.id')}
        ORDER BY t.id LIMIT $4`, [tage, project, ids, limit, mitAusnahmen]));
    if (r.rows.length > WS_ALTBESTAND_AUSFUEHREN_LIMIT) gekappt = true;
    for (const z of r.rows.slice(0, WS_ALTBESTAND_AUSFUEHREN_LIMIT)) {
      const ausnahme = z.ausnahme ? z.ausnahme.split(',') : null;
      kandidaten.push({ warteschlange: 'specialist_inbox', id: z.id, project: z.project, empfaenger: z.empfaenger, absender: z.absender,
        erstellt_am: iso(z.erstellt_am), vorher: { processed: z.processed, ...(ausnahme ? { ausnahme } : {}) }, ...(ausnahme ? { ausnahme } : {}) });
    }
  }
  if (ws === null || ws === 'zustellungen') {
    const r = await db.query<{ id: string; project: string | null; empfaenger: string; weg: string; erstellt_am: Date; letzter_grund: string | null; versuche: number }>(q(
      `SELECT z.id::text AS id, i.project, COALESCE(i.agent_id, z.identity_id) AS empfaenger, z.weg, z.erstellt_am, z.letzter_grund, z.versuche
         FROM agent_zustellungen z LEFT JOIN agent_identitaeten i ON i.id = z.identity_id
        WHERE z.status = 'pending' AND z.erstellt_am < NOW() - $1::int * interval '1 day'
          AND ($2::text IS NULL OR i.project = $2) AND ($3::text[] IS NULL OR i.agent_id = ANY($3::text[]) OR z.identity_id = ANY($3::text[]))
          AND NOT (i.agent_id IS NOT NULL AND ${WRAPPER_LEBT('i.agent_id')}) AND NOT ${OFFEN_MARKIERT('zustellungen', 'z.id')}
        ORDER BY z.id LIMIT $4`, [tage, project, ids, limit]));
    if (r.rows.length > WS_ALTBESTAND_AUSFUEHREN_LIMIT) gekappt = true;
    for (const z of r.rows.slice(0, WS_ALTBESTAND_AUSFUEHREN_LIMIT)) {
      kandidaten.push({ warteschlange: 'zustellungen', id: z.id, project: z.project, empfaenger: z.empfaenger, absender: null,
        erstellt_am: iso(z.erstellt_am), vorher: { status: 'pending', letzter_grund: z.letzter_grund, weg: z.weg, versuche: z.versuche } });
    }
  }
  // P27-T10: coedit_waits nur ausdruecklich. Kandidat = faellig wie beim Stau-Waechter und seit mehr als tage Tagen abgelaufen.
  if (ws === 'coedit_waits') {
    const r = await db.query<{ id: string; project: string; besitzer: string | null; primary_agent: string; status: string; erstellt_am: Date;
      expires_at: Date; source_plan_id: string; primary_plan_id: string | null }>(q(
      `SELECT t.wait_token::text AS id, t.project, COALESCE(t.waiting_agent, 'identity:' || t.waiting_identity_id) AS besitzer, t.primary_agent, t.status,
              t.created_at AS erstellt_am, t.expires_at, t.source_plan_id::text AS source_plan_id, t.primary_plan_id::text AS primary_plan_id
         FROM file_batch_waits t
        WHERE ${WS_ALTBESTAND_COEDIT_FAELLIG} AND t.expires_at < NOW() - $1::int * interval '1 day'
          AND ($2::text IS NULL OR t.project = $2)
          AND ($3::text[] IS NULL OR t.waiting_agent = ANY($3::text[]) OR t.waiting_identity_id = ANY($3::text[])
               OR ('identity:' || t.waiting_identity_id) = ANY($3::text[]) OR t.wait_token::text = ANY($3::text[]))
        ORDER BY t.expires_at, t.wait_token LIMIT $4`, [tage, project, ids ? ids.map((x) => (UUID_MUSTER.test(x) ? x.toLowerCase() : x)) : null, limit]));
    if (r.rows.length > WS_ALTBESTAND_AUSFUEHREN_LIMIT) gekappt = true;
    for (const z of r.rows.slice(0, WS_ALTBESTAND_AUSFUEHREN_LIMIT)) {
      kandidaten.push({ warteschlange: 'coedit_waits', id: z.id, project: z.project, empfaenger: z.besitzer ?? '(unbekannt)', absender: null,
        erstellt_am: iso(z.erstellt_am), status: z.status,
        vorher: { status: z.status, expires_at: iso(z.expires_at), traeger_plan_id: z.source_plan_id, primary_plan_id: z.primary_plan_id, primary_agent: z.primary_agent } });
    }
  }
  // Ausnahmen (Punkt 3 der Task): juengere Eintraege, Empfaenger mit lebendem Wrapper, Work-Jobs (nie).
  const [a] = (await db.query<Record<string, number>>(q(
    `SELECT
       (SELECT count(*)::int FROM specialist_inbox t WHERE t.processed IS NOT TRUE AND ($2::text IS NULL OR t.project = $2)
          AND t.created_at >= NOW() - $1::int * interval '1 day') AS inbox_juenger,
       (SELECT count(*)::int FROM specialist_inbox t WHERE t.processed IS NOT TRUE AND ($2::text IS NULL OR t.project = $2)
          AND t.created_at < NOW() - $1::int * interval '1 day' AND ${WRAPPER_LEBT('t.to_agent')}) AS inbox_empfaenger_aktiv,
       (SELECT count(*)::int FROM agent_zustellungen z LEFT JOIN agent_identitaeten i ON i.id = z.identity_id WHERE z.status = 'pending'
          AND ($2::text IS NULL OR i.project = $2) AND z.erstellt_am >= NOW() - $1::int * interval '1 day') AS zustellungen_juenger,
       (SELECT count(*)::int FROM agent_zustellungen z JOIN agent_identitaeten i ON i.id = z.identity_id WHERE z.status = 'pending'
          AND ($2::text IS NULL OR i.project = $2) AND z.erstellt_am < NOW() - $1::int * interval '1 day' AND ${WRAPPER_LEBT('i.agent_id')}) AS zustellungen_empfaenger_aktiv`,
    [tage, project]))).rows;
  let workJobs: Array<Record<string, unknown>> = [];
  try {
    workJobs = (await db.query(q(`SELECT kind, state, project, count(*)::int AS anzahl, min(created_at) AS aelteste FROM work_jobs
      WHERE state IN ('pending','leased','staged') AND ($1::text IS NULL OR project = $1) GROUP BY 1, 2, 3 ORDER BY 4 DESC`, [project]))).rows;
  } catch { workJobs = []; }
  let coedit: { juenger: number; nicht_abgelaufen: number } | null = null;
  if (ws === 'coedit_waits') {
    const [x] = (await db.query<{ juenger: number; nicht_abgelaufen: number }>(q(
      `SELECT count(*) FILTER (WHERE (${WS_ALTBESTAND_COEDIT_FAELLIG}) AND t.expires_at >= NOW() - $1::int * interval '1 day')::int AS juenger,
              count(*) FILTER (WHERE t.expires_at >= now())::int AS nicht_abgelaufen
         FROM file_batch_waits t WHERE t.status <> 'closed' AND ($2::text IS NULL OR t.project = $2)`, [tage, project]))).rows;
    coedit = { juenger: x?.juenger ?? 0, nicht_abgelaufen: x?.nicht_abgelaufen ?? 0 };
  }
  const stichtag = new Date(Date.now() - tage * 86_400_000).toISOString();
  return {
    tage, stichtag, kandidaten, gekappt,
    bestaetigung: wsAltbestandBestaetigung({ tage, project, warteschlange: ws, ids, ausnahmen: mitAusnahmen }, kandidaten),
    ausgenommen: {
      juenger_als_schwelle: { specialist_inbox: a?.inbox_juenger ?? 0, zustellungen: a?.zustellungen_juenger ?? 0, ...(coedit ? { coedit_waits: coedit.juenger } : {}) },
      empfaenger_aktiv: { specialist_inbox: a?.inbox_empfaenger_aktiv ?? 0, zustellungen: a?.zustellungen_empfaenger_aktiv ?? 0 },
      ...(coedit ? { coedit_nicht_abgelaufen: coedit.nicht_abgelaufen } : {}),
      work_jobs: { nie_ausgeblendet: true, grund: 'Work-Jobs sind Auftraege (z. B. Reverse-Leser-Nachzug unter reverse_pipeline_halt); sie werden nie ausgeblendet, nur ueber das zustaendige Werkzeug abgebrochen.', offen: workJobs },
    },
  };
}

/** P27-T10: Vorschau coedit_waits - Anzahl je Projekt und Wait-Status. */
export function zaehleCoeditJeProjektStatus(kandidaten: readonly WsAltbestandKandidat[]): Array<{ project: string | null; status: string; anzahl: number }> {
  const m = new Map<string, { project: string | null; status: string; anzahl: number }>();
  for (const k of kandidaten) {
    if (k.warteschlange !== 'coedit_waits') continue;
    const status = k.status ?? 'unbekannt';
    const key = (k.project ?? '') + '|' + status;
    const g = m.get(key) ?? { project: k.project, status, anzahl: 0 };
    g.anzahl++;
    m.set(key, g);
  }
  return [...m.values()].sort((x, y) => y.anzahl - x.anzahl || String(x.project).localeCompare(String(y.project)) || x.status.localeCompare(y.status));
}

/** Vorschau-Gruppen: je Warteschlange, Empfaenger und Projekt Anzahl, Alter und (Inbox) Absender. */
export function gruppiereWsAltbestand(kandidaten: readonly WsAltbestandKandidat[]): Array<Record<string, unknown>> {
  const m = new Map<string, { warteschlange: string; empfaenger: string; project: string | null; anzahl: number; aelteste: string; juengste: string; absender: Set<string> }>();
  for (const k of kandidaten) {
    const key = k.warteschlange + '|' + k.empfaenger + '|' + (k.project ?? '');
    const g = m.get(key) ?? { warteschlange: k.warteschlange, empfaenger: k.empfaenger, project: k.project, anzahl: 0, aelteste: k.erstellt_am, juengste: k.erstellt_am, absender: new Set<string>() };
    g.anzahl++;
    if (k.erstellt_am < g.aelteste) g.aelteste = k.erstellt_am;
    if (k.erstellt_am > g.juengste) g.juengste = k.erstellt_am;
    if (k.absender) g.absender.add(k.absender);
    m.set(key, g);
  }
  const jetzt = Date.now();
  return [...m.values()].sort((x, y) => y.anzahl - x.anzahl).map((g) => ({
    warteschlange: g.warteschlange, empfaenger: g.empfaenger, project: g.project, anzahl: g.anzahl,
    aelteste: g.aelteste, juengste: g.juengste, alter_tage: Math.floor((jetzt - Date.parse(g.aelteste)) / 86_400_000),
    ...(g.absender.size ? { absender: [...g.absender].sort().slice(0, 10) } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------
// Ausfuehren, Wiederherstellen, Status
// ---------------------------------------------------------------------------------------------
export interface WsAltbestandWer { wer: string; user_auftrag: string | null }

interface CoeditZeile {
  id: string; project: string; status: string; updated_at: string; expires_at: string; created_at: Date;
  waiting_agent: string | null; waiting_identity_id: string | null; primary_agent: string; primary_identity_id: string | null;
  source_plan_id: string; primary_plan_id: string | null; shared_files: string[]; deferred_ops: unknown; deferred_op_indexes: number[];
  traeger_status: string | null; traeger_ops: number | null;
}

export async function fuehreWsAltbestandAus(o: WsAltbestandFilter & { bestaetigung: unknown; grund?: string | null; wer: WsAltbestandWer }): Promise<Record<string, unknown>> {
  const schalter = await leseWsAltbestandSchalter();
  if (!schalter.aktiv) fehler('funktion_aus', { schalter: WS_ALTBESTAND_FUNKTION, quelle: schalter.quelle, letzter_fehler: schalter.letzter_fehler });
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('warteschlangen-altbestand'))");
    const erm = await ermittleWsAltbestand(o, c);
    if (erm.gekappt) fehler('zu_viele_kandidaten', { limit: WS_ALTBESTAND_AUSFUEHREN_LIMIT, hinweis: 'Mit project, warteschlange oder aufraeumen_ids eingrenzen.' });
    if (typeof o.bestaetigung !== 'string' || o.bestaetigung !== erm.bestaetigung) {
      fehler(o.bestaetigung ? 'vorschau_veraltet' : 'bestaetigung_fehlt', { anzahl_jetzt: erm.kandidaten.length,
        hinweis: 'Zuerst aufraeumen_modus vorschau; deren bestaetigung mit denselben tage/project/warteschlange/aufraeumen_ids mitgeben.' });
    }
    const lauf = randomUUID();
    const grund = o.grund && o.grund.trim() ? o.grund.trim() : 'Altbestand aelter als ' + erm.tage + ' Tage (P27-T11)';
    const inbox = erm.kandidaten.filter((k) => k.warteschlange === 'specialist_inbox');
    const zust = erm.kandidaten.filter((k) => k.warteschlange === 'zustellungen');
    let nInbox = 0, nZust = 0;
    if (inbox.length) {
      const r = await c.query(q(
        `WITH u AS (UPDATE specialist_inbox t SET processed = true WHERE t.id = ANY($1::int[]) AND t.processed IS NOT TRUE
                     RETURNING t.id, t.project, t.to_agent, t.created_at)
         INSERT INTO warteschlangen_ausblendungen(warteschlange, eintrag_id, project, empfaenger, eintrag_erstellt_am, vorher,
                ausgeblendet_von, ausgeblendet_grund, user_auftrag, schwelle_tage, lauf_id)
         SELECT 'specialist_inbox', u.id, u.project, u.to_agent, u.created_at,
                CASE WHEN v.ausnahme IS NULL THEN jsonb_build_object('processed', v.processed)
                     ELSE jsonb_build_object('processed', v.processed, 'ausnahme', string_to_array(v.ausnahme, ',')) END, $3, $4, $5, $6, $7
           FROM u JOIN unnest($1::int[], $2::boolean[], $8::text[]) AS v(id, processed, ausnahme) ON v.id = u.id RETURNING eintrag_id`,
        [inbox.map((k) => Number(k.id)), inbox.map((k) => (k.vorher.processed as boolean | null) ?? null), o.wer.wer, grund, o.wer.user_auftrag, erm.tage, lauf,
          inbox.map((k) => (k.ausnahme?.length ? k.ausnahme.join(',') : null))]));
      nInbox = r.rowCount ?? 0;
    }
    if (zust.length) {
      const r = await c.query(q(
        `WITH u AS (UPDATE agent_zustellungen z SET status = 'ausgeblendet' WHERE z.id = ANY($1::bigint[]) AND z.status = 'pending' AND $3::text IS NOT NULL
                     RETURNING z.id, z.identity_id, z.erstellt_am, z.weg, z.versuche)
         INSERT INTO warteschlangen_ausblendungen(warteschlange, eintrag_id, project, empfaenger, eintrag_erstellt_am, vorher,
                ausgeblendet_von, ausgeblendet_grund, user_auftrag, schwelle_tage, lauf_id)
         SELECT 'zustellungen', u.id, i.project, COALESCE(i.agent_id, u.identity_id), u.erstellt_am,
                jsonb_build_object('status', 'pending', 'letzter_grund', v.letzter_grund, 'weg', u.weg, 'versuche', u.versuche), $4, $5, $6, $7, $8
           FROM u LEFT JOIN agent_identitaeten i ON i.id = u.identity_id JOIN unnest($1::bigint[], $2::text[]) AS v(id, letzter_grund) ON v.id = u.id
         RETURNING eintrag_id`,
        [zust.map((k) => k.id), zust.map((k) => (k.vorher.letzter_grund as string | null) ?? null), lauf, o.wer.wer, grund, o.wer.user_auftrag, erm.tage, lauf]));
      nZust = r.rowCount ?? 0;
    }
    // P27-T10: Co-Edit-Waits auf dem Schliessweg von intern waits_tot; je Wait frisch gesperrt und erneut geprueft.
    const waits = erm.kandidaten.filter((k) => k.warteschlange === 'coedit_waits');
    let nWaits = 0, nTraeger = 0;
    for (const k of waits) {
      const f = (await c.query<CoeditZeile>(q(
        `SELECT t.wait_token::text AS id, t.project, t.status, t.updated_at::text AS updated_at, t.expires_at::text AS expires_at, t.created_at,
                t.waiting_agent, t.waiting_identity_id, t.primary_agent, t.primary_identity_id, t.source_plan_id::text AS source_plan_id,
                t.primary_plan_id::text AS primary_plan_id, t.shared_files, t.deferred_ops, t.deferred_op_indexes,
                p.status::text AS traeger_status, jsonb_array_length(p.ops)::int AS traeger_ops
           FROM file_batch_waits t LEFT JOIN file_batch_plans p ON p.id = t.source_plan_id
          WHERE t.wait_token = $1::uuid AND ${WS_ALTBESTAND_COEDIT_FAELLIG} AND t.expires_at < NOW() - $2::int * interval '1 day'
          FOR UPDATE OF t`, [k.id, erm.tage]))).rows[0];
      if (!f) continue; // inzwischen geschlossen oder erneuert: unberuehrt
      const s = await schliesseWaitUndLeerenTraeger(c, { wait_token: f.id, traeger_plan_id: f.source_plan_id,
        vermerk: `[Traegerplan geschlossen durch admin warteschlangen_aufraeumen coedit_waits, Lauf ${lauf}, Wait ${f.id}]` });
      if (!s.geschlossen) continue;
      const vorher = { status: f.status, updated_at: f.updated_at, expires_at: f.expires_at, primary_plan_id: f.primary_plan_id,
        waiting_agent: f.waiting_agent, waiting_identity_id: f.waiting_identity_id, primary_agent: f.primary_agent, primary_identity_id: f.primary_identity_id,
        shared_files: f.shared_files, op_indexes: f.deferred_op_indexes, ops: f.deferred_ops,
        traeger_plan_id: f.source_plan_id, traeger_status: f.traeger_status, traeger_ops: f.traeger_ops,
        traeger_verworfen: s.traeger_verworfen, traeger_reason_vorher: s.traeger_reason_vorher };
      await c.query(q(
        `INSERT INTO warteschlangen_ausblendungen(warteschlange, eintrag_id, eintrag_uuid, project, empfaenger, eintrag_erstellt_am, vorher,
                ausgeblendet_von, ausgeblendet_grund, user_auftrag, schwelle_tage, lauf_id)
         VALUES ('coedit_waits', NULL, $1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [f.id, f.project, k.empfaenger, f.created_at, JSON.stringify(vorher), o.wer.wer, grund, o.wer.user_auftrag, erm.tage, lauf]));
      nWaits++;
      if (s.traeger_verworfen) nTraeger++;
    }
    await c.query('COMMIT');
    leereWsAltbestandCache();
    const mitCoedit = o.warteschlange === 'coedit_waits';
    return { lauf_id: lauf, tage: erm.tage, grund,
      ausgeblendet: { specialist_inbox: nInbox, zustellungen: nZust, ...(mitCoedit ? { coedit_waits: nWaits } : {}), gesamt: nInbox + nZust + nWaits },
      ...(mitCoedit ? { coedit_traeger_verworfen: nTraeger } : {}),
      hinweis: 'Nichts geloescht. Rueckweg: aufraeumen_modus wiederherstellen mit aufraeumen_lauf_id ' + lauf + ' und grund.' };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function stelleWsAltbestandWiederHer(o: { lauf_id: string | null; ids: readonly string[] | null; alle: boolean; project: string | null;
  warteschlange: WsAltbestandWarteschlange | null; grund: string; wer: WsAltbestandWer }): Promise<Record<string, unknown>> {
  const ids = o.ids && o.ids.length ? o.ids.filter((x) => /^[1-9][0-9]{0,18}$/.test(x) || UUID_MUSTER.test(x)).map((x) => x.toLowerCase()) : null;
  if (!o.lauf_id && !ids?.length && !o.alle) fehler('auswahl_fehlt', { hinweis: 'aufraeumen_lauf_id, aufraeumen_ids (Eintrags-IDs) oder aufraeumen_alle:true angeben.' });
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('warteschlangen-altbestand'))");
    const m = (await c.query<{ id: string; warteschlange: WsAltbestandWarteschlange; eintrag_id: string; vorher: Record<string, unknown>; lauf_id: string }>(q(
      `SELECT id::text, warteschlange, COALESCE(eintrag_uuid::text, eintrag_id::text) AS eintrag_id, vorher, lauf_id FROM warteschlangen_ausblendungen
        WHERE wiederhergestellt_am IS NULL AND ($1::text IS NULL OR lauf_id = $1) AND ($2::text[] IS NULL OR COALESCE(eintrag_uuid::text, eintrag_id::text) = ANY($2::text[]))
          AND ($3::text IS NULL OR project = $3) AND ($4::text IS NULL OR warteschlange = $4)
        ORDER BY id FOR UPDATE`, [o.lauf_id, ids, o.project, o.warteschlange]))).rows;
    let traegerWiederOffen = 0;
    const fertig: string[] = [], fehlt: string[] = [], geaendert: Array<{ warteschlange: string; eintrag_id: string }> = [];
    for (const z of m) {
      let r;
      if (z.warteschlange === 'specialist_inbox') {
        const vorher = z.vorher?.processed === undefined ? null : z.vorher.processed;
        r = await c.query(q('UPDATE specialist_inbox SET processed = $2::boolean WHERE id = $1::int AND processed IS TRUE RETURNING id', [z.eintrag_id, vorher]));
        if (!r.rowCount) {
          const da = (await c.query(q('SELECT 1 FROM specialist_inbox WHERE id = $1::int', [z.eintrag_id]))).rowCount;
          if (da) { geaendert.push({ warteschlange: z.warteschlange, eintrag_id: z.eintrag_id }); continue; }
        }
      } else if (z.warteschlange === 'coedit_waits') {
        // P27-T10: Wait mit gespeichertem Status und updated_at zurueck, verworfenen Traeger mit altem reason wieder offen.
        const v = z.vorher ?? {};
        const w = await oeffneWaitWieder(c, { wait_token: z.eintrag_id, status: String(v.status ?? 'waiting'),
          updated_at: typeof v.updated_at === 'string' ? v.updated_at : null,
          traeger_plan_id: typeof v.traeger_plan_id === 'string' ? v.traeger_plan_id : null,
          traeger_verworfen: v.traeger_verworfen === true,
          traeger_reason_vorher: typeof v.traeger_reason_vorher === 'string' ? v.traeger_reason_vorher : null });
        if (!w.wieder_offen && !w.wait_fehlt) { geaendert.push({ warteschlange: z.warteschlange, eintrag_id: z.eintrag_id }); continue; }
        if (w.traeger_wieder_offen) traegerWiederOffen++;
        r = { rowCount: w.wieder_offen ? 1 : 0 };
      } else {
        r = await c.query(q(`UPDATE agent_zustellungen SET status = $2 WHERE id = $1::bigint AND status = 'ausgeblendet' RETURNING id`,
          [z.eintrag_id, String(z.vorher?.status ?? 'pending')]));
        if (!r.rowCount) {
          const da = (await c.query(q('SELECT 1 FROM agent_zustellungen WHERE id = $1::bigint', [z.eintrag_id]))).rowCount;
          if (da) { geaendert.push({ warteschlange: z.warteschlange, eintrag_id: z.eintrag_id }); continue; }
        }
      }
      // Wiederhergestellt oder der Eintrag existiert nicht mehr (dann bleibt nur die Historie): Markierung schliessen.
      (r.rowCount ? fertig : fehlt).push(z.eintrag_id);
      await c.query(q('UPDATE warteschlangen_ausblendungen SET wiederhergestellt_am = NOW(), wiederhergestellt_von = $2, wiederhergestellt_grund = $3 WHERE id = $1::bigint',
        [z.id, o.wer.wer, o.grund + (r.rowCount ? '' : ' (Eintrag nicht mehr vorhanden)')]));
    }
    await c.query('COMMIT');
    leereWsAltbestandCache();
    return { gefunden: m.length, wiederhergestellt: fertig.length, eintrag_fehlt: fehlt.length, geaendert,
      ...(traegerWiederOffen ? { traeger_wieder_offen: traegerWiederOffen } : {}),
      ...(geaendert.length ? { hinweis: 'geaendert = Eintrag seit dem Ausblenden veraendert; Markierung bleibt offen, nichts ueberschrieben.' } : {}) };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function leseWsAltbestandStatus(project: string | null): Promise<Record<string, unknown>> {
  const pool = getPool();
  const [schalter, schwelle] = await Promise.all([leseWsAltbestandSchalter(), leseWsAltbestandSchwelle()]);
  let offen: unknown[] = [], laeufe: unknown[] = [], letzter_fehler: string | null = null;
  try {
    offen = (await pool.query(q(`SELECT warteschlange, count(*)::int AS anzahl FROM warteschlangen_ausblendungen
      WHERE wiederhergestellt_am IS NULL AND ($1::text IS NULL OR project = $1) GROUP BY 1 ORDER BY 1`, [project]))).rows;
    laeufe = (await pool.query(q(`SELECT lauf_id, min(ausgeblendet_am) AS am, count(*)::int AS anzahl,
        count(*) FILTER (WHERE wiederhergestellt_am IS NULL)::int AS noch_ausgeblendet, min(ausgeblendet_von) AS von, min(schwelle_tage) AS schwelle_tage
      FROM warteschlangen_ausblendungen WHERE ($1::text IS NULL OR project = $1) GROUP BY lauf_id ORDER BY min(ausgeblendet_am) DESC LIMIT 5`, [project]))).rows;
  } catch (e) { letzter_fehler = String((e as { code?: string }).code ?? (e as Error).message).slice(0, 120); }
  return { schalter, schwelle, filter_wirksam: schalter.aktiv, offene_ausblendungen: offen, letzte_laeufe: laeufe, ...(letzter_fehler ? { letzter_fehler } : {}) };
}

// ---------------------------------------------------------------------------------------------
// admin(action:'warteschlangen_aufraeumen')
// ---------------------------------------------------------------------------------------------
export const WS_ALTBESTAND_ADMIN_ACTIONS = ['warteschlangen_aufraeumen'] as const;
export const WS_ALTBESTAND_MODI = ['vorschau', 'ausfuehren', 'wiederherstellen', 'status', 'einstellen'] as const;
/** Nur ein NEUER Parameter; sonst die vorhandenen aufraeumen_* (agent-entfernung.ts), grund, user_auftrag, project. */
export const WS_ALTBESTAND_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  warteschlange: { type: 'string', enum: [...WS_ALTBESTAND_WARTESCHLANGEN], description: 'warteschlangen_aufraeumen (P27-T11, Altbestand ausblenden, nie loeschen): nur diese Warteschlange (ohne = specialist_inbox und zustellungen; coedit_waits nur ausdruecklich (P27-T10): abgelaufene, nicht geschlossene Co-Edit-Waits wie der Stau-Waechter, Schwelle ab expires_at, geschlossen wie bei intern waits_tot; work_jobs nie). Modus/Schwelle/Bestaetigung/Rueckweg ueber aufraeumen_modus, aufraeumen_tage, aufraeumen_ids (vorschau/ausfuehren: Empfaenger, bei coedit_waits Besitzer oder Wait-Token; wiederherstellen: Eintrags-IDs bzw. Wait-Token), aufraeumen_bestaetigung, aufraeumen_lauf_id, aufraeumen_alle, grund, user_auftrag' },
  aufraeumen_ausnahmen_einschliessen: { type: 'boolean', description: 'warteschlangen_aufraeumen vorschau/ausfuehren (P27-T10): nur mit warteschlange specialist_inbox UND aufraeumen_ids (Empfaenger oder Inbox-IDs) - auch benannte Eintraege an Empfaenger mit lebendem Wrapper bzw. juenger als die Schwelle; nie pauschal, Rueckweg wiederherstellen' },
};
export function istWsAltbestandAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (WS_ALTBESTAND_ADMIN_ACTIONS as readonly string[]).includes(action);
}
function textListe(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : null;
}

export async function fuehreWsAltbestandAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const projektArg = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
    const project = projektArg ?? (wer.art === 'identitaet' ? wer.principal.project : null);
    const modus = typeof args.aufraeumen_modus === 'string' ? args.aufraeumen_modus : 'vorschau';
    if (!(WS_ALTBESTAND_MODI as readonly string[]).includes(modus)) fehler('modus_unbekannt', { erlaubt: WS_ALTBESTAND_MODI });
    const lesen = async () => { await pruefeProfilVerwalter(wer, project); };
    const schreiben = async (): Promise<WsAltbestandWer> => {
      const v = await pruefeProfilVerwalter(wer, project);
      const auftrag = wer.art === 'user' ? (typeof args.user_auftrag === 'string' && args.user_auftrag.trim() ? args.user_auftrag.trim() : null) : pflichtText(args.user_auftrag, 'user_auftrag_fehlt');
      return { wer: v.wer, user_auftrag: auftrag };
    };
    const tage = args.aufraeumen_tage === undefined || args.aufraeumen_tage === null ? undefined : Number(args.aufraeumen_tage);
    if (tage !== undefined && modus !== 'einstellen' && (!Number.isInteger(tage) || tage < WS_ALTBESTAND_MIN_TAGE || tage > WS_ALTBESTAND_MAX_TAGE)) {
      fehler('tage_ungueltig', { min: WS_ALTBESTAND_MIN_TAGE, max: WS_ALTBESTAND_MAX_TAGE });
    }
    const wsArg = args.warteschlange;
    if (wsArg !== undefined && wsArg !== null && !(WS_ALTBESTAND_WARTESCHLANGEN as readonly unknown[]).includes(wsArg)) {
      fehler('warteschlange_unbekannt', { erlaubt: WS_ALTBESTAND_WARTESCHLANGEN, hinweis: 'work_jobs werden nie ausgeblendet.' });
    }
    const warteschlange = (wsArg ?? null) as WsAltbestandWarteschlange | null;
    const ids = textListe(args.aufraeumen_ids);
    // P27-T10: Ausnahmen nur gezielt - specialist_inbox mit benannten ids, nie pauschal.
    const ausnahmen = args.aufraeumen_ausnahmen_einschliessen === true;
    if (ausnahmen && (modus === 'vorschau' || modus === 'ausfuehren')) {
      if (!ids?.length) fehler('ausnahmen_nur_mit_ids', { hinweis: 'aufraeumen_ausnahmen_einschliessen nur zusammen mit aufraeumen_ids (Empfaenger oder Inbox-IDs).' });
      if (warteschlange !== 'specialist_inbox') fehler('ausnahmen_nur_specialist_inbox', { hinweis: 'aufraeumen_ausnahmen_einschliessen gilt nur mit warteschlange specialist_inbox.' });
    }
    switch (modus) {
      case 'status':
        await lesen();
        return { success: true, action, modus, project, ...(await leseWsAltbestandStatus(project)) };
      case 'vorschau': {
        await lesen();
        const [schalter, schwelle, erm] = await Promise.all([leseWsAltbestandSchalter(), leseWsAltbestandSchwelle(), ermittleWsAltbestand({ tage, project, warteschlange, ids, ausnahmen_einschliessen: ausnahmen })]);
        const gruppen = gruppiereWsAltbestand(erm.kandidaten);
        return { success: true, action, modus, schalter, schwelle, tage: erm.tage, stichtag: erm.stichtag, project, warteschlange,
          anzahl: { specialist_inbox: erm.kandidaten.filter((k) => k.warteschlange === 'specialist_inbox').length,
            zustellungen: erm.kandidaten.filter((k) => k.warteschlange === 'zustellungen').length,
            ...(warteschlange === 'coedit_waits' ? { coedit_waits: erm.kandidaten.filter((k) => k.warteschlange === 'coedit_waits').length } : {}),
            gesamt: erm.kandidaten.length },
          ...(warteschlange === 'coedit_waits' ? { coedit_je_projekt_status: zaehleCoeditJeProjektStatus(erm.kandidaten) } : {}),
          ...(ausnahmen ? { ausnahmen_einschliessen: true, davon_ausnahmen: erm.kandidaten.filter((k) => k.ausnahme?.length).length } : {}),
          kandidaten_gekappt: erm.gekappt, gruppen: gruppen.slice(0, GRUPPEN_LIMIT), gruppen_gekappt: gruppen.length > GRUPPEN_LIMIT,
          beispiele: erm.kandidaten.slice(0, BEISPIELE_LIMIT).map((k) => ({ warteschlange: k.warteschlange, id: k.id, project: k.project, empfaenger: k.empfaenger, absender: k.absender, erstellt_am: k.erstellt_am, ...(k.status ? { status: k.status } : {}), ...(k.ausnahme?.length ? { ausnahme: k.ausnahme } : {}) })),
          ausgenommen: erm.ausgenommen, bestaetigung: erm.bestaetigung,
          hinweis: (schalter.aktiv ? 'ausfuehren mit dieser bestaetigung (und denselben tage/project/warteschlange/aufraeumen_ids) blendet genau diese Eintraege aus.'
            : 'Produkt-Schalter warteschlangen_altbestand ist AUS: ausfuehren wird abgewiesen, bis er freigegeben ist.')
            + ' Nichts wird geloescht: Inbox-Eintraege werden als erledigt markiert, Zustellungen beendet'
            + (warteschlange === 'coedit_waits' ? ', Co-Edit-Waits geschlossen wie bei intern waits_tot (leerer Traeger verworfen, Ops bleiben in Wait und vorher)' : '')
            + '; wiederherstellen stellt den vorherigen Zustand her.' };
      }
      case 'ausfuehren': {
        const w = await schreiben();
        const r = await fuehreWsAltbestandAus({ tage, project, warteschlange, ids, ausnahmen_einschliessen: ausnahmen, bestaetigung: args.aufraeumen_bestaetigung,
          grund: typeof args.grund === 'string' ? args.grund : null, wer: w });
        return { success: true, action, modus, ...r };
      }
      case 'wiederherstellen': {
        const w = await schreiben();
        const r = await stelleWsAltbestandWiederHer({ lauf_id: typeof args.aufraeumen_lauf_id === 'string' && args.aufraeumen_lauf_id.trim() ? args.aufraeumen_lauf_id.trim() : null,
          ids, alle: args.aufraeumen_alle === true, project: projektArg ?? (wer.art === 'user' ? null : project), warteschlange,
          grund: pflichtText(args.grund, 'grund_fehlt'), wer: w });
        return { success: true, action, modus, ...r };
      }
      default: {
        const w = await schreiben();
        const s = await setzeWsAltbestandSchwelle({ tage: args.aufraeumen_tage, grund: pflichtText(args.grund, 'grund_fehlt'), wer: w.wer });
        return { success: true, action, modus, schwelle: s };
      }
    }
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'warteschlangen_aufraeumen_fehler', message: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
