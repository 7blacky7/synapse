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
  getProjectStatus,
  setProjectStatus,
  updateLastAccess,
} from '@synapse/core';
import type { FileWatcherInstance, DetectedTechnology } from '@synapse/core';

/** Aktive FileWatcher pro Projekt */
const activeWatchers = new Map<string, FileWatcherInstance>();

/** Speichert Projekt-Pfade fuer Shutdown (name -> path) */
const projectPaths = new Map<string, string>();

/** Return-Typ fuer initProjekt */
type InitResult = {
  success: boolean;
  project: string;
  path: string;
  message: string;
  technologies?: DetectedTechnology[];
  docsIndexed?: { total: number; indexed: number; cached: number };
};

/**
 * Prueft ob Projekt reaktiviert werden kann (bereits indexiert)
 * Startet ggf. nur den FileWatcher neu
 */
async function tryReactivateProject(
  projectPath: string,
  name: string
): Promise<InitResult | null> {
  // Watcher bereits aktiv? Nur Status aktualisieren
  if (activeWatchers.has(name)) {
    updateLastAccess(projectPath);
    return {
      success: true,
      project: name,
      path: projectPath,
      message: `Projekt "${name}" ist bereits aktiv`,
    };
  }

  // Persistenten Status pruefen
  const status = getProjectStatus(projectPath);
  if (!status || status.status !== 'active') {
    return null; // Keine Reaktivierung moeglich
  }

  // Pruefen ob Collection bereits Daten hat
  const collectionName = `project_${name}`;
  const vectors = await scrollVectors(collectionName, {}, 1);
  if (vectors.length === 0) {
    return null; // Collection leer, neu initialisieren
  }

  // FileWatcher starten (Projekt war bereits indexiert)
  const watcher = startFileWatcher({
    projectPath,
    projectName: name,
    onFileChange: handleFileEvent,
    onError: (error) => console.error(`[Synapse MCP] FileWatcher Fehler:`, error),
    onIgnoreChange: async () => {
      const result = await cleanupProjekt(projectPath, name);
      console.log(`[Synapse MCP] Cleanup: ${result.deleted} geloescht`);
    },
  });
  activeWatchers.set(name, watcher);
  projectPaths.set(name, projectPath);
  updateLastAccess(projectPath);

  return {
    success: true,
    project: name,
    path: projectPath,
    message: `Projekt "${name}" reaktiviert (bereits indexiert)`,
  };
}

/**
 * Initialisiert ein Projekt
 */
