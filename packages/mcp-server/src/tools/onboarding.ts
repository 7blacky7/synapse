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

  // Rolle VOR der Registrierung bestimmen — sie gehoert ins Protokoll (Punkt 3a, 02.08.2026).
  // ⚠️ EINE Rollenbestimmung fuer beide Wege (Punkt 2.5). Hier stand das Original,
  // in mcp.ts eine leicht abweichende Kopie. GEMESSEN: 179 von 181 Identitaeten landen im
  // Standard 'subagent', der spezialist-Zweig hat seit dem 03.05.2026 null Treffer. Die
  // Erkennung bleibt vorerst wie sie ist — sie ist jetzt nur an EINER Stelle und sagt dazu,
  // ob sie geraten hat.
  const { rolleFuerAgent, rollenQuelleKlartext } = await import('@synapse/core');
  const { rolle: effectiveRole, quelle: rollenQuelle } = rolleFuerAgent(agentId, role ?? null);
  const isCoordinator = effectiveRole === 'koordinator';

  // Agent bekannt in dieser Server-Instanz? Rolle + Quelle wandern mit ins Protokoll —
  // erst dadurch wird "derselbe Agent, zwei verschiedene Rollen" ein GROUP BY statt eines
  // Zufallsfundes. Das Protokoll sagt, was das System ENTSCHIEDEN hat, nicht ob es stimmte.
  const isFirstVisit = await registerAgent(
    project,
    agentId,
    SERVER_INSTANCE_ID,
    effectiveRole,
    rollenQuelle,
  );

  if (!isFirstVisit) {
    // Agent bereits bekannt - keine Regeln
    return { isFirstVisit: false };
  }

  console.error(
    `[Synapse MCP] Neuer Agent "${agentId}" erkannt (Rolle: ${effectiveRole}, Quelle: ${rollenQuelle}) - lade Regeln...`,
  );

  try {
    const ruleMemories = await getRulesForNewAgent(project);

    // Auto-Inject: Handoff-Regeln hinzufuegen wenn nicht vorhanden (PROTOTYP)
    await ensureHandoffRules(project, ruleMemories);
    // CH-4: Meldet sich ein Channelverwalter zum ersten Mal, entsteht seine Pflichtregel
    // im Projekt — damit der Koordinator die Auflagen nicht in jeden Spawn-Prompt schreiben
    // muss. Idempotent: existiert sie, passiert nichts.
    if (effectiveRole === 'channelverwalter') {
      const { ensureChannelverwalterRegel } = await import('@synapse/core');
      await ensureChannelverwalterRegel(project);
    }
    // Regeln neu laden falls Handoff-Regeln gerade erstellt wurden
    const allRules = await getRulesForNewAgent(project);

    // Rollenspezifische Regeln filtern — gemeinsame Erkennung aus core
    // (agent-rollen.ts), damit dieser Weg und die REST-API nicht auseinanderlaufen.
    // Der exakte Vergleich von vorher liess z.B. "koordinator-only" (deutsch)
    // stillschweigend durchfallen: die Regel ging dann an alle Rollen.
    const { regelSichtbarFuer, tagVerdacht, baueOnboardingRegeln, baueRegelAbrufHinweis } =
      await import('@synapse/core');
    for (const m of allRules) {
      for (const hinweis of tagVerdacht(m.tags)) {
        console.error(`[Onboarding] Regel "${m.name}" (${project}): ${hinweis}`);
      }
    }
    const finalRules = allRules.filter((m) => regelSichtbarFuer(m.tags, effectiveRole));
    void isCoordinator;

    if (finalRules.length === 0) {
      return { isFirstVisit: true };
    }

    // ⚠️ NICHT MEHR ALLES IM VOLLTEXT (Messung 02.08.2026): 34 Regeln, 65.000 Zeichen, und
    // das bei JEDEM Wechsel der Server-Kennung erneut. Volltext behalten die Regeln mit dem
    // Tag "pflicht"; alle anderen kommen als Auszug, der Volltext ist einen Aufruf entfernt.
    // Dieselbe Funktion wie im REST-Weg — zwei Kopien derselben Aufbereitung waeren genau der
    // Fehler, den diese Codebasis an anderer Stelle teuer bezahlt hat.
    const rules: OnboardingRule[] = baueOnboardingRegeln(finalRules);
    const gekuerzt = rules.filter((r) => !r.vollstaendig).length;
    const abrufHinweis = baueRegelAbrufHinweis(project, gekuerzt);

    // ⚠️ KEIN VOLLTEXT-BLOCK MEHR (G-b, gemessen 26.08.2026). Hier stand bis heute ein
    // rulesMessage, das JEDE Regel ein ZWEITES Mal im Volltext trug — gebaut aus demselben
    // rules-Array, das direkt darunter ohnehin ausgeliefert wird. GEMESSEN auf dieser
    // Strecke, Rolle subagent, 25 Regeln: rules 31.924 Zeichen, rulesMessage 33.238 Zeichen.
    // Derselbe Text, doppelt, bei jedem Erstkontakt. Die REST-Strecke (routes/mcp.ts) hat
    // diesen Block nie gehabt und wurde trotzdem verstanden.
    // Was NUR in rulesMessage stand, steht jetzt als eigenes Feld daneben: der Abrufhinweis
    // als volltext_hinweis (Feldname wie im REST-Weg) und der Setup-Hinweis als setup_hinweis.
    // Die Channel-Uebersicht ging ohnehin schon strukturiert als channels hinaus — ihre
    // Textfassung war Teil derselben Dopplung.
    const setupHinweis =
      isCoordinator && (await getSetupPhase(project, path)) === 'initial-pending'
        ? '⚠️ Projekt-Setup unvollstaendig. Starte /projekt-setup oder frage den User.'
        : undefined;

    // CH-1 (15.08.2026): Welche Channels laufen noch, wer haengt drin, was war zuletzt los.
    // Dieselbe core-Funktion wie im REST-Weg — der Block soll auf beiden Strecken gleich sein.
    const { baueChannelUebersicht } = await import('@synapse/core');
    const channelBlock = await baueChannelUebersicht(project, isCoordinator);

    console.error(`[Synapse MCP] ${rules.length} Regeln fuer Agent "${agentId}" geladen`);

    // ⚠️ FELDSCHNITT WIE IM REST-WEG (routes/mcp.ts, agentOnboarding). rolle/rolle_quelle/
    // rolle_hinweis und volltext_hinweis entstanden auf DIESER Strecke bisher gar nicht. Der
    // Kommentar in server.ts sagt seit dem 15.08., es werde alles durchgereicht — das stimmt
    // auch, nur erzeugt hat sie hier niemand. Durchreichen ersetzt kein Erzeugen.
    // Wer hier ein Feld ergaenzt, ergaenzt es auch in routes/mcp.ts — sonst laufen die beiden
    // Strecken wieder auseinander, und genau das faellt niemandem auf.
    return {
      isFirstVisit: true,
      rolle: effectiveRole,
      rolle_quelle: rollenQuelle,
      rolle_hinweis: rollenQuelleKlartext(effectiveRole, rollenQuelle, role ?? null),
      ...(abrufHinweis ? { volltext_hinweis: abrufHinweis } : {}),
      ...(setupHinweis ? { setup_hinweis: setupHinweis } : {}),
      rules,
      ...(channelBlock ? { channels: channelBlock } : {}),
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
- Du wirst automatisch per Hook gewarnt (95% = gelb, 98% = rot)
- Bei GELB: Aktuellen Task abschliessen, dann Handoff planen
- Bei ROT: SOFORT Handoff ausfuehren

### Handoff-Protokoll (3 Schritte)

**1. Thought speichern (Schnelleinstieg):**
thought(action: "add", project: "<projekt>", source: "<dein-name>",
  content: "SESSION-HANDOFF: <Fortschritt> | NAECHSTER SCHRITT: <was> | CHAT-SEIT: <timestamp>",
  tags: ["session-uebergabe"])

**2. Neue Session starten:**
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
