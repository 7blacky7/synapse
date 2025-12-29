/**
 * Synapse MCP - Technology Detection Tools
 * Erkennt und verwaltet Projekt-Technologien
 */

import {
  detectTechnologies as coreDetectTechnologies,
  indexProjectTechnologies,
  isFrameworkCached,
  indexFrameworkDocs,
} from '@synapse/core';
import type { DetectedTechnology } from '@synapse/core';

/**
 * Erkennt verwendete Technologien in einem Projekt
 */
export async function detectProjectTechnologies(
  projectPath: string
): Promise<{
  success: boolean;
  technologies: DetectedTechnology[];
  summary: string;
}> {
  try {
    const technologies = await coreDetectTechnologies(projectPath);

    const summary = technologies.length > 0
      ? `${technologies.length} Technologien erkannt:\n` +
        technologies.map(t => `- ${t.name}${t.version ? ` v${t.version}` : ''} (${t.type})`).join('\n')
      : 'Keine Technologien erkannt';

    return {
      success: true,
      technologies,
      summary,
    };
  } catch (error) {
    return {
      success: false,
      technologies: [],
      summary: `Fehler: ${error}`,
    };
  }
}

/**
 * Indexiert Dokumentation für erkannte Technologien
 */
export async function indexTechDocs(
  projectPath: string,
  forceReindex: boolean = false
): Promise<{
  success: boolean;
  technologies: DetectedTechnology[];
  indexed: number;
  cached: number;
  message: string;
}> {
  try {
    // Erst Technologien erkennen
    const technologies = await coreDetectTechnologies(projectPath);

    if (technologies.length === 0) {
      return {
        success: true,
        technologies: [],
        indexed: 0,
        cached: 0,
        message: 'Keine Technologien erkannt - nichts zu indexieren',
      };
    }

    // Dokumentation indexieren
    const result = await indexProjectTechnologies(technologies, forceReindex);

    return {
      success: true,
      technologies,
      indexed: result.indexed,
      cached: result.cached,
      message: `${result.indexed} Docs indexiert, ${result.cached} bereits gecacht`,
    };
  } catch (error) {
    return {
      success: false,
      technologies: [],
      indexed: 0,
      cached: 0,
      message: `Fehler: ${error}`,
    };
  }
}

/**
 * Prüft ob Docs für ein Framework gecacht sind
 */
export async function checkDocsCache(
  framework: string,
  version?: string
): Promise<{
  framework: string;
  version?: string;
  cached: boolean;
}> {
  const cached = await isFrameworkCached(framework, version);

  return {
    framework,
    version,
    cached,
  };
}

/**
 * Indexiert Docs für ein spezifisches Framework
 */
export async function indexSingleFramework(
  framework: string,
  version?: string,
  forceReindex: boolean = false
): Promise<{
  success: boolean;
  framework: string;
  indexed: number;
  cached: boolean;
  message: string;
}> {
  try {
    const result = await indexFrameworkDocs(framework, version, forceReindex);

    return {
      success: true,
      framework,
      indexed: result.indexed,
      cached: result.cached,
      message: result.cached
        ? `${framework} bereits gecacht`
        : `${result.indexed} Docs für ${framework} indexiert`,
    };
  } catch (error) {
    return {
      success: false,
      framework,
      indexed: 0,
      cached: false,
      message: `Fehler: ${error}`,
    };
  }
}
