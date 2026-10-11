/**
 * MODUL: skills
 * ZWECK: Skill-Datenbank. QUELLE DER WAHRHEIT ist seit P12-T13 die Tabelle skill_sections in
 *        PostgreSQL; die Qdrant-Collection 'skills' haelt nur noch den Vektor dazu (aus PG befuellt).
 *        Gefuettert wird sie ueber die Schreibfunktionen hier (skills-Tool) — und bis zur Umstellung
 *        (P12-T19) noch vom skill-db-manager ($HOME/.claude/skills/skill-db-manager), der direkt
 *        nach Qdrant schreibt.
 *
 * SCHREIBEN (P12-T13 Teil 2, 11.10.2026):
 *   speichereSkillSection / loescheSkillSection / loescheSkill / ersetzeSkill schreiben ZUERST
 *   skill_sections (+ Zaehler in skill_names) in einer Transaktion. embedded_at bleibt NULL, bis
 *   der Vektor wirklich in Qdrant steht. Eine einzelne Section wird danach nebenlaeufig eingebettet
 *   (embeddeSkillSectionNach, Hintergrund-Pool); ersetzeSkill ist ein Massenweg und bettet NICHT
 *   selbst ein — das holt der gedrosselte Backlog nach (P5-T15). Qdrant-Loeschen folgt dem PG-Commit
 *   (best-effort; ein verwaister Punkt faellt beim Re-Embedding weg).
 *   speichereSkillSection kennt drei Modi: 'anlegen' (Fehler, wenn es die Section schon gibt),
 *   'aendern' (Fehler, wenn es sie nicht gibt) und 'beides' (Upsert, Standard).
 *   punkt_id: naechste freie Nummer aus PG unter Advisory-Lock (= Qdrant-Punkt-ID, wie im Bestand).
 *   ⚠️ Bis P12-T19 vergibt skill-db.mjs IDs aus Qdrant (max+1). Zwischen einem PG-Anlegen und
 *   dessen Einbettung kann es dieselbe ID noch einmal vergeben — kurzes Fenster, schliesst sich dann.
 *
 * LESEN: list / get_section / get_full aus PG. Qdrant nur noch als Rueckfall fuer Skills, die (noch)
 *   nicht in PG stehen (skill-db-Schreibweg bis P12-T19) oder wenn PG nicht antwortet.
 *   search bleibt semantisch ueber Qdrant (Aehnlichkeit ist dessen einzige Aufgabe).
 *
 * EMBEDDING: laeuft ueber den zentralen Synapse-Provider (embed() aus ../embeddings).
 *   Damit gilt automatisch EMBEDDING_PROVIDER/OLLAMA_MODEL/EMBEDDING_TARGET_DIM wie
 *   fuer alle anderen Collections auch.
 *   ⚠️ FRUEHER stand hier ein EIGENER Google-Aufruf (gemini-embedding-2-preview) samt
 *   fest verdrahteter Fremd-Qdrant auf Port 6334. Seit 01.08.2026 liegt die Collection in der
 *   Synapse-Qdrant und nutzt denselben Embedding-Weg wie Memories, Thoughts und Code.
 *
 * SCOPE: jede Section traegt 'scope':
 *   'global'  — gilt ueberall (NULL im Bestand wird wie global behandelt)
 *   'project' — nur fuer ein Projekt, Feld 'project' gesetzt
 *   'agent'   — nur fuer einen Agenten in einem Projekt, Felder 'project' + 'agent'
 *   Ohne scope-Angabe wird bei der Suche NICHT gefiltert, es kommt also alles.
 *
 * Datenformat (pro Qdrant-Point, id = skill_sections.punkt_id):
 *   {
 *     skill_name: string,
 *     section: string,
 *     content: string,
 *     tags: string[],
 *     scope: 'global' | 'project' | 'agent',
 *     project?: string | null,
 *     agent?: string | null,
 *     updated_at?: string, content_hash?: string, embedding_modell?: string
 *   }
 */

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { embed, embeddingModellKennung, type EmbedOptions } from '../embeddings/index.js';
import { ensureCollection } from '../qdrant/collections.js';
import { getPool, getHintergrundPool } from '../db/client.js';
import { embeddingNachtragAngehalten } from './intern-schalter.js';

const SKILL_QDRANT_URL =
  process.env.SKILL_QDRANT_URL || process.env.QDRANT_URL || 'http://localhost:6333';
const SKILL_COLLECTION = process.env.SKILL_COLLECTION || 'skills';
const configuredSearchTimeout = Number(process.env.SKILL_SEARCH_TIMEOUT_MS);
const DEFAULT_SKILL_SEARCH_TIMEOUT_MS =
  Number.isFinite(configuredSearchTimeout) && configuredSearchTimeout > 0
    ? Math.floor(configuredSearchTimeout)
    : 5_000;

