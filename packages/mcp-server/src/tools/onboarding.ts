/**
 * Synapse MCP - Agent Onboarding
 * Zentraler Mechanismus fuer automatisches Agent-Tracking und Regeln-Anzeige
 *
 * Wenn ein Agent zum ersten Mal ein Tool mit project + agent_id aufruft,
 * werden automatisch die Projekt-Regeln (category: 'rules') angezeigt.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerAgent,
  getRulesForNewAgent,
  getProjectStatus,
} from '@synapse/core';

/** Regel-Memory fuer Onboarding-Response */
export interface OnboardingRule {
  name: string;
  content: string;
}

/** Onboarding-Ergebnis das in Tool-Responses eingebunden wird */
export interface OnboardingResult {
  isFirstVisit: boolean;
  rules?: OnboardingRule[];
  rulesMessage?: string;
}

/** Pfad zur persistenten Registry-Datei */
const REGISTRY_PATH = path.join(os.homedir(), '.synapse', 'project-registry.json');

/** Cache fuer Projekt-Pfade (project name -> path) */
const projectPathCache = new Map<string, string>();

/** Registry beim Start laden */
function loadRegistry(): void {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
      for (const [name, projectPath] of Object.entries(data)) {
        projectPathCache.set(name, projectPath as string);
      }
      console.log(`[Synapse] ${projectPathCache.size} Projekte aus Registry geladen`);
    }
  } catch {
    // Registry nicht lesbar - ignorieren
  }
}

/** Registry speichern */
function saveRegistry(): void {
  try {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: Record<string, string> = {};
    projectPathCache.forEach((v, k) => { data[k] = v; });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Speichern fehlgeschlagen - ignorieren
  }
}

// Registry beim Modul-Load laden
loadRegistry();

/**
 * Registriert einen Projekt-Pfad im Cache (persistent)
 * Wird von init_projekt aufgerufen
 */
export function cacheProjectPath(projectName: string, projectPath: string): void {
  projectPathCache.set(projectName, projectPath);
  saveRegistry();
}

/**
 * Holt den Projekt-Pfad aus Cache
 */
export function getCachedProjectPath(projectName: string): string | null {
  return projectPathCache.get(projectName) || null;
}

/**
 * Prueft Agent-Onboarding und gibt Regeln zurueck wenn Agent neu ist
 *
 * @param project - Projekt-Name
 * @param agentId - Agent-ID (optional, wenn nicht angegeben wird kein Tracking gemacht)
 * @param projectPath - Projekt-Pfad (optional, wird aus Cache geholt wenn nicht angegeben)
 * @returns OnboardingResult mit isFirstVisit und ggf. Regeln
 */
export async function checkAgentOnboarding(
  project: string,
  agentId?: string,
  projectPath?: string
): Promise<OnboardingResult | null> {
  // Kein Agent-Tracking ohne ID
  if (!agentId) {
    return null;
  }

  // Projekt-Pfad ermitteln
  const path = projectPath || getCachedProjectPath(project);
  if (!path) {
    // Kein Pfad bekannt - Onboarding nicht moeglich
    return null;
  }

  // Pruefen ob Projekt-Status existiert
  const status = getProjectStatus(path);
  if (!status) {
    return null;
  }

  // Agent registrieren (gibt true zurueck wenn NEU)
  const isFirstVisit = registerAgent(path, agentId);

  if (!isFirstVisit) {
    // Agent bereits bekannt - keine Regeln
    return { isFirstVisit: false };
  }

  // Neuer Agent - Regeln laden
  console.log(`[Synapse MCP] Neuer Agent "${agentId}" erkannt - lade Regeln...`);

  try {
    const ruleMemories = await getRulesForNewAgent(project);

    if (ruleMemories.length === 0) {
      return { isFirstVisit: true };
    }

    const rules: OnboardingRule[] = ruleMemories.map(m => ({
      name: m.name,
      content: m.content,
    }));

    const rulesMessage = `\n\n📋 PROJEKT-REGELN (bitte beachten!):\n${rules.map(r => `### ${r.name}\n${r.content}`).join('\n\n')}`;

    console.log(`[Synapse MCP] ${rules.length} Regeln fuer Agent "${agentId}" geladen`);

    return {
      isFirstVisit: true,
      rules,
      rulesMessage,
    };
  } catch (error) {
    console.error(`[Synapse MCP] Fehler beim Laden der Regeln:`, error);
    return { isFirstVisit: true };
  }
}

/**
 * Erweitert ein Tool-Ergebnis um Onboarding-Informationen
 */
export function addOnboardingToResult<T extends Record<string, unknown>>(
  result: T,
  onboarding: OnboardingResult | null
): T & { agentOnboarding?: OnboardingResult } {
  if (!onboarding || !onboarding.isFirstVisit) {
    return result;
  }

  return {
    ...result,
    agentOnboarding: onboarding,
  };
}
