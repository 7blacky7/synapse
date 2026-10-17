import { agentBezugFuer, aktuellerAgentAufruf, loeseAgentZiel, type AgentZiel } from './agent-bezug.js';

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
export function bezugsWert(z: AgentZiel): string {
  return z.art === 'identity' ? z.identity_id : z.agent_id;
}
export function kommunikationsKey(agent: string): string {
  const z = eigenerKommunikationsAgent(agent);
  return z.art === 'identity' ? 'identity:' + z.identity_id : agent;
}
