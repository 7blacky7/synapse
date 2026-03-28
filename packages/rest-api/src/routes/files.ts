/**
 * Synapse API - Files Routes
 * Datei-CRUD fuer den Code-Editor (PostgreSQL-basiert)
 */

import { FastifyInstance } from 'fastify';
import {
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplace,
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  getFileContentFromPg,
} from '@synapse/core';

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
    };
  }>('/api/projects/:name/files', async (request, reply) => {
    const { name } = request.params;
    const { file_path, content, agent_id } = request.body;

    if (!file_path || content === undefined) {
      return reply.status(400).send({
        success: false,
        error: { message: 'file_path und content sind erforderlich' },
      });
    }

    try {
      const result = await createFileInPg(name, file_path, content, agent_id);
      const response: Record<string, unknown> = {
        success: true,
        message: `Datei "${file_path}" erstellt (${content.length} Zeichen)`,
      };
      if (result.warnings?.length) {
        response.errorPatterns = {
          count: result.warnings.length,
          warnings: result.warnings,
          hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
        };
      }
      return response;
    } catch (error) {
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
      new_path?: string;
      agent_id?: string;
    };
  }>('/api/projects/:name/files', async (request, reply) => {
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
      new_path,
      agent_id,
    } = request.body;

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
        const result = await updateFileInPg(name, file_path, content, agent_id);
        const response: Record<string, unknown> = {
          success: true,
          message: `Datei "${file_path}" aktualisiert (${content.length} Zeichen)`,
        };
        if (result.warnings?.length) {
          response.errorPatterns = {
            count: result.warnings.length,
            warnings: result.warnings,
            hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
          };
        }
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
          const result = await updateFileInPg(name, file_path, newContent, agent_id);
          const response: Record<string, unknown> = {
            success: true,
            message: `Zeilen ${line_start}-${line_end} in "${file_path}" ersetzt`,
          };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
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
          const result = await updateFileInPg(name, file_path, newContent, agent_id);
          const response: Record<string, unknown> = {
            success: true,
            message: `Inhalt nach Zeile ${after_line} in "${file_path}" eingefuegt`,
          };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
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
          const result = await updateFileInPg(name, file_path, newContent, agent_id);
          const response: Record<string, unknown> = {
            success: true,
            message: `Zeilen ${line_start}-${line_end} in "${file_path}" geloescht`,
          };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
          return response;
        }

        if (operation === 'search_replace') {
          if (search === undefined || replace === undefined) {
            return reply.status(400).send({
              success: false,
              error: { message: 'search und replace sind fuer search_replace erforderlich' },
            });
          }
          const { content: newContent, count } = searchReplace(currentContent, search, replace);
          if (count === 0) {
            return {
              success: true,
              count: 0,
              message: `Kein Vorkommen von "${search}" gefunden in "${file_path}"`,
            };
          }
          const result = await updateFileInPg(name, file_path, newContent, agent_id);
          const response: Record<string, unknown> = {
            success: true,
            count,
            message: `${count} Vorkommen von "${search}" ersetzt in "${file_path}"`,
          };
          if (result.warnings?.length) {
            response.errorPatterns = {
              count: result.warnings.length,
              warnings: result.warnings,
              hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
            };
          }
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
  }>('/api/projects/:name/files', async (request, reply) => {
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
