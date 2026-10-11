/**
 * Synapse Core - Docs Service
 * Framework-Dokumentation (Context7, global) cachen und durchsuchen.
 *
 * P12-T16: Schreiben und Existenzfragen laufen ueber PostgreSQL (tech_docs, project NULL,
 * source 'context7'); Qdrant (tech_docs_cache) beantwortet nur die Aehnlichkeitssuche.
 */

import {
  DocEntry,
  DocEntryPayload,
  DocSearchResult,
  COLLECTIONS,
} from '../types/index.js';
import { searchVectors } from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';
import { getConfig } from '../config.js';
import { getPool } from '../db/client.js';
import { speichereTechDoc, loescheContext7Bibliothek, meldeContext7Abfrage } from './tech-docs.js';

/**
 * Fuegt Dokumentation zum Cache hinzu — PG-first, global (Context7), Vektor abgewartet.
 * Die url hat in tech_docs keine Spalte und wird nur im Rueckgabewert durchgereicht.
 */
export async function cacheDoc(
  framework: string,
  version: string,
  title: string,
  content: string,
  url?: string
): Promise<DocEntry> {
  const result = await speichereTechDoc(
    {
      framework,
      version,
      section: title,
      content,
      type: 'code-example',
      category: 'framework',
      source: 'context7',
    },
    { embeddingAbwarten: true }
  );
  if (!result.success) {
    throw new Error(result.message);
  }

  console.error(`[Synapse] Doku gecached: ${framework} ${version} - ${title}${result.duplicate ? ' (Duplikat)' : ''}`);
  return {
    id: result.id,
    framework: framework.toLowerCase(),
    version,
    title,
    content,
    url,
    cachedAt: new Date().toISOString(),
  };
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
  const queryVector = await embed(query, { art: 'query' });

  // Filter erstellen
  const filter: Record<string, unknown> | undefined = framework
    ? {
        must: [
          {
            key: 'framework',
            match: { value: framework.toLowerCase() },
          },
        ],
      }
    : undefined;

  const results = await searchVectors<DocEntryPayload>(
    COLLECTIONS.techDocs,
    queryVector,
    limit,
    filter
  );

  // Punkte aus dem PG-first-Weg tragen section/indexed_at (Payload von tech-docs.ts),
  // Altpunkte title/cached_at — fuer die Aufrufer auf die alten Feldnamen abbilden.
  return results.map(r => ({
    ...r,
    payload: {
      ...r.payload,
      title: r.payload.title ?? (r.payload.section as string | undefined) ?? '',
      cached_at: r.payload.cached_at ?? (r.payload.indexed_at as string | undefined) ?? '',
    },
  }));
}

/**
 * Ruft alle gecachten Docs fuer ein Framework ab (aus PostgreSQL)
 */
export async function getDocsForFramework(
  framework: string,
  limit: number = 100
): Promise<DocEntry[]> {
  const { rows } = await getPool().query(
    `SELECT id, framework, version, section, content, indexed_at
       FROM tech_docs
      WHERE framework = $1 AND source = 'context7' AND project IS NULL
      ORDER BY indexed_at DESC
      LIMIT $2`,
    [framework.toLowerCase(), limit]
  );

  return rows.map(r => ({
    id: r.id,
    framework: r.framework,
    version: r.version,
    title: r.section ?? '',
    content: r.content,
    cachedAt: new Date(r.indexed_at).toISOString(),
  }));
}

/**
 * Loescht alle (globalen Context7-)Docs fuer ein Framework — PG zuerst, dann Qdrant.
 * Projektgebundene TechDocs (research/manual) bleiben bewusst unberuehrt.
 */
export async function clearDocsForFramework(framework: string): Promise<void> {
  const anzahl = await loescheContext7Bibliothek(framework);
  console.error(`[Synapse] Doku-Cache geloescht fuer: ${framework} (${anzahl} Eintraege)`);
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
        console.error(`[Synapse] Context7 Suche: "${query}" (${framework || 'alle'})`);

        const docs = await context7.searchDocs(framework || '', query);

        if (docs.length > 0) {
          // PG-first speichern; Vektoren ABWARTEN, weil direkt danach gesucht wird
          const gespeichert = await cacheSearchResults(docs, query, { embeddingAbwarten: true });
          meldeContext7Abfrage((framework || docs[0].framework || '').toLowerCase(), query, gespeichert);

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
 * Listet alle gecachten Frameworks auf (aus PostgreSQL — Existenzfrage)
 */
export async function listCachedFrameworks(): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT framework FROM tech_docs
      WHERE source = 'context7' AND project IS NULL
      ORDER BY framework`
  );
  return rows.map(r => r.framework as string);
}
