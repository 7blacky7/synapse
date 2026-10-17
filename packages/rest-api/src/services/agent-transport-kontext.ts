/** P22-T15: Service-Bearer ist kein persönlicher Agentenausweis. */
import type { FastifyInstance } from 'fastify';
import {
  leseAgentBezugModus, pruefeAgentToken, agentPrincipalAusAnmeldung,
  mitAgentAufrufKontext, type AgentPrincipal,
} from '@synapse/core';

/** Umschließt auch asynchrone Handler/Hooks; keine globale zuletzt benutzte Identität. */
export function registriereAgentTransportKontext(fastify: FastifyInstance, routenPrefix: string): void {
  fastify.addHook('onRoute', route => {
    if (!route.url.startsWith(routenPrefix)) return;
    const handler = route.handler;
    route.handler = async function(request, reply) {
      const params = request.params as { name?: string; specName?: string; agent?: string };
      const project = params.name;
      const agent = params.specName ?? params.agent;
      if (!project || !agent) return handler.call(this, request, reply);
      const header = request.headers['x-synapse-agent-token'];
      const identity = request.headers['x-synapse-agent-identity-id'];
      if (Array.isArray(header) || Array.isArray(identity)) return reply.code(403).send({ success: false, error: 'agent_transport_header_ungueltig' });
      const bezug = await leseAgentBezugModus();
      if (identity !== undefined && bezug.modus === 'alt') return reply.code(409).send({ success:false,error:'agent_transport_identity_im_altmodus' });
      let principal: AgentPrincipal = { art: 'legacy', project, agent_id: agent };
      if (header !== undefined) {
        try {
          const p = await pruefeAgentToken(header, project, bezug);
          if (p.agent_id !== agent || (identity !== undefined && identity !== p.identitaet.id))
            return reply.code(403).send({ success: false, error: 'agent_transport_ziel_falsch' });
          principal = agentPrincipalAusAnmeldung(p);
        } catch {
          return reply.code(403).send({ success: false, error: 'agent_transport_ausweis_ungueltig' });
        }
      } else if (identity !== undefined) {
        return reply.code(403).send({ success: false, error: 'agent_transport_ausweis_fehlt' });
      }
      return mitAgentAufrufKontext({ principal, bezug }, () => handler.call(this, request, reply));
    };
  });
}
