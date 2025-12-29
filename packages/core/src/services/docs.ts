/**
 * Synapse Core - Docs Service
 * Framework-Dokumentation cachen und durchsuchen
 */

import { v4 as uuidv4 } from 'uuid';
import {
  DocEntry,
  DocEntryPayload,
  DocSearchResult,
  COLLECTIONS,
} from '../types/index.js';
import {
  ensureCollection,
  insertVector,
  searchVectors,
  scrollVectors,
  deleteByFilter,
} from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';
import { getConfig } from '../config.js';

/**
 * Fuegt Dokumentation zum Cache hinzu
 */
export async function cacheDoc(
  framework: string,
  version: string,
  title: string,
  content: string,
  url?: string
): Promise<DocEntry> {
  // Collection sicherstellen
  await ensureCollection(COLLECTIONS.techDocs);

  const doc: DocEntry = {
    id: uuidv4(),
    framework,
    version,
    title,
    content,
    url,
    cachedAt: new Date().toISOString(),
  };

  // Embedding aus Titel + Content generieren
  const textForEmbedding = `${framework} ${version}: ${title}\n${content}`;
  const vector = await embed(textForEmbedding);

  const payload: DocEntryPayload = {
    framework: doc.framework,
    version: doc.version,
    title: doc.title,
    content: doc.content,
    url: doc.url,
    cached_at: doc.cachedAt,
  };

  await insertVector(COLLECTIONS.techDocs, vector, payload, doc.id);

  console.log(`[Synapse] Doku gecached: ${framework} ${version} - ${title}`);
  return doc;
}

/**
 * Durchsucht den Dokumentations-Cache semantisch
 */
export async function searchDocs(
  query: string,
  framework?: string,
  limit: number = 10
): Promise<DocSearchResult[]> {
  // Query embedden
  const queryVector = await embed(query);

  // Filter erstellen
  const filter: Record<string, unknown> | undefined = framework
    ? {
        must: [
          {
            key: 'framework',
            match: { value: framework },
          },
        ],
      }
    : undefined;

  return searchVectors<DocEntryPayload>(
    COLLECTIONS.techDocs,
    queryVector,
    limit,
    filter
  );
}

/**
 * Ruft alle gecachten Docs fuer ein Framework ab
 */
export async function getDocsForFramework(
  framework: string,
  limit: number = 100
): Promise<DocEntry[]> {
  const results = await scrollVectors<DocEntryPayload>(
    COLLECTIONS.techDocs,
    {
      must: [
        {
          key: 'framework',
          match: { value: framework },
        },
      ],
    },
    limit
  );

  return results.map(r => ({
    id: r.id,
    framework: r.payload.framework,
    version: r.payload.version,
    title: r.payload.title,
    content: r.payload.content,
    url: r.payload.url,
    cachedAt: r.payload.cached_at,
  }));
}

/**
 * Loescht alle Docs fuer ein Framework
 */
export async function clearDocsForFramework(framework: string): Promise<void> {
  await deleteByFilter(COLLECTIONS.techDocs, {
    must: [
      {
        key: 'framework',
        match: { value: framework },
      },
    ],
  });

  console.log(`[Synapse] Doku-Cache geloescht fuer: ${framework}`);
}

/**
 * Sucht Dokumentation - zuerst im Cache, optional mit Context7 Fallback
 */
export async function searchDocsWithFallback(
  query: string,
  framework?: string,
  useContext7: boolean = false,
  limit: number = 10
): Promise<DocSearchResult[]> {
  // Zuerst im Cache suchen
  const cachedResults = await searchDocs(query, framework, limit);

  // Wenn genug Ergebnisse im Cache oder Context7 nicht gewuenscht
  if (cachedResults.length >= limit || !useContext7) {
    return cachedResults;
  }

  // Context7 Fallback
  const config = getConfig();

  if (config.context7?.apiKey) {
    try {
      // Dynamic import to avoid circular dependency
      const { getContext7Client } = await import('./context7.js');
      const { cacheSearchResults } = await import('./docs-indexer.js');

      const context7 = getContext7Client();

      if (context7.isAvailable()) {
        console.log(`[Synapse] Context7 Suche: "${query}" (${framework || 'alle'})`);

        const docs = await context7.searchDocs(framework || '', query);

        if (docs.length > 0) {
          // Ergebnisse cachen fuer naechstes Mal
          await cacheSearchResults(docs, query);

          // Nochmal im Cache suchen (jetzt mit neuen Daten)
          return await searchDocs(query, framework, limit);
        }
      }
    } catch (error) {
      console.error('[Synapse] Context7 Fallback Fehler:', error);
    }
  }

  return cachedResults;
}

/**
 * Listet alle gecachten Frameworks auf
 */
export async function listCachedFrameworks(): Promise<string[]> {
  const results = await scrollVectors<DocEntryPayload>(
    COLLECTIONS.techDocs,
    {},
    1000
  );

  const frameworks = new Set(results.map(r => r.payload.framework));
  return Array.from(frameworks).sort();
}
