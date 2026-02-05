/**
 * ============================================================================
 * MODUL: Chat Sessions Routes
 * ============================================================================
 * ZWECK: Session-Verwaltung (Liste, Details, Loeschen)
 * INPUT: sessionId fuer Details/Loeschen
 * OUTPUT: Session-Liste, Session-Details, Loesch-Bestaetigung
 * ABHÄNGIGKEITEN: claude-client, image-processing, types
 * HINWEISE: Verwaltet sowohl Chat-History als auch Session-Bilder
 * ============================================================================
 */

import { FastifyInstance } from 'fastify';
import {
  getSessionHistory,
  clearSession,
  listSessions
} from '../../services/claude-client.js';
import { deleteTempImage } from '../../services/image-processing.js';
import { sessionImages } from './types.js';

/**
 * Registriert alle Session-Verwaltungs-Endpoints
 */
export async function sessionsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/chat/sessions - Liste aller Sessions
  fastify.get('/api/chat/sessions', async () => {
    const sessions = listSessions();
    return {
      sessions: sessions.map(sid => ({
        id: sid,
        preview: sid.substring(0, 8) + '...',
        hasImage: sessionImages.has(sid)
      })),
      count: sessions.length
    };
  });

  // GET /api/chat/sessions/:sessionId - Session-Details
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/chat/sessions/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const history = getSessionHistory(sessionId);

      if (history.length === 0) {
        return reply.status(404).send({ error: 'Session nicht gefunden' });
      }

      return {
        sessionId,
        messages: history,
        count: history.length,
        imagePath: sessionImages.get(sessionId)
      };
    }
  );

  // DELETE /api/chat/sessions/:sessionId - Session loeschen
  fastify.delete<{ Params: { sessionId: string } }>(
    '/api/chat/sessions/:sessionId',
    async (request) => {
      const { sessionId } = request.params;

      // Temp-Bild loeschen falls vorhanden
      const imagePath = sessionImages.get(sessionId);
      if (imagePath) {
        deleteTempImage(imagePath);
        sessionImages.delete(sessionId);
      }

      clearSession(sessionId);
      return { success: true, sessionId };
    }
  );
}
