/**
 * MODUL: Dokumentations-Indexer
 * ZWECK: Laedt Framework-Dokumentation von Context7 und cached sie in Qdrant fuer schnellen Zugriff
 *
 * INPUT:
 *   - framework: string - Name des Frameworks (z.B. "react", "vue")
 *   - version?: string - Optionale Version
 *   - technologies: DetectedTechnology[] - Liste erkannter Projekt-Technologien
 *   - forceReindex: boolean - Cache ignorieren und neu indexieren
 *   - docs: Context7Doc[] - Manuell geholte Dokumente zum Cachen
 *   - searchQuery: string - Suchbegriff fuer Cache-Zuordnung
 *
 * OUTPUT:
 *   - boolean: Ob Framework bereits gecacht ist
 *   - { indexed, cached }: Anzahl indexierter Chunks und Cache-Status
 *   - { total, indexed, cached }: Statistiken ueber alle Technologien
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Schreibt in Collection "synapse_tech_docs"
 *   - Netzwerk: Ruft Context7 API fuer Framework-Dokumentation ab
 *   - Logs: Konsolenausgabe bei Indexierung/Cache-Hit
 *
 * ABHÄNGIGKEITEN:
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - ../qdrant/index.js (intern) - Qdrant Client
 *   - ../chunking/index.js (intern) - Text-Chunking
 *   - ./context7.js (intern) - Context7 API Client
 *   - ./tech-detection.js (intern) - Technologie-Typen
 *
 * HINWEISE:
 *   - Benoetigt CONTEXT7_API_KEY Umgebungsvariable
 *   - Nur Frameworks und Libraries werden indexiert (keine Tools/Runtimes)
 *   - Cache-Pruefung basiert auf framework + version Kombination
 */

import { getEmbeddingProvider, embed } from '../embeddings/index.js';
import { getQdrantClient } from '../qdrant/index.js';
import { COLLECTIONS } from '../types/index.js';
import { chunkText } from '../chunking/index.js';
import { getContext7Client, Context7Doc } from './context7.js';
import { DetectedTechnology } from './tech-detection.js';

export interface IndexedDoc {
  id: string;
  framework: string;
  version?: string;
  title?: string;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  url?: string;
}

/**
 * Prüft ob Docs für ein Framework bereits gecacht sind
 */
export async function isFrameworkCached(
  framework: string,
  version?: string
): Promise<boolean> {
  const client = getQdrantClient();

  try {
    // Suche nach existierenden Docs
    const filter: any = {
      must: [
        { key: 'framework', match: { value: framework.toLowerCase() } },
      ],
    };

    if (version) {
      filter.must.push({ key: 'version', match: { value: version } });
    }

    const result = await client.scroll(COLLECTIONS.techDocs, {
      filter,
      limit: 1,
      with_payload: false,
      with_vector: false,
    });

    return result.points.length > 0;
  } catch {
    return false;
  }
}

/**
 * Indexiert Dokumentation für ein Framework
 */
export async function indexFrameworkDocs(
  framework: string,
  version?: string,
  forceReindex = false
): Promise<{ indexed: number; cached: boolean }> {
  // Prüfen ob bereits gecacht
  if (!forceReindex) {
    const cached = await isFrameworkCached(framework, version);
    if (cached) {
      console.log(`[DocsIndexer] ${framework} bereits gecacht`);
      return { indexed: 0, cached: true };
    }
  }

  console.log(`[DocsIndexer] Indexiere ${framework}${version ? ` v${version}` : ''}...`);

  // Dokumentation von Context7 holen
  const context7 = getContext7Client();

  if (!context7.isAvailable()) {
    console.warn('[DocsIndexer] Context7 nicht verfügbar (kein API-Key)');
    return { indexed: 0, cached: false };
  }

  const docs = await context7.getBaseDocs(framework, version);

  if (docs.length === 0) {
    console.warn(`[DocsIndexer] Keine Docs für ${framework} gefunden`);
    return { indexed: 0, cached: false };
  }

  // Docs chunken und embedden
  const indexedDocs = await processAndIndexDocs(docs);

  console.log(`[DocsIndexer] ${indexedDocs} Chunks für ${framework} indexiert`);
  return { indexed: indexedDocs, cached: false };
}

/**
 * Indexiert alle erkannten Technologien eines Projekts
 */
export async function indexProjectTechnologies(
  technologies: DetectedTechnology[],
  forceReindex = false
): Promise<{ total: number; indexed: number; cached: number }> {
  let totalIndexed = 0;
  let cachedCount = 0;

  // Nur Frameworks und Libraries indexieren
  const toIndex = technologies.filter(
    (tech) => tech.type === 'framework' || tech.type === 'library'
  );

  console.log(`[DocsIndexer] Indexiere ${toIndex.length} Technologien...`);

  for (const tech of toIndex) {
    try {
      const result = await indexFrameworkDocs(tech.name, tech.version, forceReindex);

      if (result.cached) {
        cachedCount++;
      } else {
        totalIndexed += result.indexed;
      }
    } catch (error) {
      console.error(`[DocsIndexer] Fehler bei ${tech.name}:`, error);
    }
  }

  return {
    total: toIndex.length,
    indexed: totalIndexed,
    cached: cachedCount,
  };
}

/**
 * Verarbeitet Docs: Chunking, Embedding, Speichern
 */
async function processAndIndexDocs(docs: Context7Doc[]): Promise<number> {
  const client = getQdrantClient();
  let totalChunks = 0;

  for (const doc of docs) {
    if (!doc.content || doc.content.trim().length === 0) {
      continue;
    }

    // Text chunken
    const chunks = chunkText(doc.content);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const id = generateDocId(doc.framework, doc.title || '', i);

      try {
        // Embedding erstellen
        const vector = await embed(chunk.content);

        // In Qdrant speichern
        await client.upsert(COLLECTIONS.techDocs, {
          wait: true,
          points: [
            {
              id,
              vector,
              payload: {
                framework: doc.framework.toLowerCase(),
                version: doc.version || null,
                title: doc.title || null,
                content: chunk.content,
                chunkIndex: i,
                totalChunks: chunks.length,
                url: doc.url || null,
                source: 'context7',
                indexedAt: new Date().toISOString(),
              },
            },
          ],
        });

        totalChunks++;
      } catch (error) {
        console.error(`[DocsIndexer] Chunk-Fehler:`, error);
      }
    }
  }

  return totalChunks;
}

/**
 * Speichert manuell geholte Docs (z.B. von Context7 Suche)
 */
export async function cacheSearchResults(
  docs: Context7Doc[],
  searchQuery: string
): Promise<number> {
  if (docs.length === 0) return 0;

  console.log(`[DocsIndexer] Cache ${docs.length} Suchergebnisse für "${searchQuery}"...`);

  return await processAndIndexDocs(docs);
}

/**
 * Generiert eindeutige ID für Doc-Chunk
 */
function generateDocId(framework: string, title: string, chunkIndex: number): string {
  const base = `${framework}-${title}-${chunkIndex}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100);

  // UUID-artige ID erstellen
  const hash = Buffer.from(base).toString('base64').substring(0, 8);
  return `doc-${hash}-${Date.now().toString(36)}`;
}
