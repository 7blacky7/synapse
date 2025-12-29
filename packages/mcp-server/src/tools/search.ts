/**
 * Synapse MCP - Search Tools
 * Code und Dokumentation durchsuchen
 */

import { searchCode, searchDocsWithFallback } from '@synapse/core';
import type { CodeSearchResult, DocSearchResult } from '@synapse/core';

/**
 * Semantische Code-Suche
 */
export async function semanticCodeSearch(
  query: string,
  project?: string,
  fileType?: string,
  limit: number = 10
): Promise<{
  success: boolean;
  results: Array<{
    filePath: string;
    fileName: string;
    fileType: string;
    lineStart: number;
    lineEnd: number;
    score: number;
    content: string;
  }>;
  message: string;
}> {
  if (!project) {
    return {
      success: false,
      results: [],
      message: 'Projekt muss angegeben werden',
    };
  }

  try {
    const results = await searchCode(query, project, fileType, limit);

    return {
      success: true,
      results: results.map(r => ({
        filePath: r.payload.file_path,
        fileName: r.payload.file_name,
        fileType: r.payload.file_type,
        lineStart: r.payload.line_start,
        lineEnd: r.payload.line_end,
        score: r.score,
        content: r.payload.content,
      })),
      message: `${results.length} Ergebnisse gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei Code-Suche: ${error}`,
    };
  }
}

/**
 * Dokumentations-Suche (Cache + optional Context7)
 */
export async function searchDocumentation(
  query: string,
  framework?: string,
  useContext7: boolean = false,
  limit: number = 10
): Promise<{
  success: boolean;
  results: Array<{
    framework: string;
    version: string;
    title: string;
    content: string;
    url?: string;
    score: number;
  }>;
  message: string;
}> {
  try {
    const results = await searchDocsWithFallback(query, framework, useContext7, limit);

    return {
      success: true,
      results: results.map(r => ({
        framework: r.payload.framework,
        version: r.payload.version,
        title: r.payload.title,
        content: r.payload.content,
        url: r.payload.url,
        score: r.score,
      })),
      message: `${results.length} Dokumentations-Ergebnisse gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei Docs-Suche: ${error}`,
    };
  }
}
