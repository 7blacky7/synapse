/**
 * Synapse API - Files Routes
 * Datei-CRUD fuer den Code-Editor (PostgreSQL-basiert)
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplaceEindeutig,
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  getFileContentFromPg,
  holeFehlermusterHinweise,
  resolveAgentId,
  SyntaxfehlerAbgelehnt,
  pruefeFilesPfadArgs,
} from '@synapse/core';

/**
 * P15-T36: dieselbe Pfadpruefung wie files/files_batch (core projekt-pfad.ts) vor jedem Handler dieser
 * Routen. Normalisiert file_path/new_path im Body (der Handler liest danach den normalisierten Pfad) und
 * antwortet bei Ausbruch/absolut/Steuerzeichen (pfad_ungueltig) bzw. gesperrtem Schreibziel (pfad_gesperrt)
 * mit 400. POST = create, DELETE = delete, PUT = operation (ohne operation: update).
 */
async function pfadVorpruefung(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const body = request.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return undefined;
  const name = (request.params as { name?: string }).name ?? '';
  const operation = typeof body.operation === 'string' ? body.operation : undefined;
  const action = request.method === 'POST' ? 'create' : request.method === 'DELETE' ? 'delete' : (operation ?? 'update');
  const pruefArgs: Record<string, unknown> = { action, file_path: body.file_path, new_path: body.new_path };
  const fehler = await pruefeFilesPfadArgs(name, pruefArgs);
  if (fehler) {
    const { success: _success, error: code, ...rest } = fehler;
    return reply.status(400).send({ success: false, error: { code, ...rest } });
  }
  if (typeof pruefArgs.file_path === 'string') body.file_path = pruefArgs.file_path;
  if (typeof pruefArgs.new_path === 'string') body.new_path = pruefArgs.new_path;
  return undefined;
}

/**
 * P15-T17 E2: Fehlermuster-Treffer an die REST-Antwort haengen (Feld fehlermuster, wie MCP seit E0).
 * Vorher stand hier errorPatterns aus result.warnings - das war immer leer: code-write liefert keine
 * warnings, die Pruefung laeuft nebenlaeufig nach dem Schreiben. Jetzt wartet die Antwort kurz
 * (FEHLERMUSTER_WARTE_MS) auf die laufende Pruefung; sonst kommt der Hinweis mit der naechsten
 * Antwort an denselben Agenten (MCP oder REST). Wirft nie.
 */
async function haengeFehlermusterAn(response: Record<string, unknown>, agentId: string | undefined): Promise<void> {
  const fehlermuster = await holeFehlermusterHinweise(resolveAgentId(agentId) ?? undefined);
  if (fehlermuster) response.fehlermuster = fehlermuster;
}

