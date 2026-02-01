/**
 * MODUL: Chat Main Route
 * ZWECK: POST /api/chat - Hauptendpoint fuer Chat mit optionalem Bild
 * ABHÄNGIGKEITEN: claude-client, image-processing, helpers, types
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { generateClaudeResponse, isClaudeAvailable } from '../../services/claude-client.js';
import { saveBase64AsTemp, setCurrentSession, clearSessionStatus } from '../../services/image-processing.js';
import type { ChatRequest } from './types.js';
import { sessionImages } from './types.js';
import { isRecallQuery, extractSearchTerms, detectImageIntent, gatherContext, generateFallbackResponse } from './helpers.js';

/** Registriert den Haupt-Chat-Endpoint */
export async function mainChatRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ChatRequest }>('/api/chat', {
    schema: {
      body: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          project: { type: 'string' },
          image: { type: 'string' },
          sessionId: { type: 'string' },
        },
        required: ['message'],
      },
    },
  }, async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
    const { message, project, image, sessionId } = request.body;

    if (!message?.trim()) {
      return reply.status(400).send({ error: 'Nachricht darf nicht leer sein' });
    }

    const sid = sessionId || randomUUID();
    let imagePath: string | undefined;
    let userMessageWithImage = message;

    // Neues Bild verarbeiten
    userMessageWithImage = processNewImage(image, sid, message, userMessageWithImage);
    if (image) imagePath = sessionImages.get(sid);

    // Vorheriges Bild pruefen
    userMessageWithImage = checkExistingImage(sid, image, message, userMessageWithImage);

    // Kontext sammeln und Antwort generieren
    const isRecall = isRecallQuery(message);
    const searchQuery = isRecall ? extractSearchTerms(message) : message;
    const context = await gatherContext(searchQuery, project);
    const allContext = [...context.memories, ...context.thoughts, ...context.code];

    const hasImage = !!image || !!sessionImages.get(sid);
    setCurrentSession(sid);

    try {
      const responseMessage = isClaudeAvailable()
        ? await generateClaudeResponse(userMessageWithImage, context, project, sid, undefined, hasImage)
        : generateFallbackResponse(message, context, isRecall);

      clearSessionStatus(sid);
      return {
        message: responseMessage,
        sessionId: sid,
        hasImage,
        imagePath,
        context: allContext.length > 0 ? allContext : undefined,
      };
    } catch (err) {
      clearSessionStatus(sid);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Synapse API] Fehler: ${errorMessage}`);
      return reply.status(500).send({ error: `Claude-Fehler: ${errorMessage}` });
    }
  });
}

/** Verarbeitet ein neues Bild und speichert es in der Session */
function processNewImage(image: string | undefined, sid: string, message: string, currentMessage: string): string {
  if (!image) return currentMessage;

  console.log(`[DEBUG Chat] image vorhanden, Laenge: ${image.length} chars`);
  const imagePath = saveBase64AsTemp(image, 'png');
  sessionImages.set(sid, imagePath);
  console.log(`[DEBUG Chat] Bild gespeichert: ${imagePath}`);

  return `${message}\n\n[BILD HOCHGELADEN: ${imagePath}]\nBitte schau dir das Bild an und antworte entsprechend.`;
}

/** Prueft ob ein vorheriges Bild in der Session existiert */
function checkExistingImage(sid: string, newImage: string | undefined, message: string, currentMessage: string): string {
  const existingImage = sessionImages.get(sid);
  console.log(`[DEBUG Chat] Session ID: ${sid}, existingImage: ${existingImage || 'keine'}`);

  if (!existingImage || newImage) return currentMessage;

  const imageIntent = detectImageIntent(message);
  console.log(`[DEBUG Chat] imageIntent erkannt: ${imageIntent || 'keiner'}`);

  if (imageIntent) {
    return `${message}\n\n[VORHERIGES BILD VERFUEGBAR: ${existingImage}]\nDu kannst dieses Bild fuer die Aktion "${imageIntent}" verwenden.`;
  }
  return currentMessage;
}
