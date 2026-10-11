/**
 * MODUL: Intern-Diagnose (P15-T15, Debug-Werkzeuge Welle 1)
 * ZWECK: Lesende Diagnose-Actions des intern-Tools in EINER eigenen Datei. intern-tool.ts haengt sie nur
 *        ein (DIAGNOSE_ACTIONS, DIAGNOSE_PARAMETER, DIAGNOSE_BESCHREIBUNG, fuehreDiagnoseAus) - so
 *        ueberschneidet sich dieses Modul nicht mit den Worker-/Pausen-Actions (P15-T12).
 *
 * ACTIONS
 *   bestand_abgleich  PG (gesamt/eingebettet) gegen Qdrant (count exact) je Collection; optional ID-Diff
 *                     (paginiert ueber scrollePunktIds, nie scrollVectors mit Limit - 16e5472a, ea0c2d70)
 *   durchsatz         fertige Chunks je Knoten im Zeitfenster, aktive Claims, claimbar, Knoten-Kontakt;
 *                     Befund "kaputt statt leer" (11.10.2026)
 *   warum_nicht       Chunk / Datei / Projekt / Shell-Job: was haelt es auf (intern-diagnose-code.ts)
 *   parser_pool       Slots, Queue, stillgelegte Slots, beendete Worker, Threads (07ac26de)
 *   parse_ausfaelle   parse_failures sichtbar (3ad628e5, 0bd2d859)
 *   parse_neu         Datei(en) neu parsen - NUR mit ausfuehren:true, sonst Vorschau
 *   wrapper_takt      Heartbeat-Konfiguration, Inbox-/Event-Stau je Wrapper, Verdacht "taub" (8759d1f4)
 *   wartezustand      offene Co-Edit-Waits mit Traeger-/Zielplan und Befunden (bab6fc3b)
 *   sync_inspektor    Datei PG-Stand gegen file_versions, Reservierungen, offene Plaene, Daemon (PG-Teil)
 *   schema_probe      Vorschau: Schema-Kennung des Builds gegen schema_stand; ausfuehren:true =
 *                     ensureSchema({nurProbe:true}) (Rollback, sperrt kurz alle Tabellen)
 * ANTWORT: { success, action, ... }; fuehreDiagnoseAus wirft nie.
 */

import { getPool, imHintergrund } from '../db/client.js';
import { getQdrantClient } from '../qdrant/client.js';
import { listCollections } from '../qdrant/collections.js';
import { scrollePunktIds } from '../qdrant/operations.js';
import { COLLECTIONS } from '../types/index.js';
import { ordneCollectionEin } from './neu-einbetten.js';
import { zaehleOffeneEmbeddings } from './embed-backlog.js';
import { alleSchalter } from './intern-schalter.js';
import { workerStatus } from './worker-steuerung.js';
import { SCHEMA_KENNUNG, ensureSchema } from '../db/schema.js';
import {
  DiagnoseFehler,
  parseAusfaelle,
  parseNeu,
  parserPool,
  syncInspektor,
  tabelleDa,
  warumNicht,
} from './intern-diagnose-code.js';

export { DiagnoseFehler } from './intern-diagnose-code.js';

export const DIAGNOSE_ACTIONS = [
  'bestand_abgleich', 'durchsatz', 'warum_nicht', 'parser_pool', 'parse_ausfaelle', 'parse_neu',
  'wrapper_takt', 'wartezustand', 'sync_inspektor', 'schema_probe',
] as const;
export type DiagnoseAction = (typeof DIAGNOSE_ACTIONS)[number];

export function istDiagnoseAction(action: string): action is DiagnoseAction {
  return (DIAGNOSE_ACTIONS as readonly string[]).includes(action);
}

/** Satz fuer die Tool-Beschreibung (intern-tool.ts haengt ihn an). */
export const DIAGNOSE_BESCHREIBUNG =
  'DIAGNOSE (lesend): bestand_abgleich (project, arten, ids_vergleichen): PG gegen Qdrant je Collection, optional ID-Diff; ' +
  'durchsatz (minuten, luecke_s): Chunks/min je Knoten ueber Fenster und aktive Spanne, Luecken je Knoten, Verlauf je Minute, aktive Claims, claimbar, Befund kaputt-statt-leer; ' +
  'warum_nicht (chunk_id | project + file_path | project | shell_job_id): was haelt es auf; ' +
  'parser_pool: Slots, Queue, stillgelegte Slots, Threads; parse_ausfaelle (project, limit); ' +
  'parse_neu (project, file_path oder alle_ausfaelle, mit_embeddings, ausfuehren): ohne ausfuehren:true nur Vorschau; ' +
  'wrapper_takt (project): Heartbeat, Inbox-/Event-Stau, Verdacht taub; wartezustand (project): offene Co-Edit-Waits; ' +
  'sync_inspektor (project, file_path): PG-Stand gegen file_versions; schema_probe (ausfuehren): Schema-Kennung, mit ausfuehren:true Probelauf mit Rollback. ';

