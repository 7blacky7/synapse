/**
 * P22-T80: alte Agenten weich als 'entfernt' markieren (Entwurf thought 66c2f47d).
 * Eine Markierung je Agent in agent_entfernungen (Schema 126); KEINE Daten werden geaendert oder geloescht (Verlauf, Thoughts, Memories,
 * Tool-Calls, Skills, Ausweise bleiben). Entfernte Agenten verschwinden aus den Listen (Filter unten), solange der Produkt-Schalter
 * 'agenten_entfernung' EIN ist; ein Agent, der sich wieder meldet, wird automatisch wiederhergestellt.
 *
 * ALT = keine Spur des Agenten juenger als die Schwelle (Einstellung agenten_entfernung_schwelle_tage, Standard 30, Quelle sichtbar).
 * Spuren: Sitzung, Wrapper-Status, Tool-Calls, Tool-Aktivitaet, Thoughts, Channel-Nachrichten, Verbrauch, Identitaets-Aktivitaet.
 * NIE: Koordinator, Main (rolle main/Main-Identitaet), geschuetzte Namen, offene Runtime-Auftraege, aktive Dateireservierungen.
 *
 * admin(action:'agenten_aufraeumen', aufraeumen_modus vorschau | ausfuehren | wiederherstellen | status | einstellen):
 *   vorschau/status: User und Koordinator (Koordinator nur sein Projekt, User auch alle Projekte);
 *   ausfuehren/wiederherstellen/einstellen: User, oder Koordinator mit Pflicht-Parameter user_auftrag (wird protokolliert).
 *   ausfuehren braucht die bestaetigung der zuletzt gezeigten Vorschau (Hash der Kandidatenliste) und den Schalter EIN.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { MAIN_ROLLE } from './agent-profil-vertrag.js';
import { hauptagentIdentitaetsId } from './hauptagent-dienst.js';
import { rolleFuerAgent } from './agent-rollen.js';

export const AGENT_ENTFERNUNG_FUNKTION = 'agenten_entfernung' as const;
export const AGENT_ENTFERNUNG_STANDARD_TAGE = 30;
export const AGENT_ENTFERNUNG_MIN_TAGE = 7;
export const AGENT_ENTFERNUNG_MAX_TAGE = 3650;
const SCHWELLE_NAME = 'schwelle_tage';
const VORSCHAU_LIMIT = 500;
const AUSFUEHREN_LIMIT = 2000;
/** Namen, die nie entfernt werden (Koordinator-Rollen erkennt zusaetzlich rolleFuerAgent). */
const GESCHUETZTE_IDS = new Set(['koordinator', 'hauptagent', 'user', 'main']);

type Q = QueryConfig & { query_timeout: number };
type Db = Pick<PoolClient, 'query'>;
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }
const TAG_MS = 86_400_000;
const ABFRAGE_MS = 60_000;
const q = (text: string, values: unknown[] = []): Q => ({ text, values, query_timeout: ABFRAGE_MS } as Q);

// ---------------------------------------------------------------------------------------------
// Schalter und Einstellung
// ---------------------------------------------------------------------------------------------
export interface EntfernungSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter';
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

/** Produkt-Schalter 'agenten_entfernung' (Standard AUS, nur ausdruecklich). Frisch gelesen; Lesefehler -> AUS mit letzter_fehler. */
export async function leseEntfernungSchalter(): Promise<EntfernungSchalter> {
  const p = await leseProfilProduktSchalter(AGENT_ENTFERNUNG_FUNKTION, null);
  const aktiv = p.quelle === 'produkt-schalter' ? p.aktiv : false;
  return { aktiv, quelle: p.quelle === 'produkt-schalter' ? 'produkt-schalter' : 'standard', gesetzt_von: p.gesetzt_von, gesetzt_am: p.gesetzt_am, grund: p.grund, letzter_fehler: p.letzter_fehler };
}

export interface EntfernungSchwelle { tage: number; quelle: 'standard' | 'einstellung'; standard: number; min: number; max: number; gesetzt_von: string | null; gesetzt_am: string | null }

