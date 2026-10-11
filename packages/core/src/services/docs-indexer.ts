/**
 * MODUL: Dokumentations-Indexer
 * ZWECK: Laedt Framework-Dokumentation von Context7 und speichert sie PG-first und GLOBAL
 *        (tech_docs, project NULL; Vektor in tech_docs_cache) fuer schnellen Zugriff
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
 *   - { indexed, cached }: Anzahl neu gespeicherter Chunks und Cache-Status
 *   - { total, indexed, cached }: Statistiken ueber alle Technologien
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Schreibt Zeilen in tech_docs (source 'context7', project NULL)
 *   - Qdrant: Vektor in Collection "tech_docs_cache" — nachgereicht ueber speichereContext7Chunks
 *   - Netzwerk: Ruft Context7 API fuer Framework-Dokumentation ab
 *   - Logs: Konsolenausgabe bei Indexierung/Cache-Hit
 *
 * ABHÄNGIGKEITEN:
 *   - ../db/client.js (intern) - PostgreSQL (Cache-Pruefung)
 *   - ../chunking/index.js (intern) - Text-Chunking
 *   - ./context7.js (intern) - Context7 API Client
 *   - ./tech-docs.js (intern) - PG-first-Speichern (speichereContext7Chunks)
 *   - ./tech-detection.js (intern) - Technologie-Typen
 *
 * HINWEISE:
 *   - Benoetigt CONTEXT7_API_KEY Umgebungsvariable
 *   - Nur Frameworks und Libraries werden indexiert (keine Tools/Runtimes)
 *   - Cache-Pruefung basiert auf framework + version Kombination — in PostgreSQL (P12-T16),
 *     nicht mehr im Index: "ist es schon da" ist eine Existenzfrage, die beantwortet PG.
 */

import { getPool } from '../db/client.js';
import { chunkText } from '../chunking/index.js';
import { getContext7Client, Context7Doc } from './context7.js';
import { DetectedTechnology } from './tech-detection.js';
import { speichereContext7Chunks } from './tech-docs.js';

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
 * Prüft ob Docs für ein Framework bereits gecacht sind (globale Context7-Zeilen in PG)
 */
export async function isFrameworkCached(
  framework: string,
  version?: string
): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      `SELECT 1 FROM tech_docs
        WHERE framework = $1 AND source = 'context7' AND project IS NULL
          AND ($2::text IS NULL OR version = $2)
        LIMIT 1`,
      [framework.toLowerCase(), version ?? null]
    );
    return rows.length > 0;
  } catch (error) {
    console.error('[DocsIndexer] Cache-Pruefung in PostgreSQL fehlgeschlagen:', error);
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
      console.error(`[DocsIndexer] ${framework} bereits gecacht`);
      return { indexed: 0, cached: true };
    }
  }

  console.error(`[DocsIndexer] Indexiere ${framework}${version ? ` v${version}` : ''}...`);

  // Dokumentation von Context7 holen
  const context7 = getContext7Client();

  if (!context7.isAvailable()) {
    console.warn('[DocsIndexer] Context7 nicht verfügbar (kein API-Key)');
    return { indexed: 0, cached: false };
  }

  const docs = await context7.searchDocs(framework, `${framework} getting started core concepts`);

  if (docs.length === 0) {
    console.warn(`[DocsIndexer] Keine Docs für ${framework} gefunden`);
    return { indexed: 0, cached: false };
  }

  // Docs chunken und PG-first speichern (Vektor wird nachgereicht)
  const indexedDocs = await processAndIndexDocs(docs);

  console.error(`[DocsIndexer] ${indexedDocs} Chunks für ${framework} gespeichert`);
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

  // Frameworks, Libraries und Sprachen indexieren (keine Tools/Runtimes)
  const toIndex = technologies.filter(
    (tech) => tech.type === 'framework' || tech.type === 'library' || tech.type === 'language'
  );

  console.error(`[DocsIndexer] Indexiere ${toIndex.length} Technologien...`);

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
 * Verarbeitet Docs: Chunking, dann PG-first speichern (global, Context7).
 * Der fruehere direkte Qdrant-upsert ist weg (P12-T16): er schrieb ohne PG-Zeile und mit einer
 * ID ("doc-..."), die Qdrant als Punkt-ID gar nicht annimmt.
 * @returns Anzahl NEU gespeicherter Chunks (Duplikate zaehlen nicht)
 */
async function processAndIndexDocs(
  docs: Context7Doc[],
  optionen: { embeddingAbwarten?: boolean } = {}
): Promise<number> {
  let totalChunks = 0;

  for (const doc of docs) {
    if (!doc.content || doc.content.trim().length === 0) {
      continue;
    }

    // Text chunken
    const chunks = chunkText(doc.content);
    const titel = doc.title || 'context7';

    const ergebnis = await speichereContext7Chunks(
      doc.framework || 'unbekannt',
      doc.version || 'latest',
      chunks.map((chunk, i) => ({
        section: chunks.length > 1 ? `${titel} (${i + 1}/${chunks.length})` : titel,
        content: chunk.content,
      })),
      optionen
    );

    if (ergebnis.fehlgeschlagen > 0) {
      console.error(`[DocsIndexer] ${ergebnis.fehlgeschlagen} Chunks von "${titel}" nicht gespeichert`);
    }
    totalChunks += ergebnis.gespeichert;
  }

  return totalChunks;
}

/**
 * Speichert manuell geholte Docs (z.B. von Context7 Suche).
 * embeddingAbwarten: true, wenn direkt danach semantisch gesucht wird.
 */
export async function cacheSearchResults(
  docs: Context7Doc[],
  searchQuery: string,
  optionen: { embeddingAbwarten?: boolean } = {}
): Promise<number> {
  if (docs.length === 0) return 0;

  console.error(`[DocsIndexer] Cache ${docs.length} Suchergebnisse für "${searchQuery}"...`);

  return await processAndIndexDocs(docs, optionen);
}
