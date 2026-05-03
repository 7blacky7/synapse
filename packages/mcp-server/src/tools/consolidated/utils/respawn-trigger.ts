/**
 * Synchroner Respawn-Trigger fuer Spezialisten via thought(add, trigger_respawn).
 *
 * Cross-process-Architektur:
 *   - Spezialist's eigener MCP-Server-Prozess kennt seinen Wrapper nicht direkt
 *     (kein heartbeatController.isConnected).
 *   - Loesung: status.json (auf Disk im Projekt) hat tokens.percent + model.
 *     Jeder Prozess kann es lesen.
 *
 * Ablauf:
 *   1. project-Name → projectPath via getProjectRoot
 *   2. status.json lesen → Spezialist mit Name <source> finden
 *   3. Korridor pruefen (Opus 90-99, Sonnet/Haiku 80-88)
 *   4a. In/ueber Korridor → Marker /tmp/.specialist-rotate-pending-<source> schreiben
 *       → Wrapper rotiert beim naechsten Heartbeat
 *       → Response: "Handoff registriert. Du wirst neugestartet."
 *   4b. Unter Korridor → KEIN Marker
 *       → Response: "Handoff nicht ausgefuehrt — du bist erst bei X%. Arbeite weiter."
 *   4c. Spezialist nicht in status.json → Response: "Trigger ignoriert — kein aktiver Spezialist."
 *
 * Spezialist sieht NIEMALS die Korridor-Grenzen, nur seinen aktuellen %-Stand.
 */

import { writeFile } from 'node:fs/promises';
import { readStatus } from '@synapse/agents';
import { getProjectRoot } from '@synapse/core';

const MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

export type RespawnDecision = {
  triggered: boolean;
  message: string;
};

function corridorMin(model: string): number {
  return /opus/i.test(model) ? 90 : 80; // Opus 90-99, Sonnet/Haiku 80-88
}

export async function maybeTriggerRespawn(project: string, source: string): Promise<RespawnDecision> {
  const projectPath = await getProjectRoot(project);
  if (!projectPath) {
    return { triggered: false, message: `Trigger ignoriert — Projekt "${project}" unbekannt.` };
  }

  let status;
  try {
    status = await readStatus(projectPath);
  } catch (err) {
    return { triggered: false, message: `Trigger ignoriert — status.json nicht lesbar (${err instanceof Error ? err.message : String(err)}).` };
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

  // Akzeptiert: Marker schreiben, Wrapper rotiert beim naechsten Heartbeat
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