export async function leseEntfernungSchwelle(db: Db = getPool()): Promise<EntfernungSchwelle> {
  const basis: EntfernungSchwelle = { tage: AGENT_ENTFERNUNG_STANDARD_TAGE, quelle: 'standard', standard: AGENT_ENTFERNUNG_STANDARD_TAGE,
    min: AGENT_ENTFERNUNG_MIN_TAGE, max: AGENT_ENTFERNUNG_MAX_TAGE, gesetzt_von: null, gesetzt_am: null };
  try {
    const r = await db.query<{ wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(q('SELECT wert, gesetzt_von, gesetzt_am FROM agent_entfernung_einstellungen WHERE name = $1', [SCHWELLE_NAME]));
    const z = r.rows[0];
    const n = Number(z?.wert);
    if (z && Number.isInteger(n) && n >= AGENT_ENTFERNUNG_MIN_TAGE && n <= AGENT_ENTFERNUNG_MAX_TAGE) return { ...basis, tage: n, quelle: 'einstellung', gesetzt_von: z.gesetzt_von, gesetzt_am: z.gesetzt_am.toISOString() };
  } catch { /* Tabelle fehlt noch (Schema alt): Standard */ }
  return basis;
}

let schalterCache: { bis: number; aktiv: boolean } | null = null;
/** Fuer die Filter der Listen: kurz gepuffert (Hot-Path). AUS = nichts wird ausgeblendet. */
export async function entfernungFilterAktiv(): Promise<boolean> {
  if (schalterCache && schalterCache.bis > Date.now()) return schalterCache.aktiv;
  let aktiv = false;
  try { aktiv = (await leseEntfernungSchalter()).aktiv; } catch { aktiv = false; }
  schalterCache = { bis: Date.now() + 5000, aktiv };
  return aktiv;
}
export function leereEntfernungCache(): void { schalterCache = null; }

/** SQL-Fragment (WHERE-Teil) fuer Legacy-Agenten: 'TRUE' bei Schalter AUS, sonst "keine offene Markierung". Spalten nur als feste Bezeichner. */
export async function legacyNichtEntfernt(projektSpalte: string, agentSpalte: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(projektSpalte) || !/^[a-z_][a-z0-9_.]*$/i.test(agentSpalte)) throw new Error('ungueltige Spalte');
  if (!(await entfernungFilterAktiv())) return 'TRUE';
  return `NOT EXISTS (SELECT 1 FROM agent_entfernungen e_ WHERE e_.art = 'legacy' AND e_.project = ${projektSpalte} AND e_.agent_id = ${agentSpalte} AND e_.wiederhergestellt_am IS NULL)`;
}
/** Wie legacyNichtEntfernt fuer Identitaeten (Spalte mit der Identitaets-ID). */
export async function identitaetNichtEntfernt(identitySpalte: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(identitySpalte)) throw new Error('ungueltige Spalte');
  if (!(await entfernungFilterAktiv())) return 'TRUE';
  return `NOT EXISTS (SELECT 1 FROM agent_entfernungen e_ WHERE e_.art = 'identitaet' AND e_.identity_id = ${identitySpalte} AND e_.wiederhergestellt_am IS NULL)`;
}

export interface EntferntMengen { legacy: ReadonlySet<string>; identitaet: ReadonlySet<string> }
/** Offene Markierungen eines Projekts - nur bei EIN geschaltetem Schalter (sonst null = nichts ausblenden). Fehler -> null (lieber sichtbar als weg). */
export async function ladeEntferntMengen(project: string, db: Db = getPool()): Promise<EntferntMengen | null> {
  try {
    if (!(await entfernungFilterAktiv())) return null;
    const r = await db.query<{ art: EntfernungArt; agent_id: string; identity_id: string | null }>(q(
      'SELECT art, agent_id, identity_id FROM agent_entfernungen WHERE project = $1 AND wiederhergestellt_am IS NULL', [project]));
    if (!r.rows.length) return null;
    return { legacy: new Set(r.rows.filter((z) => z.art === 'legacy').map((z) => z.agent_id)), identitaet: new Set(r.rows.filter((z) => z.identity_id).map((z) => z.identity_id as string)) };
  } catch { return null; }
}
/** Schluessel der Channel-Uebersicht: 'legacy:<name>' oder 'identity:<id>'. */
export function schluesselEntfernt(ent: EntferntMengen | null, schluesselText: string): boolean {
  if (!ent) return false;
  if (schluesselText.startsWith('identity:')) return ent.identitaet.has(schluesselText.slice(9));
  return ent.legacy.has(schluesselText.startsWith('legacy:') ? schluesselText.slice(7) : schluesselText);
}
/** Zeilen ohne entfernte Agenten (Identitaet vor Name). Ohne Schalter/Markierungen unveraendert. */
export async function ohneEntfernte<T>(project: string, zeilen: T[], key: (z: T) => { agent?: string | null; identity?: string | null }): Promise<T[]> {
  const ent = await ladeEntferntMengen(project);
  if (!ent) return zeilen;
  return zeilen.filter((z) => {
    const k = key(z);
    if (k.identity) return !ent.identitaet.has(k.identity);
    return !(k.agent && ent.legacy.has(k.agent));
  });
}
/** Ausweis-/Profiluebersicht: Feld entfernt{am,grund} fuer markierte Identitaeten; bei wirksamem Filter ohne sie, ausser mitEntfernten. */
export async function markiereEntfernteProfile<T extends { identity_id: string }>(project: string, zeilen: T[], mitEntfernten: boolean): Promise<Array<T & { entfernt?: { am: string; grund: string } }>> {
  try {
    const r = await getPool().query<{ identity_id: string; entfernt_am: Date; entfernt_grund: string }>(q(
      "SELECT identity_id, entfernt_am, entfernt_grund FROM agent_entfernungen WHERE project = $1 AND art = 'identitaet' AND wiederhergestellt_am IS NULL", [project]));
    if (!r.rows.length) return zeilen;
    const map = new Map(r.rows.map((z) => [z.identity_id, { am: z.entfernt_am.toISOString(), grund: z.entfernt_grund }]));
    const verstecken = !mitEntfernten && (await entfernungFilterAktiv());
    return zeilen.filter((z) => !(verstecken && map.has(z.identity_id))).map((z) => (map.has(z.identity_id) ? { ...z, entfernt: map.get(z.identity_id) } : z));
  } catch { return zeilen; }
}

/**
 * Rueckkehr: meldet sich ein entfernter Agent wieder (chat register / Anmeldung), schliesst das die Markierung automatisch -
 * sonst waere ein aktiver Agent unsichtbar. Wirft nie; ohne Markierung ein indizierter UPDATE ohne Treffer.
 */
