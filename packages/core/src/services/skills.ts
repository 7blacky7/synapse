/**
 * MODUL: skills (EXPERIMENTAL)
 * ZWECK: Zugriff auf die User-eigene Skill-Datenbank (Qdrant Collection 'skills'
 *        auf 192.168.50.65:6334). Skills sind aus dem skill-db-manager
 *        ($HOME/.claude/skills/skill-db-manager) gefuettert.
 *
 * STATUS: EXPERIMENTAL — wird in einer kommenden Iteration umgebaut wenn
 *         private vs general Skills getrennt werden sollen.
 *
 * Datenformat (pro Qdrant-Point):
 *   {
 *     skill_name: string,
 *     section: string,
 *     content: string,
 *     tags: string[]
 *   }
 */

const SKILL_QDRANT_URL = process.env.SKILL_QDRANT_URL || 'http://192.168.50.65:6334';
const SKILL_COLLECTION = process.env.SKILL_COLLECTION || 'skills';
const SKILL_EMBED_MODEL = process.env.SKILL_EMBED_MODEL || 'gemini-embedding-2-preview';

interface SkillPoint {
  skill_name: string;
  section: string;
  content: string;
  tags?: string[];
}

interface QdrantPoint {
  id: string | number;
  score?: number;
  payload?: SkillPoint;
}

async function getQueryEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY env not set — required for skill-search embedding');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${SKILL_EMBED_MODEL}:embedContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${SKILL_EMBED_MODEL}`,
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Skill-Embed (${SKILL_EMBED_MODEL}) ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

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

async function qdrantSearch(vector: number[], limit = 10): Promise<QdrantPoint[]> {
  const body = { vector, limit, with_payload: true };
  const res = await fetch(`${SKILL_QDRANT_URL}/collections/${SKILL_COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Skill-Qdrant search ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { result: QdrantPoint[] };
  return data.result;
}

export interface SkillSearchHit {
  skill_name: string;
  section: string;
  score: number;
  content: string;
  tags: string[];
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

/** Semantische Suche ueber alle Skills + Sections. */
export async function searchSkills(query: string, limit = 5): Promise<SkillSearchHit[]> {
  const vec = await getQueryEmbedding(query);
  const hits = await qdrantSearch(vec, limit);
  return hits.map((h) => ({
    skill_name: h.payload?.skill_name ?? '',
    section: h.payload?.section ?? '',
    score: h.score ?? 0,
    content: h.payload?.content ?? '',
    tags: h.payload?.tags ?? [],
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
