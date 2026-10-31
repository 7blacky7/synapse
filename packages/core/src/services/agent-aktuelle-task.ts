/**
 * P22-T172 (User 25.10.2026 inbox 1265/1266, Entwurf thought c1261c51): AKTUELLE TASK je Agent, an EINER Stelle ermittelt.
 * Die Web-UI zeigt ueberall, wo sie einen Agenten nennt, den Namen der Identitaet und daneben diese Task ('claude-t50 · P22-T171').
 * Ausweise werden NICHT umbenannt (entscheidung-agenten-ausweis-2026-10-19 Punkt 5a); Ausweiswerte kommen hier nie vor.
 *
 * REIHENFOLGE (Begruendung im Entwurf c1261c51):
 *   1 aktivitaet   juengstes Signal mit task_id im Zeitfenster (Einstellwert fenster_stunden):
 *                  tool_calls.args_preview ("task_id":"..."), file_versions.task_id, thoughts.task_id (deckt thought task_status ab).
 *                  Nur task_ids, die im Projekt als Task existieren (Kurz-ID oder UUID). seit = erstes Signal dieser Task nach dem
 *                  letzten Signal einer ANDEREN Task (Wechselzeitpunkt), zuletzt = juengstes Signal.
 *   2 bindung      plan_task_bindungen (juengste gesetzt_am, Task nicht done) - nur ohne Aktivitaet; Bindungen veralten.
 *   3 beteiligt    task.beteiligte (plan uebernehmen) mit Status in_progress - letzter Rueckfall.
 *   Keine Task -> kein Eintrag (die Web-UI zeigt nur den Namen).
 * SCHALTER agent_aktuelle_task (Produkt-Schalter, projekt > global, Standard AUS, nur ausdruecklich); interner Test-Override gleichen
 *   Namens (intern_schalter, freigegeben, befristet) nur bei aktivem intern-Tool. AUS: leere Liste, aktiv false (Altverhalten).
 * EINSTELLUNGEN (Regel 7): Tabelle agent_aktuelle_task_einstellungen (Schema 158), Code-Standard AKTUELLE_TASK_EINSTELLUNGEN,
 *   Quelle je Wert; setzen nur der User (REST PUT /api/main-agent/aktuelle-task/einstellungen).
 * DEBUG: jede Zeile traegt quelle (aktivitaet:tool_calls|aktivitaet:file_versions|aktivitaet:thoughts|bindung|beteiligt) und
 *   signale; die Antwort traegt schalter (mit Quelle), einstellungen (mit Quelle), reihenfolge, dauer_ms, cache, letzter_fehler.
 * Lesend, Puffer je Projekt (AKTUELLE_TASK_CACHE_MS), wirft nie.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';

type Q = import('pg').QueryConfig & { query_timeout: number };

export const AGENT_AKTUELLE_TASK_FUNKTION = 'agent_aktuelle_task' as const;
export const AKTUELLE_TASK_REIHENFOLGE = ['aktivitaet', 'bindung', 'beteiligt'] as const;
export type AktuelleTaskQuelle = 'aktivitaet:tool_calls' | 'aktivitaet:file_versions' | 'aktivitaet:thoughts' | 'bindung' | 'beteiligt';
/** Kurzer Puffer je Projekt: agenten-team, Agentennetzwerk und die Web-UI fragen dicht hintereinander. */
export const AKTUELLE_TASK_CACHE_MS = 10_000;

// ---------------------------------------------------------------------------------------------
// Einstellungen (Regel 7: PG vor Code-Standard, Quelle je Wert)
// ---------------------------------------------------------------------------------------------
export const AKTUELLE_TASK_EINSTELLUNGEN = {
  /** Zeitfenster der Aktivitaets-Signale in Stunden. */
  fenster_stunden: { standard: 12, min: 1, max: 168 },
} as const;
export type AktuelleTaskEinstellung = keyof typeof AKTUELLE_TASK_EINSTELLUNGEN;
export interface AktuelleTaskEinstellungenStand {
  werte: Record<AktuelleTaskEinstellung, number>;
  einstellungen: Record<string, { wert: number; quelle: 'standard' | 'einstellung'; min: number; max: number; gesetzt_von?: string; gesetzt_am?: string }>;
  letzter_fehler: string | null;
}

