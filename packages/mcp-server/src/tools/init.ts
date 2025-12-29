/**
 * Synapse MCP - Init Tool
 * Projekt initialisieren und FileWatcher starten
 */

import * as path from 'path';
import {
  initSynapse,
  startFileWatcher,
  handleFileEvent,
  ensureProjectCollection,
  createPlan,
  getPlan,
  detectTechnologies,
  indexProjectTechnologies,
  scrollVectors,
  deleteByFilePath,
  loadGitignore,
  shouldIgnore,
} from '@synapse/core';
import type { FileWatcherInstance, DetectedTechnology } from '@synapse/core';

/** Aktive FileWatcher pro Projekt */
const activeWatchers = new Map<string, FileWatcherInstance>();

/**
 * Initialisiert ein Projekt
 */
export async function initProjekt(
  projectPath: string,
  projectName?: string,
  indexDocs: boolean = true
): Promise<{
  success: boolean;
  project: string;
  path: string;
  message: string;
  technologies?: DetectedTechnology[];
  docsIndexed?: { total: number; indexed: number; cached: number };
}> {
  // Synapse initialisieren (Qdrant, Embeddings)
  const initialized = await initSynapse();

  if (!initialized) {
    return {
      success: false,
      project: '',
      path: projectPath,
      message: 'Synapse konnte nicht initialisiert werden (Qdrant/Embeddings pruefen)',
    };
  }

  // Projekt-Name aus Pfad ableiten wenn nicht angegeben
  const name = projectName || path.basename(projectPath);

  // Pruefen ob Watcher schon laeuft
  if (activeWatchers.has(name)) {
    return {
      success: true,
      project: name,
      path: projectPath,
      message: `Projekt "${name}" ist bereits aktiv`,
    };
  }

  // Collection erstellen
  await ensureProjectCollection(name);

  // Plan erstellen wenn nicht vorhanden
  const existingPlan = await getPlan(name);
  if (!existingPlan) {
    await createPlan(
      name,
      name,
      `Projekt-Plan fuer ${name}`,
      []
    );
  }

  // ===== TECHNOLOGIE-ERKENNUNG =====
  console.log(`[Synapse MCP] Erkenne Technologien in ${name}...`);
  const technologies = await detectTechnologies(projectPath);

  console.log(`[Synapse MCP] ${technologies.length} Technologien erkannt:`);
  for (const tech of technologies) {
    console.log(`  - ${tech.name}${tech.version ? ` v${tech.version}` : ''} (${tech.type})`);
  }

  // ===== DOKUMENTATION VORLADEN =====
  let docsIndexed: { total: number; indexed: number; cached: number } | undefined;

  if (indexDocs && technologies.length > 0) {
    console.log(`[Synapse MCP] Indexiere Framework-Dokumentation...`);
    docsIndexed = await indexProjectTechnologies(technologies);
    console.log(`[Synapse MCP] Docs: ${docsIndexed.indexed} neu, ${docsIndexed.cached} gecacht`);
  }

  // FileWatcher starten mit automatischem Cleanup bei .synapseignore Aenderungen
  const watcher = startFileWatcher({
    projectPath,
    projectName: name,
    onFileChange: handleFileEvent,
    onError: (error) => {
      console.error(`[Synapse MCP] FileWatcher Fehler:`, error);
    },
    onIgnoreChange: async () => {
      console.log(`[Synapse MCP] .synapseignore geaendert - starte automatisches Cleanup...`);
      const result = await cleanupProjekt(projectPath, name);
      console.log(`[Synapse MCP] Cleanup: ${result.deleted} Dateien geloescht, ${result.checked} geprueft`);
    },
  });

  activeWatchers.set(name, watcher);

  // Hinweis fuer KI generieren
  const techList = technologies.map(t => t.name).join(', ');
  const instruction = technologies.length > 0
    ? `\n\nERKANNTE TECHNOLOGIEN: ${techList}\n` +
      `Nutze "search_docs" um Framework-Dokumentation zu durchsuchen. ` +
      `Bei fehlenden Infos wird automatisch Context7 abgefragt und gecacht.`
    : '';

  return {
    success: true,
    project: name,
    path: projectPath,
    message: `Projekt "${name}" initialisiert. FileWatcher aktiv.${instruction}`,
    technologies,
    docsIndexed,
  };
}

/**
 * Stoppt einen FileWatcher
 */
export async function stopProjekt(projectName: string): Promise<boolean> {
  const watcher = activeWatchers.get(projectName);

  if (!watcher) {
    return false;
  }

  await watcher.stop();
  activeWatchers.delete(projectName);
  return true;
}

/**
 * Listet aktive Projekte auf
 */
export function listActiveProjects(): string[] {
  return Array.from(activeWatchers.keys());
}

/**
 * Prueft ob ein Projekt aktiv ist
 */
export function isProjectActive(projectName: string): boolean {
  return activeWatchers.has(projectName);
}

/**
 * Bereinigt ein Projekt - entfernt Dateien die jetzt in .synapseignore stehen
 */
export async function cleanupProjekt(
  projectPath: string,
  projectName: string
): Promise<{
  success: boolean;
  deleted: number;
  checked: number;
  message: string;
}> {
  console.log(`[Synapse MCP] Cleanup für "${projectName}"...`);

  // .synapseignore und .gitignore neu laden
  const ig = loadGitignore(projectPath);

  // Alle Vektoren im Projekt durchgehen
  const collectionName = `project_${projectName}`;
  let deleted = 0;
  let checked = 0;

  try {
    // Alle Vektoren holen (mit leerem Filter)
    const results = await scrollVectors<{ file_path?: string }>(collectionName, {}, 10000);

    for (const point of results) {
      checked++;
      const filePath = point.payload?.file_path;

      if (filePath) {
        // Relativen Pfad berechnen
        const relativePath = path.relative(projectPath, filePath);

        // Pruefen ob jetzt ignoriert werden soll
        if (shouldIgnore(ig, relativePath)) {
          console.log(`[Synapse MCP] Lösche ignorierte Datei: ${relativePath}`);
          await deleteByFilePath(collectionName, filePath);
          deleted++;
        }
      }
    }

    return {
      success: true,
      deleted,
      checked,
      message: `Cleanup abgeschlossen: ${deleted} Dateien gelöscht, ${checked} geprüft`,
    };
  } catch (error) {
    return {
      success: false,
      deleted,
      checked,
      message: `Cleanup Fehler: ${error}`,
    };
  }
}
