/**
 * Re-Export des core-Helpers, damit lokale Importe stabil bleiben.
 * Echte Implementierung: @synapse/core/services/specialist-respawn.ts
 * (geteilt zwischen stdio MCP-Server und REST-API).
 */

export { maybeTriggerRespawn } from '@synapse/core';
export type { RespawnDecision } from '@synapse/core';