export async function initProjekt(
  projectPath: string,
  projectName?: string,
  indexDocs: boolean = true
): Promise<InitResult> {
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

  // Pruefen ob bereits aktiv (Memory oder persistenter Status)
  const reactivated = await tryReactivateProject(projectPath, name);
  if (reactivated) {
    return reactivated;
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
  projectPaths.set(name, projectPath);

  // Persistenten Status speichern
  setProjectStatus(projectPath, { status: 'active', project: name });

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
 * Stoppt einen FileWatcher und setzt Status auf 'stopped'
 * projectPath ist optional - wird aus Cache geholt wenn nicht angegeben
 */
export async function stopProjekt(
  projectName: string,
  projectPath?: string
): Promise<boolean> {
  const watcher = activeWatchers.get(projectName);

  if (!watcher) {
    return false;
  }

  await watcher.stop();
  activeWatchers.delete(projectName);

  // Pfad aus Cache oder Parameter
  const pathToUse = projectPath || projectPaths.get(projectName);
  if (pathToUse) {
    setProjectStatus(pathToUse, { status: 'stopped' });
    projectPaths.delete(projectName);
  }

  return true;
}

/**
 * Gibt den gespeicherten Pfad fuer ein Projekt zurueck
 */
export function getProjectPath(projectName: string): string | undefined {
  return projectPaths.get(projectName);
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
  deletedFiles: string[];
  keptFiles: number;
  message: string;
  details: {
    byPattern: Record<string, string[]>;
    uniqueFiles: number;
  };
}> {
  console.log(`[Synapse MCP] Cleanup für "${projectName}"...`);

  // .synapseignore und .gitignore neu laden
  const ig = loadGitignore(projectPath);

  // Alle Vektoren im Projekt durchgehen
  const collectionName = `project_${projectName}`;
  let deleted = 0;
  let checked = 0;
  const deletedFiles: string[] = [];
  const seenFiles = new Set<string>();
  const byPattern: Record<string, string[]> = {};

  try {
    // Alle Vektoren holen (mit leerem Filter)
    const results = await scrollVectors<{ file_path?: string }>(collectionName, {}, 10000);

    for (const point of results) {
      checked++;
      const filePath = point.payload?.file_path;

      if (filePath) {
        // Relativen Pfad berechnen
        const relativePath = path.relative(projectPath, filePath);
        seenFiles.add(relativePath);

        // Pruefen ob jetzt ignoriert werden soll
        if (shouldIgnore(ig, relativePath)) {
          // Finde welches Pattern matcht (für Feedback)
          const ext = path.extname(relativePath) || 'no-extension';
          const dir = path.dirname(relativePath).split(path.sep)[0] || 'root';
          const patternKey = relativePath.includes('node_modules')
            ? 'node_modules/'
            : ext;

          if (!byPattern[patternKey]) {
            byPattern[patternKey] = [];
          }
          byPattern[patternKey].push(relativePath);

          console.log(`[Synapse MCP] Lösche ignorierte Datei: ${relativePath}`);
          await deleteByFilePath(collectionName, filePath);
          deletedFiles.push(relativePath);
          deleted++;
        }
      }
    }

    const keptFiles = seenFiles.size - deletedFiles.length;

    return {
      success: true,
      deleted,
      checked,
      deletedFiles,
      keptFiles,
      message: deleted > 0
        ? `Cleanup: ${deleted} Dateien gelöscht, ${keptFiles} behalten (${checked} Chunks geprüft)`
        : `Cleanup: Keine Änderungen nötig (${seenFiles.size} Dateien, ${checked} Chunks geprüft)`,
      details: {
        byPattern,
        uniqueFiles: seenFiles.size,
      },
    };
  } catch (error) {
    return {
      success: false,
      deleted,
      checked,
      deletedFiles,
      keptFiles: 0,
      message: `Cleanup Fehler: ${error}`,
      details: {
        byPattern,
        uniqueFiles: 0,
      },
    };
  }
}

/**
 * Holt den persistenten Projekt-Status aus .synapse/status.json
 * Gibt zusaetzlich Vektor-Statistiken zurueck wenn verfuegbar
 */
export async function getProjectStatusWithStats(
  projectPath: string
): Promise<{
  success: boolean;
  status: ReturnType<typeof getProjectStatus> | null;
  stats?: {
    totalVectors: number;
    collections: {
      code: { vectors: number };
      thoughts: { vectors: number };
      memories: { vectors: number };
    };
  };
  message: string;
}> {
  const status = getProjectStatus(projectPath);

  if (!status) {
    return {
      success: false,
      status: null,
      message: 'Kein Status gefunden. Projekt nicht initialisiert.',
    };
  }

  // Vektor-Stats holen wenn Projekt bekannt
  try {
    const { getProjectStats, getCollectionStats } = await import('@synapse/core');

    const codeStats = await getProjectStats(status.project);
    let thoughtsCount = 0;
    let memoriesCount = 0;

    try {
      const thoughtsStats = await getCollectionStats('synapse_thoughts');
      thoughtsCount = thoughtsStats?.pointsCount ?? 0;
    } catch {
      // Collection existiert moeglicherweise nicht
    }

    try {
      const memoriesStats = await getCollectionStats('synapse_memories');
      memoriesCount = memoriesStats?.pointsCount ?? 0;
    } catch {
      // Collection existiert moeglicherweise nicht
    }

    return {
      success: true,
      status,
      stats: {
        totalVectors: (codeStats?.chunkCount ?? 0) + thoughtsCount + memoriesCount,
        collections: {
          code: { vectors: codeStats?.chunkCount ?? 0 },
          thoughts: { vectors: thoughtsCount },
          memories: { vectors: memoriesCount },
        },
      },
      message: `Status fuer "${status.project}" geladen`,
    };
  } catch {
    // Falls Stats nicht verfuegbar, trotzdem Status zurueckgeben
    return {
      success: true,
      status,
      message: `Status fuer "${status.project}" geladen (Stats nicht verfuegbar)`,
    };
  }
}
