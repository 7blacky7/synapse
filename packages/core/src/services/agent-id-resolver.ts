/**
 * Zentrale Auflösung der agent_id für audit-relevante Schreib-Operationen
 * (file_versions, file_batch_plans, restore-Operations etc.).
 *
 * Reihenfolge der Quellen:
 *   1. Explizit übergebener agent_id Parameter (höchste Priorität)
 *   2. SYNAPSE_AGENT_NAME (Spezialisten-Wrapper setzt das beim Spawn)
 *   3. SYNAPSE_DEFAULT_AGENT_ID (manueller Override per Env)
 *   4. null (kein Fallback auf "koordinator" — bleibt explizit unbekannt)
 */
export function resolveAgentId(agentId?: string | null): string | null {
  if (agentId && agentId.trim().length > 0) return agentId;
  const fromAgentName = process.env.SYNAPSE_AGENT_NAME;
  if (fromAgentName && fromAgentName.trim().length > 0) return fromAgentName;
  const fromEnv = process.env.SYNAPSE_DEFAULT_AGENT_ID;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return null;
}
