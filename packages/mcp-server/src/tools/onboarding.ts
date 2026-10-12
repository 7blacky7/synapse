/**
 * MODUL: Agent-Onboarding
 * ZWECK: Automatisches Agent-Tracking und einmaliges Anzeigen der Projekt-Regeln beim Erstbesuch.
 *        Koordinatoren sehen alle Regeln; Subagenten sehen keine 'coordinator-only'-Regeln.
 *        Auto-injiziert Handoff-Regeln wenn noch nicht vorhanden (PROTOTYP).
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - agentId?: string - Agent-ID (ohne ID kein Tracking)
 *   - projectPath?: string - Pfad (optional, wird aus Cache/Registry geholt)
 *
 * OUTPUT:
 *   - checkAgentOnboarding: OnboardingResult mit isFirstVisit, rolle*, volltext_hinweis, rules[]
 *   - cacheProjectPath: void - Registriert Pfad im In-Memory-Cache + Registry
 *   - getCachedProjectPath: string | null - Bekannter Pfad fuer Projekt-Name
 *   - addOnboardingToResult: T & { agentOnboarding? } - Erweitert Tool-Ergebnisse
 *
 * NEBENEFFEKTE:
 *   - Dateisystem: Liest/schreibt ~/.synapse/project-registry.json (persistente Pfad-Registry)
 *   - Dateisystem: Liest .synapse/status.json (Agent-Tracking via registerAgent)
 *   - Qdrant: Liest synapse_memories (Regeln), schreibt ggf. Handoff-Regel (PROTOTYP)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerAgent,
  getRulesForNewAgent,
  getOnboardingMemories,
  ermittleProjektStatus,
  getSetupPhase,
  writeMemory,
} from '@synapse/core';
import { SERVER_INSTANCE_ID } from '../server.js';

/** Regel-Memory fuer Onboarding-Response */
export interface OnboardingRule {
  name: string;
  /** Volltext — nur bei Regeln mit dem Tag "pflicht". */
  content?: string;
  /** Anfang der Regel — bei allen anderen; der Volltext ist einen memory(read) entfernt. */
  auszug?: string;
  /** true, wenn der Volltext mitgeliefert wurde. */
  vollstaendig: boolean;
}

/** Onboarding-Ergebnis das in Tool-Responses eingebunden wird */
export interface OnboardingResult {
  isFirstVisit: boolean;
  /** Rolle, mit der die Regeln gefiltert wurden. */
  rolle?: string;
  /** Woher die Rolle stammt: angegeben | namensmuster | standard | unbekannt. */
  rolle_quelle?: string;
  /** Klartext dazu — macht eine Fehleinstufung beim Lesen sichtbar statt gar nicht. */
  rolle_hinweis?: string;
  /** Wie man den Volltext einer gekuerzten Regel bekommt. Fehlt, wenn nichts gekuerzt wurde. */
  volltext_hinweis?: string;
  /** Nur fuer Koordinatoren und nur bei unvollstaendigem Projekt-Setup. */
  setup_hinweis?: string;
  rules?: OnboardingRule[];
  regel_verzeichnis?: import('@synapse/core').RegelVerzeichnis;
}

/** Agenten-Rollen fuer rollenspezifisches Onboarding */
export type AgentRole = 'koordinator' | 'spezialist' | 'subagent' | 'channelverwalter';

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
  projectPath?: string,
  role?: AgentRole
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

  // Pruefen ob das Projekt eingerichtet ist. PG ist die Quelle (SETUP-1),
  // status.json nur noch Notnagel. Vorher entschied allein die Datei: fehlte
  // sie, bekam der Agent stillschweigend KEINE Projekt-Regeln.
  const status = await ermittleProjektStatus(path, project);
  if (!status) {
    return null;
  }

  try {
    const { holeAgentOnboarding } = await import('@synapse/core');
    let setupHinweis: string | undefined;
    const block = await holeAgentOnboarding({
      project, agentId, role, serverInstanceId: SERVER_INSTANCE_ID,
      vorbereiten: async () => {
        await ensureHandoffRules(project, await getRulesForNewAgent(project));
        if (role === 'koordinator' && await getSetupPhase(project, path) === 'initial-pending') {
          setupHinweis = '⚠️ Projekt-Setup unvollstaendig. Starte /projekt-setup oder frage den User.';
        }
      },
    });
    return block ? { ...block, ...(setupHinweis ? { setup_hinweis: setupHinweis } : {}) } : { isFirstVisit: false };
  } catch (error) {
    console.error('[Synapse MCP] Onboarding-Aufbereitung fehlgeschlagen:', error);
    return { isFirstVisit: false };
  }
}

/** Name der auto-injizierten Handoff-Regel */
const HANDOFF_RULE_NAME = 'context-handoff-regeln';

/** PROTOTYP: Handoff-Regeln im Content */
const HANDOFF_RULE_CONTENT = `Context-Handoff: Arbeitsstand als thought mit eigener ID/Projekt sichern. Nach Kontextwechsel das Projekt über project(status, path:<aktueller Arbeitsordner>, agent_id:<eigene ID>) auflösen; status.project übernehmen. Dann admin(index_stats, project, agent_id, role, sitzung:'fortsetzung', onboarding:true) und Regeln in agentOnboarding lesen. Gleiche Agent-ID weiterverwenden; offene Events, Channels und Co-Edit-Bindungen erhalten. Automatischer Kontextwechsel braucht eine echte strukturierte Wrapper-Schnittstelle. Kein selbst erfundener Schwellwert oder Neustartbefehl.`;

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