/** Nur NEUE Parameter (vorhandene wie project, limit, minuten, ausfuehren, arten nutzt die Diagnose mit). */
export const DIAGNOSE_PARAMETER: Record<string, unknown> = {
  file_path: { type: ['string', 'array'], items: { type: 'string' }, description: 'warum_nicht/sync_inspektor: Datei (projektrelativ); parse_neu: Datei oder Liste' },
  chunk_id: { type: 'string', description: 'warum_nicht: ID aus code_chunks' },
  shell_job_id: { type: 'string', description: 'warum_nicht: Job-UUID aus shell(history)' },
  ids_vergleichen: { type: 'boolean', description: 'bestand_abgleich: zusaetzlich IDs abgleichen (fehlend/verwaist; nur Wissens-Arten, braucht project oder arten)' },
  alle_ausfaelle: { type: 'boolean', description: 'parse_neu: alle Parse-Ausfaelle des Projekts (bis limit)' },
  mit_embeddings: { type: 'boolean', description: 'parse_neu: auch neu chunken/einbetten (Standard false = nur Symbole)' },
  luecke_s: { type: 'number', description: 'durchsatz: Abstand ohne Abschluss, ab dem eine Luecke je Knoten gemeldet wird (Standard 30 s)' },
};

// ───── Hilfen ───────────────────────────────────────────────────────────

function text(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function zahl(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return undefined;
}

function wahr(a: Record<string, unknown>, k: string): boolean {
  const v = a[k];
  return v === true || v === 'true';
}

function textListe(a: Record<string, unknown>, k: string): string[] | undefined {
  const v = a[k];
  let roh: unknown[] | undefined;
  if (Array.isArray(v)) roh = v;
  else if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try { const p: unknown = JSON.parse(t); if (Array.isArray(p)) roh = p; } catch { /* Komma-Liste */ }
    }
    roh ??= t.split(',');
  }
  const liste = (roh ?? []).map((x) => String(x).trim()).filter(Boolean);
  return liste.length > 0 ? liste : undefined;
}

function grenze(wert: number | undefined, standard: number, min: number, max: number, name: string): number {
  if (wert === undefined) return standard;
  if (!Number.isFinite(wert) || wert < min) throw new DiagnoseFehler('parameter_ungueltig', `${name}: Zahl ${min}..${max}.`);
  return Math.min(Math.floor(wert), max);
}

/** Fuehrt fn fuer jedes Element mit hoechstens n gleichzeitig aus (Reihenfolge bleibt). */
async function jeweils<T, R>(liste: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const ergebnis: R[] = new Array(liste.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, liste.length) }, async () => {
    while (i < liste.length) {
      const k = i++;
      ergebnis[k] = await fn(liste[k]);
    }
  }));
  return ergebnis;
}

// ───── bestand_abgleich ────────────────────────────────────────────────

const SKILL_COLLECTION = process.env.SKILL_COLLECTION || 'skills';
const SKILLS_GETRENNT = !!process.env.SKILL_QDRANT_URL && process.env.SKILL_QDRANT_URL !== process.env.QDRANT_URL;

/** PG-Quelle je Art: Tabelle, Bedingung, Projektspalte (null = global), ID-Spalte fuer den ID-Diff. */
const QUELLEN: Record<string, { tabelle: string; wo: string; projekt: boolean; id: string | null }> = {
  code: { tabelle: 'code_chunks', wo: 'TRUE', projekt: true, id: null }, // Punkt-ID = uuidv5(Inhalt), kein ID-Diff
  memories: { tabelle: 'memories', wo: 'TRUE', projekt: true, id: 'id' },
  thoughts: { tabelle: 'thoughts', wo: 'TRUE', projekt: true, id: 'id' },
  proposals: { tabelle: 'proposals', wo: 'TRUE', projekt: true, id: 'id' },
  plans: { tabelle: 'plans', wo: 'TRUE', projekt: true, id: 'id' },
  docs: { tabelle: 'tech_docs', wo: 'project IS NOT NULL', projekt: true, id: 'id' },
  tech_docs_cache: { tabelle: 'tech_docs', wo: 'project IS NULL', projekt: false, id: 'id' },
  error_patterns: { tabelle: 'error_patterns', wo: 'TRUE', projekt: false, id: 'id' },
  skills: { tabelle: 'skill_sections', wo: 'TRUE', projekt: false, id: null },
};

function collectionFuer(art: string, project: string | null): string {
  const p = project ?? '';
  switch (art) {
    case 'code': return COLLECTIONS.projectCode(p);
    case 'memories': return COLLECTIONS.projectMemories(p);
    case 'thoughts': return COLLECTIONS.projectThoughts(p);
    case 'proposals': return COLLECTIONS.projectProposals(p);
    case 'plans': return COLLECTIONS.projectPlans(p);
    case 'docs': return COLLECTIONS.projectDocs(p);
    case 'tech_docs_cache': return COLLECTIONS.techDocs;
    case 'error_patterns': return COLLECTIONS.globalErrorPatterns;
    default: return SKILL_COLLECTION;
  }
}

interface BestandZeile {
  collection: string;
  art: string;
  project: string | null;
  pg_gesamt: number;
  pg_eingebettet: number;
  qdrant: number | null;
  differenz: number | null;
  befund?: string;
}

async function qdrantAnzahl(name: string): Promise<number | null> {
  try {
    const r = await getQdrantClient().count(name, { exact: true });
    return r.count;
  } catch {
    return null;
  }
}

