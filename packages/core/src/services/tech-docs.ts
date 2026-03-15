/**
 * MODUL: Tech-Docs Service
 * ZWECK: Kuratierte Technologie-Dokumentation mit PostgreSQL + Qdrant
 *
 * Zwei Quellen-Typen:
 * - source='research': Agenten-recherchiert, kompakt. Wird beim Hook automatisch eingespeist.
 * - source='context7': Basis-Docs, grosse Bloecke. Nur ueber search_tech_docs abrufbar.
 *
 * Wissens-Airbag: get_docs_for_file() prueft ob indexierte Docs neuer als Agent-Cutoff sind
 * und liefert nur kuratierte research-Chunks automatisch.
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { getPool } from '../db/client.js';
import { embed } from '../embeddings/index.js';
import { ensureCollection } from '../qdrant/collections.js';
import { insertVector, searchVectors, deleteVector } from '../qdrant/operations.js';
import { COLLECTIONS } from '../types/index.js';
import { getAgentSession } from './chat.js';

export interface TechDoc {
  id: string;
  framework: string;
  version: string;
  section: string | null;
  content: string;
  type: string | null;
  category: string;
  contentHash: string;
  source: string;
  indexedAt: string;
}

/** Chunk-Types fuer Tech-Docs */
export type TechDocType =
  | 'feature'
  | 'breaking-change'
  | 'migration'
  | 'gotcha'
  | 'code-example'
  | 'best-practice'
  | 'known-issue'
  | 'community';

/**
 * Fuegt ein Tech-Doc hinzu (PostgreSQL + Qdrant)
 * Duplikat-Check ueber content_hash
 */
