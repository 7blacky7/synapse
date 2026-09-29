/**
 * Synchroner Respawn-Trigger fuer Spezialisten.
 *
 * Wird sowohl vom stdio-MCP-Server als auch von der REST-API verwendet,
 * um identisches Verhalten beim trigger_respawn-Flag in thought.add zu
 * gewaehrleisten.
 *
 * Ablauf:
 *   1. project-Name → projectPath via getProjectRoot
 *   2. PG-Read (primaer): getWrapperStatus(source, project) → Spezialist-Daten
 *      Fallback: status.json (auf Disk) lesen → Spezialist mit Name <source> finden
 *   3. Korridor-Check in ABSOLUTEN Tokens mit derselben Rechnung wie der Wrapper
 *      (berechneKontextSchwellen, services/kontext-korridor.ts): ausgeloest ab
 *      handoffTokens. Registry per getModel; kennt die DB den Alias nicht, zaehlt
 *      das Kontextfenster, das der Wrapper selbst meldet.
 *   4. In Korridor → Neustart-Aufforderung:
 *      - stdio-Weg (core laeuft auf dem Rechner des Wrappers): Marker
 *        /tmp/.specialist-rotate-pending-<source> direkt schreiben
 *      - REST-Weg (optionen.ueberDaemon): core laeuft im API-Container, dessen
 *        /tmp sieht der Wrapper nie. Stattdessen Job 'rotate' in die
 *        Specialist-Queue; der Daemon auf dem Rechner des Wrappers schreibt
 *        den Marker dort (file-watcher-daemon-ts specialist-job-worker.ts).
 *      → Wrapper rotiert beim naechsten Heartbeat
 *      → Response: "Handoff registriert. Du wirst neugestartet."
 *   5. Unter Korridor → KEIN Marker
 *      → Response: "Handoff nicht ausgefuehrt — du bist erst bei X%. Arbeite weiter."
 *
 * Spezialist sieht NIEMALS die Korridor-Grenzen, nur seinen aktuellen %-Stand.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectRoot } from './project-registry.js';
import { getWrapperStatus } from './wrapper-status.js';
import { getModel } from './model-registry.js';
import { enqueueSpecialistJob } from './specialist-queue.js';
import { berechneKontextSchwellen, type KontextSchwellen } from './kontext-korridor.js';

const MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

export type RespawnDecision = {
  triggered: boolean;
  message: string;
};

interface StatusFileShape {
  specialists?: Record<string, {
    status?: string;
    model?: string;
    tokens?: { input?: number; output?: number; percent?: number };
    contextCeiling?: number;
  }>;
}

export interface KorridorPruefung {
  ausloesen: boolean;
  /** Kontextstand in Tokens, gegen den geprueft wurde */
  tokens: number;
  /** derselbe Stand in Prozent des Fensters (nur fuer die Meldung) */
  prozent: number;
  schwellen: KontextSchwellen;
}

/**
 * Korridor-Check fuer trigger_respawn — dieselbe Rechnung wie im Wrapper.
 * tokens (input+output) hat Vorrang; fehlen sie, wird aus percent und dem vom
 * Wrapper gemeldeten Fenster zurueckgerechnet.
 */
export async function pruefeRespawnKorridor(stand: {
  model: string;
  tokens?: number | null;
  percent?: number | null;
  contextCeiling?: number | null;
}): Promise<KorridorPruefung> {
  const eintrag = await getModel(stand.model).catch(() => null);
  const schwellen = berechneKontextSchwellen(eintrag, stand.model, stand.contextCeiling);
  const fenster = stand.contextCeiling && stand.contextCeiling > 0 ? stand.contextCeiling : schwellen.ceiling;
  const tokens = stand.tokens && stand.tokens > 0
    ? stand.tokens
    : Math.round(((stand.percent ?? 0) / 100) * fenster);
  return {
    ausloesen: schwellen.handoffTokens > 0 && tokens >= schwellen.handoffTokens,
    tokens,
    prozent: schwellen.ceiling > 0 ? Math.round((tokens / schwellen.ceiling) * 100) : 0,
    schwellen,
  };
}

async function readStatusFile(projectPath: string): Promise<StatusFileShape | null> {
  try {
    const raw = await readFile(join(projectPath, '.synapse', 'agents', 'status.json'), 'utf-8');
    return JSON.parse(raw) as StatusFileShape;
  } catch {
    return null;
  }
}

export async function maybeTriggerRespawn(
  project: string,
  source: string,
  optionen: { ueberDaemon?: boolean } = {},
): Promise<RespawnDecision> {
  const projectPath = await getProjectRoot(project);
  if (!projectPath) {
    return { triggered: false, message: `Trigger ignoriert — Projekt "${project}" unbekannt.` };
  }

  // --- PG-Read (primaer) ---
  let model: string;
  let tokens: number;
  let percent: number;
  let contextCeiling: number | null;

  const pgRow = await getWrapperStatus(source, project).catch(() => null);

  if (pgRow !== null) {
    // PG-Quelle: Spezialist gefunden
    if (pgRow.status === 'stopped' || pgRow.status === 'crashed') {
      return { triggered: false, message: `Trigger ignoriert — kein aktiver Spezialist mit Name "${source}".` };
    }
    model = pgRow.model ?? 'sonnet';
    tokens = (pgRow.tokensInput ?? 0) + (pgRow.tokensOutput ?? 0);
    percent = pgRow.tokensPercent ?? 0;
    contextCeiling = pgRow.contextCeiling;
  } else {
    // Fallback: status.json auf Disk
    const status = await readStatusFile(projectPath);
    if (!status) {
      return { triggered: false, message: `Trigger ignoriert — status.json nicht lesbar.` };
    }
    const specialist = status.specialists?.[source];
    if (!specialist || specialist.status === 'stopped' || specialist.status === 'crashed') {
      return { triggered: false, message: `Trigger ignoriert — kein aktiver Spezialist mit Name "${source}".` };
    }
    model = specialist.model ?? 'sonnet';
    tokens = (specialist.tokens?.input ?? 0) + (specialist.tokens?.output ?? 0);
    percent = specialist.tokens?.percent ?? 0;
    contextCeiling = specialist.contextCeiling ?? null;
  }

  const pruefung = await pruefeRespawnKorridor({ model, tokens, percent, contextCeiling });

  if (!pruefung.ausloesen) {
    return {
      triggered: false,
      message: `Handoff nicht ausgefuehrt — du bist erst bei ${pruefung.prozent}%. Arbeite weiter.`,
    };
  }

  if (optionen.ueberDaemon) {
    try {
      await enqueueSpecialistJob({ project, action: 'rotate', args: { name: source } });
    } catch (err) {
      return {
        triggered: false,
        message: `Neustart-Auftrag an den Daemon konnte nicht eingereiht werden (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    return { triggered: true, message: 'Handoff registriert. Du wirst neugestartet.' };
  }

  try {
    await writeFile(`${MARKER_PREFIX}${source}`, `${new Date().toISOString()}\n`, 'utf8');
  } catch (err) {
    return {
      triggered: false,
      message: `Handoff-Marker konnte nicht geschrieben werden (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  return { triggered: true, message: 'Handoff registriert. Du wirst neugestartet.' };
}
