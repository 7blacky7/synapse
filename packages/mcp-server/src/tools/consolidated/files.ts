/**
 * Synapse MCP - Consolidated files Tool
 * Dateien erstellen, lesen, bearbeiten, loeschen in PostgreSQL.
 * FileWatcher synchronisiert Aenderungen automatisch auf das Dateisystem.
 */

import {
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  getFileContentFromPg,
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplace,
  getDocsForFile,
} from '@synapse/core';

import * as path from 'path';
import { ConsolidatedTool, str, reqStr, num } from './types.js';
import { getProjectPath } from '../index.js';

export const filesTool: ConsolidatedTool = {
  definition: {
    name: 'files',
    description:
      'Dateien in PostgreSQL erstellen, lesen, bearbeiten und loeschen. ' +
      'FileWatcher synchronisiert Aenderungen auf das Dateisystem. ' +
      'Bei Write-Operationen werden automatisch Error-Patterns geprueft (wenn agent_id gesetzt).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'read', 'delete', 'move', 'copy', 'replace_lines', 'insert_after', 'delete_lines', 'search_replace'],
          description: 'Action: create | update | read | delete | move | copy | replace_lines | insert_after | delete_lines | search_replace',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        file_path: {
          type: 'string',
          description: 'Dateipfad (relativ zum Projekt)',
        },
        content: {
          type: 'string',
          description: 'Dateiinhalt (fuer create, update, replace_lines, insert_after)',
        },
        new_path: {
          type: 'string',
          description: 'Neuer Pfad (fuer move, copy)',
        },
        line_start: {
          type: 'number',
          description: 'Start-Zeile (fuer replace_lines, delete_lines)',
        },
        line_end: {
          type: 'number',
          description: 'End-Zeile (fuer replace_lines, delete_lines)',
        },
        after_line: {
          type: 'number',
          description: 'Zeile nach der eingefuegt wird (fuer insert_after)',
        },
        search: {
          type: 'string',
          description: 'Suchstring (fuer search_replace)',
        },
        replace: {
          type: 'string',
          description: 'Ersetzungsstring (fuer search_replace)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID — aktiviert Error-Pattern-Check bei Write-Operationen',
        },
      },
      required: ['action', 'project', 'file_path'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');
    let filePath = reqStr(args, 'file_path');
    const agentId = str(args, 'agent_id');

    // Relative Pfade auf absolut normalisieren (Projekt-Pfad voranstellen)
    if (!path.isAbsolute(filePath)) {
      const projectPath = getProjectPath(project);
      if (projectPath) {
        filePath = path.join(projectPath, filePath);
      }
    }

    // Haiku escaped Content manchmal doppelt: "\"use client\";\n\nimport..."
    // Detection: Literale \n im String aber keine echten Newlines → doppelt escaped
    function unescapeIfNeeded(content: string): { content: string; wasFixed: boolean } {
      if (!content.includes('\n') && (content.includes('\\n') || content.startsWith('\\"'))) {
        try {
          const parsed = JSON.parse(`"${content.replace(/^"|"$/g, '')}"`);
          if (typeof parsed === 'string' && parsed.includes('\n')) {
            return { content: parsed, wasFixed: true };
          }
        } catch {
          // Fallback: manuelle Ersetzung
          const fixed = content
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          if (fixed !== content) {
            return { content: fixed, wasFixed: true };
          }
        }
      }
      return { content, wasFixed: false };
    }

    async function attachWarnings(response: Record<string, unknown>, result: { warnings?: Array<{ id: string; severity: string; description: string; fix: string }> }) {
      if (result.warnings?.length) {
        response.errorPatterns = {
          count: result.warnings.length,
          warnings: result.warnings,
          hint: `${result.warnings.length} bekannte Fehler-Patterns matchen deinen Code`,
        };
      }
      // Framework-Docs (Breaking Changes, Gotchas) einmalig pro Agent anhaengen
      if (agentId) {
        try {
          const docs = await getDocsForFile(filePath, agentId, project);
          if (docs.warnings.length > 0) {
            response.frameworkDocs = {
              agentCutoff: docs.agentCutoff,
              frameworks: docs.warnings,
              hint: 'Breaking Changes / Gotchas fuer erkannte Frameworks — bitte beachten!',
            };
          }
        } catch {
          // Docs-Check darf Write nicht blockieren
        }
      }
      return response;
    }

    switch (action) {
      case 'create': {
        const raw = reqStr(args, 'content');
        const { content, wasFixed } = unescapeIfNeeded(raw);
        const result = await createFileInPg(project, filePath, content, agentId);
        const response: Record<string, unknown> = { success: true, message: `Datei "${filePath}" erstellt (${content.length} Zeichen)` };
        if (wasFixed) response.autoFixed = 'Content war doppelt escaped (\\n statt Newlines) — automatisch korrigiert.';
        return await attachWarnings(response, result);
      }

      case 'update': {
        const raw = reqStr(args, 'content');
        const { content, wasFixed } = unescapeIfNeeded(raw);
        const result = await updateFileInPg(project, filePath, content, agentId);
        const response: Record<string, unknown> = { success: true, message: `Datei "${filePath}" aktualisiert (${content.length} Zeichen)` };
        if (wasFixed) response.autoFixed = 'Content war doppelt escaped (\\n statt Newlines) — automatisch korrigiert.';
        return await attachWarnings(response, result);
      }

      case 'read': {
        const content = await getFileContentFromPg(project, filePath);
        if (content === null) {
          return { success: false, error: `Datei "${filePath}" nicht gefunden in Projekt "${project}"` };
        }
        return { success: true, file_path: filePath, content, size: content.length };
      }

      case 'delete': {
        await softDeleteFile(project, filePath);
        return { success: true, message: `Datei "${filePath}" geloescht` };
      }

      case 'move': {
        let newPath = reqStr(args, 'new_path');
        if (!path.isAbsolute(newPath)) {
          const pp = getProjectPath(project);
          if (pp) newPath = path.join(pp, newPath);
        }
        await moveFileInPg(project, filePath, newPath);
        return { success: true, message: `Datei verschoben: "${filePath}" → "${newPath}"` };
      }

      case 'copy': {
        let newPath = reqStr(args, 'new_path');
        if (!path.isAbsolute(newPath)) {
          const pp = getProjectPath(project);
          if (pp) newPath = path.join(pp, newPath);
        }
        await copyFileInPg(project, filePath, newPath);
        return { success: true, message: `Datei kopiert: "${filePath}" → "${newPath}"` };
      }

      case 'replace_lines': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const lineStart = num(args, 'line_start');
        const lineEnd = num(args, 'line_end');
        const { content } = unescapeIfNeeded(reqStr(args, 'content'));
        if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
        const newContent = replaceLines(currentContent, lineStart, lineEnd, content);
        const result = await updateFileInPg(project, filePath, newContent, agentId);
        return await attachWarnings(
          { success: true, message: `Zeilen ${lineStart}-${lineEnd} in "${filePath}" ersetzt` },
          result
        );
      }

      case 'insert_after': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const afterLine = num(args, 'after_line');
        const { content } = unescapeIfNeeded(reqStr(args, 'content'));
        if (afterLine === undefined) return { success: false, error: 'after_line erforderlich' };
        const newContent = insertAfterLine(currentContent, afterLine, content);
        const result = await updateFileInPg(project, filePath, newContent, agentId);
        return await attachWarnings(
          { success: true, message: `Inhalt nach Zeile ${afterLine} in "${filePath}" eingefuegt` },
          result
        );
      }

      case 'delete_lines': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const lineStart = num(args, 'line_start');
        const lineEnd = num(args, 'line_end');
        if (lineStart === undefined || lineEnd === undefined) return { success: false, error: 'line_start und line_end erforderlich' };
        const newContent = deleteLines(currentContent, lineStart, lineEnd);
        const result = await updateFileInPg(project, filePath, newContent, agentId);
        return await attachWarnings(
          { success: true, message: `Zeilen ${lineStart}-${lineEnd} in "${filePath}" geloescht` },
          result
        );
      }

      case 'search_replace': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const searchStr = reqStr(args, 'search');
        const replaceStr = reqStr(args, 'replace');
        const { content: newContent, count, fuzzyMatches } = searchReplace(currentContent, searchStr, replaceStr);

        // Keine Matches gefunden — Datei wurde NICHT geändert
        if (count === 0) {
          if (fuzzyMatches && fuzzyMatches.length > 0) {
            return {
              success: false,
              count: 0,
              fuzzyMatches,
              hint: `Kein exakter Match. Ähnliche Zeilen oben — meintest du eine davon?`,
            };
          }
          return { success: false, count: 0, message: `Kein Vorkommen von "${searchStr}" in "${filePath}"` };
        }

        // Exakte Matches gefunden — ersetzen
        const result = await updateFileInPg(project, filePath, newContent, agentId);
        return await attachWarnings(
          { success: true, count, message: `${count} Vorkommen ersetzt in "${filePath}"` },
          result
        );
      }

      default:
        throw new Error(`Unbekannte files action: ${action}. Erlaubt: create, update, read, delete, move, copy, replace_lines, insert_after, delete_lines, search_replace`);
    }
  },
};
