/**
 * Synchroner Respawn-Trigger fuer Spezialisten.
 *
 * Wird sowohl vom stdio-MCP-Server als auch von der REST-API verwendet,
 * um identisches Verhalten beim trigger_respawn-Flag in thought.add zu
 * gewaehrleisten.
 *
 * Ablauf:
 *   1. project-Name → projectPath via getProjectRoot
 *   2. status.json (auf Disk) lesen → Spezialist mit Name <source> finden
 *   3. Korridor-Check (Opus ab 80%, Sonnet/Haiku ab 70%)
 *   4. In Korridor → Marker /tmp/.specialist-rotate-pending-<source> schreiben
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

const MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

export type RespawnDecision = {
  triggered: boolean;
  message: string;
};

interface StatusFileShape {
  specialists?: Record<string, {
    status?: string;
    model?: string;
    tokens?: { percent?: number };
  }>;
}

function corridorMin(model: string): number {
  // Bewusst niedrig: gibt Headroom fuer einen einzelnen grossen Tool-Call
  // damit nicht ein Turn den Context von <Schwelle direkt ueber 95% schiebt.
  return /opus/i.test(model) ? 80 : 70;
}

async function readStatusFile(projectPath: string): Promise<StatusFileShape | null> {
  try {
    const raw = await readFile(join(projectPath, '.synapse', 'agents', 'status.json'), 'utf-8');
    return JSON.parse(raw) as StatusFileShape;
  } catch {
    return null;
  }
}

export async function maybeTriggerRespawn(project: string, source: string): Promise<RespawnDecision> {
  const projectPath = await getProjectRoot(project);
  if (!projectPath) {
    return { triggered: false, message: `Trigger ignoriert — Projekt "${project}" unbekannt.` };
  }

  const status = await readStatusFile(projectPath);
  if (!status) {
    return { triggered: false, message: `Trigger ignoriert — status.json nicht lesbar.` };
  }

  const specialist = status.specialists?.[source];
  if (!specialist || specialist.status === 'stopped' || specialist.status === 'crashed') {
    return { triggered: false, message: `Trigger ignoriert — kein aktiver Spezialist mit Name "${source}".` };
  }

  const percent = specialist.tokens?.percent ?? 0;
  const model = specialist.model ?? 'sonnet';
  const minPct = corridorMin(model);

  if (percent < minPct) {
    return {
      triggered: false,
      message: `Handoff nicht ausgefuehrt — du bist erst bei ${percent}%. Arbeite weiter.`,
    };
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
