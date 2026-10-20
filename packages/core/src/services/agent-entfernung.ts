/**
 * P22-T80: alte Agenten weich als 'entfernt' markieren (Entwurf thought 66c2f47d).
 * Eine Markierung je Agent in agent_entfernungen (Schema 126); KEINE Daten werden geaendert oder geloescht (Verlauf, Thoughts, Memories,
 * Tool-Calls, Skills, Ausweise bleiben). Entfernte Agenten verschwinden aus den Listen (Filter unten), solange der Produkt-Schalter
 * 'agenten_entfernung' EIN ist.
 *
 * Teil 3 (User 8edbc2c7): Archivieren = UMBENENNEN. Der Eintrag (Legacy: Sitzung, Wrapper-Status, Channel-Mitgliedschaften, Chat-Lesestand,
 * Onboarding-Merker; Identitaet: agent_id/name, status 'deaktiviert', Identitaets-Channel-Mitgliedschaften) heisst danach
 * 'archiv-<YYYYMMDD>-<alter-name>'; der alte Name steht in frueherer_name und ist FREI - wer sich danach so meldet, ist ein neuer Agent
 * (keine automatische Rueckkehr mehr). Inhalte bleiben unter dem alten Namen; archivVerweise/archivUrsprung loesen sie zum Archiv auf.
 * Wiederherstellen benennt zurueck, nur wenn der alte Name frei ist (sonst name_belegt).
 *
 * ALT = keine Spur des Agenten juenger als die Schwelle (Einstellung agenten_entfernung_schwelle_tage, Standard 30, Quelle sichtbar).
 * Spuren: Sitzung, Wrapper-Status, Tool-Calls, Tool-Aktivitaet, Thoughts, Channel-Nachrichten, Verbrauch, Identitaets-Aktivitaet.
 * NIE: Main (rolle main/Main-Identitaet), offene Runtime-Auftraege, aktive Dateireservierungen. Koordinatoren sind eingeschlossen (Teil 3).
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

export const AGENT_ENTFERNUNG_FUNKTION = 'agenten_entfernung' as const;
export const AGENT_ENTFERNUNG_STANDARD_TAGE = 30;
export const AGENT_ENTFERNUNG_MIN_TAGE = 7;
export const AGENT_ENTFERNUNG_MAX_TAGE = 3650;
const SCHWELLE_NAME = 'schwelle_tage';
const VORSCHAU_LIMIT = 500;
const AUSFUEHREN_LIMIT = 2000;

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
export function leereEntfernungCache(): void { schalterCache = null; sichtCache.clear(); }

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
/**
 * Offene Markierungen eines Projekts - nur bei EIN geschaltetem Schalter (sonst null = nichts ausblenden). Fehler -> null (lieber sichtbar als weg).
 * Teil 3: legacy enthaelt den Archivnamen (agent_id der Markierung) und den frueheren Namen, solange ihn kein neuer Agent traegt - so verschwinden
 * auch Listen, die Namen aus Inhalten ableiten (Wissen, Channel); ein neuer Agent mit dem alten Namen bleibt sichtbar.
 */
