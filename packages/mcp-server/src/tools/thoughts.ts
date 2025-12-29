/**
 * Synapse MCP - Thoughts Tools
 * Gedankenaustausch zwischen KIs
 */

import {
  addThought as addThoughtCore,
  getThoughts as getThoughtsCore,
  searchThoughts as searchThoughtsCore,
} from '@synapse/core';
import type { Thought, ThoughtSource } from '@synapse/core';

/**
 * Fuegt einen Gedanken hinzu
 */
export async function addThought(
  project: string,
  source: ThoughtSource,
  content: string,
  tags: string[] = []
): Promise<{
  success: boolean;
  thought: Thought | null;
  message: string;
}> {
  try {
    const thought = await addThoughtCore(project, source, content, tags);

    return {
      success: true,
      thought,
      message: `Gedanke gespeichert von "${source}"`,
    };
  } catch (error) {
    return {
      success: false,
      thought: null,
      message: `Fehler beim Speichern des Gedankens: ${error}`,
    };
  }
}

/**
 * Ruft Gedanken fuer ein Projekt ab
 */
export async function getThoughts(
  project: string,
  limit: number = 50
): Promise<{
  success: boolean;
  thoughts: Thought[];
  message: string;
}> {
  try {
    const thoughts = await getThoughtsCore(project, limit);

    return {
      success: true,
      thoughts,
      message: `${thoughts.length} Gedanken geladen`,
    };
  } catch (error) {
    return {
      success: false,
      thoughts: [],
      message: `Fehler beim Laden der Gedanken: ${error}`,
    };
  }
}

/**
 * Sucht semantisch in Gedanken
 */
export async function searchThoughts(
  query: string,
  project?: string,
  limit: number = 10
): Promise<{
  success: boolean;
  results: Array<{
    id: string;
    project: string;
    source: string;
    content: string;
    tags: string[];
    timestamp: string;
    score: number;
  }>;
  message: string;
}> {
  try {
    const results = await searchThoughtsCore(query, project, limit);

    return {
      success: true,
      results: results.map(r => ({
        id: r.id,
        project: r.payload.project,
        source: r.payload.source,
        content: r.payload.content,
        tags: r.payload.tags,
        timestamp: r.payload.timestamp,
        score: r.score,
      })),
      message: `${results.length} Gedanken gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei Gedanken-Suche: ${error}`,
    };
  }
}
