/** P22-T15: lokale Laufartefakte sind nach Identität, nie nach Anzeigename, getrennt. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { homedir } from 'node:os';
interface LaufUmgebung { name: string; project: string; env: Record<string, string> }
const laeufe = new AsyncLocalStorage<LaufUmgebung>();
export function mitAgentLaufUmgebung<T>(name: string, project: string, env: Record<string,string>, arbeit: () => T): T {
  return laeufe.run({ name, project, env }, arbeit);
}
/** Nur Transport nutzen; Ausweis niemals in Status/Audit serialisieren. */
export function agentLaufUmgebung(): Record<string,string | undefined> {
  return laeufe.getStore()?.env ?? process.env;
}
export function agentLaufIdentitaet(name?: string): string | null {
  const k = laeufe.getStore(), env = agentLaufUmgebung();
  if (name && name !== (k?.name ?? process.env.SYNAPSE_AGENT_NAME)) return null;
  const id = env.SYNAPSE_AGENT_IDENTITY_ID;
  if (!id) return null;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('agent_lauf_identity_ungueltig');
  return id;
}
export function agentLaufSchluessel(name: string): string {
  if (/^identity:[a-f0-9-]{36}$/.test(name)) return name;
  const id = agentLaufIdentitaet(name);
  return id ? 'identity:' + id : name;
}
export function agentLaufPfad(projectPath: string, name: string): string {
  const id = agentLaufIdentitaet(name);
  return id ? join(homedir(), '.synapse', 'agent-runs', id) : join(projectPath, '.synapse', 'agents', name);
}
