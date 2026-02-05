/**
 * Synapse MCP - Memory Tools
 * Persistente Speicherung von Dokumentation und Notizen
 */

import {
  writeMemory as writeMemoryCore,
  getMemoryByName,
  listMemories as listMemoriesCore,
  searchMemories as searchMemoriesCore,
  deleteMemory as deleteMemoryCore,
  readMemoryWithRelatedCode,
  findMemoriesForPath,
  Memory,
  MemoryWithRelatedCode,
  RelatedMemoryResult,
} from '@synapse/core';

export type MemoryCategory = Memory['category'];  // 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other'

/**
 * Speichert ein Memory (überschreibt bei gleichem Namen)
 */
export async function writeMemory(
  project: string,
  name: string,
  content: string,
  category: MemoryCategory = 'note',
  tags: string[] = []
): Promise<string> {
  try {
    const existing = await getMemoryByName(project, name);
    const isUpdate = !!existing;
    await writeMemoryCore(project, name, content, category, tags);

    return isUpdate
      ? `✅ Memory "${name}" aktualisiert | ${content.length} Zeichen | ${category}`
      : `✅ Memory "${name}" erstellt | ${content.length} Zeichen | ${category}`;
  } catch (error) {
    return `❌ Fehler: ${error}`;
  }
}

/**
 * Liest ein Memory nach Name
 */
export async function readMemory(
  project: string,
  name: string
): Promise<{
  success: boolean;
  memory: Memory | null;
  message: string;
}> {
  try {
    const memory = await getMemoryByName(project, name);

    if (!memory) {
      return {
        success: false,
        memory: null,
        message: `Memory "${name}" nicht gefunden in Projekt "${project}"`,
      };
    }

    return {
      success: true,
      memory,
      message: `Memory "${name}" geladen (${memory.content.length} Zeichen)`,
    };
  } catch (error) {
    return {
      success: false,
      memory: null,
      message: `Fehler beim Lesen: ${error}`,
    };
  }
}

/**
 * Listet alle Memories eines Projekts
 */
export async function listMemories(
  project: string,
  category?: MemoryCategory
): Promise<{
  success: boolean;
  memories: Array<{
    name: string;
    category: string;
    tags: string[];
    sizeChars: number;
    updatedAt: string;
  }>;
  message: string;
}> {
  try {
    const memories = await listMemoriesCore(project, category);

    return {
      success: true,
      memories: memories.map((m) => ({
        name: m.name,
        category: m.category,
        tags: m.tags,
        sizeChars: m.content.length,
        updatedAt: m.updatedAt,
      })),
      message: `${memories.length} Memories gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      memories: [],
      message: `Fehler beim Auflisten: ${error}`,
    };
  }
}

/**
 * Durchsucht Memories semantisch
 */
export async function searchMemory(
  query: string,
  project?: string,
  limit: number = 10
): Promise<{
  success: boolean;
  results: Array<{
    name: string;
    category: string;
    score: number;
    preview: string;
  }>;
  message: string;
}> {
  try {
    const results = await searchMemoriesCore(query, project, limit);

    return {
      success: true,
      results: results.map((r) => ({
        name: r.payload.name,
        category: r.payload.category,
        score: r.score,
        preview: r.payload.content.substring(0, 200) + (r.payload.content.length > 200 ? '...' : ''),
      })),
      message: `${results.length} Ergebnisse gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei Suche: ${error}`,
    };
  }
}

/**
 * Löscht ein Memory
 */
export async function deleteMemory(
  project: string,
  name: string
): Promise<string> {
  try {
    const deleted = await deleteMemoryCore(project, name);
    return deleted
      ? `✅ Memory "${name}" gelöscht`
      : `⚠️ Memory "${name}" nicht gefunden`;
  } catch (error) {
    return `❌ Fehler: ${error}`;
  }
}

/**
 * Liest ein Memory mit verwandtem Code
 */
export async function readMemoryWithCode(
  project: string,
  name: string,
  options: { codeLimit?: number; includeSemanticMatches?: boolean } = {}
): Promise<{
  success: boolean;
  data: MemoryWithRelatedCode | null;
  message: string;
}> {
  try {
    const result = await readMemoryWithRelatedCode(project, name, options);
    if (!result) {
      return { success: false, data: null, message: `Memory "${name}" nicht gefunden` };
    }
    const pathMatches = result.relatedCode.filter(c => c.matchType === 'exact').length;
    const semanticMatches = result.relatedCode.filter(c => c.matchType === 'semantic').length;
    return {
      success: true,
      data: result,
      message: `Memory "${name}" mit ${pathMatches} Pfad- und ${semanticMatches} semantischen Matches`,
    };
  } catch (error) {
    return { success: false, data: null, message: `Fehler: ${error}` };
  }
}

/**
 * Findet Memories für eine Datei
 */
export async function findMemoriesForFile(
  project: string,
  filePath: string,
  limit: number = 10
): Promise<{
  success: boolean;
  results: RelatedMemoryResult[];
  message: string;
}> {
  try {
    const results = await findMemoriesForPath(project, filePath, limit);
    return {
      success: true,
      results,
      message: `${results.length} Memories gefunden für "${filePath}"`,
    };
  } catch (error) {
    return { success: false, results: [], message: `Fehler: ${error}` };
  }
}
