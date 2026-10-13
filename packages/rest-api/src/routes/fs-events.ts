/**
 * Synapse API - FS-Events vom FileWatcher-Daemon
 *
 * Der moo-basierte Daemon (packages/file-watcher-daemon/) postet pro
 * FS-Change einen Event an diesen Endpoint. Wir delegieren an das Core-
 * Indexing: added/modified → indexFile, deleted → removeFile.
 */

import { FastifyInstance } from 'fastify';
import path from 'node:path';
import {dispatchAssetFsEreignis,istAssetFsEreignis} from './assets.js';
import type {AssetFsEingang} from './assets.js';
import {AssetUploadFehler,AssetSpeicherFehler} from '@synapse/core';
import {
  indexFile,
  indexDocument,
  removeFile,
  getProjectRoot,
  isProjectEnabled,
  klassifiziereDatei,
  assetArt,
} from '@synapse/core';

// Akzeptiert beide Konventionen:
//   Legacy REST-Form:  added / modified / deleted
//   Chokidar/Core:     add   / change   / unlink   (ab moo-Daemon Phase-1)
type EventTyp = 'added' | 'modified' | 'deleted' | 'add' | 'change' | 'unlink' | 'verschoben' | 'moved' | 'wiederhergestellt' | 'restored';
type NormalizedTyp = 'added' | 'modified' | 'deleted';

const TYP_ALIAS: Record<string, NormalizedTyp> = {
  add: 'added',
  added: 'added',
  change: 'modified',
  modified: 'modified',
  unlink: 'deleted',
  deleted: 'deleted',
};

interface FsEventBody extends Omit<AssetFsEingang,'typ'|'pfad'> {
  projekt: string;
  typ: EventTyp;
  pfad: string;
  mtime?: number;
}

export async function fsEventsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: FsEventBody }>('/api/fs/events', async (request, reply) => {
    const { projekt, typ: rawTyp, pfad } = request.body ?? ({} as FsEventBody);

    // P13-T25: only new asset payloads branch before ANY code removal/project-root lookup.
    if(istAssetFsEreignis(request.body)){
      try{return reply.status(200).send(await dispatchAssetFsEreignis(request,request.body));}
      catch(err){
        if(err instanceof AssetUploadFehler)return reply.status(err.httpStatus).send({success:false,error:{code:err.code,message:err.message}});
        if(err instanceof AssetSpeicherFehler)return reply.status(400).send({success:false,error:{code:err.code,message:err.message}});
        fastify.log.error({err,projekt},'asset fs-event processing failed');return reply.status(500).send({success:false,error:{message:(err as Error).message}});
      }
    }

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
        let enabled: boolean;
        try {
          enabled = await isProjectEnabled(projekt);
        } catch (err) {
          fastify.log.error({ err, projekt, typ, pfad }, 'project status check failed');
          return reply.status(503).send({
            success: false,
            error: { message: 'Projektstatus nicht lesbar' },
          });
        }
        if (!enabled) {
          return reply.status(200).send({ success: true, uebersprungen: 'project_disabled' });
        }

        // ASSETS (P4-T67): inspiziert wird nur im lokalen Watcher-Prozess, der die Datei sieht.
        // Dieser Prozess inspiziert NIE, und Binaerdateien gehoeren nicht in den Code-Weg.
        // Die Datei liegt hier nicht vor -> Entscheidung allein nach der Endung.
        if (assetArt(relPath) === 'nur_asset') {
          return reply.status(200).send({ success: true, uebersprungen: 'asset_nur_lokal' });
        }

        // KLASSIFIKATION PFLICHT — siehe klassifiziereDatei. Dieser Endpunkt hatte
        // bis zum 28.07.2026 ueberhaupt keine Pruefung, weder Extension noch
        // Magic Bytes, und schob jede gemeldete Datei durch den Text-Pfad.
        const art = klassifiziereDatei(relPath);
        if (art === 'media') {
          return reply.status(200).send({ success: true, uebersprungen: 'media' });
        }
        if (art === 'dokument') {
          await indexDocument(relPath, projekt);
        } else {
          await indexFile(relPath, projekt, projectRoot);
        }
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
