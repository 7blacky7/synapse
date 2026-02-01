/**
 * MODUL: global-search-tools
 * ZWECK: MCP-Wrapper fuer globale Suche ueber alle Projekte
 *
 * INPUT:
 *   - query: string - Suchbegriff
 *   - options.types: ('code'|'thoughts'|'memories')[] - Zu durchsuchende Typen
 *   - options.projectFilter: string[] - Optional: Nur bestimmte Projekte
 *   - options.limit: number - Max Ergebnisse pro Typ
 *   - options.minScore: number - Minimaler Relevanz-Score
 *
 * OUTPUT:
 *   - results: GlobalSearchResult[] - Sortierte Suchergebnisse
 *   - counts: Anzahl pro Typ
 *   - searchedProjects: Durchsuchte Projekte
 *
 * NEBENEFFEKTE: Keine (Read-Only)
 *
 * ABHAENGIGKEITEN:
 *   - @synapse/core (extern) - globalSearch, listSearchableProjects
 *
 * HINWEISE:
 *   - Designed fuer externe KI-Agenten (OpenAI etc.) ohne Projekt-Kontext
 *   - Alle Operationen sind Read-Only
 */

import {
  globalSearch,
  listSearchableProjects,
  type GlobalSearchOptions,
  type GlobalSearchResult,
} from '@synapse/core';

/**
 * Wrapper fuer globale Suche mit MCP-kompatiblem Response
 */
export async function globalSearchWrapper(
  query: string,
  options: {
    types?: ('code' | 'thoughts' | 'memories')[];
    projectFilter?: string[];
    limit?: number;
    minScore?: number;
  } = {}
): Promise<{
  success: boolean;
  results: GlobalSearchResult['results'];
  counts: GlobalSearchResult['counts'];
  searchedProjects: string[];
  searchTimeMs: number;
  message: string;
}> {
  try {
    const searchOptions: GlobalSearchOptions = {
      types: options.types,
      projectFilter: options.projectFilter,
      limit: options.limit,
      minScore: options.minScore,
    };

    const result = await globalSearch(query, searchOptions);

    return {
      success: true,
      results: result.results,
      counts: result.counts,
      searchedProjects: result.searchedProjects,
      searchTimeMs: result.searchTimeMs,
      message: `${result.counts.total} Ergebnisse in ${result.searchTimeMs}ms gefunden (${result.searchedProjects.length} Projekte durchsucht)`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      counts: { code: 0, thoughts: 0, memories: 0, total: 0 },
      searchedProjects: [],
      searchTimeMs: 0,
      message: `Fehler bei globaler Suche: ${error}`,
    };
  }
}

/**
 * Listet alle verfuegbaren Projekte
 */
export async function listProjectsWrapper(): Promise<{
  success: boolean;
  projects: string[];
  count: number;
  message: string;
}> {
  try {
    const projects = await listSearchableProjects();

    return {
      success: true,
      projects,
      count: projects.length,
      message: `${projects.length} Projekte verfuegbar`,
    };
  } catch (error) {
    return {
      success: false,
      projects: [],
      count: 0,
      message: `Fehler beim Auflisten der Projekte: ${error}`,
    };
  }
}
