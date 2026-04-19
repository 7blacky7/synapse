/**
 * Synapse API - FS-Events vom FileWatcher-Daemon
 *
 * Der moo-basierte Daemon (packages/file-watcher-daemon/) postet pro
 * FS-Change einen Event an diesen Endpoint. Wir delegieren an das Core-
 * Indexing: added/modified → indexFile, deleted → removeFile.
 */

import { FastifyInstance } from 'fastify';
import path from 'node:path';
import { indexFile, removeFile, getProjectRoot } from '@synapse/core';

type EventTyp = 'added' | 'modified' | 'deleted';

interface FsEventBody {
  projekt: string;
  typ: EventTyp;
  pfad: string;
  mtime?: number;
}

export async function fsEventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: FsEventBody }>('/api/fs/events', async (request, reply) => {
    const { projekt, typ, pfad } = request.body ?? ({} as FsEventBody);

    if (!projekt || !typ || !pfad) {
      return reply.status(400).send({
        success: false,
        error: { message: 'projekt, typ, pfad sind erforderlich' },
      });
    }

    if (typ !== 'added' && typ !== 'modified' && typ !== 'deleted') {
      return reply.status(400).send({
        success: false,
        error: { message: `unbekannter typ: ${typ}` },
      });
    }

    const projectRoot = await getProjectRoot(projekt);
    if (!projectRoot) {
      return reply.status(404).send({
        success: false,
        error: { message: `unbekanntes Projekt: ${projekt}` },
      });
    }

    // Daemon liefert absolute Pfade. Core-Indexing erwartet projekt-relative.
    let relPath = pfad;
    if (path.isAbsolute(relPath)) {
      relPath = path.relative(projectRoot, relPath);
    }

    try {
      if (typ === 'deleted') {
        await removeFile(relPath, projekt);
      } else {
        await indexFile(relPath, projekt, projectRoot);
      }
      return reply.status(200).send({ success: true });
    } catch (err) {
      fastify.log.error({ err, projekt, typ, pfad }, 'fs-event processing failed');
      return reply.status(500).send({
        success: false,
        error: { message: (err as Error).message },
      });
    }
  });
}
