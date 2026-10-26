/** P22-T192: Nur unter agentRuntimeRoutes NACH dessen interaktivem User-Guard registrieren. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { leseUserInbox, setzeUserInboxGelesen, antworteUserInbox, UserInboxFehler, setzeProfilProduktSchalter, USER_INBOX_FUNKTION, setzeRuntimeUeberwachungEinstellungen } from '@synapse/core';

export async function userInboxRoutes(fastify: FastifyInstance): Promise<void> {
  const fehler = (reply: FastifyReply, e: unknown) => e instanceof UserInboxFehler
    ? reply.code(e.status).send({ success: false, error: { code: e.code, message: e.message } })
    : reply.code(500).send({ success: false, error: { code: 'user_inbox_fehler', message: 'Meine Inbox konnte nicht geladen oder gespeichert werden.' } });
  fastify.get<{ Querystring: Parameters<typeof leseUserInbox>[0] }>('/api/agent-runtimes/meine-inbox', async (request, reply) => {
    try { return await leseUserInbox(request.query); } catch (e) { return fehler(reply, e); }
  });
  fastify.put<{ Body: { werte?: unknown } }>('/api/agent-runtimes/meine-inbox/einstellungen', async (request, reply) => {
    try {
      const werte = request.body?.werte;
      if (!werte || typeof werte !== 'object' || Array.isArray(werte) || Object.keys(werte).some(n => !['user_inbox_seite','user_inbox_abgleich_sekunden','user_inbox_text_max'].includes(n))) throw new UserInboxFehler('einstellungen_ungueltig');
      await setzeRuntimeUeberwachungEinstellungen({ art: 'user' }, null, { werte, grund: 'P22-T192 Meine Inbox: Einstellungen des Users' });
      return await leseUserInbox({ nur_status: '1' });
    } catch (e) { return fehler(reply, e); }
  });
  fastify.put<{ Body: { aktiv?: unknown } }>('/api/agent-runtimes/meine-inbox/schalter', async (request, reply) => {
    try {
      if (typeof request.body?.aktiv !== 'boolean') throw new UserInboxFehler('aktiv_ungueltig');
      await setzeProfilProduktSchalter({ ebene: 'global', project: null, funktion: USER_INBOX_FUNKTION, aktiv: request.body.aktiv,
        grund: 'P22-T192 Meine Inbox: Auswahl des Users in der Web-UI' }, { system: 'user' });
      return await leseUserInbox({ nur_status: '1' });
    } catch (e) { return fehler(reply, e); }
  });
  fastify.put<{ Params: { id: string }; Body: { gelesen?: unknown } }>('/api/agent-runtimes/meine-inbox/:id/gelesen', async (request, reply) => {
    try { return await setzeUserInboxGelesen(request.params.id, request.body?.gelesen); } catch (e) { return fehler(reply, e); }
  });
  fastify.post<{ Params: { id: string }; Body: { text?: unknown } }>('/api/agent-runtimes/meine-inbox/:id/antwort', async (request, reply) => {
    try { return await antworteUserInbox(request.params.id, request.body?.text); } catch (e) { return fehler(reply, e); }
  });
}
