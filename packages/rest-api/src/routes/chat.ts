/**
 * Synapse API - Chat Routes
 * Chat-Interface mit Kontext aus Synapse + Bildverarbeitung
 * Claude CLI Subprocess mit Session-Persistenz
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import {
  searchCode,
  searchMemories,
  searchThoughts,
} from '@synapse/core';
import {
  generateClaudeResponse,
  isClaudeAvailable,
  getSessionHistory,
  clearSession,
  listSessions
} from '../services/claude-client.js';
import {
  saveBase64AsTemp,
  deleteTempImage,
  loadImage,
  analyzeImage,
  smartCut,
  applyFilter,
  toBase64,
  extractSelectionBase64,
  selectObject
} from '../services/image-processing.js';

interface ChatRequest {
  message: string;
  project?: string;
  image?: string;  // Base64 encoded
  sessionId?: string;
}

interface ContextSource {
  source: string;
  preview: string;
}

// Session-Images: Speichert temporaere Bildpfade pro Session
const sessionImages = new Map<string, string>();

/**
 * Erkennt ob eine Nachricht eine "Erinnerst du dich" Anfrage ist
 */
function isRecallQuery(message: string): boolean {
  const recallPatterns = [
    /erinnerst du dich/i,
    /weisst du noch/i,
    /was weisst du ueber/i,
    /was war das mit/i,
    /remember/i,
    /recall/i,
    /do you know about/i,
  ];
  return recallPatterns.some((p) => p.test(message));
}

/**
 * Erkennt Bildbearbeitungs-Intent
 */
function detectImageIntent(message: string): string | null {
  const intents: { pattern: RegExp; action: string }[] = [
    { pattern: /analys/i, action: 'analyze' },
    { pattern: /schneide.*aus|ausschneiden|cut|extract/i, action: 'smart-cut' },
    { pattern: /filter|effekt|schwarz.?wei|grau|sepia|blur|scharf/i, action: 'filter' },
    { pattern: /zeig|schau|sieh|look|show/i, action: 'view' },
  ];

  for (const { pattern, action } of intents) {
    if (pattern.test(message)) {
      return action;
    }
  }
  return null;
}

/**
 * Extrahiert Suchbegriffe aus einer Nachricht
 */
function extractSearchTerms(message: string): string {
  return message
    .replace(/erinnerst du dich an/i, '')
    .replace(/weisst du noch/i, '')
    .replace(/was weisst du ueber/i, '')
    .replace(/was war das mit/i, '')
    .replace(/do you remember/i, '')
    .replace(/do you recall/i, '')
    .replace(/what do you know about/i, '')
    .replace(/\?/g, '')
    .trim();
}

/**
 * Sammelt Kontext aus verschiedenen Quellen
 */
async function gatherContext(
  query: string,
  project?: string
): Promise<{
  memories: ContextSource[];
  thoughts: ContextSource[];
  code: ContextSource[];
}> {
  const memories: ContextSource[] = [];
  const thoughts: ContextSource[] = [];
  const code: ContextSource[] = [];

  try {
    const memoryResults = await searchMemories(query, project, 3);
    for (const m of memoryResults) {
      memories.push({
        source: `Memory: ${m.payload.name}`,
        preview: m.payload.content.substring(0, 200),
      });
    }
  } catch { /* Ignore */ }

  try {
    const thoughtResults = await searchThoughts(query, project, 3);
    for (const t of thoughtResults) {
      thoughts.push({
        source: `Thought (${t.payload.source})`,
        preview: t.payload.content.substring(0, 200),
      });
    }
  } catch { /* Ignore */ }

  if (project) {
    try {
      const codeResults = await searchCode(query, project, undefined, 3);
      for (const c of codeResults) {
        code.push({
          source: `Code: ${c.payload.file_name}:${c.payload.line_start}`,
          preview: c.payload.content.substring(0, 200),
        });
      }
    } catch { /* Ignore */ }
  }

  return { memories, thoughts, code };
}

/**
 * Fallback-Antwort ohne Claude
 */
