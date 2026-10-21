import type { FastifyInstance } from 'fastify';
import { ladeAgentennetzwerk } from '../services/agentennetzwerk.js';
/** Initialsnapshot und Wiederabgleich nach SSE-Hinweis; begrenzt, metadaten-only. */
export async function agentennetzwerkRoutes(app: FastifyInstance): Promise<void> {
 app.get<{Params:{name:string}}>('/api/projects/:name/agentennetzwerk', async (request, reply) => {
  reply.header('Cache-Control','no-store');
  try { return await ladeAgentennetzwerk(request.params.name); }
  catch { return reply.code(503).send({ success:false,error:{message:'Agentennetzwerk derzeit nicht erreichbar'} }); }
 });
}
