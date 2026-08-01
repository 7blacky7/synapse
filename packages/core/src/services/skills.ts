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
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([skill_name, sections]) => ({
      skill_name,
      section_count: sections.length,
      sections: sections.sort(),
    }));
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
