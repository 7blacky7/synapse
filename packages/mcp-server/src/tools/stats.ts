/**
 * MODUL: Statistik-Tools
 * ZWECK: Index-Statistiken und detaillierte Aufschluesselung aller Qdrant-Collections eines Projekts.
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *
 * OUTPUT:
 *   - getIndexStats: IndexStats mit totalVectors, aufgeteilt nach code/media/thoughts/memories
 *   - getDetailedStats: Detailansicht mit byFileType, bySource, byCategory
 *   - message: string - Zusammenfassung
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Liest aus project_<name>_code, project_<name>_media, project_<name>_thoughts, project_<name>_memories
 *   - Kein Schreiben, reine Leseoperation
 */

import { getProjectStats, COLLECTIONS } from '@synapse/core';

interface IndexStats {
  project: string;
  totalFiles: number;
  totalVectors: number;
  collections: {
    code: { vectors: number };
    media: { vectors: number; images: number; videos: number };
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
      const thoughtsStats = await getCollectionStats(COLLECTIONS.projectThoughts(project));
      thoughtsCount = thoughtsStats?.pointsCount ?? 0;
    } catch {
      // Collection existiert möglicherweise nicht
    }

    try {
      const memoriesStats = await getCollectionStats(COLLECTIONS.projectMemories(project));
      memoriesCount = memoriesStats?.pointsCount ?? 0;
    } catch {
      // Collection existiert möglicherweise nicht
    }

    // Media-Collection Stats
    let mediaCount = 0;
    let mediaImages = 0;
    let mediaVideos = 0;
    try {
      const mediaStats = await getCollectionStats(COLLECTIONS.projectMedia(project));
      mediaCount = mediaStats?.pointsCount ?? 0;
      if (mediaCount > 0) {
        const { scrollVectors } = await import('@synapse/core');
        const mediaPoints = await scrollVectors<{ media_category: string }>(
          COLLECTIONS.projectMedia(project), {}, 10000
        );
        for (const p of mediaPoints) {
          if (p.payload?.media_category === 'image') mediaImages++;
          else if (p.payload?.media_category === 'video') mediaVideos++;
        }
      }
    } catch {
      // Collection existiert möglicherweise nicht
    }

    const stats: IndexStats = {
      project,
      totalFiles: codeStats?.fileCount ?? 0,
      totalVectors: (codeStats?.chunkCount ?? 0) + mediaCount + thoughtsCount + memoriesCount,
      collections: {
        code: { vectors: codeStats?.chunkCount ?? 0 },
        media: { vectors: mediaCount, images: mediaImages, videos: mediaVideos },
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
    const collectionName = COLLECTIONS.projectCode(project);
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
      const thoughtPoints = await scrollVectors<{ source: string }>(
        COLLECTIONS.projectThoughts(project),
        {},
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
      const memoryPoints = await scrollVectors<{ category: string }>(
        COLLECTIONS.projectMemories(project),
        {},
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