export async function bestandAbgleich(opt: { project?: string; arten?: string[]; idsVergleichen: boolean; limit: number }): Promise<Record<string, unknown>> {
  const pool = getPool();
  const unbekannt = (opt.arten ?? []).filter((x) => !(x in QUELLEN));
  if (unbekannt.length > 0) throw new DiagnoseFehler('parameter_ungueltig', `arten: ${Object.keys(QUELLEN).join(' | ')} (unbekannt: ${unbekannt.join(', ')}).`);
  const arten = opt.arten && opt.arten.length > 0 ? opt.arten : Object.keys(QUELLEN);

  // PG je (Art, Projekt)
  const zeilen = new Map<string, BestandZeile>();
  for (const art of arten) {
    const q = QUELLEN[art];
    if (art === 'skills' && SKILLS_GETRENNT) continue;
    if (!q.projekt && opt.project) continue; // globale Arten nur ohne Projektfilter
    const sql = q.projekt
      ? `SELECT project, count(*)::int AS gesamt, count(embedded_at)::int AS eingebettet FROM ${q.tabelle}
          WHERE ${q.wo} AND project IS NOT NULL AND ($1::text IS NULL OR project = $1) GROUP BY project`
      : `SELECT NULL::text AS project, count(*)::int AS gesamt, count(embedded_at)::int AS eingebettet FROM ${q.tabelle} WHERE ${q.wo}`;
    const { rows } = await pool.query<{ project: string | null; gesamt: number; eingebettet: number }>(sql, q.projekt ? [opt.project ?? null] : []);
    for (const r of rows) {
      const collection = collectionFuer(art, r.project);
      zeilen.set(collection, { collection, art, project: r.project, pg_gesamt: r.gesamt, pg_eingebettet: r.eingebettet, qdrant: null, differenz: null });
    }
  }
  // Qdrant-Collections ohne PG-Zeilen (verwaist) dazu
  const namen = await listCollections();
  const vorhanden = new Set(namen);
  const nichtZugeordnet: string[] = [];
  for (const name of namen) {
    if (zeilen.has(name)) continue;
    const e = ordneCollectionEin(name);
    if (e.art === 'media' || e.art === 'unbekannt') { nichtZugeordnet.push(name); continue; }
    if (!arten.includes(e.art)) continue;
    if (opt.project && e.project !== opt.project) continue;
    if (e.art === 'skills' && SKILLS_GETRENNT) continue;
    zeilen.set(name, { collection: name, art: e.art, project: e.project, pg_gesamt: 0, pg_eingebettet: 0, qdrant: null, differenz: null });
  }
  const liste = [...zeilen.values()];
  await jeweils(liste, 8, async (z) => {
    z.qdrant = vorhanden.has(z.collection) ? await qdrantAnzahl(z.collection) : null;
    if (!vorhanden.has(z.collection)) {
      z.differenz = -z.pg_eingebettet;
      if (z.pg_eingebettet > 0) z.befund = `Collection fehlt, aber ${z.pg_eingebettet} PG-Zeilen gelten als eingebettet`;
      return;
    }
    if (z.qdrant === null) { z.befund = 'Qdrant-Zaehlung fehlgeschlagen'; return; }
    z.differenz = z.qdrant - z.pg_eingebettet;
    if (z.differenz > 0) z.befund = `${z.differenz} Punkte mehr als eingebettete PG-Zeilen (verwaist oder Altpunkte)`;
    else if (z.differenz < 0) z.befund = `${-z.differenz} eingebettete PG-Zeilen ohne Punkt (still verloren)`;
  });

  const jeArt: Record<string, { collections: number; pg_gesamt: number; pg_eingebettet: number; qdrant: number; abweichend: number }> = {};
  for (const z of liste) {
    const s = (jeArt[z.art] ??= { collections: 0, pg_gesamt: 0, pg_eingebettet: 0, qdrant: 0, abweichend: 0 });
    s.collections++; s.pg_gesamt += z.pg_gesamt; s.pg_eingebettet += z.pg_eingebettet; s.qdrant += z.qdrant ?? 0;
    if (z.befund) s.abweichend++;
  }
  const abweichend = liste.filter((z) => z.befund).sort((x, y) => Math.abs(y.differenz ?? 0) - Math.abs(x.differenz ?? 0));

  let idDiff: unknown = undefined;
  if (opt.idsVergleichen) {
    if (!opt.project && !(opt.arten && opt.arten.length > 0)) {
      throw new DiagnoseFehler('parameter_fehlt', 'ids_vergleichen braucht project oder arten (sonst zu gross).');
    }
    const diffs: Array<Record<string, unknown>> = [];
    for (const z of liste) {
      const q = QUELLEN[z.art];
      if (!q.id) { diffs.push({ collection: z.collection, uebersprungen: z.art === 'code' ? 'Code-Punkt-IDs sind Inhalts-Hashes, kein ID-Diff' : 'Skills: Punkt-ID numerisch, nicht abgeglichen' }); continue; }
      if (!vorhanden.has(z.collection)) { diffs.push({ collection: z.collection, uebersprungen: 'Collection fehlt' }); continue; }
      if (z.pg_gesamt > 200_000) { diffs.push({ collection: z.collection, uebersprungen: 'mehr als 200.000 Zeilen' }); continue; }
      const pgIds = await pool.query<{ id: string }>(
        `SELECT ${q.id}::text AS id FROM ${q.tabelle} WHERE ${q.wo} AND embedded_at IS NOT NULL` + (q.projekt ? ' AND project = $1' : ''),
        q.projekt ? [z.project] : [],
      );
      const pg = new Set(pgIds.rows.map((r) => r.id.toLowerCase()));
      const qd = new Set((await scrollePunktIds(z.collection, {}, 2000)).map((x) => String(x).toLowerCase()));
      const fehlend = [...pg].filter((x) => !qd.has(x));
      const verwaist = [...qd].filter((x) => !pg.has(x));
      diffs.push({
        collection: z.collection, pg_eingebettet: pg.size, qdrant_punkte: qd.size,
        fehlend_in_qdrant: fehlend.length, fehlend_beispiele: fehlend.slice(0, 10),
        verwaist_in_qdrant: verwaist.length, verwaist_beispiele: verwaist.slice(0, 10),
      });
    }
    idDiff = diffs;
  }

  return {
    project: opt.project ?? null,
    collections: liste.length,
    je_art: jeArt,
    abweichend: { anzahl: abweichend.length, liste: abweichend.slice(0, opt.limit) },
    ...(opt.project ? { alle: liste } : {}),
    nicht_zugeordnet: nichtZugeordnet,
    ...(SKILLS_GETRENNT ? { hinweis_skills: 'Skills liegen in einer eigenen Qdrant (SKILL_QDRANT_URL) - nicht abgeglichen.' } : {}),
    ...(idDiff !== undefined ? { id_abgleich: idDiff } : {}),
    hinweis: 'Qdrant mit count(exact). differenz = Qdrant - eingebettete PG-Zeilen. Code: Abweichungen nach oben = Altpunkte frueherer Dateistaende. Offene Embeddings (embedded_at NULL) zaehlen nicht als Abweichung.',
  };
}

