/**
 * MODUL: Init-Tool
 * ZWECK: Projekt initialisieren, FileWatcher starten und Agenten-Onboarding ausloesen.
 *        Erkennt Technologien, laedt Framework-Docs vor und triggert Setup-Wizard bei Ersteinrichtung.
 *
 * INPUT:
 *   - projectPath: string - Absoluter Pfad zum Projekt-Verzeichnis
 *   - projectName?: string - Optionaler Projekt-Name (default: Verzeichnisname)
 *   - indexDocs?: boolean - Framework-Docs vorladen (default: true)
 *   - agentId?: string - Agent-ID fuer Onboarding (neue Agenten sehen Projekt-Regeln)
 *
 * OUTPUT:
 *   - initProjekt: InitResult mit project, path, technologies, docsIndexed, isFirstVisit, rules, setupRequired
 *   - stopProjekt: boolean - ob Watcher erfolgreich gestoppt
 *   - listActiveProjects: string[] - Namen aktiver Projekte
 *   - cleanupProjekt: deleted/checked/deletedFiles/keptFiles/details
 *   - getProjectStatusWithStats: status + Vektor-Statistiken
 *   (dropNamelist entfernt — Onboarding jetzt via PG server_instance_id)
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Erstellt project_<name>_code Collection, liest/schreibt project_plans
 *   - Dateisystem: Schreibt .synapse/status.json, startet chokidar FileWatcher
 *   - Registry: Aktualisiert ~/.synapse/project-registry.json via onboarding.ts
 *   - Setup-Wizard: Wird getriggert wenn keine Regeln-Memories vorhanden sind
 */

import * as path from 'path';
import * as fs from 'fs';
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
  registerAgent,
  getRulesForNewAgent,
  registerProject,
} from '@synapse/core';
import type { FileWatcherInstance, DetectedTechnology, Memory } from '@synapse/core';
import { SERVER_INSTANCE_ID } from '../server.js';
import type { SetupQuestion } from './setup.js';

/** Aktive FileWatcher pro Projekt */
const activeWatchers = new Map<string, FileWatcherInstance>();

/** Speichert Projekt-Pfade fuer Shutdown und Onboarding (name -> path) */
import { cacheProjectPath as cachePathInOnboarding } from './onboarding.js';
import { heartbeatController } from '@synapse/agents';
const projectPaths = new Map<string, string>();

/** Wrapper der beide Caches synchron haelt */
function cacheProjectPathBoth(name: string, path: string): void {
  projectPaths.set(name, path);
  cachePathInOnboarding(name, path);
}

/** Regel-Memory fuer Onboarding-Response */
interface RuleMemory {
  name: string;
  content: string;
}

/** Return-Typ fuer initProjekt */
type InitResult = {
  success: boolean;
  project: string;
  path: string;
  message: string;
  technologies?: DetectedTechnology[];
  docsIndexed?: { total: number; indexed: number; cached: number };
  isFirstVisit?: boolean;
  rules?: RuleMemory[];
  setupRequired?: {
    phase: string;
    questions: SetupQuestion[];
    detectedContext: { technologies: DetectedTechnology[]; readmeExcerpt: string | null };
    instructions: string;
  };
};

/**
 * Prueft ob Projekt reaktiviert werden kann (bereits indexiert)
 * Startet ggf. nur den FileWatcher neu
 * @param agentId - Optionale Agent-ID fuer Onboarding
 */
async function tryReactivateProject(
  projectPath: string,
  name: string,
  agentId?: string
): Promise<InitResult | null> {
  // Persistenten Status pruefen (activeWatchers-Check passiert bereits in initProjekt)
  const status = getProjectStatus(projectPath);
  if (!status || status.status !== 'active') {
    return null; // Keine Reaktivierung moeglich
  }

  // Pruefen ob Collection bereits Daten hat
  const collectionName = `project_${name}_code`;
  const vectors = await scrollVectors(collectionName, {}, 1);
  if (vectors.length === 0) {
    return null; // Collection leer, neu initialisieren
  }

  // FileWatcher starten (Projekt war bereits indexiert)
  const watcher = startFileWatcher({
    projectPath,
    projectName: name,
    onFileChange: (event) => handleFileEvent(event, projectPath),
    onError: (error) => console.error(`[Synapse MCP] FileWatcher Fehler:`, error),
    onIgnoreChange: async () => {
      const result = await cleanupProjekt(projectPath, name);
      console.error(`[Synapse MCP] Cleanup: ${result.deleted} geloescht`);
    },
  });
  activeWatchers.set(name, watcher);
  cacheProjectPathBoth(name, projectPath);
  await registerProject(name, projectPath);
  updateLastAccess(projectPath);

  // Reconnect zu laufenden Spezialisten (Wrapper-Prozesse ueberleben Session-Wechsel)
  try {
    const reconnected = await heartbeatController.reconnectAll(projectPath);
    if (reconnected.connected.length > 0) {
      console.error(`[Synapse] Reconnected to ${reconnected.connected.length} running specialists for "${name}"`);
    }
    if (reconnected.cleaned.length > 0) {
      console.error(`[Synapse] Cleaned up ${reconnected.cleaned.length} stale specialist entries for "${name}"`);
    }
  } catch (err) {
    console.error(`[Synapse] Specialist reconnect failed for "${name}":`, err);
  }

  // Agent-Onboarding bei Reaktivierung
  let isFirstVisit = false;
  let rules: RuleMemory[] | undefined;

  if (agentId) {
    isFirstVisit = await registerAgent(name, agentId, SERVER_INSTANCE_ID);
    if (isFirstVisit) {
      try {
        const ruleMemories = await getRulesForNewAgent(name);
        if (ruleMemories.length > 0) {
          rules = ruleMemories.map(m => ({ name: m.name, content: m.content }));
        }
      } catch { /* ignore */ }
    }
  }

  const rulesHint = rules && rules.length > 0
    ? `\n\n📋 PROJEKT-REGELN (bitte beachten!):\n${rules.map(r => `- ${r.name}`).join('\n')}`
    : '';

  return {
    success: true,
    project: name,
    path: projectPath,
    message: `Projekt "${name}" reaktiviert (bereits indexiert)${rulesHint}`,
    isFirstVisit,
    rules,
  };
}