export type SkillScope = 'global' | 'project' | 'agent';

/** Baut den Qdrant-Filter aus skill_name und Scope. Undefined = kein Filter. */
export function baueSkillSichtbarkeitsFilter(opts: {
  skillName?: string;
  scope?: SkillScope;
  project?: string;
  agent?: string;
  visibility?: { project: string; agent: string };
}): Record<string, unknown> | undefined {
  const must: Record<string, unknown>[] = [];
  if (opts.skillName) must.push({ key: 'skill_name', match: { value: opts.skillName } });
  if (opts.visibility) {
    must.push({
      should: [
        { key: 'scope', match: { value: 'global' } },
        { must: [
          { key: 'scope', match: { value: 'project' } },
          { key: 'project', match: { value: opts.visibility.project } },
        ] },
        { must: [
          { key: 'scope', match: { value: 'agent' } },
          { key: 'project', match: { value: opts.visibility.project } },
          { key: 'agent', match: { value: opts.visibility.agent } },
        ] },
      ],
    });
  } else {
    if (opts.scope) must.push({ key: 'scope', match: { value: opts.scope } });
    if (opts.project) must.push({ key: 'project', match: { value: opts.project } });
    if (opts.agent) must.push({ key: 'agent', match: { value: opts.agent } });
  }
  return must.length ? { must } : undefined;
}

interface SkillPoint {
  skill_name: string;
  section: string;
  content: string;
  tags?: string[];
  scope?: SkillScope;
  project?: string | null;
  agent?: string | null;
}

interface QdrantPoint {
  id: string | number;
  score?: number;
  payload?: SkillPoint;
}

// getQueryEmbedding entfaellt — die Anfrage wird ueber embed() aus dem zentralen
// Provider eingebettet, genau wie der Bestand beim Schreiben.

