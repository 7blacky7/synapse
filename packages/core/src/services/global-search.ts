/**
 * MODUL: Globale Suche
 * ZWECK: Durchsucht alle Projekt-Collections parallel fuer externe KI-Agenten (Read-Only)
 *
 * INPUT:
 *   - query: string - Suchbegriff fuer semantische Suche
 *   - options.types: SearchType[] - Welche Typen durchsucht werden (code, thoughts, memories)
 *   - options.projectFilter: string[] - Optional: Nur bestimmte Projekte durchsuchen
 *   - options.limit: number - Maximale Ergebnisse pro Typ (default: 10)
 *   - options.minScore: number - Minimaler Score fuer Ergebnisse (default: 0.5)
 *
 * OUTPUT:
 *   - GlobalSearchResult: Gemergte und sortierte Ergebnisse aller Collections
 *
 * NEBENEFFEKTE:
 *   - Keine (Read-Only)
 *
 * ABHÄNGIGKEITEN:
 *   - ../qdrant/collections.js (intern) - Collection-Listing
 *   - ../qdrant/operations.js (intern) - Vektor-Suche
 *   - ../embeddings/index.js (intern) - Query-Embedding
 *   - ../types/index.js (intern) - Collection-Namen und Payloads
 *
 * HINWEISE:
 *   - Designed fuer externe KIs (OpenAI, etc.) via REST-API/MCP
 *   - Durchsucht alle Projekte parallel fuer Performance
 *   - Ergebnisse werden nach Score sortiert und dedupliziert
 */

import { listCollections } from '../qdrant/collections.js';
import { searchVectors } from '../qdrant/operations.js';
import { embed } from '../embeddings/index.js';
import {
  COLLECTIONS,
  CodeChunkPayload,
  ThoughtPayload,
} from '../types/index.js';

// ===========================================
// TYPEN
// ===========================================

/** Suchbare Datentypen */
export type SearchType = 'code' | 'thoughts' | 'memories';

/** Optionen fuer globale Suche */
export interface GlobalSearchOptions {
  /** Welche Typen durchsuchen (default: alle) */
  types?: SearchType[];
  /** Nur bestimmte Projekte durchsuchen (default: alle) */
  projectFilter?: string[];
  /** Maximale Ergebnisse pro Typ (default: 10) */
  limit?: number;
  /** Minimaler Score (default: 0.5) */
  minScore?: number;
}

/** Einzelnes Suchergebnis */
export interface GlobalSearchItem {
  /** Eindeutige ID */
  id: string;
  /** Typ des Ergebnisses */
  type: SearchType;
  /** Projekt-Name */
  project: string;
  /** Relevanz-Score (0-1) */
  score: number;
  /** Inhalt-Vorschau */
  content: string;
  /** Zusaetzliche Metadaten je nach Typ */
  metadata: GlobalSearchMetadata;
}

/** Metadaten je nach Ergebnis-Typ */
export type GlobalSearchMetadata =
  | CodeSearchMetadata
  | ThoughtSearchMetadata
  | MemorySearchMetadata;

/** Metadaten fuer Code-Ergebnisse */
export interface CodeSearchMetadata {
  type: 'code';
  filePath: string;
  fileName: string;
  fileType: string;
  lineStart: number;
  lineEnd: number;
}

/** Metadaten fuer Thought-Ergebnisse */
export interface ThoughtSearchMetadata {
  type: 'thoughts';
  source: string;
  tags: string[];
  timestamp: string;
}

/** Metadaten fuer Memory-Ergebnisse */
export interface MemorySearchMetadata {
  type: 'memories';
  name: string;
  category: string;
  tags: string[];
  updatedAt: string;
}

