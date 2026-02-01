/**
 * ============================================================================
 * MODUL: Chat Routes Index
 * ============================================================================
 * ZWECK: Aggregiert und exportiert alle Chat-Sub-Routes
 * INPUT: FastifyInstance
 * OUTPUT: Registrierte Routes unter /api/chat/*
 * ABHÄNGIGKEITEN: main, status, sessions, image Module
 * HINWEISE: Ersetzt die alte monolithische chat.ts
 * ============================================================================
 */

import { FastifyInstance } from 'fastify';
import { mainChatRoute } from './main.js';
import { statusRoute } from './status.js';
import { sessionsRoutes } from './sessions.js';
import { imageRoutes } from './image.js';

// Re-export Types fuer externe Verwendung
export type { ChatRequest, ContextSource, GatheredContext } from './types.js';
export { sessionImages } from './types.js';

/**
 * Registriert alle Chat-Routes
 *
 * Endpoints:
 * - POST /api/chat          - Hauptchat mit optionalem Bild
 * - GET  /api/chat/status/:sessionId - SSE Status-Updates
 * - GET  /api/chat/sessions - Liste aller Sessions
 * - GET  /api/chat/sessions/:sessionId - Session-Details
 * - DELETE /api/chat/sessions/:sessionId - Session loeschen
 * - POST /api/chat/image/analyze - Bildanalyse
 * - POST /api/chat/image/process - Bildverarbeitung
 */
export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  // Alle Sub-Routes registrieren
  await mainChatRoute(fastify);
  await statusRoute(fastify);
  await sessionsRoutes(fastify);
  await imageRoutes(fastify);
}

// Default export fuer Kompatibilitaet
export default chatRoutes;
