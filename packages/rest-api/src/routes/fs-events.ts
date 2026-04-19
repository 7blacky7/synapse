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

// Akzeptiert beide Konventionen:
//   Legacy REST-Form:  added / modified / deleted
//   Chokidar/Core:     add   / change   / unlink   (ab moo-Daemon Phase-1)
type EventTyp = 'added' | 'modified' | 'deleted' | 'add' | 'change' | 'unlink';
type NormalizedTyp = 'added' | 'modified' | 'deleted';

const TYP_ALIAS: Record<string, NormalizedTyp> = {
  add: 'added',
  added: 'added',
  change: 'modified',
  modified: 'modified',
  unlink: 'deleted',
  deleted: 'deleted',
};

interface FsEventBody {
  projekt: string;
  typ: EventTyp;
  pfad: string;
  mtime?: number;
}

export async function fsEventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: FsEventBody }>('/api/fs/events', async (request, reply) => {
    const { projekt, typ: rawTyp, pfad } = request.body ?? ({} as FsEventBody);

    if (!projekt || !rawTyp || !pfad) {
      return reply.status(400).send({
        success: false,
        error: { message: 'projekt, typ, pfad sind erforderlich' },
      });
    }

    const typ = TYP_ALIAS[rawTyp];
    if (!typ) {
      return reply.status(400).send({
        success: false,
        error: { message: `unbekannter typ: ${rawTyp}` },
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