/** Memory-Payload fuer interne Verwendung */
interface MemoryPayload {
  project: string;
  name: string;
  content: string;
  category: string;
  tags: string[];
  linkedPaths: string[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Gesamtergebnis der globalen Suche */
export interface GlobalSearchResult {
  /** Alle Ergebnisse sortiert nach Score */
  results: GlobalSearchItem[];
  /** Anzahl Ergebnisse pro Typ */
  counts: {
    code: number;
    thoughts: number;
    memories: number;
    total: number;
  };
  /** Durchsuchte Projekte */
  searchedProjects: string[];
  /** Suchzeit in Millisekunden */
  searchTimeMs: number;
}

// ===========================================
// KONSTANTEN
// ===========================================

/** Collection-Name fuer Memories */
const MEMORIES_COLLECTION = 'synapse_memories';

/** Default-Optionen */
const DEFAULT_OPTIONS: Required<GlobalSearchOptions> = {
  types: ['code', 'thoughts', 'memories'],
  projectFilter: [],
  limit: 10,
  minScore: 0.5,
};

// ===========================================
// HILFSFUNKTIONEN
// ===========================================

/**
 * Extrahiert Projekt-Name aus Collection-Namen
 * z.B. "project_synapse" -> "synapse"
 */
function extractProjectName(collectionName: string): string | null {
  const prefix = 'project_';
  if (collectionName.startsWith(prefix)) {
    return collectionName.slice(prefix.length);
  }
  return null;
}

/**
 * Findet alle Projekt-Collections
 * Filtert nach "project_*" Pattern und optional nach Projekt-Liste
 */
async function findProjectCollections(
  projectFilter: string[]
): Promise<string[]> {
  const allCollections = await listCollections();

  // Nur project_* Collections
  const projectCollections = allCollections.filter(name =>
    name.startsWith('project_')
  );

  // Optional: Nach Projekten filtern
  if (projectFilter.length > 0) {
    return projectCollections.filter(name => {
      const project = extractProjectName(name);
      return project && projectFilter.includes(project);
    });
  }

  return projectCollections;
}

/**
 * Durchsucht Code-Collections parallel
 */
async function searchCodeCollections(
  queryVector: number[],
  collections: string[],
  limit: number,
  minScore: number
): Promise<GlobalSearchItem[]> {
  const results: GlobalSearchItem[] = [];

  // Parallel durchsuchen
  const searchPromises = collections.map(async collectionName => {
    const project = extractProjectName(collectionName);
    if (!project) return [];

    try {
      const hits = await searchVectors<CodeChunkPayload>(
        collectionName,
        queryVector,
        limit
      );

      return hits
        .filter(hit => hit.score >= minScore)
        .map(hit => ({
          id: hit.id,
          type: 'code' as SearchType,
          project,
          score: hit.score,
          content: hit.payload.content,
          metadata: {
            type: 'code' as const,
            filePath: hit.payload.file_path,
            fileName: hit.payload.file_name,
            fileType: hit.payload.file_type,
            lineStart: hit.payload.line_start,
            lineEnd: hit.payload.line_end,
          },
        }));
    } catch (error) {
      console.warn(`[GlobalSearch] Fehler bei Collection ${collectionName}:`, error);
      return [];
    }
  });

  const allResults = await Promise.all(searchPromises);
  for (const collectionResults of allResults) {
    results.push(...collectionResults);
  }

  return results;
}

/**
 * Durchsucht Thoughts-Collection
 */
async function searchThoughtsCollection(
  queryVector: number[],
  projectFilter: string[],
  limit: number,
  minScore: number
): Promise<GlobalSearchItem[]> {
  try {
    // Filter erstellen
    const filter: Record<string, unknown> | undefined =
      projectFilter.length > 0
        ? {
            should: projectFilter.map(project => ({
              key: 'project',
              match: { value: project },
            })),
          }
        : undefined;

    const hits = await searchVectors<ThoughtPayload>(
      COLLECTIONS.projectThoughts,
      queryVector,
      limit,
      filter
    );

    return hits
      .filter(hit => hit.score >= minScore)
      .map(hit => ({
        id: hit.id,
        type: 'thoughts' as SearchType,
        project: hit.payload.project,
        score: hit.score,
        content: hit.payload.content,
        metadata: {
          type: 'thoughts' as const,
          source: hit.payload.source,
          tags: hit.payload.tags || [],
          timestamp: hit.payload.timestamp,
        },
      }));
  } catch (error) {
    console.warn('[GlobalSearch] Fehler bei Thoughts-Suche:', error);
    return [];
  }
}

/**
 * Durchsucht Memories-Collection
 */
async function searchMemoriesCollection(
  queryVector: number[],
  projectFilter: string[],
  limit: number,
  minScore: number
): Promise<GlobalSearchItem[]> {
  try {
    // Filter erstellen
    const filter: Record<string, unknown> | undefined =
      projectFilter.length > 0
        ? {
            should: projectFilter.map(project => ({
              key: 'project',
              match: { value: project },
            })),
          }
        : undefined;

    const hits = await searchVectors<MemoryPayload>(
      MEMORIES_COLLECTION,
      queryVector,
      limit,
      filter
    );

    return hits
      .filter(hit => hit.score >= minScore)
      .map(hit => ({
        id: hit.id,
        type: 'memories' as SearchType,
        project: hit.payload.project,
        score: hit.score,
        content: hit.payload.content,
        metadata: {
          type: 'memories' as const,
          name: hit.payload.name,
          category: hit.payload.category,
          tags: hit.payload.tags || [],
          updatedAt: hit.payload.updatedAt,
        },
      }));
  } catch (error) {
    console.warn('[GlobalSearch] Fehler bei Memories-Suche:', error);
    return [];
  }
}

// ===========================================
// HAUPTFUNKTION
// ===========================================

/**
 * Globale semantische Suche ueber alle Projekte
 *
 * Durchsucht parallel:
 * - Code-Collections (project_*)
 * - Thoughts-Collection (project_thoughts)
 * - Memories-Collection (synapse_memories)
 *
 * @param query - Suchbegriff
 * @param options - Such-Optionen
 * @returns Gemergte und sortierte Ergebnisse
 *
 * @example
 * // Alle Typen durchsuchen
 * const result = await globalSearch("authentication middleware");
 *
 * @example
 * // Nur Code in bestimmten Projekten
 * const result = await globalSearch("database connection", {
 *   types: ['code'],
 *   projectFilter: ['synapse', 'myapp'],
 *   limit: 20
 * });
 */
export async function globalSearch(
  query: string,
  options: GlobalSearchOptions = {}
): Promise<GlobalSearchResult> {
  const startTime = Date.now();

  // Optionen mit Defaults mergen (nullish coalescing um undefined zu ignorieren)
  const opts: Required<GlobalSearchOptions> = {
    types: options.types ?? DEFAULT_OPTIONS.types,
    projectFilter: options.projectFilter ?? DEFAULT_OPTIONS.projectFilter,
    limit: options.limit ?? DEFAULT_OPTIONS.limit,
    minScore: options.minScore ?? DEFAULT_OPTIONS.minScore,
  };

  // Query embedden
  const queryVector = await embed(query);

  // Projekte sammeln
  const searchedProjects = new Set<string>();

  // Ergebnisse sammeln
  const allResults: GlobalSearchItem[] = [];
  const counts = { code: 0, thoughts: 0, memories: 0, total: 0 };

  // Parallel durchsuchen je nach aktivierten Typen
  const searchPromises: Promise<void>[] = [];

  // Code-Suche
  if (opts.types.includes('code')) {
    searchPromises.push(
      (async () => {
        const collections = await findProjectCollections(opts.projectFilter);

        // Projekte sammeln
        for (const col of collections) {
          const project = extractProjectName(col);
          if (project) searchedProjects.add(project);
        }

        const results = await searchCodeCollections(
          queryVector,
          collections,
          opts.limit,
          opts.minScore
        );

        allResults.push(...results);
        counts.code = results.length;
      })()
    );
  }

  // Thoughts-Suche
  if (opts.types.includes('thoughts')) {
    searchPromises.push(
      (async () => {
        const results = await searchThoughtsCollection(
          queryVector,
          opts.projectFilter,
          opts.limit,
          opts.minScore
        );

        // Projekte sammeln
        for (const r of results) {
          searchedProjects.add(r.project);
        }

        allResults.push(...results);
        counts.thoughts = results.length;
      })()
    );
  }

  // Memories-Suche
  if (opts.types.includes('memories')) {
    searchPromises.push(
      (async () => {
        const results = await searchMemoriesCollection(
          queryVector,
          opts.projectFilter,
          opts.limit,
          opts.minScore
        );

        // Projekte sammeln
        for (const r of results) {
          searchedProjects.add(r.project);
        }

        allResults.push(...results);
        counts.memories = results.length;
      })()
    );
  }

  // Auf alle Suchen warten
  await Promise.all(searchPromises);

  // Nach Score sortieren (hoechster zuerst)
  allResults.sort((a, b) => b.score - a.score);

  // Gesamt-Limit anwenden (3x limit fuer alle Typen zusammen)
  const totalLimit = opts.limit * 3;
  const limitedResults = allResults.slice(0, totalLimit);

  counts.total = limitedResults.length;

  const searchTimeMs = Date.now() - startTime;

  return {
    results: limitedResults,
    counts,
    searchedProjects: Array.from(searchedProjects).sort(),
    searchTimeMs,
  };
}

/**
 * Listet alle verfuegbaren Projekte
 * Nuetzlich fuer UI-Auswahl oder Vorschau
 */
export async function listSearchableProjects(): Promise<string[]> {
  const collections = await findProjectCollections([]);
  const projects = collections
    .map(extractProjectName)
    .filter((p): p is string => p !== null);

  return [...new Set(projects)].sort();
}