export async function filesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/projects/:name/files
   * Neue Datei erstellen
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      file_path: string;
      content: string;
      agent_id?: string;
      /** P15-T17 E-b: Syntaxbefund quittieren, NUR bei absichtlich fehlerhaftem Inhalt (Pflichtgrund). */
      quittieren?: string;
    };
  }>('/api/projects/:name/files', { preHandler: pfadVorpruefung }, async (request, reply) => {
    const { name } = request.params;
    const { file_path, content, agent_id, quittieren } = request.body;

    if (!file_path || content === undefined) {
      return reply.status(400).send({
        success: false,
        error: { message: 'file_path und content sind erforderlich' },
      });
    }

    try {
      await createFileInPg(name, file_path, content, agent_id, undefined, undefined, undefined, undefined, { einzelweg: true, quittieren });
      const response: Record<string, unknown> = {
        success: true,
        message: `Datei "${file_path}" erstellt (${content.length} Zeichen)`,
      };
      await haengeFehlermusterAn(response, agent_id);
      return response;
    } catch (error) {
      // P15-T17 E-a: Syntaxfehler in geaenderten Zeilen -> nichts geschrieben, 422 mit Befund.
      if (error instanceof SyntaxfehlerAbgelehnt) return reply.status(422).send(error.antwort());
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * PUT /api/projects/:name/files
   * Datei aktualisieren (verschiedene Operationen)
   */
  fastify.put<{
    Params: { name: string };
    Body: {
      file_path: string;
      content?: string;
      operation?: string;
      line_start?: number;
      line_end?: number;
      after_line?: number;
      search?: string;
      replace?: string;
      /** search_replace: alle Vorkommen ersetzen (Default false = Suchtext muss genau einmal vorkommen) */
      replace_all?: boolean;
      new_path?: string;
      agent_id?: string;
      /** P15-T17 E-b: Syntaxbefund quittieren, NUR bei absichtlich fehlerhaftem Inhalt (Pflichtgrund). */
      quittieren?: string;
    };
  }>('/api/projects/:name/files', { preHandler: pfadVorpruefung }, async (request, reply) => {
    const { name } = request.params;
    const {
      file_path,
      content,
      operation,
      line_start,
      line_end,
      after_line,
      search,
      replace,
      replace_all,
      new_path,
      agent_id,
      quittieren,
    } = request.body;
    const einzel = { einzelweg: true, quittieren };

    if (!file_path) {
      return reply.status(400).send({
        success: false,
        error: { message: 'file_path ist erforderlich' },
      });
    }

    try {
      // Kein operation + content -> vollstaendiger Ersatz
      if (!operation) {
        if (content === undefined) {
          return reply.status(400).send({
            success: false,
            error: { message: 'content ist erforderlich wenn keine operation angegeben' },
          });
        }
        await updateFileInPg(name, file_path, content, agent_id, 'update', undefined, undefined, undefined, einzel);
        const response: Record<string, unknown> = {
          success: true,
          message: `Datei "${file_path}" aktualisiert (${content.length} Zeichen)`,
        };
        await haengeFehlermusterAn(response, agent_id);
        return response;
      }

      // Zeilenbasierte Operationen: aktuellen Inhalt laden
      if (
        operation === 'replace_lines' ||
        operation === 'insert_after' ||
        operation === 'delete_lines' ||
        operation === 'search_replace'
      ) {
        const currentContent = await getFileContentFromPg(name, file_path);
        if (currentContent === null) {
          return reply.status(404).send({
            success: false,
            error: { message: `Datei "${file_path}" nicht gefunden in Projekt "${name}"` },
          });
        }

        if (operation === 'replace_lines') {
          if (line_start === undefined || line_end === undefined || content === undefined) {
            return reply.status(400).send({
              success: false,
              error: { message: 'line_start, line_end und content sind fuer replace_lines erforderlich' },
            });
          }
          let newContent: string;
          try {
            newContent = replaceLines(currentContent, line_start, line_end, content);
          } catch (err) {
            return reply.status(400).send({
              success: false,
              error: { message: String(err) },
            });
          }
          await updateFileInPg(name, file_path, newContent, agent_id, operation, undefined, undefined, undefined, einzel);
          const response: Record<string, unknown> = {
            success: true,
            message: `Zeilen ${line_start}-${line_end} in "${file_path}" ersetzt`,
          };
          await haengeFehlermusterAn(response, agent_id);
          return response;
        }

        if (operation === 'insert_after') {
          if (after_line === undefined || content === undefined) {
            return reply.status(400).send({
              success: false,
              error: { message: 'after_line und content sind fuer insert_after erforderlich' },
            });
          }
          let newContent: string;
          try {
            newContent = insertAfterLine(currentContent, after_line, content);
          } catch (err) {
            return reply.status(400).send({
              success: false,
              error: { message: String(err) },
            });
          }
          await updateFileInPg(name, file_path, newContent, agent_id, operation, undefined, undefined, undefined, einzel);
          const response: Record<string, unknown> = {
            success: true,
            message: `Inhalt nach Zeile ${after_line} in "${file_path}" eingefuegt`,
          };
          await haengeFehlermusterAn(response, agent_id);
          return response;
        }

        if (operation === 'delete_lines') {
          if (line_start === undefined || line_end === undefined) {
            return reply.status(400).send({
              success: false,
              error: { message: 'line_start und line_end sind fuer delete_lines erforderlich' },
            });
          }
          let newContent: string;
          try {
            newContent = deleteLines(currentContent, line_start, line_end);
          } catch (err) {
            return reply.status(400).send({
              success: false,
              error: { message: String(err) },
            });
          }
          await updateFileInPg(name, file_path, newContent, agent_id, operation, undefined, undefined, undefined, einzel);
          const response: Record<string, unknown> = {
            success: true,
            message: `Zeilen ${line_start}-${line_end} in "${file_path}" geloescht`,
          };
          await haengeFehlermusterAn(response, agent_id);
          return response;
        }

        if (operation === 'search_replace') {
          if (search === undefined || replace === undefined) {
            return reply.status(400).send({
              success: false,
              error: { message: 'search und replace sind fuer search_replace erforderlich' },
            });
          }
          // P15-T10: ohne replace_all muss der Suchtext genau einmal vorkommen — sonst nichts schreiben
          // (409 bei Mehrdeutigkeit, 404 wenn er nicht vorkommt; vorher: alle ersetzt bzw. success:true).
          const sr = searchReplaceEindeutig(currentContent, search, replace, replace_all === true);
          if (!sr.ok) {
            return reply.status(sr.count === 0 ? 404 : 409).send({
              success: false,
              count: sr.count,
              lines: sr.lines,
              error: { message: sr.error },
            });
          }
          await updateFileInPg(name, file_path, sr.content, agent_id, operation, undefined, undefined, undefined, einzel);
          const response: Record<string, unknown> = {
            success: true,
            count: sr.count,
            lines: sr.lines,
            message: `${sr.count} Vorkommen von "${search}" ersetzt in "${file_path}"`,
          };
          await haengeFehlermusterAn(response, agent_id);
          return response;
        }
      }

      if (operation === 'move') {
        if (!new_path) {
          return reply.status(400).send({
            success: false,
            error: { message: 'new_path ist fuer move erforderlich' },
          });
        }
        await moveFileInPg(name, file_path, new_path);
        return {
          success: true,
          message: `Datei verschoben von "${file_path}" nach "${new_path}"`,
        };
      }

      if (operation === 'copy') {
        if (!new_path) {
          return reply.status(400).send({
            success: false,
            error: { message: 'new_path ist fuer copy erforderlich' },
          });
        }
        await copyFileInPg(name, file_path, new_path);
        return {
          success: true,
          message: `Datei kopiert von "${file_path}" nach "${new_path}"`,
        };
      }

      return reply.status(400).send({
        success: false,
        error: { message: `Unbekannte operation: "${operation}"` },
      });
    } catch (error) {
      // P15-T17 E-a: Syntaxfehler in geaenderten Zeilen -> nichts geschrieben, 422 mit Befund.
      if (error instanceof SyntaxfehlerAbgelehnt) return reply.status(422).send(error.antwort());
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * DELETE /api/projects/:name/files
   * Datei soft-loeschen
   */
  fastify.delete<{
    Params: { name: string };
    Body: {
      file_path: string;
    };
  }>('/api/projects/:name/files', { preHandler: pfadVorpruefung }, async (request, reply) => {
    const { name } = request.params;
    const { file_path } = request.body;

    if (!file_path) {
      return reply.status(400).send({
        success: false,
        error: { message: 'file_path ist erforderlich' },
      });
    }

    try {
      await softDeleteFile(name, file_path);

      return {
        success: true,
        message: `Datei "${file_path}" geloescht`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
