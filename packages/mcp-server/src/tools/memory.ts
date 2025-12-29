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
  Memory,
} from '@synapse/core';

export type MemoryCategory = Memory['category'];

/**
 * Speichert ein Memory (überschreibt bei gleichem Namen)
 */
export async function writeMemory(
  project: string,
  name: string,
  content: string,
  category: MemoryCategory = 'note',
  tags: string[] = []
): Promise<{
  success: boolean;
  memory: Memory | null;
  isUpdate: boolean;
  message: string;
}> {
  try {
    // Prüfen ob Update
    const existing = await getMemoryByName(project, name);
    const isUpdate = !!existing;

    const memory = await writeMemoryCore(project, name, content, category, tags);

    return {
      success: true,
      memory,
      isUpdate,
      message: isUpdate
        ? `Memory "${name}" aktualisiert (${content.length} Zeichen)`
        : `Memory "${name}" erstellt (${content.length} Zeichen)`,
    };
  } catch (error) {
    return {
      success: false,
      memory: null,
      isUpdate: false,
      message: `Fehler beim Speichern: ${error}`,
    };
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
): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const deleted = await deleteMemoryCore(project, name);

    if (!deleted) {
      return {
        success: false,
        message: `Memory "${name}" nicht gefunden`,
      };
    }

    return {
      success: true,
      message: `Memory "${name}" gelöscht`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Fehler beim Löschen: ${error}`,
    };
  }
}
