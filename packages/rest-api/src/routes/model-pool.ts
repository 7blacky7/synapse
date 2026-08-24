/**
 * REST-Schnittstelle des Modell-Pools.
 *
 * Grundlage der Oberflaeche: alle erkannten Modelle nebeneinander, mit Filter,
 * Sortierung und einem Freigabeschalter je Zeile.
 *
 * Warum die Freigabe hier liegt und nicht im MCP-Werkzeug `free_models`:
 * Sie ist eine Entscheidung des Nutzers ueber Geld. Ein Agent darf Kandidaten
 * suchen und vorschlagen — sich selbst ein kostenpflichtiges Modell zu
 * erlauben, waere genau die Luecke, die der ganze Aufbau vermeiden soll.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  searchPool,
  getPoolModel,
  getPoolProviders,
  getPoolSnapshot,
  probeProvider,
  setzeModellFreigabe,
  setzeDatenverwendung,
  listeAliase,
  listeSperren,
  loescheSperren,
  leseProtokoll,
  listeCredentials,
  speichereCredential,
  type CostClass,
} from '@synapse/core';

function fehler(reply: FastifyReply, error: unknown, status = 500): FastifyReply {
  const nachricht = error instanceof Error ? error.message : String(error);
  return reply.status(status).send({ success: false, error: { message: nachricht } });
}

function istKostenklasse(wert: unknown): wert is CostClass | 'any' {
  return wert === 'free' || wert === 'paid' || wert === 'unknown' || wert === 'any';
}

export async function modelPoolRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Modellliste. Standard ist hier bewusst ANDERS als beim Agenten-Werkzeug:
   * die Oberflaeche zeigt alles, auch Nichtfreigegebenes und Gesperrtes —
   * sonst koennte man nichts freigeben, was man nicht sieht.
   */
  fastify.get<{
    Querystring: {
      cost?: string;
      provider?: string;
      query?: string;
      min_context?: string;
      capabilities?: string;
      sort?: string;
      limit?: string;
      only_usable?: string;
    };
  }>('/api/model-pool/models', async (request, reply) => {
    try {
      const q = request.query;
      const nurNutzbare = q.only_usable === 'true';
      const ergebnis = await searchPool({
        cost: istKostenklasse(q.cost) ? q.cost : 'any',
        provider: q.provider,
        query: q.query,
        minContext: q.min_context ? Number(q.min_context) : undefined,
        capabilities: q.capabilities ? q.capabilities.split(',').filter(Boolean) : undefined,
        sort: q.sort === 'name' || q.sort === 'price' ? q.sort : 'context',
        limit: q.limit ? Number(q.limit) : 500,
        includeDeprecated: !nurNutzbare,
        includeCooling: !nurNutzbare,
        includeForbidden: !nurNutzbare,
        onlyReachable: nurNutzbare,
      });
      return {
        success: true,
        count: ergebnis.models.length,
        matched: ergebnis.matched,
        total: ergebnis.total,
        fetchedAt: ergebnis.fetchedAt,
        models: ergebnis.models,
      };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  fastify.get('/api/model-pool/providers', async (_request, reply) => {
    try {
      return { success: true, providers: await getPoolProviders() };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  /**
   * Freigabe setzen oder zuruecknehmen.
   * `decision`: "allow" | "deny" | "reset" — Letzteres stellt die Standardregel
   * wieder her (kostenlos ja, alles andere nein).
   */
  fastify.put<{
    Body: { ref?: string; decision?: string; reason?: string };
  }>('/api/model-pool/allowed', async (request, reply) => {
    const ref = request.body?.ref;
    const entscheidung = request.body?.decision;
    if (!ref) return fehler(reply, new Error('ref ist erforderlich'), 400);
    if (entscheidung !== 'allow' && entscheidung !== 'deny' && entscheidung !== 'reset') {
      return fehler(reply, new Error('decision muss "allow", "deny" oder "reset" sein'), 400);
    }
    try {
      const modell = await setzeModellFreigabe(
        ref,
        entscheidung === 'reset' ? null : entscheidung === 'allow',
        request.body?.reason,
      );
      return { success: true, model: modell };
    } catch (error) {
      return fehler(reply, error, 400);
    }
  });

  /** Datenverwendung setzen — begrenzt mittelbar, in welcher Rolle ein Modell laufen darf. */
  fastify.put<{
    Body: { ref?: string; data_use?: string };
  }>('/api/model-pool/data-use', async (request, reply) => {
    const ref = request.body?.ref;
    const verwendung = request.body?.data_use;
    if (!ref) return fehler(reply, new Error('ref ist erforderlich'), 400);
    if (verwendung !== 'private' && verwendung !== 'retained' && verwendung !== 'training' && verwendung !== 'unknown') {
      return fehler(reply, new Error('data_use muss private, retained, training oder unknown sein'), 400);
    }
    try {
      const modell = await getPoolModel(ref);
      if (!modell) return fehler(reply, new Error('Modell nicht im Katalog'), 404);
      await setzeDatenverwendung(modell.ref, verwendung);
      return { success: true, ref: modell.ref, data_use: verwendung };
    } catch (error) {
      return fehler(reply, error, 400);
    }
  });

  /** Erreichbarkeit eines Anbieters mit einem echten, minimalen Aufruf pruefen. */
  fastify.post<{ Params: { provider: string }; Body?: { model?: string } }>(
    '/api/model-pool/providers/:provider/probe',
    async (request, reply) => {
      try {
        return { success: true, provider: await probeProvider(request.params.provider, request.body?.model) };
      } catch (error) {
        return fehler(reply, error, 400);
      }
    },
  );

  fastify.post('/api/model-pool/refresh', async (_request, reply) => {
    try {
      const daten = await getPoolSnapshot(true);
      return {
        success: true,
        fetchedAt: daten.fetchedAt,
        models: daten.models.length,
        free: daten.models.filter((m) => m.costClass === 'free').length,
      };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  fastify.get('/api/model-pool/aliases', async (_request, reply) => {
    try {
      return { success: true, aliases: await listeAliase() };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  fastify.get('/api/model-pool/cooldowns', async (_request, reply) => {
    try {
      return { success: true, cooldowns: listeSperren() };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  /** Alle Sperren aufheben — fuer einen bewussten Neuversuch aus der Oberflaeche. */
  fastify.delete('/api/model-pool/cooldowns', async (_request, reply) => {
    try {
      return { success: true, cleared: loescheSperren() };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  fastify.get<{ Querystring: { limit?: string } }>('/api/model-pool/events', async (request, reply) => {
    try {
      const limit = request.query.limit ? Number(request.query.limit) : 50;
      return { success: true, events: await leseProtokoll(limit) };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  /** Hinterlegte Zugaenge — ohne die Schluessel selbst. */
  fastify.get<{ Querystring: { provider?: string } }>('/api/model-pool/credentials', async (request, reply) => {
    try {
      return { success: true, credentials: await listeCredentials(request.query.provider) };
    } catch (error) {
      return fehler(reply, error);
    }
  });

  fastify.post<{
    Body: {
      provider?: string;
      label?: string;
      secret_ref?: string;
      api_key?: string;
      has_payment_method?: boolean;
      priority?: number;
    };
  }>('/api/model-pool/credentials', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.provider || !body.label) {
      return fehler(reply, new Error('provider und label sind erforderlich'), 400);
    }
    if (!body.secret_ref && !body.api_key) {
      return fehler(
        reply,
        new Error('Entweder secret_ref (Name einer Umgebungsvariablen, empfohlen) oder api_key angeben'),
        400,
      );
    }
    try {
      const id = await speichereCredential({
        provider: body.provider,
        label: body.label,
        secretRef: body.secret_ref ?? null,
        apiKey: body.api_key ?? null,
        // Sicherer Standard: ohne ausdrueckliche Angabe gilt ein Zugang als
        // abrechenbar. Ein zu vorsichtiges Ja kostet nichts.
        hasPaymentMethod: body.has_payment_method !== false,
        priority: body.priority,
      });
      return { success: true, id };
    } catch (error) {
      return fehler(reply, error, 400);
    }
  });
}