// ───── durchsatz ───────────────────────────────────────────────────────

const OHNE_CLAIM = '(ohne Claim: Parse-Weg/Daemon)';

/** Schrittweite des Verlaufs: 1 min bis 60 min Fenster, darueber so, dass hoechstens 60 Schritte entstehen. */
export function verlaufSchrittMin(minuten: number): number {
  return minuten <= 60 ? 1 : Math.ceil(minuten / 60);
}

interface Luecke { von: string; bis: string; s: number; art: 'zwischen' | 'vor_erstem' | 'seit_letztem' }

/**
 * P15-T20: je_min ueber die AKTIVE Zeitspanne (erster..letzter Abschluss) statt ueber das ganze Fenster.
 * Nach Deploy/Neustart war ein Knoten nur einen Teil des Fensters aktiv - n/minuten meldete dann einen
 * Einbruch, den es nicht gab (3-min-Fenster: 618.7/min gemeldet, ~1030/min echt).
 * Abschluesse kommen in Stapeln mit gleichem embedded_at (completeEmbeddingClaims) - Luecken werden
 * deshalb ueber DISTINCT embedded_at je Knoten gemessen.
 */
export async function durchsatz(minuten: number, lueckeS = 30): Promise<Record<string, unknown>> {
  const pool = getPool();
  const schritt = verlaufSchrittMin(minuten);
  const [fertig, aktiv, offen, haengend, knoten, jeProjekt, luecken, verlauf, jetzt] = await Promise.all([
    pool.query<{ knoten: string; n: number; erster: Date; letzter: Date }>(
      `SELECT COALESCE(claimed_by, '(ohne Claim: Parse-Weg/Daemon)') AS knoten, count(*)::int AS n,
              min(embedded_at) AS erster, max(embedded_at) AS letzter
         FROM code_chunks WHERE embedded_at > NOW() - make_interval(mins => $1::int)
        GROUP BY 1 ORDER BY n DESC`, [minuten]),
    pool.query<{ knoten: string; n: number; naechster_ablauf: Date }>(
      `SELECT claimed_by AS knoten, count(*)::int AS n, min(lease_until) AS naechster_ablauf
         FROM code_chunks WHERE embedded_at IS NULL AND lease_until >= NOW() GROUP BY 1 ORDER BY n DESC`),
    pool.query<{ offen: number; claimbar: number; abgelaufen: number; projekt_aus: number }>(
      `SELECT count(*)::int AS offen,
              count(*) FILTER (WHERE (cc.lease_until IS NULL OR cc.lease_until < NOW()) AND pr.aktiv)::int AS claimbar,
              count(*) FILTER (WHERE cc.lease_until < NOW())::int AS abgelaufen,
              count(*) FILTER (WHERE pr.aktiv IS NOT TRUE)::int AS projekt_aus
         FROM code_chunks cc
         LEFT JOIN (SELECT name, bool_or(enabled) AS aktiv FROM projects GROUP BY name) pr ON pr.name = cc.project
        WHERE cc.embedded_at IS NULL`),
    pool.query(
      `SELECT id, project, file_path, chunk_index, claim_attempt, claimed_by, length(content)::int AS zeichen
         FROM code_chunks WHERE embedded_at IS NULL AND claim_attempt >= 3
        ORDER BY claim_attempt DESC LIMIT 5`),
    pool.query(
      `SELECT node_id, host, modell, status, gesperrt_vom_user, active_jobs, max_concurrency,
              EXTRACT(EPOCH FROM (NOW() - letzter_kontakt))::int AS kontakt_vor_s
         FROM embedding_knoten ORDER BY letzter_kontakt DESC`).catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
    pool.query(
      `SELECT cc.project, count(*)::int AS offen, COALESCE(e.stufe, 3) AS stufe
         FROM code_chunks cc LEFT JOIN embed_prioritaet e ON e.project = cc.project
        WHERE cc.embedded_at IS NULL GROUP BY cc.project, e.stufe ORDER BY COALESCE(e.stufe, 3), offen DESC LIMIT 10`),
    pool.query<{ knoten: string; von: Date; bis: Date; s: number }>(
      `WITH d AS (SELECT DISTINCT COALESCE(claimed_by, '${OHNE_CLAIM}') AS knoten, embedded_at AS t
                    FROM code_chunks WHERE embedded_at > NOW() - make_interval(mins => $1::int)),
            l AS (SELECT knoten, lag(t) OVER (PARTITION BY knoten ORDER BY t) AS von, t AS bis FROM d)
       SELECT knoten, von, bis, EXTRACT(EPOCH FROM (bis - von))::float8 AS s
         FROM l WHERE von IS NOT NULL AND bis - von > make_interval(secs => $2::int)
        ORDER BY s DESC LIMIT 200`, [minuten, lueckeS]),
    pool.query<{ ab: Date; knoten: string | null; n: number }>(
      `WITH g AS (SELECT generate_series(
                    to_timestamp(floor(EXTRACT(EPOCH FROM NOW() - make_interval(mins => $1::int)) / ($2::int * 60)) * $2::int * 60),
                    NOW(), make_interval(mins => $2::int)) AS ab),
            f AS (SELECT to_timestamp(floor(EXTRACT(EPOCH FROM embedded_at) / ($2::int * 60)) * $2::int * 60) AS ab,
                         COALESCE(claimed_by, '${OHNE_CLAIM}') AS knoten, count(*)::int AS n
                    FROM code_chunks WHERE embedded_at > NOW() - make_interval(mins => $1::int) GROUP BY 1, 2)
       SELECT g.ab, f.knoten, COALESCE(f.n, 0)::int AS n FROM g LEFT JOIN f ON f.ab = g.ab ORDER BY g.ab`, [minuten, schritt]),
    pool.query<{ jetzt: Date }>('SELECT NOW() AS jetzt'),
  ]);
  const haengendGesamt = (await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM code_chunks WHERE embedded_at IS NULL AND claim_attempt >= 3')).rows[0].n;
  let schalter: Array<Record<string, unknown>> = [];
  try { schalter = ((await alleSchalter()) as unknown as Array<Record<string, unknown>>).filter((s) => s.aktiv === true); } catch { /* ohne */ }
  const pausiert = workerStatus().filter((w) => w.zustand === 'pausiert').map((w) => ({ name: w.name, bis: w.pause?.bis, grund: w.pause?.grund }));
  let wissenOffen: Record<string, number> | { fehler: string };
  try { wissenOffen = await zaehleOffeneEmbeddings(); } catch (err) { wissenOffen = { fehler: (err as Error).message }; }

  const fertigGesamt = fertig.rows.reduce((s, r) => s + r.n, 0);
  const o = offen.rows[0];

  // Aktive Spanne, Luecken (zwischen Abschluessen + Raender des Fensters) und je_min je Knoten
  const jetztMs = new Date(jetzt.rows[0].jetzt).getTime();
  const beginnMs = jetztMs - minuten * 60_000;
  const rund1 = (x: number) => Math.round(x * 10) / 10;
  const lueckenJe = new Map<string, Luecke[]>();
  for (const l of luecken.rows) {
    const liste = lueckenJe.get(l.knoten) ?? [];
    liste.push({ von: new Date(l.von).toISOString(), bis: new Date(l.bis).toISOString(), s: Math.round(l.s), art: 'zwischen' });
    lueckenJe.set(l.knoten, liste);
  }
  const fertigJeKnoten = fertig.rows.map((r) => {
    const ersterMs = new Date(r.erster).getTime();
    const letzterMs = new Date(r.letzter).getTime();
    const liste = lueckenJe.get(r.knoten) ?? [];
    if ((ersterMs - beginnMs) / 1000 > lueckeS) liste.push({ von: new Date(beginnMs).toISOString(), bis: new Date(ersterMs).toISOString(), s: Math.round((ersterMs - beginnMs) / 1000), art: 'vor_erstem' });
    if ((jetztMs - letzterMs) / 1000 > lueckeS) liste.push({ von: new Date(letzterMs).toISOString(), bis: new Date(jetztMs).toISOString(), s: Math.round((jetztMs - letzterMs) / 1000), art: 'seit_letztem' });
    liste.sort((x, y) => y.s - x.s);
    const aktivS = Math.max(0, (letzterMs - ersterMs) / 1000);
    const zwischenS = liste.filter((l) => l.art === 'zwischen').reduce((s, l) => s + l.s, 0);
    // Unter 30 s aktiver Spanne (ein, zwei Stapel) ist eine Rate nicht belastbar.
    const jeMinAktiv = aktivS >= 30 ? rund1(r.n / (aktivS / 60)) : null;
    const ohneLueckenS = aktivS - zwischenS;
    return {
      ...r,
      je_min: rund1(r.n / minuten),
      je_min_fenster: rund1(r.n / minuten),
      aktiv_s: Math.round(aktivS),
      je_min_aktiv: jeMinAktiv,
      je_min_ohne_luecken: ohneLueckenS >= 30 ? rund1(r.n / (ohneLueckenS / 60)) : null,
      luecken_s_summe: liste.reduce((s, l) => s + l.s, 0),
      luecken: liste.slice(0, 10),
      ...(liste.length > 10 ? { luecken_gekappt: liste.length } : {}),
    };
  });

  // Verlauf: ein Eintrag je Schritt (auch leere), je Knoten die Zahl fertiger Chunks
  const verlaufMap = new Map<string, { ab: string; gesamt: number; je_knoten: Record<string, number> }>();
  for (const v of verlauf.rows) {
    const ab = new Date(v.ab).toISOString();
    const e = verlaufMap.get(ab) ?? { ab, gesamt: 0, je_knoten: {} };
    if (v.knoten) { e.je_knoten[v.knoten] = v.n; e.gesamt += v.n; }
    verlaufMap.set(ab, e);
  }
  const verlaufListe = [...verlaufMap.values()];
  const befund: string[] = [];
  if (o.offen === 0) befund.push('LEER: kein Code-Chunk ohne Vektor.');
  else if (o.claimbar > 0 && fertigGesamt === 0) {
    befund.push(`KAPUTT statt leer: ${o.claimbar} claimbare Chunks, aber in ${minuten} min keiner fertig.`);
    if (schalter.some((s) => s.name === 'embedding')) befund.push('  Ursache: Schalter embedding ist an.');
    if (pausiert.length > 0) befund.push(`  Pausierte Worker in diesem Prozess: ${pausiert.map((p) => p.name).join(', ')}.`);
    const lebend = (knoten.rows as Array<Record<string, unknown>>).filter((k) => Number(k.kontakt_vor_s) < 120 && !k.gesperrt_vom_user);
    befund.push(`  GPU-Knoten mit Kontakt < 2 min: ${lebend.length}. Server-Loop: intern(worker_status).`);
  } else if (o.claimbar === 0) {
    befund.push(`Nichts claimbar: ${o.offen} offen, davon ${o.projekt_aus} in deaktivierten/nicht registrierten Projekten, Rest geclaimt.`);
  } else {
    befund.push(`Laeuft: ${fertigGesamt} Chunks in ${minuten} min (${rund1(fertigGesamt / minuten)}/min ueber das Fenster), ${o.claimbar} claimbar.`);
  }
  for (const k of fertigJeKnoten) {
    const rand = k.luecken.find((l) => l.art === 'seit_letztem');
    if (rand && o.claimbar > 0) befund.push(`Knoten ${k.knoten}: seit ${rand.s} s kein Abschluss (letzter ${rand.von}).`);
    const vorn = k.luecken.find((l) => l.art === 'vor_erstem');
    if (vorn && k.je_min_aktiv !== null) befund.push(`Knoten ${k.knoten}: erst ab ${vorn.bis} aktiv - je_min_aktiv ${k.je_min_aktiv}/min statt ${k.je_min_fenster}/min ueber das Fenster (Start/Neustart, kein Einbruch).`);
    const mitte = k.luecken.filter((l) => l.art === 'zwischen');
    if (mitte.length > 0) befund.push(`Knoten ${k.knoten}: ${mitte.length} Luecke(n) > ${lueckeS} s zwischen Abschluessen, laengste ${mitte[0].s} s ab ${mitte[0].von}.`);
  }
  if (o.abgelaufen > 0) befund.push(`${o.abgelaufen} offene Chunks mit abgelaufenem Lease (Knoten abgebrochen; werden neu vergeben).`);
  if (haengendGesamt > 0) befund.push(`${haengendGesamt} Chunks mit claim_attempt >= 3 - scheitern wiederholt (Beispiele in haengend).`);
  for (const k of knoten.rows as Array<Record<string, unknown>>) {
    if (Number(k.kontakt_vor_s) > 120 && Number(k.active_jobs) > 0) befund.push(`Knoten ${k.node_id}: ${k.active_jobs} aktive Jobs, aber Kontakt vor ${k.kontakt_vor_s} s.`);
  }
  return {
    minuten,
    luecke_s: lueckeS,
    fertig_je_knoten: fertigJeKnoten,
    fertig_gesamt: fertigGesamt,
    verlauf_schritt_min: schritt,
    verlauf: verlaufListe,
    aktive_claims: aktiv.rows,
    offen: o,
    haengend: { anzahl: haengendGesamt, beispiele: haengend.rows },
    offen_je_projekt: jeProjekt.rows,
    knoten: knoten.rows,
    schalter_aktiv: schalter,
    worker_pausiert: pausiert,
    wissen_offen: wissenOffen,
    befund,
    hinweis: 'je_min / je_min_fenster = n / minuten (ganzes Fenster). je_min_aktiv = n / (letzter - erster Abschluss), null unter 30 s. je_min_ohne_luecken zieht zusaetzlich die Luecken zwischen Abschluessen ab. luecken: art zwischen | vor_erstem (Fensterbeginn bis erster Abschluss) | seit_letztem (bis jetzt). Abschluesse kommen in Stapeln mit gleichem embedded_at.',
  };
}

// ───── wartezustand ────────────────────────────────────────────────────

export async function wartezustand(project: string | undefined, limit: number): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT w.wait_token::text, w.project, w.waiting_agent, w.primary_agent, w.shared_files, w.status,
            w.source_plan_id::text, w.primary_plan_id::text,
            jsonb_array_length(w.deferred_ops)::int AS ops, cardinality(w.consumed_deferred_op_indexes)::int AS verbraucht,
            w.contributed_files, w.no_change_files, w.expires_at, w.created_at, w.updated_at,
            EXTRACT(EPOCH FROM (NOW() - w.created_at))::int AS alter_s,
            sp.status::text AS traeger_status, jsonb_array_length(sp.ops)::int AS traeger_ops,
            pp.status::text AS ziel_status, pp.owner_agent_id AS ziel_owner, jsonb_array_length(pp.ops)::int AS ziel_ops,
            pp.committed_at AS ziel_committed
       FROM file_batch_waits w
       LEFT JOIN file_batch_plans sp ON sp.id = w.source_plan_id
       LEFT JOIN file_batch_plans pp ON pp.id = w.primary_plan_id
      WHERE w.status <> 'closed' AND ($1::text IS NULL OR w.project = $1)
      ORDER BY w.created_at DESC LIMIT $2`, [project ?? null, limit],
  );
  const jeStatus: Record<string, number> = {};
  const auffaellig: Array<Record<string, unknown>> = [];
  for (const w of rows) {
    jeStatus[w.status] = (jeStatus[w.status] ?? 0) + 1;
    const befund: string[] = [];
    const offen = w.status === 'waiting' || w.status === 'linked';
    if (offen && !w.primary_plan_id && w.alter_s > 120) befund.push(`ohne Ziel seit ${Math.round(w.alter_s / 60)} min (target_plan_id null - bab6fc3b)`);
    if (offen && w.primary_plan_id && w.ziel_status && w.ziel_status !== 'open') befund.push(`Zielplan ${w.primary_plan_id} ist ${w.ziel_status}, Wait noch ${w.status}`);
    if (new Date(w.expires_at) < new Date()) befund.push('abgelaufen, aber nicht geschlossen');
    if (w.verbraucht < w.ops && w.ziel_status === 'committed') befund.push(`${w.ops - w.verbraucht} zurueckgestellte Op(s) nicht verbraucht, Ziel schon committet - Beitrag verloren?`);
    if ((w.status === 'ready' || w.status === 'no_changes') && w.traeger_status === 'open' && w.traeger_ops === 0) befund.push(`Traeger ${w.source_plan_id} offen ohne Ops`);
    w.befund = befund;
    if (befund.length > 0) auffaellig.push(w);
  }
  return {
    project: project ?? null,
    offen: rows.length,
    je_status: jeStatus,
    auffaellig,
    waits: rows,
    hinweis: 'Status: waiting (wartet auf Ziel/ersten Beitrag), linked (begonnen), ready, no_changes; closed wird nicht gezeigt. Details eines Plans: files(plan_status, plan_id).',
  };
}

// ───── wrapper_takt ────────────────────────────────────────────────────

export async function wrapperTakt(project: string | undefined): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ws.agent_name, ws.project, ws.status, ws.busy, ws.model, ws.heartbeat_enabled, ws.heartbeat_interval_ms,
            ws.last_activity, EXTRACT(EPOCH FROM (NOW() - ws.last_activity))::int AS aktivitaet_vor_s,
            (SELECT count(*)::int FROM specialist_inbox i WHERE i.to_agent = ws.agent_name AND i.processed = false) AS inbox_offen,
            (SELECT EXTRACT(EPOCH FROM (NOW() - min(i.created_at)))::int FROM specialist_inbox i
              WHERE i.to_agent = ws.agent_name AND i.processed = false) AS inbox_aelteste_s,
            (SELECT count(*)::int FROM agent_events e
              WHERE e.project = ws.project AND e.requires_ack AND e.created_at > NOW() - INTERVAL '24 hours'
                AND (e.scope = 'all' OR e.scope = ws.agent_name)
                AND NOT EXISTS (SELECT 1 FROM agent_event_acks k WHERE k.event_id = e.id AND k.agent_id = ws.agent_name)) AS events_ohne_ack
       FROM wrapper_status ws
      WHERE ($1::text IS NULL OR ws.project = $1) AND ws.status NOT IN ('stopped')
      ORDER BY ws.project, ws.agent_name`, [project ?? null],
  );
  const verdacht: string[] = [];
  for (const w of rows) {
    const befund: string[] = [];
    if (!w.heartbeat_enabled) befund.push('Heartbeat aus: reagiert nur auf wake/NOTIFY');
    // Erwarteter Abstand: fester Takt x 3, sonst 5 min (Ladder 10 s .. 60 min)
    const erwartet = w.heartbeat_interval_ms ? Math.max(60, (w.heartbeat_interval_ms / 1000) * 3) : 300;
    if (!w.busy && w.inbox_offen > 0 && (w.inbox_aelteste_s ?? 0) > erwartet) {
      befund.push(`VERDACHT TAUB: ${w.inbox_offen} Inbox-Nachricht(en), aelteste seit ${Math.round((w.inbox_aelteste_s ?? 0) / 60)} min unverarbeitet, nicht busy (8759d1f4)`);
    }
    if ((w.status === 'running' || w.status === 'idle') && w.aktivitaet_vor_s > 180) befund.push(`kein Lebenszeichen seit ${Math.round(w.aktivitaet_vor_s / 60)} min`);
    if (w.events_ohne_ack > 0) befund.push(`${w.events_ohne_ack} Event(s) der letzten 24 h ohne ACK`);
    w.befund = befund;
    if (befund.some((b) => b.startsWith('VERDACHT') || b.startsWith('kein Lebenszeichen'))) verdacht.push(`${w.project}/${w.agent_name}`);
  }
  return {
    project: project ?? null,
    wrapper: rows,
    verdacht,
    hinweis: 'Takt und naechster Poll leben nur im Wrapper-Prozess. last_activity schreibt ein eigener 90-s-Timer - frisch heisst NICHT, dass gepollt wird. Indiz fuer "taub" ist liegende Post. Vorschlag Welle 2: wrapper_status.letzter_poll/naechster_poll vom Wrapper schreiben lassen.',
  };
}

