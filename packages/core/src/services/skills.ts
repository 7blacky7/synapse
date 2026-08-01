/**
 * MODUL: skills
 * ZWECK: Zugriff auf die Skill-Datenbank in der Synapse-Qdrant (Collection 'skills').
 *        Gefuettert aus dem skill-db-manager ($HOME/.claude/skills/skill-db-manager).
 *
 * EMBEDDING: laeuft ueber den zentralen Synapse-Provider (embed() aus ../embeddings).
 *   Damit gilt automatisch EMBEDDING_PROVIDER/OLLAMA_MODEL/EMBEDDING_TARGET_DIM wie
 *   fuer alle anderen Collections auch.
 *   ⚠️ FRUEHER stand hier ein EIGENER Google-Aufruf (gemini-embedding-2-preview) samt
 *   fest verdrahteter Fremd-Qdrant auf Port 6334. Der Bestand war mit Google
 *   eingebettet, die Anfrage kam mit demselben Modell — technisch stimmig, aber ein
 *   Sonderweg neben dem Rest des Systems, mit eigenem Schluessel und eigener Datenbank.
 *   Seit 01.08.2026 liegt die Collection in der Synapse-Qdrant und nutzt denselben
 *   Embedding-Weg wie Memories, Thoughts und Code.
 *
 * SCOPE: jeder Punkt traegt ein Feld 'scope':
 *   'global'  — gilt ueberall (aktuell ALLE Eintraege)
 *   'project' — nur fuer ein Projekt, Feld 'project' gesetzt
 *   'agent'   — nur fuer einen Agenten in einem Projekt, Felder 'project' + 'agent'
 *   Ohne scope-Angabe wird NICHT gefiltert, es kommt also alles. Das ist Absicht,
 *   solange nur globale Skills existieren.
 *
 * Datenformat (pro Qdrant-Point):
 *   {
 *     skill_name: string,
 *     section: string,
 *     content: string,
 *     tags: string[],
 *     scope: 'global' | 'project' | 'agent',
 *     project?: string | null,
 *     agent?: string | null
 *   }
 */

import { embed, type EmbedOptions } from '../embeddings/index.js';
import { getPool } from '../db/client.js';

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
  const vec = await embed(query, embedding);
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
  const vector = await embed(query, opts.embedding);
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

/** Liste aller Skills (skill_name + Section-Count). Optional skill_name → nur Sections eines Skills. */
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

export async function listSkills(skillName?: string): Promise<SkillListEntry[]> {
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
  const liste = Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([skill_name, sections]) => ({
      skill_name,
      section_count: sections.length,
      sections: sections.sort(),
    }));

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

/** Eine konkrete Section eines Skills lesen. */
export async function getSkillSection(skillName: string, section: string): Promise<SkillSection | null> {
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

/** Alle Sections eines Skills auf einmal lesen (Bulk). */
export async function getSkillFull(skillName: string): Promise<SkillSection[]> {
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