async function qdrantScroll(filter?: Record<string, unknown>, limit = 1000): Promise<QdrantPoint[]> {
  const body: Record<string, unknown> = { limit, with_payload: true, with_vector: false };
  if (filter) body.filter = filter;
  const res = await fetch(`${SKILL_QDRANT_URL}/collections/${SKILL_COLLECTION}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Skill-Qdrant scroll ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { result: { points: QdrantPoint[] } };
  return data.result.points;
}

async function qdrantSearch(
  vector: number[],
  limit = 10,
  filter?: Record<string, unknown>,
  timeoutMs = DEFAULT_SKILL_SEARCH_TIMEOUT_MS,
): Promise<QdrantPoint[]> {
  const body: Record<string, unknown> = { vector, limit, with_payload: true };
  if (filter) body.filter = filter;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SKILL_QDRANT_URL}/collections/${SKILL_COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Skill-Qdrant search ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { result: QdrantPoint[] };
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export interface SkillSearchHit {
  skill_name: string;
  section: string;
  score: number;
  content: string;
  tags: string[];
  scope?: SkillScope;
  project?: string | null;
  agent?: string | null;
}

export interface SkillListEntry {
  skill_name: string;
  section_count: number;
  sections: string[];
  /** P12-T13: woher die Angaben stammen — 'qdrant' nur fuer Skills, die (noch) nicht in PG stehen. */
  quelle?: 'pg' | 'qdrant';
}

export interface SkillSection {
  skill_name: string;
  section: string;
  content: string;
  tags: string[];
}

/**
 * Semantische Suche ueber Skills + Sections.
 * Optional skill_name (nur innerhalb eines Skills) und scope/project/agent.
 */
export async function searchSkills(
  query: string,
  limit = 5,
  skillName?: string,
  opts: {
    scope?: SkillScope;
    project?: string;
    agent?: string;
    visibility?: { project: string; agent: string };
    embedding?: EmbedOptions;
    searchTimeoutMs?: number;
  } = {},
): Promise<SkillSearchHit[]> {
  const { embedding, searchTimeoutMs, ...filterOpts } = opts;
  const vec = await embed(query, { ...embedding, art: 'query' });
  const filter = baueSkillSichtbarkeitsFilter({ skillName, ...filterOpts });
  const timeoutMs = Number.isFinite(searchTimeoutMs) && Number(searchTimeoutMs) > 0
    ? Math.floor(Number(searchTimeoutMs))
    : DEFAULT_SKILL_SEARCH_TIMEOUT_MS;
  const hits = await qdrantSearch(vec, limit, filter, timeoutMs);
  return hits.map((h) => ({
    skill_name: h.payload?.skill_name ?? '',
    section: h.payload?.section ?? '',
    score: h.score ?? 0,
    content: h.payload?.content ?? '',
    tags: h.payload?.tags ?? [],
    scope: h.payload?.scope,
    project: h.payload?.project ?? null,
    agent: h.payload?.agent ?? null,
  }));
}

/**
 * Sichtbarkeitsgefilterte Suche fuer mehrere Agenten mit genau EINEM Embedding.
 * Nur die Qdrant-Abfrage wird pro Agent wiederholt; der GPU-Pfad bleibt pro Post konstant.
 */
export async function searchSkillsForAgents(
  query: string,
  project: string,
  agents: string[],
  limit = 8,
  opts: { embedding?: EmbedOptions; searchTimeoutMs?: number } = {},
): Promise<Array<{ agent: string; hits: SkillSearchHit[] }>> {
  const vector = await embed(query, { ...opts.embedding, art: 'query' });
  const timeoutMs = Number.isFinite(opts.searchTimeoutMs) && Number(opts.searchTimeoutMs) > 0
    ? Math.floor(Number(opts.searchTimeoutMs))
    : DEFAULT_SKILL_SEARCH_TIMEOUT_MS;
  return Promise.all(agents.map(async (agent) => {
    const filter = baueSkillSichtbarkeitsFilter({ visibility: { project, agent } });
    const points = await qdrantSearch(vector, limit, filter, timeoutMs);
    return {
      agent,
      hits: points.map((h) => ({
        skill_name: h.payload?.skill_name ?? '',
        section: h.payload?.section ?? '',
        score: h.score ?? 0,
        content: h.payload?.content ?? '',
        tags: h.payload?.tags ?? [],
        scope: h.payload?.scope,
        project: h.payload?.project ?? null,
        agent: h.payload?.agent ?? null,
      })),
    };
  }));
}

/**
 * Haelt die Namenstabelle mit der Skill-Datenbank gleich.
 *
 * Wird nach listSkills() angestossen und bei jedem Anlegen/Aendern eines Skills. Der
 * Abgleich ist billig (ein INSERT ... ON CONFLICT je Name) und darf niemals den Aufrufer
 * aufhalten — faellt er aus, bleibt die Tabelle einfach auf dem letzten Stand.
 */
export async function synchronisiereSkillNamen(
  eintraege: Array<{ skill_name: string; section_count?: number }>,
): Promise<number> {
  if (eintraege.length === 0) return 0;
  const pool = getPool();
  let geschrieben = 0;
  for (const eintrag of eintraege) {
    if (!eintrag.skill_name) continue;
    try {
      await pool.query(
        `INSERT INTO skill_names (skill_name, section_count, aktualisiert_am)
         VALUES ($1, $2, NOW())
         ON CONFLICT (skill_name) DO UPDATE SET
           section_count = EXCLUDED.section_count,
           aktualisiert_am = NOW()`,
        [eintrag.skill_name, eintrag.section_count ?? 0],
      );
      geschrieben++;
    } catch {
      // Ein einzelner Name darf den Abgleich nicht abbrechen.
    }
  }
  return geschrieben;
}

/**
 * Unscharfe Namenssuche — ohne Embedding, ohne Qdrant.
 *
 * Zwei Wege, absichtlich in dieser Reihenfolge:
 * 1. Der Name (oder sein Anfang an einer Segmentgrenze) steht woertlich im Text.
 * 2. Trigram-Aehnlichkeit ueber der Schwelle — faengt Tippfehler und Schreibvarianten.
 *
 * ⚠️ DIE SCHWELLE IST DER GANZE UNTERSCHIED zwischen Hilfe und Rauschen. Zu niedrig, und
 * "test" zieht jeden Skill mit "testing" im Namen herbei. 0,45 ist bewusst streng: die
 * unscharfe Suche soll Vertipper auffangen, nicht Themen erraten. Dafuer gibt es das
 * Embedding.
 */
export async function findeSkillsNachName(
  text: string,
  mindestAehnlichkeit = 0.45,
): Promise<string[]> {
  const tiefe = text.toLowerCase().trim();
  if (tiefe.length < 3) return [];
  try {
    const { rows } = await getPool().query<{ skill_name: string }>(
      `SELECT skill_name FROM skill_names
        WHERE position(lower(skill_name) in $1) > 0
           OR similarity(lower(skill_name), $1) >= $2
        ORDER BY similarity(lower(skill_name), $1) DESC
        LIMIT 20`,
      [tiefe, mindestAehnlichkeit],
    );
    const gefunden = new Set(rows.map((row) => row.skill_name));

    // Namensanfaenge: "ki-browser" meint ki-browser-standalone. Ab sechs Zeichen, nur an
    // einer Segmentgrenze — und nur, wenn das Fragment als EIGENES WORT dasteht.
    //
    // ⚠️ DIE WORTGRENZE IST NICHT OPTIONAL. Ohne sie traf ein realistischer Auftragstext
    // am 02.08.2026 zwei Skills, die niemand genannt hatte:
    //   "Testprompt"             enthaelt "prompt"      -> prompt-engineering-patterns
    //   "playwright-e2e-testing" enthaelt "e2e-testing" -> e2e-testing-automation
    // Beide sahen mit Score 0,99 aus wie sichere Treffer. Ein Fragment mitten in einem
    // anderen Wort bedeutet nichts.
    const { rows: alle } = await getPool().query<{ skill_name: string }>(
      'SELECT skill_name FROM skill_names',
    );
    // ⚠️ DER BINDESTRICH ZAEHLT NICHT ALS GRENZE. Sonst trifft jedes Fragment, das in einem
    // LAENGEREN Skillnamen steckt, der wirklich im Text steht:
    //   "playwright-e2e-testing" -> e2e-testing-automation
    //   "frontend-design"        -> frontend-build-guardian
    // Beide mit Score 0,99, beide nie genannt. Ein Fragment gilt nur, wenn links und rechts
    // ein echtes Trennzeichen steht — Leerzeichen, Satzzeichen, Zeilenanfang oder -ende.
    const grenze = (zeichen: string | undefined) =>
      zeichen === undefined || !/[a-z0-9-]/.test(zeichen);
    for (const { skill_name: name } of alle as Array<{ skill_name: string }>) {
      const klein = name.toLowerCase();
      if (gefunden.has(name)) continue;
      for (let ende = klein.length - 1; ende >= 6; ende--) {
        if (klein[ende] !== '-' && klein[ende] !== ':') continue;
        const fragment = klein.slice(0, ende);
        let ab = tiefe.indexOf(fragment);
        let treffer = false;
        while (ab !== -1) {
          if (grenze(tiefe[ab - 1]) && grenze(tiefe[ab + fragment.length])) {
            treffer = true;
            break;
          }
          ab = tiefe.indexOf(fragment, ab + 1);
        }
        if (treffer) { gefunden.add(name); break; }
      }
    }
    return [...gefunden];
  } catch {
    return [];
  }
}

/**
 * Wie oft die Namenstabelle beim Auflisten hoechstens nachgezogen wird. Der Abgleich ist
 * billig, aber er muss nicht bei jedem Aufruf laufen.
 */
let letzterNamensAbgleich = 0;
const NAMENS_ABGLEICH_MS = 300_000;

/** Qdrant-Stand (Rueckfall): Skillname -> Sections. */
async function qdrantSkillListe(skillName?: string): Promise<Map<string, string[]>> {
  const filter = skillName
    ? { must: [{ key: 'skill_name', match: { value: skillName } }] }
    : undefined;
  const points = await qdrantScroll(filter, 2000);
  const map = new Map<string, string[]>();
  for (const p of points) {
    const name = p.payload?.skill_name;
    const sec = p.payload?.section;
    if (!name || !sec) continue;
    const arr = map.get(name) ?? [];
    arr.push(sec);
    map.set(name, arr);
  }
  return map;
}

/**
 * Liste aller Skills (skill_name + Section-Count). Optional skill_name -> nur Sections eines Skills.
 * P12-T13: aus PG; Skills, die nur in Qdrant stehen (skill-db-Schreibweg bis P12-T19), kommen mit
 * quelle 'qdrant' dazu. Antwortet PG nicht, liefert Qdrant allein.
 */
export async function listSkills(skillName?: string): Promise<SkillListEntry[]> {
  const ausPg = new Map<string, string[]>();
  let pgOk = true;
  try {
    const { rows } = await getPool().query<{ skill_name: string; sections: string[] }>(
      `SELECT skill_name, array_agg(section ORDER BY section) AS sections
         FROM skill_sections
        WHERE ($1::text IS NULL OR skill_name = $1)
        GROUP BY skill_name`,
      [skillName ?? null],
    );
    for (const r of rows) ausPg.set(r.skill_name, r.sections);
  } catch (fehler) {
    pgOk = false;
    console.error('[Skills] skill_sections nicht lesbar, Rueckfall auf Qdrant:', (fehler as Error).message);
  }

  let ausQdrant = new Map<string, string[]>();
  try {
    ausQdrant = await qdrantSkillListe(skillName);
  } catch (fehler) {
    if (!pgOk) throw fehler;
    // PG hat geantwortet — dann ist Qdrant nur Ergaenzung, sein Ausfall kein Fehler.
  }

  const liste: SkillListEntry[] = [];
  for (const [name, sections] of ausPg) {
    liste.push({ skill_name: name, section_count: sections.length, sections, quelle: 'pg' });
  }
  for (const [name, sections] of ausQdrant) {
    if (ausPg.has(name)) continue;
    liste.push({ skill_name: name, section_count: sections.length, sections: sections.sort(), quelle: 'qdrant' });
  }
  liste.sort((a, b) => a.skill_name.localeCompare(b.skill_name));

  // Namenstabelle nebenbei gleichhalten — fire-and-forget, damit das Auflisten nicht auf
  // den Abgleich wartet. Ohne skillName-Filter, sonst wuerde eine Einzelabfrage die
  // Tabelle auf einen Namen verengen wollen.
  if (!skillName && Date.now() - letzterNamensAbgleich > NAMENS_ABGLEICH_MS) {
    letzterNamensAbgleich = Date.now();
    void synchronisiereSkillNamen(liste).catch((fehler) => {
      console.error('[Skills] Namenstabelle konnte nicht abgeglichen werden:', fehler);
    });
  }

  return liste;
}

/** Sections aus PG; null = PG nicht lesbar (dann Rueckfall auf Qdrant). */
async function sectionsAusPg(skillName: string, section?: string): Promise<SkillSection[] | null> {
  try {
    const { rows } = await getPool().query<SkillSection>(
      `SELECT skill_name, section, content, tags
         FROM skill_sections
        WHERE skill_name = $1 AND ($2::text IS NULL OR section = $2)
        ORDER BY section, COALESCE(scope, 'global'), COALESCE(project, ''), COALESCE(agent, '')`,
      [skillName, section ?? null],
    );
    return rows.map((r) => ({ ...r, tags: r.tags ?? [] }));
  } catch (fehler) {
    console.error('[Skills] skill_sections nicht lesbar, Rueckfall auf Qdrant:', (fehler as Error).message);
    return null;
  }
}

/** Eine konkrete Section eines Skills lesen (PG, Rueckfall Qdrant). */
export async function getSkillSection(skillName: string, section: string): Promise<SkillSection | null> {
  const pg = await sectionsAusPg(skillName, section);
  if (pg && pg.length > 0) return pg[0];
  const filter = {
    must: [
      { key: 'skill_name', match: { value: skillName } },
      { key: 'section', match: { value: section } },
    ],
  };
  const points = await qdrantScroll(filter, 5);
  const p = points[0];
  if (!p || !p.payload) return null;
  return {
    skill_name: p.payload.skill_name,
    section: p.payload.section,
    content: p.payload.content,
    tags: p.payload.tags ?? [],
  };
}

/** Alle Sections eines Skills auf einmal lesen (Bulk; PG, Rueckfall Qdrant). */
export async function getSkillFull(skillName: string): Promise<SkillSection[]> {
  const pg = await sectionsAusPg(skillName);
  if (pg && pg.length > 0) return pg;
  const filter = { must: [{ key: 'skill_name', match: { value: skillName } }] };
  const points = await qdrantScroll(filter, 500);
  return points
    .filter((p) => p.payload)
    .map((p) => ({
      skill_name: p.payload!.skill_name,
      section: p.payload!.section,
      content: p.payload!.content,
      tags: p.payload!.tags ?? [],
    }))
    .sort((a, b) => a.section.localeCompare(b.section));
}

// ─── Schreiben (P12-T13 Teil 2): PostgreSQL zuerst, Qdrant aus PG ─────────────────────

export interface SkillSectionEingabe {
  skill_name: string;
  section: string;
  content: string;
  tags?: string[];
  /** Default 'global'. */
  scope?: SkillScope;
  project?: string | null;
  agent?: string | null;
}

export interface SkillSchreibErgebnis {
  punkt_id: number;
  skill_name: string;
  section: string;
  status: 'neu' | 'geaendert' | 'unveraendert';
  /** true = embedded_at ist NULL, der Vektor folgt (Hintergrund bzw. Backlog). */
  embeddings_pending: boolean;
}

/** Sicht einer Section (wer sie sieht) — Teil des Eindeutigkeitsschluessels. */
export interface SkillSicht {
  scope?: SkillScope;
  project?: string | null;
  agent?: string | null;
}

/** anlegen: nur neu; aendern: nur vorhandene; beides: Upsert. */
export type SkillSchreibModus = 'anlegen' | 'aendern' | 'beides';

/** Erwarteter Schreibfehler (Section existiert schon bzw. fehlt) — nichts geschrieben. */
export class SkillSchreibFehler extends Error {
  constructor(readonly code: 'exists' | 'not_found', message: string) {
    super(message);
    this.name = 'SkillSchreibFehler';
  }
}

const SKILL_ID_SPERRE = 'skill_sections:punkt_id';

function skillInhaltHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function pruefeSkillEingabe(e: SkillSectionEingabe): void {
  if (!e.skill_name?.trim() || !e.section?.trim()) throw new Error('skill_name und section sind Pflicht');
  if (!e.content?.trim()) throw new Error('content darf nicht leer sein');
  const scope = e.scope ?? 'global';
  if (!['global', 'project', 'agent'].includes(scope)) throw new Error(`scope "${scope}" unbekannt (global|project|agent)`);
  if (scope === 'project' && !e.project) throw new Error("scope 'project' braucht project");
  if (scope === 'agent' && (!e.project || !e.agent)) throw new Error("scope 'agent' braucht project und agent");
}

/** Eine kurze Transaktion; Sperren nie laenger als noetig (lock_timeout 5 s). */
async function inSkillTransaktion<T>(arbeit: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw fehler;
  } finally {
    client.release();
  }
}

/** Zaehler in skill_names nachziehen; ohne Sections verschwindet der Name. */
async function aktualisiereSkillName(client: PoolClient, skillName: string): Promise<void> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM skill_sections WHERE skill_name = $1',
    [skillName],
  );
  const n = rows[0]?.n ?? 0;
  if (n === 0) {
    await client.query('DELETE FROM skill_names WHERE skill_name = $1', [skillName]);
    return;
  }
  await client.query(
    `INSERT INTO skill_names (skill_name, section_count, aktualisiert_am)
     VALUES ($1, $2, NOW())
     ON CONFLICT (skill_name) DO UPDATE SET section_count = EXCLUDED.section_count, aktualisiert_am = NOW()`,
    [skillName, n],
  );
}

/** Schreibt EINE Section in der laufenden Transaktion (Upsert ueber den Eindeutigkeitsschluessel). */
async function schreibeSectionInTransaktion(
  client: PoolClient,
  e: SkillSectionEingabe,
  modus: SkillSchreibModus = 'beides',
): Promise<SkillSchreibErgebnis> {
  const scope = e.scope ?? 'global';
  const project = e.project ?? null;
  const agent = e.agent ?? null;
  const tags = (e.tags ?? []).map(String);
  const hash = skillInhaltHash(e.content);
  const basis = { skill_name: e.skill_name, section: e.section };

  const vorhanden = (await client.query<{ punkt_id: string; content_hash: string | null; tags: string[] | null }>(
    `SELECT punkt_id::text AS punkt_id, content_hash, tags
       FROM skill_sections
      WHERE skill_name = $1 AND section = $2 AND COALESCE(scope, 'global') = $3
        AND COALESCE(project, '') = COALESCE($4, '') AND COALESCE(agent, '') = COALESCE($5, '')
      FOR UPDATE`,
    [e.skill_name, e.section, scope, project, agent],
  )).rows[0];

  if (vorhanden && modus === 'anlegen') {
    throw new SkillSchreibFehler('exists', `Section ${e.skill_name}/${e.section} gibt es schon — zum Aendern update_section verwenden`);
  }
  if (!vorhanden && modus === 'aendern') {
    throw new SkillSchreibFehler('not_found', `Section ${e.skill_name}/${e.section} gibt es nicht — zum Anlegen add_section verwenden`);
  }

  if (vorhanden) {
    const punktId = Number(vorhanden.punkt_id);
    if (vorhanden.content_hash === hash && JSON.stringify(vorhanden.tags ?? []) === JSON.stringify(tags)) {
      return { punkt_id: punktId, ...basis, status: 'unveraendert', embeddings_pending: false };
    }
    await client.query(
      `UPDATE skill_sections
          SET content = $2, tags = $3, content_hash = $4, aktualisiert_am = NOW(),
              embedded_at = NULL, embedding_modell = NULL
        WHERE punkt_id = $1`,
      [punktId, e.content, tags, hash],
    );
    return { punkt_id: punktId, ...basis, status: 'geaendert', embeddings_pending: true };
  }

  // Neue punkt_id: naechste freie Nummer, serialisiert (sonst vergaeben zwei Schreiber dieselbe).
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SKILL_ID_SPERRE]);
  const punktId = Number((await client.query<{ id: string }>(
    'SELECT (COALESCE(MAX(punkt_id), 0) + 1)::text AS id FROM skill_sections',
  )).rows[0].id);
  await client.query(
    `INSERT INTO skill_sections
       (punkt_id, skill_name, section, content, tags, scope, project, agent, content_hash,
        aktualisiert_am, embedded_at, embedding_modell)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NULL, NULL)`,
    [punktId, e.skill_name, e.section, e.content, tags, scope, project, agent, hash],
  );
  return { punkt_id: punktId, ...basis, status: 'neu', embeddings_pending: true };
}

/** Entfernt Punkte aus der Skill-Collection (best-effort, nach dem PG-Commit). */
async function entferneSkillVektoren(punktIds: number[], skillNameFilter?: string): Promise<void> {
  if (punktIds.length === 0 && !skillNameFilter) return;
  const koerper = punktIds.length > 0
    ? { points: punktIds }
    : { filter: { must: [{ key: 'skill_name', match: { value: skillNameFilter } }] } };
  try {
    const res = await fetch(`${SKILL_QDRANT_URL}/collections/${SKILL_COLLECTION}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(koerper),
    });
    if (!res.ok) throw new Error(`Skill-Qdrant delete ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (fehler) {
    // PG ist bereits bereinigt; ein verwaister Punkt faellt beim naechsten Re-Embedding weg.
    console.error('[Skills] Qdrant-Loeschen fehlgeschlagen (PG bereits bereinigt):', (fehler as Error).message);
  }
}

/**
 * Legt eine Section an bzw. aendert sie (PG zuerst). Unveraenderter Inhalt + Tags = kein Schreiben.
 * modus 'anlegen'/'aendern' wirft SkillSchreibFehler, wenn die Section schon da ist bzw. fehlt.
 * Der Vektor folgt nebenlaeufig im Hintergrund; nurBacklog: true ueberlaesst ihn dem Backlog
 * (Pflicht fuer Massenwege).
 */
export async function speichereSkillSection(
  eingabe: SkillSectionEingabe,
  optionen: { nurBacklog?: boolean; modus?: SkillSchreibModus } = {},
): Promise<SkillSchreibErgebnis> {
  pruefeSkillEingabe(eingabe);
  const ergebnis = await inSkillTransaktion(async (client) => {
    const r = await schreibeSectionInTransaktion(client, eingabe, optionen.modus ?? 'beides');
    if (r.status !== 'unveraendert') await aktualisiereSkillName(client, eingabe.skill_name);
    return r;
  });
  if (ergebnis.embeddings_pending && !optionen.nurBacklog) {
    void embeddeSkillSectionNach(null, String(ergebnis.punkt_id)).catch((fehler) => {
      console.error(`[Skills] Embedding fuer ${eingabe.skill_name}/${eingabe.section} fehlgeschlagen, Backlog holt es nach:`, fehler);
    });
  }
  return ergebnis;
}

/** Loescht eine Section (PG zuerst, dann ihr Qdrant-Punkt). */
export async function loescheSkillSection(
  skillName: string,
  section: string,
  sicht: SkillSicht = {},
): Promise<{ geloescht: number }> {
  const ids = await inSkillTransaktion(async (client) => {
    const { rows } = await client.query<{ punkt_id: string }>(
      `DELETE FROM skill_sections
        WHERE skill_name = $1 AND section = $2 AND COALESCE(scope, 'global') = $3
          AND COALESCE(project, '') = COALESCE($4, '') AND COALESCE(agent, '') = COALESCE($5, '')
        RETURNING punkt_id::text AS punkt_id`,
      [skillName, section, sicht.scope ?? 'global', sicht.project ?? null, sicht.agent ?? null],
    );
    if (rows.length > 0) await aktualisiereSkillName(client, skillName);
    return rows.map((r) => Number(r.punkt_id));
  });
  await entferneSkillVektoren(ids);
  return { geloescht: ids.length };
}

/**
 * Loescht einen ganzen Skill (alle Sichten). In Qdrant zusaetzlich per Namensfilter — erfasst
 * auch Punkte, die skill-db.mjs bis P12-T19 nur dort angelegt hat.
 */
export async function loescheSkill(skillName: string): Promise<{ geloescht: number }> {
  const ids = await inSkillTransaktion(async (client) => {
    const { rows } = await client.query<{ punkt_id: string }>(
      'DELETE FROM skill_sections WHERE skill_name = $1 RETURNING punkt_id::text AS punkt_id',
      [skillName],
    );
    await aktualisiereSkillName(client, skillName);
    return rows.map((r) => Number(r.punkt_id));
  });
  await entferneSkillVektoren(ids);
  await entferneSkillVektoren([], skillName);
  return { geloescht: ids.length };
}

/**
 * Ersetzt einen Skill komplett durch die uebergebenen Sections (eine Transaktion): gleiche
 * Section + gleicher Inhalt bleibt unberuehrt, Geaendertes/Neues bekommt embedded_at NULL,
 * nicht mehr Genanntes wird geloescht. MASSENWEG: kein eigenes Einbetten, das holt der Backlog.
 */
export async function ersetzeSkill(
  skillName: string,
  sections: Array<Omit<SkillSectionEingabe, 'skill_name'>>,
): Promise<{ neu: number; geaendert: number; unveraendert: number; geloescht: number; embeddings_pending: boolean }> {
  const eingaben = sections.map((s) => ({ ...s, skill_name: skillName }));
  for (const e of eingaben) pruefeSkillEingabe(e);
  if (eingaben.length === 0) throw new Error('sections darf nicht leer sein — zum Entfernen loescheSkill verwenden');

  const { zaehler, entfernt } = await inSkillTransaktion(async (client) => {
    const zaehler = { neu: 0, geaendert: 0, unveraendert: 0 };
    const behalten: number[] = [];
    for (const e of eingaben) {
      const r = await schreibeSectionInTransaktion(client, e);
      zaehler[r.status]++;
      behalten.push(r.punkt_id);
    }
    const { rows } = await client.query<{ punkt_id: string }>(
      `DELETE FROM skill_sections
        WHERE skill_name = $1 AND NOT (punkt_id = ANY($2::bigint[]))
        RETURNING punkt_id::text AS punkt_id`,
      [skillName, behalten],
    );
    await aktualisiereSkillName(client, skillName);
    return { zaehler, entfernt: rows.map((r) => Number(r.punkt_id)) };
  });
  await entferneSkillVektoren(entfernt);
  return {
    ...zaehler,
    geloescht: entfernt.length,
    embeddings_pending: zaehler.neu + zaehler.geaendert > 0,
  };
}

/**
 * Traegt den Vektor einer Section nach (Einzel-Schreibweg nebenlaeufig, sonst der Backlog).
 * Liest die Zeile frisch aus PG (Hintergrund-Pool), bettet den Inhalt ueber den Core-Weg ein und
 * schreibt den Punkt mit derselben ID in die Skill-Collection. embedded_at wird nur gesetzt, wenn
 * sich der Inhalt seitdem nicht erneut geaendert hat. Signatur wie die anderen Nachtraege
 * (project, id, embedOptions), damit der Backlog sie gleich aufrufen kann.
 */
export async function embeddeSkillSectionNach(
  _project: string | null,
  id: string,
  embedOptions: EmbedOptions = {},
): Promise<void> {
  // P5-T15: Nachtraege sind Hintergrundarbeit -> eigener Pool, nie die Verbindungen der Tool-Anfragen
  // P5-T15/P14-T2: der Nachtrag ist Hintergrundarbeit (die KI hat ihre Antwort schon), ausser ein Aufrufer
  // wartet bewusst und setzt priority selbst. Schalter embedding an -> Hintergrund-Nachtrag auslassen;
  // embedded_at bleibt NULL, der Backlog holt nach der Freigabe nach.
  embedOptions = { ...embedOptions, priority: embedOptions.priority ?? 'background' };
  if (embedOptions.priority === 'background' && await embeddingNachtragAngehalten()) return;
  const pool = getHintergrundPool();
  const row = (await pool.query<{
    punkt_id: string; skill_name: string; section: string; content: string; tags: string[] | null;
    scope: SkillScope | null; project: string | null; agent: string | null; content_hash: string | null;
    aktualisiert_am: Date;
  }>(
    `SELECT punkt_id::text AS punkt_id, skill_name, section, content, tags, scope, project, agent,
            content_hash, aktualisiert_am
       FROM skill_sections WHERE punkt_id = $1::bigint`,
    [id],
  )).rows[0];
  if (!row) return; // zwischenzeitlich geloescht

  const vector = await embed(row.content, embedOptions);
  const modell = embeddingModellKennung();
  const punkt = {
    id: Number(row.punkt_id),
    vector,
    payload: {
      skill_name: row.skill_name,
      section: row.section,
      content: row.content,
      tags: row.tags ?? [],
      ...(row.scope ? { scope: row.scope } : {}),
      project: row.project,
      agent: row.agent,
      updated_at: new Date(row.aktualisiert_am).toISOString(),
      content_hash: row.content_hash,
      embedding_modell: modell,
    },
  };
  const upsert = () => fetch(`${SKILL_QDRANT_URL}/collections/${SKILL_COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [punkt] }),
  });
  let res = await upsert();
  // P12-T12: nach intern(neu_einbetten) oder auf einer frischen Qdrant fehlt die Collection -> anlegen
  // und einmal wiederholen. Nur wenn die Skills in der Synapse-Qdrant liegen (ensureCollection spricht
  // QDRANT_URL an).
  if (res.status === 404 && SKILL_QDRANT_URL === (process.env.QDRANT_URL || 'http://localhost:6333')) {
    await ensureCollection(SKILL_COLLECTION);
    res = await upsert();
  }
  if (!res.ok) throw new Error(`Skill-Qdrant upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);

  await pool.query(
    `UPDATE skill_sections SET embedded_at = NOW(), embedding_modell = $2
      WHERE punkt_id = $1::bigint AND content_hash IS NOT DISTINCT FROM $3`,
    [id, modell, row.content_hash],
  );
}