/**
 * Initialisiert ein Projekt
 * @param projectPath - Absoluter Pfad zum Projekt
 * @param projectName - Optionaler Projekt-Name
 * @param indexDocs - Framework-Docs vorladen (default: true)
 * @param agentId - Optionale Agent-ID fuer Onboarding (neue Agenten sehen Regeln)
 */
export async function initProjekt(
  projectPath: string,
  projectName?: string,
  indexDocs: boolean = true,
  agentId?: string
): Promise<InitResult> {
  // Projekt-Name aus Pfad ableiten wenn nicht angegeben
  const name = projectName || path.basename(projectPath);

  // Fast-Path: FileWatcher laeuft bereits → initSynapse komplett ueberspringen
  if (activeWatchers.has(name)) {
    updateLastAccess(projectPath);

    let isFirstVisit = false;
    let rules: RuleMemory[] | undefined;

    if (agentId) {
      isFirstVisit = await registerAgent(name, agentId, SERVER_INSTANCE_ID);
      if (isFirstVisit) {
        try {
          const ruleMemories = await getRulesForNewAgent(name);
          if (ruleMemories.length > 0) {
            rules = ruleMemories.map(m => ({ name: m.name, content: m.content }));
          }
        } catch { /* ignore */ }
      }
    }

    const rulesHint = rules && rules.length > 0
      ? `\n\n📋 PROJEKT-REGELN (bitte beachten!):\n${rules.map(r => `- ${r.name}`).join('\n')}`
      : '';

    return {
      success: true,
      project: name,
      path: projectPath,
      message: `Projekt "${name}" ist bereits aktiv${rulesHint}`,
      isFirstVisit,
      rules,
    };
  }

  // Projekt-Pfad FRUEH registrieren (vor initSynapse, damit backfillCodeFiles den Root kennt)
  await registerProject(name, projectPath);

  // Cold-Start: Synapse initialisieren (Qdrant, Embeddings) – mit Projektname fuer gezielte Migration
  const initialized = await initSynapse(name);

  if (!initialized) {
    return {
      success: false,
      project: '',
      path: projectPath,
      message: 'Synapse konnte nicht initialisiert werden (Qdrant/Embeddings pruefen)',
    };
  }

  // Persistenten Status pruefen (Watcher war nicht aktiv, aber Projekt war vorher initialisiert)
  const reactivated = await tryReactivateProject(projectPath, name, agentId);
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
  console.error(`[Synapse MCP] Erkenne Technologien in ${name}...`);
  const technologies = await detectTechnologies(projectPath);

  console.error(`[Synapse MCP] ${technologies.length} Technologien erkannt:`);
  for (const tech of technologies) {
    console.error(`  - ${tech.name}${tech.version ? ` v${tech.version}` : ''} (${tech.type})`);
  }

  // ===== DOKUMENTATION VORLADEN =====
  let docsIndexed: { total: number; indexed: number; cached: number } | undefined;

  if (indexDocs && technologies.length > 0) {
    console.error(`[Synapse MCP] Indexiere Framework-Dokumentation...`);
    docsIndexed = await indexProjectTechnologies(technologies);
    console.error(`[Synapse MCP] Docs: ${docsIndexed.indexed} neu, ${docsIndexed.cached} gecacht`);
  }

  // FileWatcher starten mit automatischem Cleanup bei .synapseignore Aenderungen
  const watcher = startFileWatcher({
    projectPath,
    projectName: name,
    onFileChange: (event) => handleFileEvent(event, projectPath),
    onError: (error) => {
      console.error(`[Synapse MCP] FileWatcher Fehler:`, error);
    },
    onIgnoreChange: async () => {
      console.error(`[Synapse MCP] .synapseignore geaendert - starte automatisches Cleanup...`);
      const result = await cleanupProjekt(projectPath, name);
      console.error(`[Synapse MCP] Cleanup: ${result.deleted} Dateien geloescht, ${result.checked} geprueft`);
    },
  });

  activeWatchers.set(name, watcher);
  cacheProjectPathBoth(name, projectPath);

  // Projekt-Pfad in DB registrieren (Multi-Machine Support)
  await registerProject(name, projectPath);

  // Persistenten Status speichern
  setProjectStatus(projectPath, { status: 'active', project: name });

  // Reconnect zu laufenden Spezialisten (Wrapper-Prozesse ueberleben Session-Wechsel)
  try {
    const reconnected = await heartbeatController.reconnectAll(projectPath);
    if (reconnected.connected.length > 0) {
      console.error(`[Synapse] Reconnected to ${reconnected.connected.length} running specialists for "${name}"`);
    }
    if (reconnected.cleaned.length > 0) {
      console.error(`[Synapse] Cleaned up ${reconnected.cleaned.length} stale specialist entries for "${name}"`);
    }
  } catch (err) {
    console.error(`[Synapse] Specialist reconnect failed for "${name}":`, err);
  }

  // ===== SETUP-WIZARD PRUEFEN =====
  let setupRequired: InitResult['setupRequired'] | undefined;

  try {
    const { listMemories: listMems } = await import('@synapse/core');
    let existingRules: unknown[] = [];
    try {
      existingRules = await listMems(name, 'rules');
    } catch {
      // Collection existiert noch nicht — keine rules vorhanden
    }
    if (existingRules.length === 0) {
      const { buildSetupWizard, readReadmeExcerpt } = await import('./setup.js');
      const readmeExcerpt = readReadmeExcerpt(projectPath);
      setProjectStatus(projectPath, { setupPhase: 'initial-pending' });
      const wizard = buildSetupWizard('initial', technologies, readmeExcerpt);
      setupRequired = {
        phase: wizard.phase,
        questions: wizard.questions,
        detectedContext: wizard.detectedContext,
        instructions: wizard.instructions,
      };
      console.error(`[Synapse MCP] Setup-Wizard: ${wizard.questions.length} Fragen fuer Phase "initial"`);
    }
  } catch (error) {
    console.error(`[Synapse MCP] Setup-Wizard Fehler:`, error);
  }

  // ===== AGENT ONBOARDING =====
  let isFirstVisit = false;
  let rules: RuleMemory[] | undefined;

  if (agentId) {
    // Pruefen ob Agent neu ist und registrieren
    isFirstVisit = await registerAgent(name, agentId, SERVER_INSTANCE_ID);

    if (isFirstVisit) {
      // Regeln-Memories fuer neuen Agent laden
      console.error(`[Synapse MCP] Neuer Agent "${agentId}" - lade Regeln...`);
      try {
        const ruleMemories = await getRulesForNewAgent(name);
        if (ruleMemories.length > 0) {
          rules = ruleMemories.map(m => ({
            name: m.name,
            content: m.content,
          }));
          console.error(`[Synapse MCP] ${rules.length} Regeln fuer Agent geladen`);
        }
      } catch (error) {
        console.error(`[Synapse MCP] Fehler beim Laden der Regeln:`, error);
      }
    }
  }

  // Hinweis fuer KI generieren
  const techList = technologies.map(t => t.name).join(', ');
  const instruction = technologies.length > 0
    ? `\n\nERKANNTE TECHNOLOGIEN: ${techList}\n` +
      `Nutze "search_docs" um Framework-Dokumentation zu durchsuchen. ` +
      `Bei fehlenden Infos wird automatisch Context7 abgefragt und gecacht.`
    : '';

  // Regeln-Hinweis hinzufuegen wenn vorhanden
  const rulesHint = rules && rules.length > 0
    ? `\n\n📋 PROJEKT-REGELN (bitte beachten!):\n${rules.map(r => `- ${r.name}`).join('\n')}`
    : '';

  return {
    success: true,
    project: name,
    path: projectPath,
    message: `Projekt "${name}" initialisiert. FileWatcher aktiv.${instruction}${rulesHint}`,
    technologies,
    docsIndexed,
    isFirstVisit,
    rules,
    setupRequired,
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
  console.error(`[Synapse MCP] Cleanup für "${projectName}"...`);

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
        // Relativen Pfad berechnen (file_path kann absolut oder relativ sein)
        const relativePath = filePath.startsWith('/')
          ? path.relative(projectPath, filePath)
          : filePath;
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

          console.error(`[Synapse MCP] Lösche ignorierte Datei: ${relativePath}`);
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
      const thoughtsStats = await getCollectionStats('project_thoughts');
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