export async function ladeEntferntMengen(project: string, db: Db = getPool()): Promise<EntferntMengen | null> {
  try {
    if (!(await entfernungFilterAktiv())) return null;
    const r = await db.query<{ art: EntfernungArt; agent_id: string; identity_id: string | null; frueherer_name: string | null; alt_frei: boolean }>(q(
      `SELECT e.art, e.agent_id, e.identity_id, e.frueherer_name,
              (e.frueherer_name IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = e.frueherer_name AND s.project = e.project)
                AND NOT EXISTS (SELECT 1 FROM wrapper_status w WHERE w.agent_name = e.frueherer_name AND w.project = e.project)
                AND NOT EXISTS (SELECT 1 FROM agent_identitaeten i WHERE i.project = e.project AND i.agent_id = e.frueherer_name)) AS alt_frei
         FROM agent_entfernungen e WHERE e.project = $1 AND e.wiederhergestellt_am IS NULL`, [project]));
    if (!r.rows.length) return null;
    const legacy = new Set<string>();
    for (const z of r.rows) {
      if (z.art === 'legacy') legacy.add(z.agent_id);
      if (z.frueherer_name && z.alt_frei) legacy.add(z.frueherer_name);
    }
    return { legacy, identitaet: new Set(r.rows.filter((z) => z.identity_id).map((z) => z.identity_id as string)) };
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
export async function markiereEntfernteProfile<T extends { identity_id: string }>(project: string, zeilen: T[], mitEntfernten: boolean): Promise<Array<T & { entfernt?: { am: string; grund: string; frueherer_name?: string | null } }>> {
  try {
    const r = await getPool().query<{ identity_id: string; entfernt_am: Date; entfernt_grund: string; frueherer_name: string | null }>(q(
      "SELECT identity_id, entfernt_am, entfernt_grund, frueherer_name FROM agent_entfernungen WHERE project = $1 AND art = 'identitaet' AND wiederhergestellt_am IS NULL", [project]));
    if (!r.rows.length) return zeilen;
    const map = new Map(r.rows.map((z) => [z.identity_id, { am: z.entfernt_am.toISOString(), grund: z.entfernt_grund, frueherer_name: z.frueherer_name }]));
    const verstecken = !mitEntfernten && (await entfernungFilterAktiv());
    return zeilen.filter((z) => !(verstecken && map.has(z.identity_id))).map((z) => (map.has(z.identity_id) ? { ...z, entfernt: map.get(z.identity_id) } : z));
  } catch { return zeilen; }
}

/**
 * Rueckkehr: meldet sich ein entfernter Agent wieder (chat register / Anmeldung), schliesst das die Markierung automatisch -
 * sonst waere ein aktiver Agent unsichtbar. Wirft nie; ohne Markierung ein indizierter UPDATE ohne Treffer.
 * Teil 3: gilt NUR fuer Markierungen ohne Umbenennung (Altbestand). Ein umbenannter Agent kehrt nicht zurueck - wer sich unter dem
 * alten Namen meldet, ist ein neuer Agent; die archivierte Identitaet ist deaktiviert.
 */
export async function markiereRueckkehr(project: string, agentId: string, identityId?: string | null, db: Db = getPool()): Promise<number> {
  try {
    const r = await db.query(q(
      `UPDATE agent_entfernungen SET wiederhergestellt_am = NOW(), wiederhergestellt_von = 'auto:anmeldung', wiederhergestellt_grund = 'Agent hat sich wieder gemeldet'
        WHERE wiederhergestellt_am IS NULL AND neuer_name IS NULL
          AND ((art = 'legacy' AND project = $1 AND agent_id = $2) OR (art = 'identitaet' AND identity_id = $3))`,
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
  /** Teil 3: Name nach dem Archivieren ('archiv-<YYYYMMDD>-<alt>', belegt -> Zusatz -2 ...); die Vorschau rechnet mit heute. */
  neuer_name: string | null;
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
    // Teil 3 (User 8edbc2c7): keine Ausnahme mehr ueber Namen oder Koordinator-Rolle - nur Main, offene Runtime-Auftraege, aktive Reservierungen.
    if (a.art === 'identitaet' && a.rolle === MAIN_ROLLE) { ausn(a, 'rolle_' + a.rolle); continue; }
    if (a.identity_id && a.identity_id === mainId) { ausn(a, 'main_identitaet'); continue; }
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
      letzte_aktivitaet: best ? best.zeit.toISOString() : null, letzte_spur: best?.spur ?? null, warnungen: [], neuer_name: null };
  });
  // Eine Spur, die doch juenger als der Stichtag ist (z. B. andere Schreibweise des Projekts), macht den Agenten wieder aktiv.
  kandidaten = kandidaten.filter((k) => !k.letzte_aktivitaet || new Date(k.letzte_aktivitaet) < cutoff);
  kandidaten.sort((a, b) => (a.project + a.art + a.agent_id).localeCompare(b.project + b.art + b.agent_id));
  await haengeTaskWarnungen(db, kandidaten, o.project);
  await vergebeArchivNamen(db, kandidaten, jetzt);
  return { tage: o.tage, stichtag: cutoff.toISOString(), kandidaten, ausgenommen, bestaetigung: bestaetigungFuer(o.tage, kandidaten) };
}

/** Teil 3: Archivname 'archiv-<YYYYMMDD>-<alter-name>' (Datum des Laufs, UTC); nr > 1 haengt '-<nr>' an. */
export function archivNameFuer(alt: string, jetzt: Date, nr = 1): string {
  return `archiv-${jetzt.toISOString().slice(0, 10).replace(/-/g, '')}-${alt}${nr > 1 ? '-' + nr : ''}`;
}
/** Belegt = Sitzung, Wrapper-Status, Identitaet (agent_id oder name) oder offene Markierung mit diesem Namen (projektuebergreifend, streng). */
const BELEGT_SQL = `SELECT n FROM unnest($1::text[]) AS n
  WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE id = n) OR EXISTS (SELECT 1 FROM wrapper_status WHERE agent_name = n)
     OR EXISTS (SELECT 1 FROM agent_identitaeten WHERE agent_id = n OR name = n)
     OR EXISTS (SELECT 1 FROM agent_entfernungen WHERE agent_id = n AND wiederhergestellt_am IS NULL)`;

async function vergebeArchivNamen(db: Db, kandidaten: EntfernungKandidat[], jetzt: Date): Promise<void> {
  const vergeben = new Set<string>();
  let offen = kandidaten;
  for (let nr = 1; offen.length && nr <= 50; nr++) {
    const vorschlag = offen.map((k) => archivNameFuer(k.agent_id, jetzt, nr));
    const belegt = new Set((await db.query<{ n: string }>(q(BELEGT_SQL, [[...new Set(vorschlag)]]))).rows.map((r) => r.n));
    const rest: EntfernungKandidat[] = [];
    offen.forEach((k, i) => {
      const n = vorschlag[i];
      if (belegt.has(n) || vergeben.has(n)) rest.push(k);
      else { k.neuer_name = n; vergeben.add(n); }
    });
    offen = rest;
  }
  if (offen.length) fehler('archivname_belegt', { agent_ids: offen.slice(0, 20).map((k) => k.agent_id) });
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
  Promise<{ lauf_id: string; entfernt: number; schon_markiert: number; tage: number; stichtag: string;
    umbenannt: Array<{ art: EntfernungArt; project: string; alt: string; neu: string }>; umbenannt_gekappt: boolean }> {
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
    const grund = `archiviert (umbenannt): inaktiv > ${erm.tage} Tage`;
    const von = e.wer.wer + (e.wer.user_auftrag ? ' (Auftrag: ' + e.wer.user_auftrag.slice(0, 200) + ')' : '');
    let neu = 0;
    const umbenannt: Array<{ art: EntfernungArt; project: string; alt: string; neu: string }> = [];
    for (const k of erm.kandidaten) {
      const neuName = k.neuer_name as string;
      let altName: string | null = null;
      let altStatus: string | null = null;
      if (k.identity_id) {
        const i = await c.query<{ name: string; status: string }>(q('SELECT name, status FROM agent_identitaeten WHERE id = $1 FOR UPDATE', [k.identity_id]));
        altName = i.rows[0]?.name ?? null;
        altStatus = i.rows[0]?.status ?? null;
      }
      const r = await c.query(q(
        `INSERT INTO agent_entfernungen (project, art, agent_id, identity_id, entfernt_grund, letzte_aktivitaet, schwelle_tage, entfernt_von, lauf_id,
                                         frueherer_name, neuer_name, frueherer_identitaet_name, frueherer_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$3,$11,$12)
         ON CONFLICT (project, art, agent_id) WHERE wiederhergestellt_am IS NULL DO NOTHING`,
        [k.project, k.art, neuName, k.identity_id, grund, k.letzte_aktivitaet, erm.tage, von, lauf, k.agent_id, altName, altStatus]));
      if (!r.rowCount) continue;
      neu++;
      await benenneEintragUm(c, { art: k.art, project: k.project, identity_id: k.identity_id, von: k.agent_id, nach: neuName, name: k.identity_id ? neuName : null, status: k.identity_id ? 'deaktiviert' : null });
      umbenannt.push({ art: k.art, project: k.project, alt: k.agent_id, neu: neuName });
      if (k.identity_id) {
        await c.query(q('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [k.identity_id, e.wer.wer, 'archiviert', JSON.stringify({ agent_id: k.agent_id, name: altName, status: altStatus }),
            JSON.stringify({ agent_id: neuName, name: neuName, status: 'deaktiviert', lauf_id: lauf, letzte_aktivitaet: k.letzte_aktivitaet, schwelle_tage: erm.tage }), grund, e.wer.actor_identity_id]));
      }
    }
    await c.query('COMMIT');
    leereEntfernungCache();
    return { lauf_id: lauf, entfernt: neu, schon_markiert: erm.kandidaten.length - neu, tage: erm.tage, stichtag: erm.stichtag,
      umbenannt: umbenannt.slice(0, VORSCHAU_LIMIT), umbenannt_gekappt: umbenannt.length > VORSCHAU_LIMIT };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Teil 3: benennt den EINTRAG eines Agenten um. Legacy = Sitzung, Wrapper-Status, Channel-Mitgliedschaften, Chat-Lesestand, Onboarding-Merker;
 * Identitaet = agent_id/name/status, Identitaets-Channel-Mitgliedschaften, verknuepfte Sitzungszeile. Inhalte (Thoughts, Memories, Channel-
 * Nachrichten, Tool-Calls, Verlauf, Plaene, Dateiversionen, Wissen, Event-Quittungen) bleiben unter dem alten Namen. Zeilen, deren Ziel-Schluessel
 * schon belegt ist (z. B. beim Rueckbenennen), bleiben am bisherigen Namen.
 */
async function benenneEintragUm(c: Db, u: { art: EntfernungArt; project: string; identity_id: string | null; von: string; nach: string; name: string | null; status: string | null }): Promise<void> {
  if (u.art === 'identitaet' && u.identity_id) {
    await c.query(q('UPDATE agent_identitaeten SET agent_id = $2, name = COALESCE($3, name), status = COALESCE($4, status) WHERE id = $1', [u.identity_id, u.nach, u.name, u.status]));
    await c.query(q('UPDATE agent_identitaet_channel_mitglieder SET agent_name = $2 WHERE identity_id = $1', [u.identity_id, u.nach]));
    await c.query(q('UPDATE agent_sessions SET id = $2 WHERE id = $3 AND identity_id = $1 AND NOT EXISTS (SELECT 1 FROM agent_sessions s2 WHERE s2.id = $2)', [u.identity_id, u.nach, u.von]));
    return;
  }
  const w = [u.project, u.von, u.nach];
  await c.query(q('UPDATE agent_sessions SET id = $3 WHERE id = $2 AND project = $1 AND identity_id IS NULL AND NOT EXISTS (SELECT 1 FROM agent_sessions s2 WHERE s2.id = $3)', w));
  await c.query(q('UPDATE wrapper_status SET agent_name = $3 WHERE agent_name = $2 AND project = $1 AND NOT EXISTS (SELECT 1 FROM wrapper_status w2 WHERE w2.agent_name = $3 AND w2.project = $1)', w));
  await c.query(q(`UPDATE specialist_channel_members m SET agent_name = $3 FROM specialist_channels ch
     WHERE ch.id = m.channel_id AND ch.project = $1 AND m.agent_name = $2
       AND NOT EXISTS (SELECT 1 FROM specialist_channel_members m2 WHERE m2.channel_id = m.channel_id AND m2.agent_name = $3)`, w));
  await c.query(q('UPDATE chat_lesestand l SET agent_id = $3 WHERE l.project = $1 AND l.agent_id = $2 AND NOT EXISTS (SELECT 1 FROM chat_lesestand l2 WHERE l2.project = $1 AND l2.agent_id = $3)', w));
  await c.query(q(`UPDATE agent_onboardings o SET agent_id = $3 WHERE o.project = $1 AND o.agent_id = $2
     AND NOT EXISTS (SELECT 1 FROM agent_onboardings o2 WHERE o2.project = $1 AND o2.agent_id = $3 AND o2.server_instance_id = o.server_instance_id)`, w));
  // Nachbesserung: Postfach und Wissen sind Eigentum des Eintrags. Zum Zeitpunkt der Umbenennung liegen dort genau die Zeilen VOR der
  // Umbenennung; sie wandern mit dem Eintrag (Inhalt, Absender, Zeitstempel bleiben). So sieht ein neuer Agent mit dem alten Namen sie auf
  // keinem Weg (Inbox lesen/quittieren/zaehlen/purgen, Wrapper-Bruecke), und ein Wissens-Block des neuen Agenten ueberschreibt nie den alten.
  await c.query(q('UPDATE specialist_inbox SET to_agent = $3 WHERE project = $1 AND to_agent = $2 AND to_identity_id IS NULL', w));
  await c.query(q(`UPDATE agent_wissen aw SET agent_name = $3 WHERE aw.project = $1 AND aw.agent_name = $2
     AND NOT (aw.form = 'block' AND EXISTS (SELECT 1 FROM agent_wissen w2 WHERE w2.project = $1 AND w2.agent_name = $3 AND w2.art = aw.art AND w2.form = 'block'))`, w));
}

interface Markierung { id: string; project: string; art: EntfernungArt; agent_id: string; identity_id: string | null; frueherer_name: string | null;
  neuer_name: string | null; frueherer_identitaet_name: string | null; frueherer_status: string | null }

/** Wer traegt den frueheren Namen inzwischen? null = frei. Identitaet: agent_id oder (name, instanz_nr) einer ANDEREN Identitaet. */
async function nameBelegt(c: Db, m: Markierung): Promise<string | null> {
  const r = await c.query<{ wo: string }>(q(
    `SELECT 'sitzung' AS wo FROM agent_sessions WHERE id = $2
     UNION ALL SELECT 'wrapper' FROM wrapper_status WHERE agent_name = $2 AND project = $1
     UNION ALL SELECT 'identitaet' FROM agent_identitaeten
       WHERE project = $1 AND id IS DISTINCT FROM $4::text
         AND (agent_id = $2 OR (name = $3 AND instanz_nr = (SELECT instanz_nr FROM agent_identitaeten WHERE id = $4::text)))
     LIMIT 1`, [m.project, m.frueherer_name, m.frueherer_identitaet_name ?? m.frueherer_name, m.identity_id]));
  return r.rows[0]?.wo ?? null;
}

export async function stelleEntfernteWiederHer(e: { lauf_id?: string | null; ids?: readonly string[] | null; alle?: boolean; project?: string | null; grund: string; wer: EntfernungWer }):
  Promise<{ wiederhergestellt: number; abgelehnt: Array<{ agent_id: string; frueherer_name: string; project: string; grund: string; belegt_durch: string }> }> {
  if (!e.lauf_id && !e.ids?.length && e.alle !== true) fehler('auswahl_fehlt', { hinweis: 'lauf_id, ids oder alle:true angeben' });
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const von = e.wer.wer + (e.wer.user_auftrag ? ' (Auftrag: ' + e.wer.user_auftrag.slice(0, 200) + ')' : '');
    const r = await c.query<Markierung>(q(
      `SELECT id, project, art, agent_id, identity_id, frueherer_name, neuer_name, frueherer_identitaet_name, frueherer_status FROM agent_entfernungen
        WHERE wiederhergestellt_am IS NULL AND ($1::text IS NULL OR project = $1) AND ($2::text IS NULL OR lauf_id = $2)
          AND ($3::text[] IS NULL OR agent_id = ANY($3) OR identity_id = ANY($3) OR frueherer_name = ANY($3))
        ORDER BY id FOR UPDATE`,
      [e.project ?? null, e.lauf_id ?? null, e.ids?.length ? [...e.ids] : null]));
    let n = 0;
    const abgelehnt: Array<{ agent_id: string; frueherer_name: string; project: string; grund: string; belegt_durch: string }> = [];
    for (const m of r.rows) {
      if (m.neuer_name && m.frueherer_name) {
        const belegt = await nameBelegt(c, m);
        if (belegt) { abgelehnt.push({ agent_id: m.agent_id, frueherer_name: m.frueherer_name, project: m.project, grund: 'name_belegt', belegt_durch: belegt }); continue; }
        await benenneEintragUm(c, { art: m.art, project: m.project, identity_id: m.identity_id, von: m.agent_id, nach: m.frueherer_name,
          name: m.art === 'identitaet' ? (m.frueherer_identitaet_name ?? m.frueherer_name) : null, status: m.art === 'identitaet' ? (m.frueherer_status ?? 'aktiv') : null });
      }
      await c.query(q('UPDATE agent_entfernungen SET wiederhergestellt_am = NOW(), wiederhergestellt_von = $2, wiederhergestellt_grund = $3 WHERE id = $1', [m.id, von, e.grund]));
      n++;
      if (m.identity_id) {
        await c.query(q('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [m.identity_id, e.wer.wer, 'entfernung_aufgehoben', JSON.stringify({ agent_id: m.agent_id }), JSON.stringify({ agent_id: m.frueherer_name ?? m.agent_id }), e.grund, e.wer.actor_identity_id]));
      }
    }
    if (!n && abgelehnt.length) {
      fehler('name_belegt', { abgelehnt: abgelehnt.slice(0, 50), hinweis: 'Der fruehere Name gehoert inzwischen einem anderen Agenten; Rueckbenennen erst, wenn er frei ist.' });
    }
    await c.query('COMMIT');
    leereEntfernungCache();
    return { wiederhergestellt: n, abgelehnt: abgelehnt.slice(0, VORSCHAU_LIMIT) };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Teil 3: Inhalte unter altem Namen dem Archiv-Eintrag zuordnen (nur Anzeige; Inhalte bleiben unveraendert)
// ---------------------------------------------------------------------------------------------
export interface ArchivVerweis { archiv_name: string; anzeige: string }
interface ArchivMarke { frueherer_name: string; neuer_name: string; identity_id: string | null; am: Date }

/**
 * Je Zeile der Archiv-Verweis oder null. Eine Zeile gehoert zum Archiv, wenn ihr Absender der fruehere Name einer offenen Umbenennung ist und
 * sie VOR der Umbenennung entstand (Identitaet: zusaetzlich gleiche identity_id, falls die Zeile eine traegt; Legacy: Zeile ohne identity_id).
 * Spaetere Zeilen unter dem alten Namen stammen vom neuen Agenten. Fehler (Schema alt) -> keine Verweise.
 */
export async function archivVerweise<T>(project: string, zeilen: readonly T[],
  lese: (z: T) => { name: string | null | undefined; identity?: string | null; zeit?: Date | string | null }): Promise<Array<ArchivVerweis | null>> {
  const namen = [...new Set(zeilen.map((z) => lese(z).name).filter((n): n is string => !!n))];
  if (!namen.length) return zeilen.map(() => null);
  let marken: ArchivMarke[] = [];
  try {
    marken = (await getPool().query<ArchivMarke>(q(
      `SELECT frueherer_name, neuer_name, identity_id, entfernt_am AS am FROM agent_entfernungen
        WHERE project = $1 AND wiederhergestellt_am IS NULL AND neuer_name IS NOT NULL AND frueherer_name = ANY($2::text[])`, [project, namen]))).rows;
  } catch { return zeilen.map(() => null); }
  if (!marken.length) return zeilen.map(() => null);
  const nachName = new Map<string, ArchivMarke[]>();
  for (const m of marken) (nachName.get(m.frueherer_name) ?? nachName.set(m.frueherer_name, []).get(m.frueherer_name) as ArchivMarke[]).push(m);
  return zeilen.map((z) => {
    const k = lese(z);
    const liste = k.name ? nachName.get(k.name) : undefined;
    if (!liste) return null;
    const zeit = k.zeit ? new Date(k.zeit) : null;
    const vorher = (m: ArchivMarke) => !zeit || Number.isNaN(zeit.getTime()) || zeit <= m.am;
    const m = liste.find((x) => (x.identity_id ? (k.identity ? k.identity === x.identity_id : vorher(x)) : !k.identity && vorher(x)));
    return m ? { archiv_name: m.neuer_name, anzeige: `${m.frueherer_name} (archiviert)` } : null;
  });
}

/** Suche ueber den Archivnamen: fruehere Name + Zeitpunkt der Umbenennung (Inhalte bis dahin gehoeren zum Archiv). Fehler/kein Archiv -> null. */
export async function archivUrsprung(project: string, archivName: string): Promise<{ frueherer_name: string; identity_id: string | null; bis: Date } | null> {
  if (!archivName.startsWith('archiv-')) return null;
  try {
    const r = await getPool().query<{ frueherer_name: string; identity_id: string | null; bis: Date }>(q(
      `SELECT frueherer_name, identity_id, entfernt_am AS bis FROM agent_entfernungen
        WHERE project = $1 AND neuer_name = $2 AND wiederhergestellt_am IS NULL AND frueherer_name IS NOT NULL ORDER BY id DESC LIMIT 1`, [project, archivName]));
    return r.rows[0] ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Nachbesserung: Direktnachrichten (chat_messages) zeitbasiert dem Archiv zuordnen, Sperrriegel fuer Archivnamen
// ---------------------------------------------------------------------------------------------
/**
 * Sicht eines Lesenden auf Zeilen unter Namen: verdeckt_bis = er traegt einen frueheren Namen, Zeilen bis dahin gehoeren dem Archiv (fuer ihn
 * unsichtbar); archiv = er IST ein Archiv-Eintrag und liest zusaetzlich die Zeilen unter dem frueheren Namen bis zur Umbenennung.
 */
export interface ArchivSicht { verdeckt_bis: Date | null; archiv: { frueherer_name: string; bis: Date } | null }
const KEINE_SICHT: ArchivSicht = { verdeckt_bis: null, archiv: null };
const sichtCache = new Map<string, { bis: number; sicht: ArchivSicht }>();

/** Kurz gepuffert (5 s, geleert bei ausfuehren/wiederherstellen). Fehler (Schema alt) -> keine Einschraenkung. */
export async function archivSichtFuer(project: string, name: string): Promise<ArchivSicht> {
  if (!project || !name) return KEINE_SICHT;
  const k = project + '|' + name;
  const c = sichtCache.get(k);
  if (c && c.bis > Date.now()) return c.sicht;
  let sicht = KEINE_SICHT;
  try {
    const r = await getPool().query<{ verdeckt_bis: Date | null; frueherer_name: string | null; bis: Date | null }>(q(
      `SELECT (SELECT max(entfernt_am) FROM agent_entfernungen
                WHERE project = $1 AND frueherer_name = $2 AND neuer_name IS NOT NULL AND wiederhergestellt_am IS NULL) AS verdeckt_bis,
              a.frueherer_name, a.entfernt_am AS bis
         FROM (SELECT 1) x LEFT JOIN LATERAL (SELECT frueherer_name, entfernt_am FROM agent_entfernungen
                WHERE project = $1 AND neuer_name = $2 AND frueherer_name IS NOT NULL AND wiederhergestellt_am IS NULL ORDER BY id DESC LIMIT 1) a ON TRUE`, [project, name]));
    const z = r.rows[0];
    if (z && (z.verdeckt_bis || z.frueherer_name)) {
      sicht = { verdeckt_bis: z.verdeckt_bis ?? null, archiv: z.frueherer_name && z.bis ? { frueherer_name: z.frueherer_name, bis: z.bis } : null };
    }
  } catch { sicht = KEINE_SICHT; }
  sichtCache.set(k, { bis: Date.now() + 5000, sicht });
  return sicht;
}

/** SQL-Bedingung statt '<spalte> = <leser>' fuer Namensspalte + Zeitspalte (feste Bezeichner); Werte ueber bind. */
export function archivNamensBedingung(spalte: string, zeit: string, leser: string, sicht: ArchivSicht | null, bind: (v: unknown) => string): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(spalte) || !/^[a-z_][a-z0-9_.]*$/i.test(zeit)) throw new Error('ungueltige Spalte');
  if (!sicht || (!sicht.verdeckt_bis && !sicht.archiv)) return `${spalte} = ${leser}`;
  const eigen = sicht.verdeckt_bis ? `(${spalte} = ${leser} AND ${zeit} > ${bind(sicht.verdeckt_bis)})` : `${spalte} = ${leser}`;
  return sicht.archiv ? `(${eigen} OR (${spalte} = ${bind(sicht.archiv.frueherer_name)} AND ${zeit} <= ${bind(sicht.archiv.bis)}))` : eigen;
}

/**
 * Sperrriegel: der Name eines offen archivierten Eintrags ist weder registrier- noch anmeldbar; nur wiederherstellen reaktiviert ihn.
 * Nur Namen mit 'archiv-' werden geprueft (kein Aufwand sonst). Lesefehler -> gesperrt (lieber abweisen als ein Archiv beleben).
 */
export async function istGesperrterArchivName(name: string): Promise<boolean> {
  if (typeof name !== 'string' || !name.startsWith('archiv-')) return false;
  try {
    const r = await getPool().query(q('SELECT 1 FROM agent_entfernungen WHERE agent_id = $1 AND neuer_name IS NOT NULL AND wiederhergestellt_am IS NULL LIMIT 1', [name]));
    return (r.rowCount ?? 0) > 0;
  } catch { return true; }
}
export const ARCHIVNAME_GESPERRT = 'archivname_gesperrt';

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
  aufraeumen_modus: { type: 'string', enum: [...AGENT_ENTFERNUNG_MODI], description: 'agenten_aufraeumen: vorschau (Standard, zeigt alt -> neuer_name) | ausfuehren (benennt in archiv-<Datum>-<alt> um; braucht bestaetigung der Vorschau + Schalter agenten_entfernung EIN) | wiederherstellen (benennt zurueck, nur wenn der Name frei ist) | status | einstellen (Schwelle)' },
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
          hinweis: (schalter.aktiv ? 'ausfuehren mit dieser bestaetigung (und denselben tage/project/art/ids) benennt genau diese Agenten in neuer_name um (Datum = Tag des Laufs).' : 'Produkt-Schalter agenten_entfernung ist AUS: ausfuehren wird abgewiesen, bis er freigegeben ist.')
            + ' Der alte Name wird frei; Inhalte (Thoughts, Channel, Verlauf ...) bleiben unveraendert und lesbar.' };
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
