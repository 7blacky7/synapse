/**
 * Synapse API - Tech Routes
 * Technologie-Erkennung und Framework-Dokumentation indexieren
 */

import { FastifyInstance } from 'fastify';
import {
  detectTechnologies,
  indexProjectTechnologies,
} from '@synapse/core';
import type { DetectedTechnology } from '@synapse/core';

export async function techRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/tech/detect
   * Erkennt verwendete Technologien in einem Projekt
   */
  fastify.post<{
    Body: {
      path: string;
    };
  }>('/api/tech/detect', async (request, reply) => {
    const { path } = request.body;

    if (!path) {
      return reply.status(400).send({
        success: false,
        error: { message: 'path ist erforderlich' },
      });
    }

    try {
      const technologies = await detectTechnologies(path);

      const summary = technologies.length > 0
        ? `${technologies.length} Technologien erkannt:\n` +
          technologies.map(t => `- ${t.name}${t.version ? ` v${t.version}` : ''} (${t.type})`).join('\n')
        : 'Keine Technologien erkannt';

      return {
        success: true,
        technologies,
        message: summary,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/tech/index-docs
   * Erkennt Technologien und indexiert deren Framework-Dokumentation
   */
  fastify.post<{
    Body: {
      path: string;
      forceReindex?: boolean;
    };
  }>('/api/tech/index-docs', async (request, reply) => {
    const { path, forceReindex = false } = request.body;

    if (!path) {
      return reply.status(400).send({
        success: false,
        error: { message: 'path ist erforderlich' },
      });
    }

    try {
      // Erst Technologien erkennen
      const technologies = await detectTechnologies(path);

      if (technologies.length === 0) {
        return {
          success: true,
          technologies: [],
          indexed: true,
          message: 'Keine Technologien erkannt - nichts zu indexieren',
        };
      }

      // Dokumentation indexieren
      const result = await indexProjectTechnologies(technologies, forceReindex);

      return {
        success: true,
        technologies,
        indexed: true,
        message: `${result.indexed} Docs indexiert, ${result.cached} bereits gecacht (${technologies.length} Technologien erkannt)`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