export async function addTechDoc(
  framework: string,
  version: string,
  section: string,
  content: string,
  type: TechDocType,
  category: string = 'framework',
  source: string = 'research',
  project?: string
): Promise<{ success: boolean; id: string; duplicate: boolean; message: string }> {
  const contentHash = createHash('sha256').update(content).digest('hex');

  // Duplikat-Check in PostgreSQL
  const pool = getPool();
  const existing = await pool.query(
    'SELECT id FROM tech_docs WHERE content_hash = $1',
    [contentHash]
  );

  if (existing.rows.length > 0) {
    return {
      success: true,
      id: existing.rows[0].id,
      duplicate: true,
      message: `Duplikat: ${framework} ${version} ${section} existiert bereits`,
    };
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  // 1. PostgreSQL (Source of Truth)
  await pool.query(
    `INSERT INTO tech_docs (id, framework, version, section, content, type, category, content_hash, source, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, framework.toLowerCase(), version, section, content, type, category, contentHash, source, now]
  );

  // 2. Qdrant (Vektor-Index) - in Projekt-Collection wenn angegeben, sonst global
  const collectionName = project ? COLLECTIONS.projectDocs(project) : COLLECTIONS.techDocs;
  await ensureCollection(collectionName);
  const vector = await embed(`${framework} ${version} ${section} ${content}`);
  await insertVector(collectionName, vector, {
    framework: framework.toLowerCase(),
    version,
    section,
    content,
    type,
    category,
    source,
    content_hash: contentHash,
    indexed_at: now,
  }, id);

  console.error(`[Synapse TechDocs] ${framework} ${version} ${section} (${type}) indexiert`);
  return { success: true, id, duplicate: false, message: `${framework} ${version} ${section} indexiert` };
}

/**
 * Sucht in Tech-Docs (semantisch ueber Qdrant)
 */
export async function searchTechDocs(
  query: string,
  options: {
    framework?: string;
    type?: string;
    source?: string;
    project?: string;
    limit?: number;
  } = {}
): Promise<Array<{ id: string; score: number; framework: string; version: string; section: string; content: string; type: string; source: string }>> {
  const { framework, type, source, project, limit: rawLimit = 10 } = options;
  const limit = typeof rawLimit === 'string' ? parseInt(rawLimit, 10) : rawLimit;

  const collectionName = project ? COLLECTIONS.projectDocs(project) : COLLECTIONS.techDocs;

  const queryVector = await embed(query);
  console.error(`[Synapse TechDocs] Suche in "${collectionName}" mit ${queryVector.length}d Vektor, limit=${limit}`);

  const must: Array<Record<string, unknown>> = [];
  if (framework) must.push({ key: 'framework', match: { value: framework.toLowerCase() } });
  if (type) must.push({ key: 'type', match: { value: type } });
  if (source) must.push({ key: 'source', match: { value: source } });

  // Qdrant REST-API direkt nutzen (Client hat Bug mit bestimmten Collections)
  const { getConfig } = await import('../config.js');
  const qdrantUrl = getConfig().qdrant.url;
  const searchBody: Record<string, unknown> = {
    vector: queryVector,
    limit,
    with_payload: true,
  };
  if (must.length > 0) {
    searchBody.filter = { must };
  }

  const response = await fetch(`${qdrantUrl}/collections/${collectionName}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(searchBody),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Qdrant search failed: ${response.status} ${errBody}`);
  }

  const data = await response.json() as { result: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
  const results = data.result;

  return results.map(r => ({
    id: r.id,
    score: r.score,
    framework: r.payload.framework as string,
    version: r.payload.version as string,
    section: r.payload.section as string,
    content: r.payload.content as string,
    type: r.payload.type as string,
    source: r.payload.source as string,
  }));
}

/**
 * Wissens-Airbag: Holt relevante Tech-Docs fuer eine Datei
 * Prueft ob Docs neuer als Agent-Cutoff sind und liefert nur kuratierte research-Chunks
 *
 * @param filePath - Dateipfad (z.B. "src/api.ts")
 * @param agentId - Agent-ID fuer Cutoff-Ermittlung
 * @param project - Projekt-Name
 */
export async function getDocsForFile(
  filePath: string,
  agentId: string,
  project: string
): Promise<{
  warnings: Array<{ framework: string; version: string; docs: Array<{ section: string; type: string; content: string }> }>;
  agentCutoff: string | null;
}> {
  // 1. Agent-Cutoff ermitteln
  const session = await getAgentSession(agentId);
  const agentCutoff = session?.cutoffDate || null;

  if (!agentCutoff) {
    return { warnings: [], agentCutoff: null };
  }

  // 2. Datei-Extension → moegliche Frameworks ableiten
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const frameworkHints = getFrameworkHintsForExtension(ext);

  if (frameworkHints.length === 0) {
    return { warnings: [], agentCutoff };
  }

  // 3. Relevante Docs aus PostgreSQL holen (nur research, neuer als Cutoff)
  const pool = getPool();
  const result = await pool.query(
    `SELECT framework, version, section, type, content
     FROM tech_docs
     WHERE framework = ANY($1)
       AND indexed_at > $2
       AND source = 'research'
       AND type IN ('breaking-change', 'migration', 'gotcha', 'known-issue')
     ORDER BY framework, indexed_at DESC`,
    [frameworkHints, agentCutoff]
  );

  if (result.rows.length === 0) {
    return { warnings: [], agentCutoff };
  }

  // 4. Nach Framework gruppieren
  const grouped = new Map<string, { version: string; docs: Array<{ section: string; type: string; content: string }> }>();

  for (const row of result.rows) {
    const key = row.framework;
    if (!grouped.has(key)) {
      grouped.set(key, { version: row.version, docs: [] });
    }
    grouped.get(key)!.docs.push({
      section: row.section,
      type: row.type,
      content: row.content,
    });
  }

  const warnings = Array.from(grouped.entries()).map(([framework, data]) => ({
    framework,
    version: data.version,
    docs: data.docs,
  }));

  return { warnings, agentCutoff };
}

/**
 * Hilfsfunktion: Datei-Extension → moegliche Framework-Namen
 */
function getFrameworkHintsForExtension(ext: string): string[] {
  const hints: Record<string, string[]> = {
    'ts': ['typescript', 'nodejs', 'react', 'vue', 'angular', 'express', 'fastify', 'next'],
    'tsx': ['typescript', 'react', 'next'],
    'js': ['nodejs', 'javascript', 'react', 'vue', 'express'],
    'jsx': ['react', 'javascript'],
    'vue': ['vue', 'nuxt'],
    'py': ['python', 'django', 'flask', 'fastapi'],
    'rs': ['rust'],
    'go': ['go'],
    'java': ['java', 'spring'],
    'kt': ['kotlin'],
    'swift': ['swift'],
    'rb': ['ruby', 'rails'],
    'php': ['php', 'laravel'],
    'cs': ['dotnet', 'csharp'],
    'css': ['css', 'tailwind'],
    'scss': ['sass', 'css'],
  };

  return hints[ext] || [];
}

/**
 * Loescht ein Tech-Doc aus PostgreSQL + Qdrant
 */
export async function deleteTechDoc(
  id: string,
  project?: string
): Promise<boolean> {
  const pool = getPool();
  await pool.query('DELETE FROM tech_docs WHERE id = $1', [id]);

  const collectionName = project ? COLLECTIONS.projectDocs(project) : COLLECTIONS.techDocs;
  try {
    await deleteVector(collectionName, id);
  } catch { /* Collection existiert evtl nicht */ }

  return true;
}
