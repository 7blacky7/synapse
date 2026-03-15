/**
 * MCP-Tools fuer Tech-Docs Integration + Wissens-Airbag
 */

import {
  addTechDoc as coreAddTechDoc,
  searchTechDocs as coreSearchTechDocs,
  getDocsForFile as coreGetDocsForFile,
} from '@synapse/core';
import type { TechDocType } from '@synapse/core';

/**
 * Indexiert ein Tech-Doc (Breaking Change, Migration, Gotcha etc.)
 */
export async function addTechDocTool(
  framework: string,
  version: string,
  section: string,
  content: string,
  type: TechDocType,
  category: string = 'framework',
  source: string = 'research',
  project?: string
): Promise<{ success: boolean; id: string; duplicate: boolean; message: string }> {
  return coreAddTechDoc(framework, version, section, content, type, category, source, project);
}

/**
 * Durchsucht Tech-Docs semantisch
 */
export async function searchTechDocsTool(
  query: string,
  options: {
    framework?: string;
    type?: string;
    source?: string;
    project?: string;
    limit?: number;
  } = {}
): Promise<{
  success: boolean;
  results: Array<{ framework: string; version: string; section: string; content: string; type: string; score: number }>;
  message: string;
}> {
  try {
    const results = await coreSearchTechDocs(query, options);
    return {
      success: true,
      results: results.map(r => ({
        framework: r.framework,
        version: r.version,
        section: r.section,
        content: r.content,
        type: r.type,
        score: r.score,
      })),
      message: `${results.length} Tech-Docs gefunden`,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' | ') : '';
    console.error(`[Synapse TechDocs] Suche fehlgeschlagen: ${errMsg}`);
    console.error(`[Synapse TechDocs] Stack: ${errStack}`);
    return { success: false, results: [], message: `Fehler: ${errMsg} | ${errStack}` };
  }
}

/**
 * Wissens-Airbag: Holt relevante Docs fuer eine Datei basierend auf Agent-Cutoff
 */
export async function getDocsForFileTool(
  filePath: string,
  agentId: string,
  project: string
): Promise<{
  success: boolean;
  warnings: Array<{ framework: string; version: string; docs: Array<{ section: string; type: string; content: string }> }>;
  agentCutoff: string | null;
  message: string;
}> {
  try {
    const result = await coreGetDocsForFile(filePath, agentId, project);

    if (result.warnings.length === 0) {
      return {
        success: true,
        warnings: [],
        agentCutoff: result.agentCutoff,
        message: 'Keine relevanten Docs-Warnungen fuer diese Datei',
      };
    }

    const totalDocs = result.warnings.reduce((sum, w) => sum + w.docs.length, 0);
    return {
      success: true,
      warnings: result.warnings,
      agentCutoff: result.agentCutoff,
      message: `⚠️ ${totalDocs} relevante Docs fuer ${result.warnings.map(w => w.framework).join(', ')} (neuer als Cutoff ${result.agentCutoff})`,
    };
  } catch (error) {
    return { success: false, warnings: [], agentCutoff: null, message: `Fehler: ${error}` };
  }
}