function generateFallbackResponse(
  message: string,
  context: { memories: ContextSource[]; thoughts: ContextSource[]; code: ContextSource[] },
  isRecall: boolean
): string {
  const allContext = [...context.memories, ...context.thoughts, ...context.code];

  if (allContext.length === 0) {
    if (isRecall) {
      return 'Ich habe leider keine Erinnerungen zu diesem Thema gefunden.';
    }
    return 'Ich habe keinen relevanten Kontext zu dieser Anfrage gefunden.';
  }

  const parts: string[] = [];
  parts.push(isRecall ? 'Ja, ich erinnere mich! Hier ist was ich gefunden habe:\n' : 'Hier ist der relevante Kontext:\n');

  if (context.memories.length > 0) {
    parts.push('\n**Memories:**');
    for (const m of context.memories) {
      parts.push(`\n- ${m.source}: ${m.preview}...`);
    }
  }

  if (context.thoughts.length > 0) {
    parts.push('\n\n**Gedanken:**');
    for (const t of context.thoughts) {
      parts.push(`\n- ${t.source}: ${t.preview}...`);
    }
  }

  if (context.code.length > 0) {
    parts.push('\n\n**Code:**');
    for (const c of context.code) {
      parts.push(`\n- ${c.source}`);
    }
  }

  return parts.join('');
}

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/chat
   * Hauptendpoint fuer Chat mit optionalem Bild
   */
  fastify.post<{ Body: ChatRequest }>(
    '/api/chat',
    {
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
    },
    async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
      const { message, project, image, sessionId } = request.body;

      if (!message?.trim()) {
        return reply.status(400).send({ error: 'Nachricht darf nicht leer sein' });
      }

      const sid = sessionId || randomUUID();
      let imagePath: string | undefined;
      let userMessageWithImage = message;

      // ================================================================
      // BILD-VERARBEITUNG
      // ================================================================
      if (image) {
        // Base64 -> Temp-Datei
        imagePath = saveBase64AsTemp(image, 'png');
        sessionImages.set(sid, imagePath);

        // Fuege Bildpfad zur Nachricht hinzu damit Claude es sehen kann
        userMessageWithImage = `${message}\n\n[BILD HOCHGELADEN: ${imagePath}]\nBitte schau dir das Bild an und antworte entsprechend.`;

        console.log(`[Chat] Bild fuer Session ${sid.substring(0, 8)} gespeichert: ${imagePath}`);
      }

      // Prüfe ob vorheriges Bild in Session existiert
      const existingImage = sessionImages.get(sid);
      if (existingImage && !image) {
        // User referenziert moeglicherweise vorheriges Bild
        const imageIntent = detectImageIntent(message);
        if (imageIntent) {
          userMessageWithImage = `${message}\n\n[VORHERIGES BILD VERFUEGBAR: ${existingImage}]\nDu kannst dieses Bild fuer die Aktion "${imageIntent}" verwenden.`;
        }
      }

      // Kontext sammeln
      const isRecall = isRecallQuery(message);
      const searchQuery = isRecall ? extractSearchTerms(message) : message;
      const context = await gatherContext(searchQuery, project);
      const allContext = [...context.memories, ...context.thoughts, ...context.code];

      // Antwort generieren
      let responseMessage: string;
      const hasImage = !!image || !!existingImage;

      if (isClaudeAvailable()) {
        responseMessage = await generateClaudeResponse(
          userMessageWithImage,
          context,
          project,
          sid,
          undefined,
          hasImage
        );
      } else {
        responseMessage = generateFallbackResponse(message, context, isRecall);
      }

      return {
        message: responseMessage,
        sessionId: sid,
        hasImage: hasImage,
        imagePath: imagePath,
        context: allContext.length > 0 ? allContext : undefined,
      };
    }
  );

  /**
   * GET /api/chat/sessions
   */
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

  /**
   * GET /api/chat/sessions/:sessionId
   */
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

  /**
   * DELETE /api/chat/sessions/:sessionId
   */
  fastify.delete<{ Params: { sessionId: string } }>(
    '/api/chat/sessions/:sessionId',
    async (request) => {
      const { sessionId } = request.params;

      // Temp-Bild loeschen
      const imagePath = sessionImages.get(sessionId);
      if (imagePath) {
        deleteTempImage(imagePath);
        sessionImages.delete(sessionId);
      }

      clearSession(sessionId);
      return { success: true, sessionId };
    }
  );

  /**
   * POST /api/chat/image/analyze
   * Analysiert ein Bild direkt
   */
  fastify.post<{ Body: { image: string; sessionId?: string } }>(
    '/api/chat/image/analyze',
    async (request, reply) => {
      const { image, sessionId } = request.body;

      if (!image) {
        return reply.status(400).send({ error: 'Bild erforderlich' });
      }

      const sid = sessionId || randomUUID();
      const imagePath = saveBase64AsTemp(image, 'png');
      sessionImages.set(sid, imagePath);

      // Bild laden und analysieren
      await loadImage(imagePath);
      const analysis = await analyzeImage('auto');

      return {
        success: true,
        sessionId: sid,
        imagePath,
        analysis: analysis.data
      };
    }
  );

  /**
   * POST /api/chat/image/process
   * Verarbeitet ein Bild mit ai_photoshop
   */
  fastify.post<{ Body: { sessionId: string; action: string; params?: any } }>(
    '/api/chat/image/process',
    async (request, reply) => {
      const { sessionId, action, params } = request.body;

      const imagePath = sessionImages.get(sessionId);
      if (!imagePath) {
        return reply.status(404).send({ error: 'Kein Bild in dieser Session' });
      }

      let result;

      switch (action) {
        case 'analyze':
          await loadImage(imagePath);
          result = await analyzeImage(params?.method || 'auto');
          break;

        case 'smart-cut':
          const outputDir = params?.outputDir || `${imagePath}_cuts`;
          result = await smartCut(imagePath, outputDir);
          break;

        case 'filter':
          await loadImage(imagePath);
          result = await applyFilter(params?.filter || 'grayscale', params);
          break;

        case 'select':
          result = await selectObject(params?.objectId || 0);
          break;

        case 'extract':
          result = await extractSelectionBase64(params?.format || 'PNG', params?.padding || 0);
          break;

        case 'to-base64':
          await loadImage(imagePath);
          result = await toBase64(params?.format || 'PNG');
          break;

        default:
          return reply.status(400).send({ error: `Unbekannte Aktion: ${action}` });
      }

      return {
        success: result.success,
        action,
        result: result.data,
        error: result.error
      };
    }
  );
}