function standardEinstellungen(): AktuelleTaskEinstellungenStand {
  const werte = {} as Record<AktuelleTaskEinstellung, number>;
  const einstellungen: AktuelleTaskEinstellungenStand['einstellungen'] = {};
  for (const [name, d] of Object.entries(AKTUELLE_TASK_EINSTELLUNGEN)) {
    werte[name as AktuelleTaskEinstellung] = d.standard;
    einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max };
  }
  return { werte, einstellungen, letzter_fehler: null };
}

function gueltigerWert(name: string, wert: unknown): number | null {
  const d = AKTUELLE_TASK_EINSTELLUNGEN[name as AktuelleTaskEinstellung];
  const n = typeof wert === 'number' ? wert : typeof wert === 'string' && wert.trim() ? Number(wert) : NaN;
  return d && Number.isInteger(n) && n >= d.min && n <= d.max ? n : null;
}

/** Wirksame Einstellungen (PG vor Code-Standard). Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseAktuelleTaskEinstellungen(): Promise<AktuelleTaskEinstellungenStand> {
  const stand = standardEinstellungen();
  try {
    const r = await getPool().query<{ name: string; wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(
      'SELECT name, wert, gesetzt_von, gesetzt_am FROM agent_aktuelle_task_einstellungen');
    const ungueltig: string[] = [];
    for (const z of r.rows) {
      const w = gueltigerWert(z.name, z.wert);
      if (w === null) { ungueltig.push(z.name); continue; }
      stand.werte[z.name as AktuelleTaskEinstellung] = w;
      const d = AKTUELLE_TASK_EINSTELLUNGEN[z.name as AktuelleTaskEinstellung];
      stand.einstellungen[z.name] = { wert: w, quelle: 'einstellung', min: d.min, max: d.max, gesetzt_von: z.gesetzt_von,
        gesetzt_am: z.gesetzt_am instanceof Date ? z.gesetzt_am.toISOString() : String(z.gesetzt_am) };
    }
    if (ungueltig.length) stand.letzter_fehler = 'einstellung_ungueltig: ' + ungueltig.join(', ');
  } catch (error) {
    stand.letzter_fehler = 'einstellungen_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error));
  }
  return stand;
}

/** Einstellungen setzen (nur der User, die Route prueft das). werte {name: zahl|null}; null = zurueck auf den Code-Standard. */
export async function setzeAktuelleTaskEinstellungen(werte: unknown, grund: unknown, von: string): Promise<AktuelleTaskEinstellungenStand> {
  if (!werte || typeof werte !== 'object' || Array.isArray(werte)) throw new ProfilVerwaltungFehler('werte_fehlen', { erlaubt: Object.keys(AKTUELLE_TASK_EINSTELLUNGEN) });
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < 5) throw new ProfilVerwaltungFehler('grund_fehlt');
  const eintraege = Object.entries(werte as Record<string, unknown>);
  for (const [name, wert] of eintraege) {
    if (!(name in AKTUELLE_TASK_EINSTELLUNGEN)) throw new ProfilVerwaltungFehler('einstellung_unbekannt', { name, erlaubt: Object.keys(AKTUELLE_TASK_EINSTELLUNGEN) });
    if (wert !== null && gueltigerWert(name, wert) === null) {
      const d = AKTUELLE_TASK_EINSTELLUNGEN[name as AktuelleTaskEinstellung];
      throw new ProfilVerwaltungFehler('wert_ungueltig', { name, min: d.min, max: d.max });
    }
  }
  const setzen = eintraege.filter(([, w]) => w !== null).map(([n, w]) => [n, gueltigerWert(n, w)] as const);
  const entfernen = eintraege.filter(([, w]) => w === null).map(([n]) => n);
  const pool = getPool();
  if (setzen.length) {
    await pool.query(
      `INSERT INTO agent_aktuelle_task_einstellungen (name, wert, grund, gesetzt_von)
       SELECT n, to_jsonb(w), $3, $4 FROM unnest($1::text[], $2::int[]) AS t(n, w)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW()`,
      [setzen.map(([n]) => n), setzen.map(([, w]) => w), g, von]);
  }
  if (entfernen.length) await pool.query('DELETE FROM agent_aktuelle_task_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
  leereAktuelleTaskCache();
  return leseAktuelleTaskEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface AktuelleTaskSchalter {
  funktion: typeof AGENT_AKTUELLE_TASK_FUNKTION;
  project: string | null;
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  ebene: 'global' | 'projekt' | null;
  bis: string | null;
  letzter_fehler: string | null;
}

/** intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (projekt > global) > AUS. Frisch je Aufruf, wirft nie. */
export async function leseAktuelleTaskSchalter(project?: string | null): Promise<AktuelleTaskSchalter> {
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const basis: AktuelleTaskSchalter = { funktion: AGENT_AKTUELLE_TASK_FUNKTION, project: p, aktiv: false, quelle: 'standard', ebene: null, bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  try {
    // Dynamisch wie chat-zitate.ts (Importzyklus ueber intern-tool).
    const { internToolAktiv } = await import('./intern-tool.js');
    if (internToolAktiv()) {
      try {
        const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
          text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
          values: [AGENT_AKTUELLE_TASK_FUNKTION], query_timeout: 2000,
        } as Q);
        const z = r.rows[0];
        if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
      } catch { letzter = 'schalter_nicht_erreichbar'; }
    }
    const s = await leseProfilProduktSchalter(AGENT_AKTUELLE_TASK_FUNKTION, p);
    if (s.quelle === 'produkt-schalter' && !s.letzter_fehler) return { ...basis, aktiv: s.aktiv, quelle: 'produkt-schalter', ebene: s.ebene, letzter_fehler: letzter };
    return { ...basis, letzter_fehler: letzter ?? s.letzter_fehler };
  } catch (error) {
    return { ...basis, letzter_fehler: 'schalter_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

// ---------------------------------------------------------------------------------------------
// Ermittlung
// ---------------------------------------------------------------------------------------------
export interface AktuelleTask {
  /** Identitaet des Agenten; null bei Legacy-Namen ohne Identitaet im Projekt. */
  identity_id: string | null;
  agent_id: string;
  /** Anzeigename der Identitaet (agent_identitaeten.name), sonst agent_id. */
  name: string;
  task_id: string;
  titel: string | null;
  status: string | null;
  seit: string | null;
  zuletzt: string | null;
  quelle: AktuelleTaskQuelle;
  /** Debug: Zahl der Aktivitaets-Signale dieses Agenten im Fenster (0 bei bindung/beteiligt). */
  signale: number;
}

export interface AktuelleTasksStand {
  success: true;
  project: string;
  aktiv: boolean;
  agenten: AktuelleTask[];
  schalter: AktuelleTaskSchalter;
  einstellungen: AktuelleTaskEinstellungenStand;
  reihenfolge: readonly string[];
  stand: string;
  dauer_ms: number;
  cache: 'neu' | 'puffer';
  letzter_fehler: string | null;
}

// Aktivitaet: juengstes Signal je Agent (Identitaet, sonst Name; Legacy-Namen einer Identitaet werden ihr zugeordnet), dazu der
// Wechselzeitpunkt (seit). Die Teilindizes idx_fv_task_id / idx_thoughts_project_task_id halten die Abfrage klein.
const AKTIVITAET_SQL = `
WITH t AS (
  SELECT id::text AS uuid, task->>'kurz_id' AS kurz, task->>'title' AS titel, task->>'status' AS status
    FROM plan_tasks WHERE project = $1 AND COALESCE(task->>'kurz_id', '') <> ''
), ident AS (
  SELECT id::text AS id, agent_id FROM agent_identitaeten WHERE project = $1 AND status = 'aktiv'
), roh AS (
  SELECT c.identity_id, c.agent_id, substring(c.args_preview from '"task_id"\\s*:\\s*"([^"]{1,80})"') AS tid, c.ts, 'aktivitaet:tool_calls'::text AS quelle
    FROM tool_calls c
   WHERE c.project = $1 AND c.ts > NOW() - make_interval(hours => $2::int) AND c.args_preview LIKE '%"task_id"%'
  UNION ALL
  SELECT v.author_identity_id, v.agent_id, v.task_id, v.created_at, 'aktivitaet:file_versions'
    FROM file_versions v WHERE v.task_id IS NOT NULL AND v.project = $1 AND v.created_at > NOW() - make_interval(hours => $2::int)
  UNION ALL
  SELECT h.source_identity_id, h.source, h.task_id, h."timestamp", 'aktivitaet:thoughts'
    FROM thoughts h WHERE h.task_id IS NOT NULL AND h.project = $1 AND h."timestamp" > NOW() - make_interval(hours => $2::int)
), s AS (
  SELECT COALESCE(r.identity_id, i.id) AS identity_id, r.agent_id, t.kurz, t.titel, t.status, r.ts, r.quelle,
         CASE WHEN COALESCE(r.identity_id, i.id) IS NOT NULL THEN 'i:' || COALESCE(r.identity_id, i.id) ELSE 'n:' || r.agent_id END AS schluessel
    FROM roh r
    LEFT JOIN t u ON u.uuid = r.tid
    JOIN t ON t.kurz = COALESCE(u.kurz, r.tid)
    LEFT JOIN ident i ON r.identity_id IS NULL AND i.agent_id = r.agent_id
   WHERE r.tid IS NOT NULL AND (r.identity_id IS NOT NULL OR COALESCE(r.agent_id, '') <> '')
), o AS (
  SELECT s.*, row_number() OVER (PARTITION BY schluessel ORDER BY ts DESC) AS rn FROM s
), oben AS (SELECT * FROM o WHERE rn = 1),
wechsel AS (
  SELECT o.schluessel, max(o.ts) AS m FROM o JOIN oben b USING (schluessel) WHERE o.kurz <> b.kurz GROUP BY o.schluessel
)
SELECT b.identity_id, b.agent_id, b.kurz AS task_id, b.titel, b.status, b.quelle, b.ts AS zuletzt,
       (SELECT min(x.ts) FROM o x WHERE x.schluessel = b.schluessel AND x.kurz = b.kurz AND x.ts > COALESCE(w.m, '-infinity'::timestamptz)) AS seit,
       (SELECT count(*) FROM o x WHERE x.schluessel = b.schluessel)::int AS signale
  FROM oben b LEFT JOIN wechsel w USING (schluessel)
 ORDER BY b.ts DESC`;

/** P22-T232: dieselben Aktivitaetssignale wie die Agenten-Zuordnung, nach Task statt Agent gruppiert. */
export async function letzteAktiveProjektTasks(project: string) {
 const einstellungen = await leseAktuelleTaskEinstellungen();
 const sql = AKTIVITAET_SQL.split('), o AS (')[0] + `)
 SELECT DISTINCT ON (kurz) kurz AS task_id,titel,ts AS zuletzt,quelle FROM s
 WHERE status='in_progress' ORDER BY kurz,ts DESC`;
 const r = await getPool().query<{task_id:string;titel:string|null;zuletzt:Date;quelle:string}>({text:sql,values:[project,einstellungen.werte.fenster_stunden],query_timeout:5000} as Q);
 return r.rows.sort((a,b)=>b.zuletzt.getTime()-a.zuletzt.getTime()).slice(0,3)
  .map(z=>({...z,zuletzt:z.zuletzt.toISOString()}));
}

const BINDUNG_SQL = `
SELECT DISTINCT ON (x.id) x.id AS identity_id, b.task_id, b.gesetzt_am, p.task->>'title' AS titel, p.task->>'status' AS status
  FROM plan_task_bindungen b
  CROSS JOIN LATERAL unnest(b.identity_ids) AS x(id)
  JOIN plan_tasks p ON p.project = b.project AND p.task->>'kurz_id' = b.task_id
 WHERE b.project = $1 AND COALESCE(p.task->>'status', '') <> 'done'
 ORDER BY x.id, b.gesetzt_am DESC`;

const BETEILIGT_SQL = `
SELECT CASE WHEN jsonb_typeof(e) = 'object' THEN NULLIF(e->>'identity_id', '') END AS identity_id,
       CASE WHEN jsonb_typeof(e) = 'object' THEN e->>'agent_id' ELSE e #>> '{}' END AS agent_id,
       CASE WHEN jsonb_typeof(e) = 'object' THEN e->>'seit' END AS seit,
       p.task->>'kurz_id' AS task_id, p.task->>'title' AS titel, p.task->>'status' AS status, p.task->>'updatedAt' AS geaendert
  FROM plan_tasks p
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.task->'beteiligte') = 'array' THEN p.task->'beteiligte' ELSE '[]'::jsonb END) AS e
 WHERE p.project = $1 AND p.task->>'status' = 'in_progress' AND COALESCE(p.task->>'kurz_id', '') <> ''`;

const IDENT_SQL = `SELECT id::text AS id, agent_id, name FROM agent_identitaeten WHERE project = $1 AND status = 'aktiv'`;

interface AktivZeile { identity_id: string | null; agent_id: string | null; task_id: string; titel: string | null; status: string | null; quelle: AktuelleTaskQuelle; zuletzt: Date; seit: Date | null; signale: number }
interface BindungZeile { identity_id: string; task_id: string; gesetzt_am: Date; titel: string | null; status: string | null }
interface BeteiligtZeile { identity_id: string | null; agent_id: string | null; seit: string | null; task_id: string; titel: string | null; status: string | null; geaendert: string | null }

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
};

const PUFFER = new Map<string, { bis: number; stand: AktuelleTasksStand }>();
/** Puffer verwerfen (Tests; automatisch nach dem Setzen einer Einstellung im eigenen Prozess). */
export function leereAktuelleTaskCache(): void { PUFFER.clear(); }

function leer(project: string, schalter: AktuelleTaskSchalter, einstellungen: AktuelleTaskEinstellungenStand, start: number, fehler: string | null): AktuelleTasksStand {
  return { success: true, project, aktiv: schalter.aktiv, agenten: [], schalter, einstellungen, reihenfolge: AKTUELLE_TASK_REIHENFOLGE,
    stand: new Date().toISOString(), dauer_ms: Date.now() - start, cache: 'neu', letzter_fehler: fehler };
}

/**
 * Aktuelle Task je Agent des Projekts (Reihenfolge oben). Schalter AUS -> leere Liste. Wirft nie; ein Lesefehler steht in
 * letzter_fehler, die Liste enthaelt dann nur, was gelesen werden konnte (und wird nicht gepuffert).
 */
export async function ermittleAktuelleTasks(project: string, optionen: { neu?: boolean } = {}): Promise<AktuelleTasksStand> {
  const start = Date.now();
  const p = typeof project === 'string' ? project.trim() : '';
  const schalter = await leseAktuelleTaskSchalter(p || null);
  if (!p || !schalter.aktiv) return leer(p, schalter, standardEinstellungen(), start, schalter.letzter_fehler);
  const gepuffert = optionen.neu ? undefined : PUFFER.get(p);
  if (gepuffert && gepuffert.bis > Date.now()) return { ...gepuffert.stand, schalter, cache: 'puffer' };

  const einstellungen = await leseAktuelleTaskEinstellungen();
  const fehler: string[] = [];
  if (einstellungen.letzter_fehler) fehler.push(einstellungen.letzter_fehler);
  const lies = async <T>(art: string, sql: string, werte: unknown[]): Promise<T[]> => {
    try { return (await getPool().query({ text: sql, values: werte, query_timeout: 5000 } as Q)).rows as T[]; }
    catch (error) { fehler.push(art + ': ' + (error instanceof Error ? error.message : String(error)).slice(0, 160)); return []; }
  };
  const [aktiv, bindung, beteiligt, ident] = await Promise.all([
    lies<AktivZeile>('aktivitaet', AKTIVITAET_SQL, [p, einstellungen.werte.fenster_stunden]),
    lies<BindungZeile>('bindung', BINDUNG_SQL, [p]),
    lies<BeteiligtZeile>('beteiligt', BETEILIGT_SQL, [p]),
    lies<{ id: string; agent_id: string; name: string }>('identitaeten', IDENT_SQL, [p]),
  ]);

  const nachId = new Map(ident.map((i) => [i.id, i]));
  const nachName = new Map(ident.map((i) => [i.agent_id, i]));
  const ergebnis = new Map<string, AktuelleTask>();
  const schluessel = (identityId: string | null, agentId: string | null) => {
    const i = (identityId && nachId.get(identityId)) || (agentId ? nachName.get(agentId) : undefined);
    return i ? { key: 'i:' + i.id, identity_id: i.id, agent_id: i.agent_id, name: i.name || i.agent_id }
      : identityId ? { key: 'i:' + identityId, identity_id: identityId, agent_id: agentId ?? identityId, name: agentId ?? identityId }
        : agentId ? { key: 'n:' + agentId, identity_id: null, agent_id: agentId, name: agentId } : null;
  };
  // Erster Treffer je Agent gewinnt: die Quellen werden in der Reihenfolge aktivitaet > bindung > beteiligt eingetragen.
  const merke = (k: ReturnType<typeof schluessel>, t: Omit<AktuelleTask, 'identity_id' | 'agent_id' | 'name'>) => {
    if (!k || ergebnis.has(k.key)) return;
    ergebnis.set(k.key, { identity_id: k.identity_id, agent_id: k.agent_id, name: k.name, ...t });
  };
  // 1 Aktivitaet (bereits nach zuletzt absteigend; je Schluessel nur die juengste Zeile)
  for (const z of aktiv) {
    merke(schluessel(z.identity_id, z.agent_id), { task_id: z.task_id, titel: z.titel, status: z.status, seit: iso(z.seit) ?? iso(z.zuletzt),
      zuletzt: iso(z.zuletzt), quelle: z.quelle, signale: Number(z.signale) || 0 });
  }
  // 2 Bindung (nur ohne Aktivitaet)
  for (const z of bindung) {
    merke(schluessel(z.identity_id, null), { task_id: z.task_id, titel: z.titel, status: z.status, seit: iso(z.gesetzt_am), zuletzt: null, quelle: 'bindung', signale: 0 });
  }
  // 3 Beteiligt (juengste Uebernahme zuerst)
  const beteiligtSortiert = [...beteiligt].sort((a, b) => (Date.parse(b.seit ?? b.geaendert ?? '') || 0) - (Date.parse(a.seit ?? a.geaendert ?? '') || 0));
  for (const z of beteiligtSortiert) {
    merke(schluessel(z.identity_id, z.agent_id), { task_id: z.task_id, titel: z.titel, status: z.status, seit: iso(z.seit) ?? iso(z.geaendert), zuletzt: null, quelle: 'beteiligt', signale: 0 });
  }

  const stand: AktuelleTasksStand = {
    success: true, project: p, aktiv: true, agenten: [...ergebnis.values()], schalter, einstellungen, reihenfolge: AKTUELLE_TASK_REIHENFOLGE,
    stand: new Date().toISOString(), dauer_ms: Date.now() - start, cache: 'neu', letzter_fehler: fehler.length ? fehler.join(' | ') : null,
  };
  if (!fehler.length) PUFFER.set(p, { bis: Date.now() + AKTUELLE_TASK_CACHE_MS, stand });
  return stand;
}

/** Eintrag fuer einen Agenten (Identitaet vor Name). */
export function aktuelleTaskFuer(stand: Pick<AktuelleTasksStand, 'agenten'> | null | undefined, wer: { identity_id?: string | null; agent_id?: string | null }): AktuelleTask | null {
  if (!stand) return null;
  return (wer.identity_id ? stand.agenten.find((a) => a.identity_id === wer.identity_id) : undefined)
    ?? (wer.agent_id ? stand.agenten.find((a) => a.agent_id === wer.agent_id || a.name === wer.agent_id) : undefined) ?? null;
}