export async function markiereRueckkehr(project: string, agentId: string, identityId?: string | null, db: Db = getPool()): Promise<number> {
  try {
    const r = await db.query(q(
      `UPDATE agent_entfernungen SET wiederhergestellt_am = NOW(), wiederhergestellt_von = 'auto:anmeldung', wiederhergestellt_grund = 'Agent hat sich wieder gemeldet'
        WHERE wiederhergestellt_am IS NULL AND ((art = 'legacy' AND project = $1 AND agent_id = $2) OR (art = 'identitaet' AND identity_id = $3))`,
      [project, agentId, identityId ?? null]));
    return r.rowCount ?? 0;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------------------------
// Kandidaten
// ---------------------------------------------------------------------------------------------
export type EntfernungArt = 'legacy' | 'identitaet';
export interface EntfernungKandidat {
  art: EntfernungArt; project: string; agent_id: string; identity_id: string | null; name: string | null; rolle: string | null;
  modell: string | null; status: string | null; letzte_aktivitaet: string | null; letzte_spur: string | null;
  /** Hinweise, die NICHT von der Entfernung ausnehmen (z. B. offene_task:P22-T75 = Beteiligter einer offenen Task). */
  warnungen: string[];
}
export interface EntfernungAusnahme { art: EntfernungArt; project: string; agent_id: string; identity_id: string | null; grund: string }
export interface EntfernungErmittlung {
  tage: number; stichtag: string; kandidaten: EntfernungKandidat[]; ausgenommen: EntfernungAusnahme[]; bestaetigung: string;
}
interface Agent { art: EntfernungArt; project: string; agent_id: string; identity_id: string | null; name: string | null; rolle: string | null; modell: string | null;
  status: string | null; basis: Date | null }

const schluessel = (project: string | null | undefined, agent: string) => `${project ?? '*'}|${agent}`;
const maxDatum = (a: Date | null, b: Date | null): Date | null => (a && b ? (a > b ? a : b) : a ?? b);

export function bestaetigungFuer(tage: number, kandidaten: ReadonlyArray<Pick<EntfernungKandidat, 'art' | 'project' | 'agent_id'>>): string {
  const zeilen = kandidaten.map((k) => `${k.art}|${k.project}|${k.agent_id}`).sort();
  return createHash('sha256').update(`${tage}\n${zeilen.join('\n')}`).digest('hex').slice(0, 16);
}

/** Alle Agenten (ohne bereits offen markierte) einer Auswahl. */
async function ladeAgenten(db: Db, project: string | null): Promise<Agent[]> {
  const legacy = await db.query<{ project: string; agent_id: string; model: string | null; status: string | null; basis: Date | null }>(q(
    `SELECT s.project, s.id AS agent_id, s.model, s.status, COALESCE(s.sitzung_seit, s.registered_at) AS basis
       FROM agent_sessions s WHERE s.identity_id IS NULL AND ($1::text IS NULL OR s.project = $1)
     UNION ALL
     SELECT w.project, w.agent_name, w.model, w.status, w.last_activity FROM wrapper_status w
      WHERE ($1::text IS NULL OR w.project = $1)
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s2 WHERE s2.id = w.agent_name AND s2.project = w.project)`, [project]));
  const ident = await db.query<{ id: string; project: string; agent_id: string; name: string; rolle: string; status: string; modell: string | null; zuletzt_aktiv: Date | null; erstellt_am: Date | null }>(q(
    `SELECT i.id, i.project, i.agent_id, i.name, i.rolle, i.status, COALESCE(i.modell_bestaetigt, i.modell_selbstauskunft) AS modell, i.zuletzt_aktiv, i.erstellt_am
       FROM agent_identitaeten i WHERE ($1::text IS NULL OR i.project = $1)`, [project]));
  const offen = await db.query<{ art: EntfernungArt; project: string; agent_id: string }>(q(
    'SELECT art, project, agent_id FROM agent_entfernungen WHERE wiederhergestellt_am IS NULL AND ($1::text IS NULL OR project = $1)', [project]));
  const markiert = new Set(offen.rows.map((o) => `${o.art}|${o.project}|${o.agent_id}`));
  const aus: Agent[] = [];
  const gesehen = new Set<string>();
  for (const l of legacy.rows) {
    const k = `legacy|${l.project}|${l.agent_id}`;
    if (markiert.has(k) || gesehen.has(k)) continue;
    gesehen.add(k);
    aus.push({ art: 'legacy', project: l.project, agent_id: l.agent_id, identity_id: null, name: l.agent_id, rolle: null, modell: l.model, status: l.status, basis: l.basis });
  }
  for (const i of ident.rows) {
    if (markiert.has(`identitaet|${i.project}|${i.agent_id}`)) continue;
    aus.push({ art: 'identitaet', project: i.project, agent_id: i.agent_id, identity_id: i.id, name: i.name, rolle: i.rolle, modell: i.modell, status: i.status, basis: maxDatum(i.zuletzt_aktiv, i.erstellt_am) });
  }
  return aus;
}

interface Spur { project: string | null; agent_id: string | null; identity_id: string | null; zeit: Date | null }
/** Eine Aktivitaetsquelle: Name + Abfrage-Fabrik (cutoff-Variante: DISTINCT seit Stichtag; letzte-Variante: max je Agent fuer die Kandidaten). */
const QUELLEN: Array<{ name: string; seit: string; letzte: string }> = [
  { name: 'sitzung', seit: `SELECT project, id AS agent_id, NULL::text AS identity_id, COALESCE(sitzung_seit, registered_at) AS zeit FROM agent_sessions WHERE COALESCE(sitzung_seit, registered_at) >= $1`,
    letzte: `SELECT project, id AS agent_id, identity_id, COALESCE(sitzung_seit, registered_at) AS zeit FROM agent_sessions WHERE id = ANY($1::text[])` },
  { name: 'wrapper', seit: `SELECT project, agent_name AS agent_id, NULL::text AS identity_id, last_activity AS zeit FROM wrapper_status WHERE last_activity >= $1`,
    letzte: `SELECT project, agent_name AS agent_id, NULL::text AS identity_id, last_activity AS zeit FROM wrapper_status WHERE agent_name = ANY($1::text[])` },
  { name: 'identitaets_wrapper', seit: `SELECT project, NULL::text AS agent_id, identity_id, last_activity AS zeit FROM agent_identitaet_wrapper_status WHERE last_activity >= $1`,
    letzte: `SELECT project, NULL::text AS agent_id, identity_id, last_activity AS zeit FROM agent_identitaet_wrapper_status WHERE identity_id = ANY($1::text[])` },
  { name: 'identitaets_sitzung', seit: `SELECT project, agent_id, identity_id, zuletzt_aktiv AS zeit FROM agent_identitaet_sitzungen WHERE zuletzt_aktiv >= $1`,
    letzte: `SELECT project, agent_id, identity_id, zuletzt_aktiv AS zeit FROM agent_identitaet_sitzungen WHERE identity_id = ANY($1::text[])` },
  { name: 'tool_calls', seit: `SELECT project, agent_id, identity_id, max(ts) AS zeit FROM tool_calls WHERE ts >= $1 GROUP BY 1, 2, 3`,
    letzte: `SELECT project, agent_id, identity_id, max(ts) AS zeit FROM tool_calls WHERE agent_id = ANY($1::text[]) GROUP BY 1, 2, 3` },
  { name: 'tool_aktivitaet', seit: `SELECT projekt AS project, agent_id, identity_id, max(zeit) AS zeit FROM tool_aktivitaet WHERE zeit >= $1 GROUP BY 1, 2, 3`,
    letzte: `SELECT projekt AS project, agent_id, identity_id, max(zeit) AS zeit FROM tool_aktivitaet WHERE agent_id = ANY($1::text[]) GROUP BY 1, 2, 3` },
  { name: 'thoughts', seit: `SELECT project, source AS agent_id, source_identity_id AS identity_id, max("timestamp") AS zeit FROM thoughts WHERE "timestamp" >= $1 GROUP BY 1, 2, 3`,
    letzte: `SELECT project, source AS agent_id, source_identity_id AS identity_id, max("timestamp") AS zeit FROM thoughts WHERE source = ANY($1::text[]) GROUP BY 1, 2, 3` },
  { name: 'channel_nachrichten', seit: `SELECT c.project, m.sender AS agent_id, m.sender_identity_id AS identity_id, max(m.created_at) AS zeit FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE m.created_at >= $1 GROUP BY 1, 2, 3`,
    letzte: `SELECT c.project, m.sender AS agent_id, m.sender_identity_id AS identity_id, max(m.created_at) AS zeit FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id WHERE m.sender = ANY($1::text[]) GROUP BY 1, 2, 3` },
  { name: 'verbrauch', seit: `SELECT project, agent_id, identity_id, max(zeit) AS zeit FROM agent_verbrauch WHERE zeit >= $1 GROUP BY 1, 2, 3`,
    letzte: `SELECT project, agent_id, identity_id, max(zeit) AS zeit FROM agent_verbrauch WHERE agent_id = ANY($1::text[]) GROUP BY 1, 2, 3` },
];

/**
 * Warnhinweis (KEINE Ausnahme): Kandidaten, die Beteiligte einer offenen Task (todo | in_progress | blocked) sind. Die Entfernung aendert
 * nichts an der Task; der User sieht in der Vorschau, dass dort noch jemand eingetragen ist. Lesefehler -> keine Warnungen (nur Hinweis).
 */
async function haengeTaskWarnungen(db: Db, kandidaten: EntfernungKandidat[], project: string | null): Promise<void> {
  if (!kandidaten.length) return;
  let rows: Array<{ project: string; identity_id: string | null; agent_id: string | null; ref: string }>;
  try {
    rows = (await db.query<{ project: string; identity_id: string | null; agent_id: string | null; ref: string }>(q(
      `SELECT t.project, b->>'identity_id' AS identity_id, b->>'agent_id' AS agent_id, COALESCE(t.task->>'kurz_id', t.id) AS ref
         FROM plan_tasks t,
              jsonb_array_elements(CASE WHEN jsonb_typeof(t.task->'beteiligte') = 'array' THEN t.task->'beteiligte' ELSE '[]'::jsonb END) b
        WHERE t.task->>'status' IN ('todo','in_progress','blocked') AND ($1::text IS NULL OR t.project = $1)`, [project]))).rows;
  } catch { return; }
  const nachIdentitaet = new Map<string, Set<string>>();
  const nachAgent = new Map<string, Set<string>>();
  const merke = (m: Map<string, Set<string>>, k: string, ref: string) => { (m.get(k) ?? m.set(k, new Set()).get(k) as Set<string>).add(ref); };
  for (const r of rows) {
    if (r.identity_id) merke(nachIdentitaet, r.identity_id, r.ref);
    else if (r.agent_id) merke(nachAgent, schluessel(r.project, r.agent_id), r.ref);
  }
  for (const k of kandidaten) {
    const refs = new Set<string>([...(k.identity_id ? nachIdentitaet.get(k.identity_id) ?? [] : []), ...(nachAgent.get(schluessel(k.project, k.agent_id)) ?? [])]);
    k.warnungen = [...refs].sort().slice(0, 5).map((r) => 'offene_task:' + r);
  }
}

async function ermittleKandidatenInt(db: Db, o: { tage: number; project: string | null; art?: EntfernungArt | null; ids?: readonly string[] | null; jetzt?: Date }): Promise<EntfernungErmittlung> {
  const jetzt = o.jetzt ?? new Date();
  const cutoff = new Date(jetzt.getTime() - o.tage * TAG_MS);
  const alle = await ladeAgenten(db, o.project);

  // Aktive: jede Spur seit dem Stichtag. Fehlt eine Quelle (Schema), ist die Ermittlung unsicher -> Fehler statt falscher Kandidaten.
  const aktivAgent = new Set<string>();
  const aktivIdentitaet = new Set<string>();
  for (const quelle of QUELLEN) {
    let rows: Spur[];
    try { rows = (await db.query<Spur>(q(quelle.seit, [cutoff]))).rows; } catch (e) { fehler('aktivitaetsquelle_fehler', { quelle: quelle.name, meldung: String((e as Error)?.message ?? e).slice(0, 200) }); }
    for (const s of rows) {
      if (s.agent_id) aktivAgent.add(schluessel(s.project, s.agent_id));
      if (s.identity_id) aktivIdentitaet.add(s.identity_id);
    }
  }
  const aktivIdentitaetenZeile = new Set(alle.filter((a) => a.art === 'identitaet' && a.basis && a.basis >= cutoff).map((a) => a.identity_id as string));
  const sitzungAktiv = new Set(alle.filter((a) => a.art === 'legacy' && a.basis && a.basis >= cutoff).map((a) => schluessel(a.project, a.agent_id)));

  // Ausnahmen
  const mainId = await hauptagentIdentitaetsId().catch(() => null);
  const auftraege = await db.query<{ identity_id: string }>(q("SELECT DISTINCT identity_id FROM agent_runtime_auftraege WHERE status IN ('pending','claimed','accepted')"));
  const offeneAuftraege = new Set(auftraege.rows.map((r) => r.identity_id));
  const reservierungen = await db.query<{ project: string; agent_id: string }>(q(
    `SELECT DISTINCT project, agent_id FROM file_reservations WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
     UNION SELECT DISTINCT project, agent_id FROM agent_identitaet_file_reservations WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`));
  const reserviert = new Set(reservierungen.rows.map((r) => schluessel(r.project, r.agent_id)));

  const kandidatenRoh: Agent[] = [];
  const ausgenommen: EntfernungAusnahme[] = [];
  const ausn = (a: Agent, grund: string) => ausgenommen.push({ art: a.art, project: a.project, agent_id: a.agent_id, identity_id: a.identity_id, grund });
  const idsFilter = o.ids?.length ? new Set(o.ids) : null;
  for (const a of alle) {
    if (o.art && a.art !== o.art) continue;
    if (idsFilter && !idsFilter.has(a.agent_id) && !(a.identity_id && idsFilter.has(a.identity_id))) continue;
    const key = schluessel(a.project, a.agent_id);
    const aktiv = aktivAgent.has(key) || aktivAgent.has(schluessel(null, a.agent_id)) || sitzungAktiv.has(key)
      || (a.identity_id !== null && (aktivIdentitaet.has(a.identity_id) || aktivIdentitaetenZeile.has(a.identity_id)));
    if (aktiv) continue; // nicht alt: kein Kandidat und keine Ausnahme
    if (GESCHUETZTE_IDS.has(a.agent_id.toLowerCase())) { ausn(a, 'geschuetzter_name'); continue; }
    if (a.art === 'identitaet' && (a.rolle === 'koordinator' || a.rolle === MAIN_ROLLE)) { ausn(a, 'rolle_' + a.rolle); continue; }
    if (a.identity_id && a.identity_id === mainId) { ausn(a, 'main_identitaet'); continue; }
    if (a.art === 'legacy' && rolleFuerAgent(a.agent_id).rolle === 'koordinator') { ausn(a, 'rolle_koordinator'); continue; }
    if (a.identity_id && offeneAuftraege.has(a.identity_id)) { ausn(a, 'offener_runtime_auftrag'); continue; }
    if (reserviert.has(key)) { ausn(a, 'aktive_dateireservierung'); continue; }
    kandidatenRoh.push(a);
  }

  // Letzte Aktivitaet (alle Zeiten) nur fuer die Kandidaten
  const letzte = new Map<string, { zeit: Date; spur: string }>();
  const merke = (k: string, zeit: Date | null, spur: string) => { if (zeit && (!letzte.get(k) || zeit > (letzte.get(k) as { zeit: Date }).zeit)) letzte.set(k, { zeit, spur }); };
  if (kandidatenRoh.length) {
    const namen = [...new Set(kandidatenRoh.map((a) => a.agent_id))];
    const idents = [...new Set(kandidatenRoh.map((a) => a.identity_id).filter((x): x is string => !!x))];
    for (const quelle of QUELLEN) {
      const nutztIdent = quelle.letzte.includes('identity_id = ANY');
      let rows: Spur[];
      try { rows = (await db.query<Spur>(q(quelle.letzte, [nutztIdent ? idents : namen]))).rows; } catch { continue; }
      for (const s of rows) {
        if (s.agent_id) merke(schluessel(s.project, s.agent_id), s.zeit, quelle.name);
        if (s.identity_id) merke('i|' + s.identity_id, s.zeit, quelle.name);
      }
    }
  }
  let kandidaten: EntfernungKandidat[] = kandidatenRoh.map((a) => {
    const l1 = letzte.get(schluessel(a.project, a.agent_id));
    const l2 = a.identity_id ? letzte.get('i|' + a.identity_id) : undefined;
    let best: { zeit: Date; spur: string } | null = l1 && l2 ? (l1.zeit > l2.zeit ? l1 : l2) : l1 ?? l2 ?? null;
    if (a.basis && (!best || a.basis > best.zeit)) best = { zeit: a.basis, spur: a.art === 'identitaet' ? 'identitaet' : 'sitzung' };
    return { art: a.art, project: a.project, agent_id: a.agent_id, identity_id: a.identity_id, name: a.name, rolle: a.rolle, modell: a.modell, status: a.status,
      letzte_aktivitaet: best ? best.zeit.toISOString() : null, letzte_spur: best?.spur ?? null, warnungen: [] };
  });
  // Eine Spur, die doch juenger als der Stichtag ist (z. B. andere Schreibweise des Projekts), macht den Agenten wieder aktiv.
  kandidaten = kandidaten.filter((k) => !k.letzte_aktivitaet || new Date(k.letzte_aktivitaet) < cutoff);
  kandidaten.sort((a, b) => (a.project + a.art + a.agent_id).localeCompare(b.project + b.art + b.agent_id));
  await haengeTaskWarnungen(db, kandidaten, o.project);
  return { tage: o.tage, stichtag: cutoff.toISOString(), kandidaten, ausgenommen, bestaetigung: bestaetigungFuer(o.tage, kandidaten) };
}

export async function ermittleEntfernungKandidaten(o: { tage?: number; project?: string | null; art?: EntfernungArt | null; ids?: readonly string[] | null; jetzt?: Date },
  db: Db = getPool()): Promise<EntfernungErmittlung> {
  const tage = o.tage ?? (await leseEntfernungSchwelle(db)).tage;
  return ermittleKandidatenInt(db, { tage, project: o.project ?? null, art: o.art ?? null, ids: o.ids ?? null, jetzt: o.jetzt });
}

// ---------------------------------------------------------------------------------------------
// Ausfuehren / Wiederherstellen
// ---------------------------------------------------------------------------------------------
export interface EntfernungWer { wer: string; actor_identity_id: string | null; user_auftrag: string | null }

export async function fuehreEntfernungAus(e: { tage?: number; project?: string | null; art?: EntfernungArt | null; ids?: readonly string[] | null; bestaetigung: unknown; wer: EntfernungWer; jetzt?: Date }):
  Promise<{ lauf_id: string; entfernt: number; schon_markiert: number; tage: number; stichtag: string }> {
  const schalter = await leseEntfernungSchalter();
  if (!schalter.aktiv) fehler('funktion_aus', { funktion: AGENT_ENTFERNUNG_FUNKTION, quelle: schalter.quelle, hinweis: 'Produkt-Schalter agenten_entfernung ist AUS; Vorschau und Wiederherstellen gehen weiter.' });
  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const erm = await ermittleKandidatenInt(c, { tage: e.tage ?? (await leseEntfernungSchwelle(c)).tage, project: e.project ?? null, art: e.art ?? null, ids: e.ids ?? null, jetzt: e.jetzt });
    if (typeof e.bestaetigung !== 'string' || e.bestaetigung !== erm.bestaetigung) {
      fehler(e.bestaetigung ? 'vorschau_veraltet' : 'bestaetigung_fehlt', { anzahl_jetzt: erm.kandidaten.length, hinweis: 'Zuerst aufraeumen_modus vorschau; deren bestaetigung unveraendert mitgeben.' });
    }
    if (erm.kandidaten.length > AUSFUEHREN_LIMIT) fehler('zu_viele_kandidaten', { anzahl: erm.kandidaten.length, grenze: AUSFUEHREN_LIMIT, hinweis: 'Nach Projekt oder art einschraenken.' });
    const lauf = randomUUID();
    const grund = `wurde entfernt: inaktiv > ${erm.tage} Tage`;
    let neu = 0;
    for (const k of erm.kandidaten) {
      const r = await c.query(q(
        `INSERT INTO agent_entfernungen (project, art, agent_id, identity_id, entfernt_grund, letzte_aktivitaet, schwelle_tage, entfernt_von, lauf_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (project, art, agent_id) WHERE wiederhergestellt_am IS NULL DO NOTHING`,
        [k.project, k.art, k.agent_id, k.identity_id, grund, k.letzte_aktivitaet, erm.tage, e.wer.wer + (e.wer.user_auftrag ? ' (Auftrag: ' + e.wer.user_auftrag.slice(0, 200) + ')' : ''), lauf]));
      if (r.rowCount) {
        neu++;
        if (k.identity_id) {
          await c.query(q('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [k.identity_id, e.wer.wer, 'entfernt', null, JSON.stringify({ lauf_id: lauf, letzte_aktivitaet: k.letzte_aktivitaet, schwelle_tage: erm.tage }), grund, e.wer.actor_identity_id]));
        }
      }
    }
    await c.query('COMMIT');
    leereEntfernungCache();
    return { lauf_id: lauf, entfernt: neu, schon_markiert: erm.kandidaten.length - neu, tage: erm.tage, stichtag: erm.stichtag };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function stelleEntfernteWiederHer(e: { lauf_id?: string | null; ids?: readonly string[] | null; alle?: boolean; project?: string | null; grund: string; wer: EntfernungWer }):
  Promise<{ wiederhergestellt: number }> {
  if (!e.lauf_id && !e.ids?.length && e.alle !== true) fehler('auswahl_fehlt', { hinweis: 'lauf_id, ids oder alle:true angeben' });
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await c.query<{ art: EntfernungArt; identity_id: string | null }>(q(
      `UPDATE agent_entfernungen SET wiederhergestellt_am = NOW(), wiederhergestellt_von = $1, wiederhergestellt_grund = $2
        WHERE wiederhergestellt_am IS NULL AND ($3::text IS NULL OR project = $3) AND ($4::text IS NULL OR lauf_id = $4)
          AND ($5::text[] IS NULL OR agent_id = ANY($5) OR identity_id = ANY($5))
        RETURNING art, identity_id`,
      [e.wer.wer + (e.wer.user_auftrag ? ' (Auftrag: ' + e.wer.user_auftrag.slice(0, 200) + ')' : ''), e.grund, e.project ?? null, e.lauf_id ?? null, e.ids?.length ? [...e.ids] : null]));
    for (const z of r.rows) {
      if (z.identity_id) {
        await c.query(q('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [z.identity_id, e.wer.wer, 'entfernung_aufgehoben', null, null, e.grund, e.wer.actor_identity_id]));
      }
    }
    await c.query('COMMIT');
    leereEntfernungCache();
    return { wiederhergestellt: r.rowCount ?? 0 };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function setzeEntfernungSchwelle(e: { tage: unknown; grund: string; wer: EntfernungWer }): Promise<EntfernungSchwelle> {
  const n = Number(e.tage);
  if (!Number.isInteger(n) || n < AGENT_ENTFERNUNG_MIN_TAGE || n > AGENT_ENTFERNUNG_MAX_TAGE) fehler('tage_ungueltig', { min: AGENT_ENTFERNUNG_MIN_TAGE, max: AGENT_ENTFERNUNG_MAX_TAGE });
  await getPool().query(q(
    `INSERT INTO agent_entfernung_einstellungen (name, wert, gesetzt_von, gesetzt_am, grund) VALUES ($1, $2::jsonb, $3, NOW(), $4)
     ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW(), grund = EXCLUDED.grund`,
    [SCHWELLE_NAME, JSON.stringify(n), e.wer.wer, e.grund]));
  return leseEntfernungSchwelle();
}

export async function leseEntfernungStatus(project: string | null): Promise<Record<string, unknown>> {
  const pool = getPool();
  const [schalter, schwelle, offen, laeufe] = await Promise.all([
    leseEntfernungSchalter(), leseEntfernungSchwelle(),
    pool.query<{ project: string; art: string; n: number }>(q('SELECT project, art, count(*)::int AS n FROM agent_entfernungen WHERE wiederhergestellt_am IS NULL AND ($1::text IS NULL OR project = $1) GROUP BY 1, 2 ORDER BY 1, 2', [project])),
    pool.query(q(`SELECT lauf_id, min(entfernt_am) AS am, count(*)::int AS anzahl, count(*) FILTER (WHERE wiederhergestellt_am IS NULL)::int AS noch_entfernt, min(entfernt_von) AS von, min(schwelle_tage) AS schwelle_tage
                    FROM agent_entfernungen WHERE ($1::text IS NULL OR project = $1) GROUP BY lauf_id ORDER BY min(entfernt_am) DESC LIMIT 5`, [project])),
  ]);
  return { schalter, schwelle, filter_wirksam: schalter.aktiv, offene_markierungen: offen.rows, letzte_laeufe: laeufe.rows };
}

// ---------------------------------------------------------------------------------------------
// admin(action:'agenten_aufraeumen')
// ---------------------------------------------------------------------------------------------
export const AGENT_ENTFERNUNG_ADMIN_ACTIONS = ['agenten_aufraeumen'] as const;
export const AGENT_ENTFERNUNG_MODI = ['vorschau', 'ausfuehren', 'wiederherstellen', 'status', 'einstellen'] as const;
export const AGENT_ENTFERNUNG_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  aufraeumen_modus: { type: 'string', enum: [...AGENT_ENTFERNUNG_MODI], description: 'agenten_aufraeumen: vorschau (Standard) | ausfuehren (braucht bestaetigung der Vorschau + Schalter agenten_entfernung EIN) | wiederherstellen | status | einstellen (Schwelle)' },
  aufraeumen_tage: { type: 'number', description: 'agenten_aufraeumen: Schwelle in Tagen ohne Aktivitaet (7..3650; ohne Angabe die Einstellung, Standard 30); bei einstellen der neue Dauerwert' },
  aufraeumen_art: { type: 'string', enum: ['legacy', 'identitaet'], description: 'agenten_aufraeumen: nur diese Art' },
  aufraeumen_ids: { type: 'array', items: { type: 'string' }, description: 'agenten_aufraeumen: nur diese Agenten (agent_id oder identity_id)' },
  aufraeumen_bestaetigung: { type: 'string', description: 'agenten_aufraeumen ausfuehren: bestaetigung aus der Vorschau mit denselben tage/project/art/ids' },
  aufraeumen_lauf_id: { type: 'string', description: 'agenten_aufraeumen wiederherstellen: Lauf der Entfernung' },
  mit_entfernten: { type: 'boolean', description: 'profil_uebersicht: auch entfernte Agenten (Feld entfernt) zeigen' },
  aufraeumen_alle: { type: 'boolean', description: 'agenten_aufraeumen wiederherstellen: alle offenen Markierungen (des project) aufheben' },
};

export function istAgentEntfernungAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (AGENT_ENTFERNUNG_ADMIN_ACTIONS as readonly string[]).includes(action);
}

function textListe(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : null;
}

export async function fuehreAgentEntfernungAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const projektArg = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
    const project = projektArg ?? (wer.art === 'identitaet' ? wer.principal.project : null);
    const modus = typeof args.aufraeumen_modus === 'string' ? args.aufraeumen_modus : 'vorschau';
    if (!(AGENT_ENTFERNUNG_MODI as readonly string[]).includes(modus)) fehler('modus_unbekannt', { erlaubt: AGENT_ENTFERNUNG_MODI });
    // Nicht-User sehen und aendern nur ihr eigenes Projekt (pruefeProfilVerwalter verlangt dafuer ein Projekt).
    const lesen = async () => { await pruefeProfilVerwalter(wer, project); };
    const schreiben = async (): Promise<EntfernungWer> => {
      const v = await pruefeProfilVerwalter(wer, project);
      const auftrag = wer.art === 'user' ? (typeof args.user_auftrag === 'string' && args.user_auftrag.trim() ? args.user_auftrag.trim() : null) : pflichtText(args.user_auftrag, 'user_auftrag_fehlt');
      return { wer: v.wer, actor_identity_id: v.actor_identity_id, user_auftrag: auftrag };
    };
    const tage = args.aufraeumen_tage === undefined || args.aufraeumen_tage === null ? undefined : Number(args.aufraeumen_tage);
    if (tage !== undefined && modus !== 'einstellen' && (!Number.isInteger(tage) || tage < AGENT_ENTFERNUNG_MIN_TAGE || tage > AGENT_ENTFERNUNG_MAX_TAGE)) {
      fehler('tage_ungueltig', { min: AGENT_ENTFERNUNG_MIN_TAGE, max: AGENT_ENTFERNUNG_MAX_TAGE });
    }
    const art = args.aufraeumen_art === 'legacy' || args.aufraeumen_art === 'identitaet' ? args.aufraeumen_art : null;
    const ids = textListe(args.aufraeumen_ids);
    switch (modus) {
      case 'status':
        await lesen();
        return { success: true, action, modus, ...(await leseEntfernungStatus(project)) };
      case 'vorschau': {
        await lesen();
        const [schalter, erm] = await Promise.all([leseEntfernungSchalter(), ermittleEntfernungKandidaten({ tage, project, art, ids })]);
        const jeProjekt: Record<string, { legacy: number; identitaet: number }> = {};
        for (const k of erm.kandidaten) { (jeProjekt[k.project] ??= { legacy: 0, identitaet: 0 })[k.art]++; }
        return { success: true, action, modus, schalter, schwelle: await leseEntfernungSchwelle(), tage: erm.tage, stichtag: erm.stichtag, project,
          anzahl: { legacy: erm.kandidaten.filter((k) => k.art === 'legacy').length, identitaet: erm.kandidaten.filter((k) => k.art === 'identitaet').length,
            gesamt: erm.kandidaten.length, ausgenommen: erm.ausgenommen.length, mit_warnung: erm.kandidaten.filter((k) => k.warnungen.length > 0).length }, je_projekt: jeProjekt,
          kandidaten: erm.kandidaten.slice(0, VORSCHAU_LIMIT), kandidaten_gekappt: erm.kandidaten.length > VORSCHAU_LIMIT,
          ausgenommen: erm.ausgenommen.slice(0, VORSCHAU_LIMIT), bestaetigung: erm.bestaetigung,
          warnungen: erm.kandidaten.filter((k) => k.warnungen.length > 0).map((k) => ({ agent_id: k.agent_id, project: k.project, warnungen: k.warnungen })).slice(0, VORSCHAU_LIMIT),
          hinweis: schalter.aktiv ? 'ausfuehren mit dieser bestaetigung (und denselben tage/project/art/ids) entfernt genau diese Agenten.' : 'Produkt-Schalter agenten_entfernung ist AUS: ausfuehren wird abgewiesen, bis er freigegeben ist.' };
      }
      case 'ausfuehren': {
        const w = await schreiben();
        const r = await fuehreEntfernungAus({ tage, project, art, ids, bestaetigung: args.aufraeumen_bestaetigung, wer: w });
        return { success: true, action, modus, ...r };
      }
      case 'wiederherstellen': {
        const w = await schreiben();
        const r = await stelleEntfernteWiederHer({ lauf_id: typeof args.aufraeumen_lauf_id === 'string' ? args.aufraeumen_lauf_id : null, ids, alle: args.aufraeumen_alle === true, project: projektArg ?? (wer.art === 'user' ? null : project),
          grund: pflichtText(args.grund, 'grund_fehlt'), wer: w });
        return { success: true, action, modus, ...r };
      }
      default: {
        const w = await schreiben();
        const s = await setzeEntfernungSchwelle({ tage: args.aufraeumen_tage, grund: pflichtText(args.grund, 'grund_fehlt'), wer: w });
        return { success: true, action, modus, schwelle: s };
      }
    }
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'agenten_aufraeumen_fehler' };
  }
}
