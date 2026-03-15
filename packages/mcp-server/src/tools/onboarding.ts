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
  writeMemory,
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
      console.error(`[Synapse] ${projectPathCache.size} Projekte aus Registry geladen`);
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
  const isCoordinator = agentId === 'koordinator' || agentId.startsWith('koordinator-');
  console.error(`[Synapse MCP] Neuer Agent "${agentId}" erkannt (Koordinator: ${isCoordinator}) - lade Regeln...`);

  try {
    const ruleMemories = await getRulesForNewAgent(project);

    // Auto-Inject: Handoff-Regeln hinzufuegen wenn nicht vorhanden (PROTOTYP)
    await ensureHandoffRules(project, ruleMemories);
    // Regeln neu laden falls Handoff-Regeln gerade erstellt wurden
    const allRules = await getRulesForNewAgent(project);

    // Koordinator-Only Regeln filtern: Agenten sehen nur Regeln OHNE Tag "coordinator-only"
    const finalRules = isCoordinator
      ? allRules
      : allRules.filter(m => !m.tags?.includes('coordinator-only'));

    if (finalRules.length === 0) {
      return { isFirstVisit: true };
    }

    const rules: OnboardingRule[] = finalRules.map(m => ({
      name: m.name,
      content: m.content,
    }));

    const rulesMessage = `\n\n📋 PROJEKT-REGELN (bitte beachten!):\n${rules.map(r => `### ${r.name}\n${r.content}`).join('\n\n')}`;

    console.error(`[Synapse MCP] ${rules.length} Regeln fuer Agent "${agentId}" geladen`);

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

/** Name der auto-injizierten Handoff-Regel */
const HANDOFF_RULE_NAME = 'context-handoff-regeln';

/** PROTOTYP: Handoff-Regeln im Content */
const HANDOFF_RULE_CONTENT = `## Context-Handoff Regeln (PROTOTYP)

Synapse unterstuetzt automatischen Session-Handoff wenn das Context-Window voll wird.

### Wann Handoff noetig ist
- Du wirst automatisch per Hook gewarnt (60% = gelb, 80% = rot)
- Bei GELB: Aktuellen Task abschliessen, dann Handoff planen
- Bei ROT: SOFORT Handoff ausfuehren

### Handoff-Protokoll (3 Schritte)

**1. Thought speichern (Schnelleinstieg):**
add_thought(project, source: "<dein-name>",
  content: "SESSION-HANDOFF: <Fortschritt> | NAECHSTER SCHRITT: <was> | MEMORY: session-handoff-<projekt>-<YYYY-MM-DD-HH-MM>",
  tags: ["session-uebergabe"])

**2. Memory speichern (Details):**
write_memory(project, name: "session-handoff-<projekt>-<YYYY-MM-DD-HH-MM>",
  category: "note", content: "User-Auftrag, Erledigtes, Offene Tasks, Naechste Schritte, Branch/Git-Status")

**3. Neue Session starten:**
bash <projekt-pfad>/scripts/context-handoff/context-handoff.sh "<projekt-pfad>" "<projekt-name>" "<aufgabe>"

### Wichtig
- Handoff NICHT mitten in einer Datei-Bearbeitung — erst commit
- Die neue Session liest automatisch den Synapse-Kontext und arbeitet weiter
- Neuen einzigartigen Agent-Namen in der Folge-Session verwenden`;

/**
 * PROTOTYP: Prueft ob Handoff-Regeln existieren und erstellt sie automatisch
 * Wird beim Onboarding aufgerufen — nur einmal pro Projekt
 * Tag "coordinator-only" sorgt dafuer dass nur Koordinatoren sie sehen
 */
async function ensureHandoffRules(
  project: string,
  existingRules: { name: string; content: string }[]
): Promise<void> {
  // Bereits vorhanden?
  const hasHandoff = existingRules.some(r =>
    r.name === HANDOFF_RULE_NAME ||
    r.content.includes('context-handoff') ||
    r.content.includes('SESSION-HANDOFF')
  );

  if (hasHandoff) {
    return;
  }

  console.error(`[Synapse MCP] Auto-Inject: Handoff-Regeln fuer Projekt "${project}" erstellen (PROTOTYP)`);

  try {
    await writeMemory(
      project,
      HANDOFF_RULE_NAME,
      HANDOFF_RULE_CONTENT,
      'rules',
      ['context-handoff', 'prototyp', 'coordinator-only']
    );
    console.error(`[Synapse MCP] Handoff-Regeln erfolgreich erstellt (coordinator-only)`);
  } catch (error) {
    console.error(`[Synapse MCP] Handoff-Regeln konnten nicht erstellt werden:`, error);
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
