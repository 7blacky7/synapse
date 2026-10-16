/**
 * P22-T11: Gemeinsame Token-Grenze fuer REST und stdio.
 * Geteilte MCP-Verbindungen erhalten KEINE globale "zuletzt angemeldete" Identitaet.
 * Jeder Aufruf bezeugt sich per token oder dediziertem Starttransport (Env/Header).
 */
import {
  leseTokenIdentitaetSchalter, stelleAgentTokenAus, meldeAgentMitTokenAn,
  pruefeAgentToken, AgentIdentitaetFehler, type AgentTokenAnmeldung,
} from './agent-identitaet.js';
import { registerAgent } from './chat.js';
import { getPool } from '../db/client.js';
import { holeAgentOnboarding } from './agent-onboarding.js';
import { pruefeUnbekannteParameter } from './unbekannte-parameter.js';
import { logToolCall } from './tool-call-log.js';

export const AGENT_TOKEN_PARAMETER = {
  token: { type: 'string', description: 'Persoenlicher Synapse-Agentenausweis. chat(anmelden) erneuert den Kontext; Folgeaufrufe pruefen die Identitaet. Nie in Logs/Channels ablegen.' },
};
/** Nur Schemas erweitern; die ausgeschaltete Fachlogik bleibt unveraendert. */
export function ergaenzeAgentTokenParameter(defs: Array<{ inputSchema?: { properties?: Record<string, unknown> } }>): void {
  for (const d of defs) if (d.inputSchema?.properties) Object.assign(d.inputSchema.properties, AGENT_TOKEN_PARAMETER);
}
/** Nur die Werbung ist schalterabhaengig; der interne Annahmevertrag bleibt stabil.
 * Kopien verhindern, dass ein paralleler tools/list-Aufruf andere Verbindungen veraendert.
 */
export async function beworbeneAgentTools<T extends { name: string; inputSchema?: { properties?: Record<string, unknown> } }>(defs: T[]): Promise<T[]> {
  if ((await leseTokenIdentitaetSchalter()).freigegeben) return defs;
  return defs.map(def => {
    const kopie = structuredClone(def);
    if (kopie.inputSchema?.properties) {
      delete kopie.inputSchema.properties.token;
      if (kopie.name === 'chat') {
        const action = kopie.inputSchema.properties.action as { enum?: unknown[] } | undefined;
        if (action?.enum) action.enum = action.enum.filter(a => a !== 'anmelden' && a !== 'identitaet');
      }
    }
    return kopie;
  });
}