// ───── schema_probe ────────────────────────────────────────────────────

export async function schemaProbe(ausfuehren: boolean): Promise<Record<string, unknown>> {
  let stand: { hash: string; angewandt_am: Date } | null = null;
  if (await tabelleDa('schema_stand')) {
    stand = (await getPool().query<{ hash: string; angewandt_am: Date }>('SELECT hash, angewandt_am FROM schema_stand WHERE id = 1')).rows[0] ?? null;
  }
  const basis = {
    build_kennung: SCHEMA_KENNUNG,
    db_kennung: stand?.hash ?? null,
    db_angewandt_am: stand?.angewandt_am ?? null,
    gleich: stand?.hash === SCHEMA_KENNUNG,
  };
  if (!ausfuehren) {
    return {
      modus: 'vorschau',
      ...basis,
      hinweis: 'gleich:false = die DB traegt das Schema eines anderen Builds. Probelauf mit ausfuehren:true: ensureSchema({nurProbe:true}) - sperrt alle Tabellen kurz einzeln (lock_timeout), fuehrt SCHEMA_SQL + AUTH_SCHEMA_SQL aus und rollt zurueck. Unter Last nur mit Bedacht.',
    };
  }
  try {
    const erg = await ensureSchema({ nurProbe: true, sperrFristMs: 30_000 });
    return { modus: 'ausgefuehrt', ...basis, bestanden: erg.probe === true, ergebnis: erg };
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: string };
    return { modus: 'ausgefuehrt', ...basis, bestanden: false, fehler: { code: e.code ?? null, message: e.message ?? String(err), detail: e.detail ?? null } };
  }
}

