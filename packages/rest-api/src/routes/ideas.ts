/**
 * Synapse API - Ideas Routes
 * Projekt-Ideen mit automatischer Namensgenerierung und Bestaetigungs-Workflow
 */

import { FastifyInstance } from 'fastify';
import { writeMemory, getMemoryByName } from '@synapse/core';

/** Temporaerer Speicher fuer unbestaetigte Ideen */
interface PendingIdea {
  content: string;
  project: string;
  suggestedName: string;
  tags: string[];
  createdAt: Date;
}

const pendingIdeas = new Map<string, PendingIdea>();

/**
 * Generiert einen eindeutigen Namen aus dem Content
 */
function generateIdeaName(content: string): string {
  const stopwords = new Set([
    'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'fuer', 'mit', 'von', 'zu', 'auf',
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'on', 'in', 'is', 'are', 'be',
    'that', 'this', 'it', 'as', 'at', 'by', 'from', 'into', 'of', 'about', 'should',
    'could', 'would', 'will', 'can', 'may', 'might', 'must', 'shall', 'need', 'want',
    'ich', 'du', 'wir', 'sie', 'er', 'es', 'man', 'kann', 'soll', 'wird',
  ]);

  const words = content
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u00E4\u00F6\u00FC\u00C4\u00D6\u00DC\u00DF\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  const keywords = words.slice(0, 3);
  const date = new Date().toISOString().split('T')[0];
  const namePart = keywords.length > 0 ? keywords.join('-') : 'idea';

  return `idea-${namePart}-${date}`;
}

/**
 * Generiert eine kurze Vorschau des Contents
 */
function generatePreview(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.substring(0, maxLength).trim() + '...';
}

/**
 * Generiert eine eindeutige temporaere ID
 */
function generateTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Entfernt abgelaufene Ideen (aelter als 30 Minuten)
 */
function cleanupExpiredIdeas(): void {
  const now = Date.now();
  for (const [id, idea] of pendingIdeas.entries()) {
    if (now - idea.createdAt.getTime() > 30 * 60 * 1000) {
      pendingIdeas.delete(id);
    }
  }
}

export async function ideasRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/projects/:name/ideas
   * Idee vormerken (temporaer, nicht in Qdrant)
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      content: string;
      tags?: string[];
    };
  }>('/api/projects/:name/ideas', async (request, reply) => {
    const { name } = request.params;
    const { content, tags = [] } = request.body;

    if (!content || content.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        error: { message: 'content ist erforderlich und darf nicht leer sein' },
      });
    }

    // Abgelaufene Ideen aufraemen
    cleanupExpiredIdeas();

    const suggestedName = generateIdeaName(content);
    const tempId = generateTempId();
    const preview = generatePreview(content);

    // Temporaer speichern (nur im Arbeitsspeicher)
    pendingIdeas.set(tempId, {
      content,
      project: name,
      suggestedName,
      tags,
      createdAt: new Date(),
    });

    return {
      success: true,
      tempId,
      suggestedName,
      preview,
      project: name,
      confirmationRequired: true,
      message: `Idee vorgemerkt. Vorgeschlagener Name: "${suggestedName}". Bitte mit /api/projects/${name}/ideas/confirm bestaetigen oder eigenen Namen angeben.`,
    };
  });

  /**
   * POST /api/projects/:name/ideas/confirm
   * Vorgemerkte Idee bestaetigen und persistent speichern
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      tempId: string;
      customName?: string;
    };
  }>('/api/projects/:name/ideas/confirm', async (request, reply) => {
    const { name } = request.params;
    const { tempId, customName } = request.body;

    if (!tempId) {
      return reply.status(400).send({
        success: false,
        error: { message: 'tempId ist erforderlich' },
      });
    }

    const pendingIdea = pendingIdeas.get(tempId);

    if (!pendingIdea) {
      return reply.status(404).send({
        success: false,
        error: { message: `Keine vorgemerkte Idee mit ID "${tempId}" gefunden. Ideen werden nach 30 Minuten automatisch geloescht.` },
      });
    }

    // Projekt aus URL muss zum gespeicherten Projekt passen
    if (pendingIdea.project !== name) {
      return reply.status(400).send({
        success: false,
        error: { message: `Idee gehoert zu Projekt "${pendingIdea.project}", nicht zu "${name}"` },
      });
    }

    const finalName = customName?.trim() || pendingIdea.suggestedName;

    try {
      // Pruefen ob Name schon existiert
      const existing = await getMemoryByName(name, finalName);
      if (existing) {
        return reply.status(409).send({
          success: false,
          error: { message: `Ein Memory mit dem Namen "${finalName}" existiert bereits. Bitte anderen Namen waehlen.` },
        });
      }

      // Als Memory persistent speichern
      const memory = await writeMemory(
        name,
        finalName,
        pendingIdea.content,
        'note',
        [...pendingIdea.tags, 'idea']
      );

      // Aus temporaerem Speicher entfernen
      pendingIdeas.delete(tempId);

      return {
        success: true,
        name: finalName,
        project: name,
        memory: {
          name: memory.name,
          category: memory.category,
          tags: memory.tags,
          sizeChars: memory.content.length,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        },
        message: `Idee "${finalName}" erfolgreich gespeichert in Projekt "${name}".`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
