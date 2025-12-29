/**
 * Synapse MCP - Statistics Tools
 * Index-Statistiken und Projekt-Übersicht
 */

import { getProjectStats } from '@synapse/core';

interface IndexStats {
  project: string;
  totalFiles: number;
  totalVectors: number;
  collections: {
    code: { vectors: number };
    thoughts: { vectors: number };
    memories: { vectors: number };
  };
}

/**
 * Holt Index-Statistiken für ein Projekt
 */
export async function getIndexStats(
  project: string
): Promise<{
  success: boolean;
  stats: IndexStats | null;
  message: string;
}> {
  try {
    // Code-Stats holen
    const codeStats = await getProjectStats(project);

    // Thoughts-Collection Stats
    const { getCollectionStats } = await import('@synapse/core');
    let thoughtsCount = 0;
    let memoriesCount = 0;

    try {
      const thoughtsStats = await getCollectionStats('synapse_thoughts');
      thoughtsCount = thoughtsStats?.pointsCount ?? 0;
    } catch {
      // Collection existiert möglicherweise nicht
    }

    try {
      const memoriesStats = await getCollectionStats('synapse_memories');
      memoriesCount = memoriesStats?.pointsCount ?? 0;
    } catch {
      // Collection existiert möglicherweise nicht
    }

    const stats: IndexStats = {
      project,
      totalFiles: codeStats?.fileCount ?? 0,
      totalVectors: (codeStats?.chunkCount ?? 0) + thoughtsCount + memoriesCount,
      collections: {
        code: { vectors: codeStats?.chunkCount ?? 0 },
        thoughts: { vectors: thoughtsCount },
        memories: { vectors: memoriesCount },
      },
    };

    return {
      success: true,
      stats,
      message: `Statistiken für "${project}": ${stats.totalVectors} Vektoren`,
    };
  } catch (error) {
    return {
      success: false,
      stats: null,
      message: `Fehler beim Abrufen der Statistiken: ${error}`,
    };
  }
}

/**
 * Detaillierte Statistiken mit Dateigrößen
 */
export async function getDetailedStats(
  project: string
): Promise<{
  success: boolean;
  stats: {
    project: string;
    code: {
      totalChunks: number;
      byFileType: Record<string, number>;
    };
    thoughts: {
      total: number;
      bySource: Record<string, number>;
    };
    memories: {
      total: number;
      byCategory: Record<string, number>;
    };
  } | null;
  message: string;
}> {
  try {
    const { scrollVectors } = await import('@synapse/core');

    // Code-Chunks nach Dateityp gruppieren
    const collectionName = `project_${project}`;
    let codeByType: Record<string, number> = {};
    let totalChunks = 0;

    try {
      const codePoints = await scrollVectors<{ file_type: string }>(
        collectionName,
        {},
        10000
      );
      totalChunks = codePoints.length;
      codeByType = codePoints.reduce(
        (acc, p) => {
          const type = p.payload?.file_type || 'unknown';
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );
    } catch {
      // Collection existiert nicht
    }

    // Thoughts nach Source
    let thoughtsBySource: Record<string, number> = {};
    let totalThoughts = 0;

    try {
      const thoughtPoints = await scrollVectors<{ source: string; project: string }>(
        'synapse_thoughts',
        { must: [{ key: 'project', match: { value: project } }] },
        10000
      );
      totalThoughts = thoughtPoints.length;
      thoughtsBySource = thoughtPoints.reduce(
        (acc, p) => {
          const source = p.payload?.source || 'unknown';
          acc[source] = (acc[source] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );
    } catch {
      // Collection existiert nicht
    }

    // Memories nach Category
    let memoriesByCategory: Record<string, number> = {};
    let totalMemories = 0;

    try {
      const memoryPoints = await scrollVectors<{ category: string; project: string }>(
        'synapse_memories',
        { must: [{ key: 'project', match: { value: project } }] },
        10000
      );
      totalMemories = memoryPoints.length;
      memoriesByCategory = memoryPoints.reduce(
        (acc, p) => {
          const cat = p.payload?.category || 'unknown';
          acc[cat] = (acc[cat] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );
    } catch {
      // Collection existiert nicht
    }

    return {
      success: true,
      stats: {
        project,
        code: {
          totalChunks,
          byFileType: codeByType,
        },
        thoughts: {
          total: totalThoughts,
          bySource: thoughtsBySource,
        },
        memories: {
          total: totalMemories,
          byCategory: memoriesByCategory,
        },
      },
      message: 'Detaillierte Statistiken abgerufen',
    };
  } catch (error) {
    return {
      success: false,
      stats: null,
      message: `Fehler: ${error}`,
    };
  }
}
