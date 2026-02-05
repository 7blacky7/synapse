/**
 * Synapse MCP - Search Tools
 * Code und Dokumentation durchsuchen
 */

import { searchCode, searchDocsWithFallback, scrollVectors, searchDocuments } from '@synapse/core';
import type { CodeSearchResult, DocSearchResult, DocumentSearchResult } from '@synapse/core';
import { minimatch } from 'minimatch';

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

interface CodeChunkPayload {
  file_path: string;
  file_name: string;
  file_type: string;
  line_start: number;
  line_end: number;
  content: string;
  project: string;
}

/**
 * Exakte Pfadsuche - findet Code nach Pfad-Pattern (kein Embedding)
 * Unterstützt Glob-Patterns wie: "backend/src/*", "*.ts", "** /utils/*"
 */
export async function searchByPath(
  project: string,
  pathPattern: string,
  options: {
    contentPattern?: string;
    limit?: number;
  } = {}
): Promise<{
  success: boolean;
  results: Array<{
    filePath: string;
    fileName: string;
    fileType: string;
    lineStart: number;
    lineEnd: number;
    content: string;
  }>;
  totalMatches: number;
  message: string;
}> {
  const { contentPattern, limit = 50 } = options;

  try {
    const collectionName = `project_${project}`;

    // Alle Vektoren holen
    const allPoints = await scrollVectors<CodeChunkPayload>(
      collectionName,
      {},
      10000
    );

    // Nach Pfad-Pattern filtern
    let matches = allPoints.filter((point) => {
      const filePath = point.payload?.file_path || '';
      // Normalisiere Pfade für Cross-Platform
      const normalizedPath = filePath.replace(/\\/g, '/');
      return minimatch(normalizedPath, pathPattern, { matchBase: true });
    });

    // Optional: Nach Content filtern
    if (contentPattern) {
      const regex = new RegExp(contentPattern, 'i');
      matches = matches.filter((point) => {
        const content = point.payload?.content || '';
        return regex.test(content);
      });
    }

    const totalMatches = matches.length;

    // Limitieren
    const limited = matches.slice(0, limit);

    return {
      success: true,
      results: limited.map((p) => ({
        filePath: p.payload.file_path,
        fileName: p.payload.file_name,
        fileType: p.payload.file_type,
        lineStart: p.payload.line_start,
        lineEnd: p.payload.line_end,
        content: p.payload.content,
      })),
      totalMatches,
      message: totalMatches > limit
        ? `${limit} von ${totalMatches} Treffern angezeigt`
        : `${totalMatches} Treffer gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      totalMatches: 0,
      message: `Fehler bei Pfadsuche: ${error}`,
    };
  }
}

/**
 * Kombinierte Suche: Pfad + semantisch
 * Erst nach Pfad filtern, dann semantisch ranken
 */
export async function searchCodeWithPath(
  query: string,
  project: string,
  options: {
    pathPattern?: string;
    fileType?: string;
    limit?: number;
  } = {}
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
  const { pathPattern, fileType, limit = 10 } = options;

  try {
    // Wenn kein Pfad-Pattern, normale semantische Suche
    if (!pathPattern) {
      const results = await searchCode(query, project, fileType, limit);
      return {
        success: true,
        results: results.map((r) => ({
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
    }

    // Mit Pfad-Pattern: Erst semantische Suche, dann filtern
    // Mehr Ergebnisse holen damit nach Filter noch genug übrig
    const results = await searchCode(query, project, fileType, limit * 5);

    const filtered = results.filter((r) => {
      const normalizedPath = r.payload.file_path.replace(/\\/g, '/');
      return minimatch(normalizedPath, pathPattern, { matchBase: true });
    });

    return {
      success: true,
      results: filtered.slice(0, limit).map((r) => ({
        filePath: r.payload.file_path,
        fileName: r.payload.file_name,
        fileType: r.payload.file_type,
        lineStart: r.payload.line_start,
        lineEnd: r.payload.line_end,
        score: r.score,
        content: r.payload.content,
      })),
      message: `${filtered.length} Ergebnisse für Pattern "${pathPattern}"`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei kombinierter Suche: ${error}`,
    };
  }
}

/**
 * Semantische Dokument-Suche (PDF, Word, Excel)
 */
export async function searchDocumentsWrapper(
  query: string,
  project: string,
  documentType?: 'pdf' | 'docx' | 'xlsx' | 'all',
  limit: number = 10
): Promise<{
  success: boolean;
  results: Array<{
    filePath: string;
    fileName: string;
    documentType: string;
    content: string;
    score: number;
    chunkIndex: number;
  }>;
  message: string;
}> {
  try {
    const results = await searchDocuments(query, project, {
      documentType: documentType || 'all',
      limit,
    });

    return {
      success: true,
      results: results.map(r => ({
        filePath: r.filePath,
        fileName: r.fileName,
        documentType: r.documentType,
        content: r.content,
        score: r.score,
        chunkIndex: r.chunkIndex,
      })),
      message: `${results.length} Dokument-Ergebnisse gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei Dokument-Suche: ${error}`,
    };
  }
}
