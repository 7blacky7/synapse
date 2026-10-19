import { agentBezugFuer, aktuellerAgentAufruf, loeseAgentZiel, type AgentZiel } from './agent-bezug.js';
import { getPool } from '../db/client.js';

/** Eigene Leser dürfen den verifizierten Principal verwenden; fremde Namen bleiben Legacy. */
export function kommunikationsAgent(project: string, agent: string | AgentZiel): AgentZiel {
  if (typeof agent !== 'string') {
    if (agent.project !== project) throw new Error('agent_ziel_projekt_falsch');
    if (agent.art === 'identity' && !agentBezugAktiv()) throw new Error('agent_bezug_nicht_freigegeben');
    return agent;
  }
  return agentBezugFuer(project, agent);
}
export function agentBezugAktiv(): boolean {
  const k = aktuellerAgentAufruf();
  return !!k && k.bezug.modus !== 'alt';
}
export function eigenerKommunikationsAgent(agent: string): AgentZiel {
  return kommunikationsAgent(aktuellerAgentAufruf()?.principal?.project ?? '', agent);
}
/** Zielnamen bezeichnen immer den Legacy-Namensraum, niemals zufällig den Actor. */
export function kommunikationsZiel(project: string, agent: string | AgentZiel): AgentZiel {
  return typeof agent === 'string' ? { art: 'legacy', project, agent_id: agent }
    : kommunikationsAgent(project, agent);
}
/** Kanonische ID-Ziele passen auch durch vorhandene String-Transportparameter. */
export async function aufgeloestesKommunikationsZiel(project:string,agent:string|AgentZiel,eigen=false): Promise<AgentZiel> {
  if (typeof agent === 'string' && agent.startsWith('identity:')) {
    if (!agentBezugAktiv()) throw new Error('agent_bezug_nicht_freigegeben');
    return loeseAgentZiel(project,{identity_id:agent.slice(9)});
  }
  const z=eigen ? kommunikationsAgent(project,agent) : kommunikationsZiel(project,agent);
  return z.art === 'identity' ? loeseAgentZiel(project,{identity_id:z.identity_id,agent_id:z.agent_id}) : z;
}
/**
 * P22-T31 Punkt 4 (Koordinator-Entscheidung 623b0b95): Sendeziel. Ein NAME erreicht die Identitaet, wenn es genau eine aktive
 * Identitaet mit gueltigem Ausweis dieses Namens im Projekt gibt und KEINE aktive Legacy-Sitzung dieses Namens; sonst Bestand
 * (Legacy-Namensraum). Nur bei aktivem Agentenbezug; Lesen/Eigenbezug bleiben bei aufgeloestesKommunikationsZiel.
 */
export async function aufgeloestesSendeZiel(project: string, agent: string | AgentZiel): Promise<AgentZiel> {
  const z = await aufgeloestesKommunikationsZiel(project, agent);
  if (typeof agent !== 'string' || z.art !== 'legacy' || !agentBezugAktiv()) return z;
  const name = agent.trim();
  if (!name) return z;
  try {
    const r = await getPool().query<{ id: string; agent_id: string }>(
      `SELECT i.id, i.agent_id FROM agent_identitaeten i
        WHERE i.project=$1 AND i.agent_id=$2 AND i.status='aktiv'
          AND EXISTS (SELECT 1 FROM agent_identitaet_tokens t WHERE t.identity_id=i.id AND t.widerrufen_am IS NULL AND t.token_offen IS NOT NULL
                        AND (t.gueltig_bis IS NULL OR t.gueltig_bis > NOW()))
          AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.project=$1 AND s.id=$2 AND s.identity_id IS NULL AND s.status='active')`,
      [project, name]);
    if (r.rows.length === 1) return { art: 'identity', project, identity_id: r.rows[0].id, agent_id: r.rows[0].agent_id };
  } catch { /* Bestand: Legacy-Namensraum */ }
  return z;
}
export function bezugsWert(z: AgentZiel): string {
  return z.art === 'identity' ? z.identity_id : z.agent_id;
}
export function kommunikationsKey(agent: string): string {
  const z = eigenerKommunikationsAgent(agent);
  return z.art === 'identity' ? 'identity:' + z.identity_id : agent;
}
