/**
 * P22-T15: gemeinsamer Principal-/Zielvertrag. Nur verifizierte Adapter erzeugen
 * identity-Principals; Tool-Argumente sind niemals ein Identitaetsnachweis.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import type { AgentTokenAnmeldung } from './agent-identitaet.js';

export const AGENT_BEZUG_MODI = ['alt', 'beide', 'neu'] as const;
export type AgentBezugModus = typeof AGENT_BEZUG_MODI[number];
export interface AgentBezugStand {
  modus: AgentBezugModus;
  standard: AgentBezugModus;
  quelle: 'standard' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}
export interface LegacyAgentZiel { art: 'legacy'; project: string; agent_id: string }
export interface IdentitaetsAgentZiel {
  art: 'identity'; project: string; agent_id: string; identity_id: string;
}
export type AgentZiel = LegacyAgentZiel | IdentitaetsAgentZiel;
export interface IdentitaetsAgentPrincipal extends IdentitaetsAgentZiel {
  rolle: string; modell: string | null; context_epoch: number; lauf_id: string | null;
}
export type AgentPrincipal = LegacyAgentZiel | IdentitaetsAgentPrincipal;
export interface AgentAufrufKontext {
  principal: AgentPrincipal | null;
  bezug: AgentBezugStand;
}
const aufrufe = new AsyncLocalStorage<AgentAufrufKontext>();
export function istAgentBezugModus(v: unknown): v is AgentBezugModus {
  return typeof v === 'string' && (AGENT_BEZUG_MODI as readonly string[]).includes(v);
}
/** Kein alter Cache bei Ausfall; intern AUS/abgelaufen -> Produktionsstandard. */
export async function leseAgentBezugModus(): Promise<AgentBezugStand> {
  const env = process.env.SYNAPSE_AGENT_BEZUG_MODUS ?? 'alt';
  const standard: AgentBezugModus = istAgentBezugModus(env) ? env : 'alt';
  const basis: AgentBezugStand = { modus: standard, standard, quelle: 'standard', bis: null,
    letzter_fehler: istAgentBezugModus(env) ? null : 'agent_bezug_standard_ungueltig' };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; modus: string; bis: Date | null }>({
      text: "SELECT aktiv,modus,bis FROM intern_schalter WHERE name='agent_bezug_modus' AND (bis IS NULL OR bis>NOW())",
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    if (!z) return basis;
    if (!istAgentBezugModus(z.modus)) return { ...basis, letzter_fehler: 'agent_bezug_override_ungueltig' };
    return { ...basis, modus: z.aktiv ? z.modus : 'alt', quelle: 'intern',
      bis: z.bis?.toISOString() ?? null };
  } catch {
    return { ...basis, letzter_fehler: 'agent_bezug_schalter_nicht_erreichbar' };
  }
}
export function agentPrincipalAusAnmeldung(p: AgentTokenAnmeldung): IdentitaetsAgentPrincipal {
  return { art: 'identity', project: p.project, agent_id: p.agent_id,
    identity_id: p.identitaet.id, rolle: p.rolle, modell: p.modell,
    context_epoch: p.context_epoch, lauf_id: p.lauf_id };
}
/** Kein Namensfallback fuer Identitaeten; Projekt ist bei Legacy Teil des Keys. */
export function agentSchluessel(z: AgentZiel): string {
  return z.art === 'identity' ? 'identity:' + z.identity_id : 'legacy:' + z.project + ':' + z.agent_id;
}
export function gleicherAgent(a: AgentZiel, b: AgentZiel): boolean {
  return a.project === b.project && agentSchluessel(a) === agentSchluessel(b);
}
export function mitAgentAufrufKontext<T>(k: AgentAufrufKontext, arbeit: () => T): T {
  return aufrufe.run(k, arbeit);
}
export function aktuellerAgentAufruf(): AgentAufrufKontext | undefined { return aufrufe.getStore(); }
export function aktuellerAgentPrincipal(): AgentPrincipal | null { return aufrufe.getStore()?.principal ?? null; }
/** Fuer Schreib-/Actorpfade. Fremde Zielnamen werden NICHT auf den Aufrufer umgedeutet. */
export function agentBezugFuer(project: string, agentId: string): AgentZiel {
  const k = aufrufe.getStore(), p = k?.principal;
  if (k?.bezug.modus !== 'alt' && p?.art === 'identity' && p.project === project && p.agent_id === agentId) return p;
  return { art: 'legacy', project, agent_id: agentId };
}
export function aktuelleAgentIdentityId(project: string, agentId?: string | null): string | null {
  const k = aufrufe.getStore(), p = k?.principal;
  return k?.bezug.modus !== 'alt' && p?.art === 'identity' && p.project === project
    && (agentId === undefined || agentId === p.agent_id) ? p.identity_id : null;
}
/** Globale Auditobjekte: Actor-ID nur aus bezeugtem Request, nie aus einem Namen raten. */
export function aktuelleAgentAkteurIdentityId(agentId?: unknown): string | null {
  const k = aufrufe.getStore(), p = k?.principal;
  return k?.bezug.modus !== 'alt' && p?.art === 'identity'
    && (agentId === undefined || agentId === p.agent_id) ? p.identity_id : null;
}

/** Explizites Ziel ist keine Berechtigung. Nie eine ID durch passenden Namen erraten. */
export async function loeseAgentZiel(project: string, ziel: { agent_id?: string; identity_id?: string }): Promise<AgentZiel> {
  if (!project) throw new Error('agent_ziel_projekt_fehlt');
  if (ziel.identity_id) {
    const r = await getPool().query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'",
      [ziel.identity_id, project]);
    if (!r.rows[0] || (ziel.agent_id !== undefined && ziel.agent_id !== r.rows[0].agent_id)) throw new Error('agent_ziel_ungueltig');
    return { art: 'identity', project, identity_id: ziel.identity_id, agent_id: r.rows[0].agent_id };
  }
  if (!ziel.agent_id?.trim()) throw new Error('agent_ziel_fehlt');
  return { art: 'legacy', project, agent_id: ziel.agent_id };
}