export interface AgentToolKontext {
  aktiv: boolean;
  args: Record<string, unknown>;
  principal?: AgentTokenAnmeldung;
  antwort?: Record<string, unknown>;
}
function feld(a: Record<string, unknown>, k: string): string | undefined {
  return typeof a[k] === 'string' && a[k] !== '' ? a[k] as string : undefined;
}
function bezeuge(a: Record<string, unknown>, k: string, v: unknown, erlaubt?: Set<string>): void {
  // Deklarierte Felder ueberleben Fachadapter-Spreads; interne Rollen bleiben nur fuer Hooks sichtbar.
  Object.defineProperty(a, k, { value: v, enumerable: Object.hasOwn(a, k) || (k !== 'role' && erlaubt?.has(k) === true), writable: true, configurable: true });
}
function zeigePrincipal(p: AgentTokenAnmeldung): Record<string, unknown> {
  return { identity_id: p.identitaet.id, agent_id: p.agent_id, project: p.project,
    rolle: p.rolle, modell: p.modell, context_epoch: p.context_epoch,
    ...('lauf_id' in p ? { lauf_id: p.lauf_id } : {}), ausweis: '[maskiert]' };
}
/** Fehlermeldungen enthalten ausschliesslich feste Codes, niemals Zugangswerte/DB-Fehler. */
export async function bereiteAgentToolAufrufVor(
  tool: string, eingabe: Record<string, unknown>, serverInstanceId: string, transportToken?: string, erlaubteParameter?: Set<string>,
): Promise<AgentToolKontext> {
  const schalter = await leseTokenIdentitaetSchalter();
  const args = { ...eingabe };
  const token = Object.hasOwn(eingabe, 'token') ? feld(eingabe, 'token') : transportToken;

  delete args.token;
  const basis: AgentToolKontext = { aktiv: schalter.freigegeben, args };
  const action = feld(args, 'action');
  if (!schalter.freigegeben) {
    if (Object.hasOwn(eingabe, 'token') || transportToken !== undefined || (tool === 'chat' && ['anmelden', 'identitaet'].includes(action ?? ''))) {
      basis.antwort = { success: false, error: 'token_identitaet_aus', schalter };
    }
    return basis;
  }
  const parameterBefund = erlaubteParameter ? pruefeUnbekannteParameter(tool, erlaubteParameter, eingabe) : null;
  if (parameterBefund) {
    basis.antwort = { success: false, error: 'unbekannter_parameter', tool,
      unbekannte_parameter: parameterBefund.unbekannt, message: parameterBefund.meldung };
    return basis;
  }
  try {
    if (Object.hasOwn(eingabe, 'token') && !token) throw new AgentIdentitaetFehler('agent_token_ungueltig');
    // Erstanmeldung ist der einzige unbeglaubigte Einstieg. Selbstauskunft verleiht keine Rechte.
    if (tool === 'chat' && action === 'register' && !token) {
      const id = feld(args, 'id'), project = feld(args, 'project');
      if (!id || !project || /^user$/i.test(id)) throw new AgentIdentitaetFehler('identitaet_parameter_ungueltig');
      const ausgabe = await stelleAgentTokenAus({ project, name: id, modell_selbstauskunft: feld(args, 'model') });
      const p = await meldeAgentMitTokenAn(ausgabe.token, project);
      basis.principal = p;
      bezeuge(args, 'agent_id', p.agent_id, erlaubteParameter); bezeuge(args, 'project', p.project, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
      const session = await registerAgent(p.agent_id, p.project, p.modell ?? undefined, feld(args, 'cutoff_date'));
      const agentOnboarding = await holeAgentOnboarding({ project: p.project, agentId: p.agent_id,
        role: p.rolle, serverInstanceId, explizit: true });
      basis.antwort = { success: true, ...session, action: 'register', token: ausgabe.token,
        principal: zeigePrincipal(p), agentOnboarding };
      return basis;
    }
    if (!token) {
      basis.antwort = { success: false, error: 'agent_token_fehlt',
        message: 'Mit chat(action:"register", id, project) erstmalig registrieren; danach token verwenden.' };
      return basis;
    }
    const sitzungsSignal = tool === 'admin' && action === 'index_stats' && ['neu', 'fortsetzung'].includes(String(args.sitzung));
    const anmeldung = (tool === 'chat' && (action === 'anmelden' || action === 'register')) || sitzungsSignal;
    const p = anmeldung ? await meldeAgentMitTokenAn(token, feld(args, 'project'))
      : await pruefeAgentToken(token, feld(args, 'project'));
    basis.principal = p;
    const abweichungen = Object.fromEntries(['agent_id', 'role', 'model'].flatMap(k => {
      const soll = k === 'agent_id' ? p.agent_id : k === 'role' ? p.rolle : p.modell;
      return args[k] !== undefined && args[k] !== soll ? [[k, { vorschlag: args[k], bezeugt: soll }]] : [];
    }));
    if (Object.keys(abweichungen).length) await logToolCall({
      project: p.project, agentId: p.agent_id, source: 'token-identitaet', tool: 'chat',
      action: 'identitaet_abweichung', argsPreview: JSON.stringify(abweichungen), ok: false,
      error: 'selbstauskunft_weicht_ab',
    });
    bezeuge(args, 'agent_id', p.agent_id, erlaubteParameter); bezeuge(args, 'project', p.project, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
    if (Object.hasOwn(args, 'model')) args.model = p.modell;
    // Fachliche Absenderfelder duerfen die gepruefte Attribution nicht wieder ersetzen.
    if (tool === 'thought' && ['add', 'add_batch'].includes(action ?? '')) args.source = p.agent_id;
    if (tool === 'event' && action === 'emit') args.source_id = p.agent_id;
    if (tool === 'chat' && action === 'send') args.sender_id = p.agent_id;
    if (tool === 'chat' && action === 'inbox_send') args.from_agent = p.agent_id;
    if (tool === 'chat' && action === 'inbox_check') args.agent_name = p.agent_id;
    if (tool === 'channel' && action === 'post') args.sender = p.agent_id;
    if (tool === 'channel' && ['join', 'leave', 'mark_read'].includes(action ?? '')) args.agent_name = p.agent_id;
    if (anmeldung) {
      // Auch nach Inaktivitaet die Lebensphase erhalten: offene Broadcasts bleiben adressiert.
      await getPool().query("UPDATE agent_sessions SET status='active', sitzung_seit=clock_timestamp() WHERE id=$1 AND project=$2 AND identity_id=$3", [p.agent_id, p.project, p.identitaet.id]);
      const agentOnboarding = await holeAgentOnboarding({ project: p.project, agentId: p.agent_id,
        role: p.rolle, serverInstanceId, explizit: true });
      if (sitzungsSignal) {
        // Die Fachantwort von index_stats bleibt erhalten. Kein 'neu' darf die Lebensphase ersetzen.
        args.sitzung = 'fortsetzung'; args.onboarding = true;
      } else {
        basis.antwort = { success: true, action: 'anmelden', principal: zeigePrincipal(p), agentOnboarding };
      }
    } else if (tool === 'chat' && action === 'identitaet') {
      basis.antwort = { success: true, action: 'identitaet', principal: zeigePrincipal(p), schalter };
    }
    return basis;
  } catch (e) {
    basis.antwort = { success: false, error: e instanceof AgentIdentitaetFehler ? e.code : 'agent_anmeldung_fehlgeschlagen' };
    return basis;
  }
}