// ───── Dispatcher ──────────────────────────────────────────────────────

/** Fuehrt eine Diagnose-Action aus. Wirft nie: Fehler als { success:false, action, error, message }. */
export async function fuehreDiagnoseAus(
  action: string,
  a: Record<string, unknown>,
  _agentId?: string,
): Promise<Record<string, unknown>> {
  try {
    switch (action as DiagnoseAction) {
      case 'bestand_abgleich': {
        const erg = await imHintergrund(() => bestandAbgleich({
          project: text(a, 'project'),
          arten: textListe(a, 'arten'),
          idsVergleichen: wahr(a, 'ids_vergleichen'),
          limit: grenze(zahl(a, 'limit'), 30, 1, 500, 'limit'),
        }));
        return { success: true, action, ...erg };
      }
      case 'durchsatz': {
        const minuten = grenze(zahl(a, 'minuten'), 10, 1, 1440, 'minuten');
        const lueckeS = grenze(zahl(a, 'luecke_s'), 30, 1, 3600, 'luecke_s');
        return { success: true, action, ...(await imHintergrund(() => durchsatz(minuten, lueckeS))) };
      }
      case 'warum_nicht': {
        const datei = textListe(a, 'file_path');
        return {
          success: true,
          action,
          ...(await warumNicht({
            chunk_id: text(a, 'chunk_id'),
            project: text(a, 'project'),
            file_path: datei?.[0],
            shell_job_id: text(a, 'shell_job_id'),
          })),
        };
      }
      case 'parser_pool':
        return { success: true, action, ...parserPool() };
      case 'parse_ausfaelle':
        return { success: true, action, ...(await parseAusfaelle(text(a, 'project'), grenze(zahl(a, 'limit'), 50, 1, 500, 'limit'))) };
      case 'parse_neu': {
        const project = text(a, 'project');
        if (!project) throw new DiagnoseFehler('parameter_fehlt', 'parse_neu: project fehlt.');
        return {
          success: true,
          action,
          ...(await parseNeu({
            project,
            dateien: textListe(a, 'file_path'),
            alle_ausfaelle: wahr(a, 'alle_ausfaelle'),
            limit: grenze(zahl(a, 'limit'), 20, 1, 50, 'limit'),
            ausfuehren: wahr(a, 'ausfuehren'),
            mit_embeddings: wahr(a, 'mit_embeddings'),
          })),
        };
      }
      case 'wrapper_takt':
        return { success: true, action, ...(await wrapperTakt(text(a, 'project'))) };
      case 'wartezustand':
        return { success: true, action, ...(await wartezustand(text(a, 'project'), grenze(zahl(a, 'limit'), 50, 1, 500, 'limit'))) };
      case 'sync_inspektor': {
        const project = text(a, 'project');
        const datei = textListe(a, 'file_path')?.[0];
        if (!project || !datei) throw new DiagnoseFehler('parameter_fehlt', 'sync_inspektor: project und file_path angeben.');
        return { success: true, action, ...(await syncInspektor(project, datei)) };
      }
      case 'schema_probe':
        return { success: true, action, ...(await schemaProbe(wahr(a, 'ausfuehren'))) };
      default:
        return { success: false, action, error: 'unbekannte_action', message: `Keine Diagnose-Action: ${action}.` };
    }
  } catch (err) {
    if (err instanceof DiagnoseFehler) return { success: false, action, error: err.code, message: err.message };
    return { success: false, action, error: 'interner_fehler', message: err instanceof Error ? err.message : String(err) };
  }
}
