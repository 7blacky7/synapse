/** P13-T14: öffentliche Einmal-Bildroute, Erzeugen/Prüfen bleibt hinter Auth. */
import type { FastifyInstance } from 'fastify';
import { BildprobeDienst } from '@synapse/core';
export const bildprobeDienst = new BildprobeDienst(undefined, { kennung: 'api' });
export async function bildprobeRoutes(fastify: FastifyInstance, opts: { dienst?: BildprobeDienst } = {}): Promise<void> {
  const dienst = opts.dienst ?? bildprobeDienst;
  fastify.post<{ Body: Record<string, unknown> }>('/api/bildprobe', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return dienst.ausfuehren(request.body ?? {});
  });
  fastify.get<{ Params: { token: string } }>('/api/bildprobe/:token', async (request, reply) => {
    reply.header('Cache-Control', 'no-store, max-age=0');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    const result = dienst.abrufen(request.params.token, {
      ip: request.ip, userAgent: String(request.headers['user-agent'] ?? ''),
    });
    if (result.status !== 200) return reply.code(410).send({ error: 'bildprobe_verbraucht_oder_abgelaufen' });
    return reply.type('image/png').send(result.png);
  });
}
