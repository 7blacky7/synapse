/**
 * ============================================================================
 * MODUL: Chat Status Route (SSE)
 * ============================================================================
 * ZWECK: GET /api/chat/status/:sessionId - Server-Sent Events fuer Live-Status
 * INPUT: sessionId als URL-Parameter
 * OUTPUT: SSE Stream mit Status-Updates
 * ABHÄNGIGKEITEN: image-processing (imageProcessingEvents)
 * HINWEISE: Heartbeat alle 15 Sekunden, Cleanup bei Verbindungsabbruch
 * ============================================================================
 */

import { FastifyInstance } from 'fastify';
import { imageProcessingEvents } from '../../services/image-processing.js';

/**
 * Status-Event Datenstruktur
 */
interface StatusEvent {
  sessionId: string;
  action: string;
  description: string;
}

/**
 * Registriert den SSE Status-Endpoint
 */
export async function statusRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/chat/status/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;

      // SSE Headers setzen
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Event-Listener fuer diese Session
      const onStatus = (data: StatusEvent) => {
        if (data.sessionId === sessionId) {
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      };

      imageProcessingEvents.on('status', onStatus);

      // Heartbeat alle 15 Sekunden um Verbindung offen zu halten
      const heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
      }, 15000);

      // Cleanup bei Verbindungsabbruch
      request.raw.on('close', () => {
        imageProcessingEvents.off('status', onStatus);
        clearInterval(heartbeat);
      });
    }
  );
}
