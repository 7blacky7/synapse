/**
 * Respawn-Trigger fuer Spezialisten via thought(add, trigger_respawn: true).
 *
 * Cross-process-Design:
 * Spezialisten haben ihren eigenen MCP-Server-Prozess (separates claude CLI).
 * Dessen heartbeatController hat KEINE Connection zum eigenen Wrapper.
 * Daher: MCP-Server schreibt nur den Marker. Der Wrapper macht den Korridor-
 * Check selbst beim Marker-Lesen (er kennt seinen Context% und sein Modell).
 *
 * Marker-Pfad: /tmp/.specialist-rotate-pending-<source>
 */

const MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

export type RespawnDecision = {
  triggered: boolean;
  message: string;
};

export async function maybeTriggerRespawn(source: string): Promise<RespawnDecision> {
  const markerPath = `${MARKER_PREFIX}${source}`;
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(markerPath, `${new Date().toISOString()}\n`, 'utf8');
    return {
      triggered: true,
      message: 'Handoff-Marker gesetzt. Der Wrapper prueft beim naechsten Heartbeat den Context-Stand und entscheidet ueber den Respawn.',
    };
  } catch (err) {
    return {
      triggered: false,
      message: `Handoff-Marker konnte nicht geschrieben werden (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}
