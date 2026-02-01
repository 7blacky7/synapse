/**
 * ============================================================================
 * MODUL: Chat Image Routes
 * ============================================================================
 * ZWECK: Bildverarbeitungs-Endpoints (Analyse, Verarbeitung)
 * INPUT: Base64-Bilder, Session-IDs, Aktionen mit Parametern
 * OUTPUT: Analyse-Ergebnisse, verarbeitete Bilder
 * ABHÄNGIGKEITEN: image-processing Service, types
 * HINWEISE: Nutzt ai_photoshop fuer erweiterte Bildverarbeitung
 * ============================================================================
 */

import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import {
  saveBase64AsTemp,
  loadImage,
  analyzeImage,
  smartCut,
  applyFilter,
  toBase64,
  extractSelectionBase64,
  selectObject,
} from '../../services/image-processing.js';
import type { ImageAnalyzeRequest, ImageProcessRequest } from './types.js';
import { sessionImages } from './types.js';

/**
 * Registriert alle Bild-Endpoints
 */
export async function imageRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/chat/image/analyze - Direktanalyse
  fastify.post<{ Body: ImageAnalyzeRequest }>(
    '/api/chat/image/analyze',
    async (request, reply) => {
      const { image, sessionId } = request.body;

      if (!image) {
        return reply.status(400).send({ error: 'Bild erforderlich' });
      }

      const sid = sessionId || randomUUID();
      const imagePath = saveBase64AsTemp(image, 'png');
      sessionImages.set(sid, imagePath);

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

  // POST /api/chat/image/process - Allgemeine Verarbeitung
  fastify.post<{ Body: ImageProcessRequest }>(
    '/api/chat/image/process',
    async (request, reply) => {
      const { sessionId, action, params } = request.body;

      const imagePath = sessionImages.get(sessionId);
      if (!imagePath) {
        return reply.status(404).send({ error: 'Kein Bild in dieser Session' });
      }

      const result = await processImageAction(imagePath, action, params);

      if (result.error && result.error.includes('Unbekannte Aktion')) {
        return reply.status(400).send({ error: result.error });
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

// ============================================================================
// Private Hilfsfunktionen
// ============================================================================

/**
 * Analyse-Methoden Typ
 */
type AnalyzeMethod = 'auto' | 'contour' | 'color' | 'edge';

/**
 * Fuehrt eine Bildverarbeitungs-Aktion aus
 */
async function processImageAction(
  imagePath: string,
  action: string,
  params?: Record<string, unknown>
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  switch (action) {
    case 'analyze':
      await loadImage(imagePath);
      return await analyzeImage((params?.method as AnalyzeMethod) || 'auto');

    case 'smart-cut': {
      const outputDir = (params?.outputDir as string) || `${imagePath}_cuts`;
      return await smartCut(imagePath, outputDir);
    }

    case 'filter':
      await loadImage(imagePath);
      return await applyFilter(
        (params?.filter as string) || 'grayscale',
        params as Record<string, unknown> | undefined
      );

    case 'select':
      return await selectObject((params?.objectId as number) || 0);

    case 'extract':
      return await extractSelectionBase64(
        (params?.format as string) || 'PNG',
        (params?.padding as number) || 0
      );

    case 'to-base64':
      await loadImage(imagePath);
      return await toBase64((params?.format as string) || 'PNG');

    default:
      return {
        success: false,
        error: `Unbekannte Aktion: ${action}`
      };
  }
}
