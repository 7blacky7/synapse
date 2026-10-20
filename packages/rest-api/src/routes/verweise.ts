/**
 * Synapse API - Verweise (P8-T31)
 * POST /api/projects/:name/verweise/aufloesen   gebuendelte Aufloesung von Kandidaten
 * GET  /api/projects/:name/verweise/:art/:id    Inhalt als Klartext (nie rohes JSON)
 */

import { FastifyInstance } from 'fastify';
import {
  KANDIDATEN_MAX,
  istVerweisArt,
  leseVerweis,
  loeseVerweiseAuf,
  type VerweisKandidat,
} from '../services/verweise.js';

const HINWEISE = ['event', 'nachricht', 'chat', 'memory', 'asset'];

export async function verweiseRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Params: { name: string };
    Body: { kandidaten?: Array<{ text?: unknown; hinweis?: unknown }> };
  }>('/api/projects/:name/verweise/aufloesen', async (request, reply) => {
    const roh = request.body?.kandidaten;
    if (!Array.isArray(roh)) {
      return reply.status(400).send({ success: false, error: { message: 'kandidaten (Array) ist erforderlich' } });
    }
    const kandidaten: VerweisKandidat[] = roh
      .filter((k) => k && typeof k.text === 'string')
      .slice(0, KANDIDATEN_MAX)
      .map((k) => ({
        text: String(k.text),
        hinweis: typeof k.hinweis === 'string' && HINWEISE.includes(k.hinweis) ? (k.hinweis as VerweisKandidat['hinweis']) : undefined,
      }));
    try {
      const ergebnisse = await loeseVerweiseAuf(request.params.name, kandidaten);
      return { success: true, ergebnisse };
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  fastify.get<{
    Params: { name: string; art: string; id: string };
  }>('/api/projects/:name/verweise/:art/:id', async (request, reply) => {
    const { name, art, id } = request.params;
    if (!istVerweisArt(art)) {
      return reply.status(400).send({ success: false, error: { message: 'Unbekannte Art: ' + art } });
    }
    try {
      const verweis = await leseVerweis(name, art, decodeURIComponent(id));
      if (!verweis) {
        return reply.status(404).send({ success: false, error: { message: art + ' ' + id + ' nicht gefunden' } });
      }
      return { success: true, verweis };
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });
}
