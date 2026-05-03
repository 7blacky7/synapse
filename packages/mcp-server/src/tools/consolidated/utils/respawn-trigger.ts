/**
 * Respawn-Trigger fuer Spezialisten via thought(add, trigger_respawn: true).
 *
 * Spezialist ruft thought.add mit trigger_respawn=true auf wenn er sein
 * Auto-Handoff macht. Der MCP-Server prueft den aktuellen Context-Stand
 * gegen einen Modell-spezifischen Korridor und schreibt einen Marker
 * fuer den Wrapper, der bei naechstem Heartbeat eine Rotation ausloest.
 *
 * Schwellen-Korridore (siehe Korridor-Design 2026-05-03):
 *   - Opus:        90% .. 99%
 *   - Sonnet/Haiku: 80% .. 88%
 *
 * Regeln:
 *   - Spezialist erfaehrt seinen aktuellen %-Stand, aber NIE den Korridor
 *   - Im / ueber Korridor → Marker setzen, Respawn akzeptiert
 *   - Unter Korridor     → kein Marker, "arbeite weiter"
 *   - Source matcht keinen aktiven Spezialisten → Trigger ignoriert
 */

import { heartbeatController } from '@synapse/agents';

const MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

export type RespawnDecision =
  | { triggered: true; message: string }
  | { triggered: false; message: string };

interface WrapperStatus {
  model?: string;
  tokens?: { percent?: number };
}

function resolveCorridor(model: string | undefined): { min: number; max: number } {
  // Default = Sonnet/Haiku-Korridor (defensiv: unbekannte Modelle behandeln wir wie Sonnet)
  if (model && /opus/i.test(model)) {
    return { min: 0.90, max: 0.99 };
  }
  return { min: 0.80, max: 0.88 };
}

export async function maybeTriggerRespawn(source: string): Promise<RespawnDecision> {
  if (!heartbeatController.isConnected(source)) {
    return {
      triggered: false,
      message: `Handoff-Trigger ignoriert — kein aktiver Spezialist mit Name "${source}".`,
    };
  }

  let status: WrapperStatus;
  try {
    status = (await heartbeatController.getWrapperStatus(source)) as WrapperStatus;
  } catch (err) {
    return {
      triggered: false,
      message: `Handoff-Trigger ignoriert — Wrapper-Status konnte nicht gelesen werden (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  const percent = typeof status?.tokens?.percent === 'number' ? status.tokens.percent : 0;
  const corridor = resolveCorridor(status?.model);
  const fraction = percent / 100;

  // Marker IMMER auf den eigenen Namen setzen (Wrapper liest nur seinen Marker)
  const markerPath = `${MARKER_PREFIX}${source}`;

  if (fraction >= corridor.min) {
    // In oder ueber Korridor → Respawn akzeptiert
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(markerPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      return {
        triggered: false,
        message: `Handoff-Trigger fehlgeschlagen — Marker konnte nicht geschrieben werden (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    return {
      triggered: true,
      message: `Handoff registriert. Du wirst neugestartet.`,
    };
  }

  // Unter Korridor → kein Respawn, Hinweis ohne Korridor-Info
  return {
    triggered: false,
    message: `Handoff nicht ausgefuehrt — du bist erst bei ${Math.round(percent)}%. Arbeite weiter.`,
  };
}
