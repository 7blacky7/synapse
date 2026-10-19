/**
 * P22-T29 (Befund b13f126a H5): Bearbeiter-Angaben fuer die T18-Grundpflicht (update_task / thought task_status auf gebundener Task).
 * Die effektive Agent-ID der REST-Strecke (Header/Session, effectiveAgentId in routes/mcp.ts) zaehlt wie args.agent_id;
 * sie hat Vorrang (gleiche Regel wie beim shell-Tool). User-Pfad = wirklich keine Agent-ID (weder Header/Session noch Argument).
 * Angaben aus dem Aufruf, KEIN Identitaetsnachweis (der Token-Principal wird im Core separat bewertet).
 */
export interface TaskBearbeiterAngaben { agent_id?: string; grund?: string }

function nichtLeer(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function bearbeiterAusAufruf(args: Record<string, unknown>, effectiveAgentId?: string): TaskBearbeiterAngaben {
  const agent_id = nichtLeer(effectiveAgentId) ?? nichtLeer(args.agent_id);
  const grund = typeof args.grund === 'string' ? args.grund : undefined;
  return { agent_id, grund };
}
