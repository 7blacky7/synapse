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
  searchReplaceBatch,
  getDocsForFile,
  getProjectRoot,
  toRelativePath,
  applyContentRange,
  listFileVersions,
  getFileVersion,
  restoreFileVersion,
  restoreBatch,
} from '@synapse/core';
import type { BatchEdit } from '@synapse/core';

import * as path from 'path';
import { ConsolidatedTool, str, reqStr, num } from './types.js';
import { getProjectPath } from '../index.js';

export const filesTool: ConsolidatedTool = {
  definition: {
    name: 'files',
    description:
      'Dateien in PostgreSQL erstellen, lesen, bearbeiten und loeschen. ' +
      'FileWatcher synchronisiert Aenderungen auf das Dateisystem. ' +
      'Bei Write-Operationen werden automatisch Error-Patterns geprueft (wenn agent_id gesetzt). ' +
      'Auto-Versionierung: jede Aenderung erzeugt einen Snapshot in file_versions — abrufbar mit ' +
      'action="versions", einzelne Version lesen mit "get_version", zurueckrollen mit "restore" ' +
      'oder ganze Multi-File-Batches mit "restore_batch".',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'read', 'delete', 'move', 'copy', 'replace_lines', 'insert_after', 'delete_lines', 'search_replace', 'search_replace_batch', 'versions', 'get_version', 'restore', 'restore_batch'],
          description: 'Action: create | update | read | delete | move | copy | replace_lines | insert_after | delete_lines | search_replace | search_replace_batch | versions | get_version | restore | restore_batch',
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
        edits: {
          type: 'array',
          description: 'Edits fuer search_replace_batch (1..50 Elemente)',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Exakter Suchstring' },
              replace: { type: 'string', description: 'Ersetzungsstring' },
              replace_all: { type: 'boolean', description: 'Alle Vorkommen ersetzen (default: false)' },
            },
            required: ['search', 'replace'],
          },
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID — aktiviert Error-Pattern-Check bei Write-Operationen',
        },
        from_line: {
          type: 'number',
          description: 'read: Start-Zeile (1-basiert, Standard: 1)',
        },
        to_line: {
          type: 'number',
          description: 'read: End-Zeile inklusiv (Standard: letzte Zeile). Wird automatisch reduziert wenn Content > 80k Zeichen.',
        },
        truncate_long_lines: {
          type: 'number',
          description: 'read: Zeilen laenger als N Zeichen kuerzen und Marker anhaengen. 0 = deaktiviert (Standard).',
        },
        version_id: {
          type: 'string',
          description: 'Versions-ID (fuer get_version, restore). String, weil BIGSERIAL > Number.MAX_SAFE_INTEGER moeglich ist.',
        },
        batch_id: {
          type: 'string',
          description: 'Batch-ID (fuer restore_batch — rollt alle Files einer Multi-File-Batch zurueck).',
        },
        limit: {
          type: 'number',
          description: 'versions: Max Eintraege (Standard 50, Max 500).',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');
    const agentId = str(args, 'agent_id');

    // Versionierungs-Actions brauchen kein file_path (versions: ja, get_version/restore: version_id,
    // restore_batch: batch_id). Werden hier vor der file_path-Pflicht abgefangen.
    if (action === 'get_version') {
      const versionId = reqStr(args, 'version_id');
      const v = await getFileVersion(versionId);
      if (!v) return { success: false, message: `Version ${versionId} nicht gefunden.` };
      return { success: true, version: v };
    }
    if (action === 'restore') {
      const versionId = reqStr(args, 'version_id');
      const r = await restoreFileVersion(versionId, agentId);
      return {
        success: true,
        ...r,
        message: `Datei "${r.file_path}" auf Version ${r.restored_from} zurueckgerollt. Vorheriger Stand wurde als neue Version gesnapshottet.`,
      };
    }
    if (action === 'restore_batch') {
      const batchId = reqStr(args, 'batch_id');
      const restored = await restoreBatch(batchId, agentId);
      return {
        success: true,
        batch_id: batchId,
        files_restored: restored.length,
        files: restored,
        message: `Batch ${batchId} zurueckgerollt: ${restored.length} Datei(en).`,
      };
    }

    // Ab hier: actions die file_path brauchen.
    let filePath = reqStr(args, 'file_path');

    // Pfade normalisieren: DB erwartet relative Pfade
    const projectRootPath = await getProjectRoot(project);
    if (projectRootPath && path.isAbsolute(filePath)) {
      filePath = toRelativePath(projectRootPath, filePath);
    }
    // Wenn filePath immer noch absolut (kein projectRoot gefunden): als Fallback behalten

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
        const rawContent = await getFileContentFromPg(project, filePath);
        if (rawContent === null) {
          return { success: false, error: `Datei "${filePath}" nicht gefunden in Projekt "${project}"` };
        }
        const ranged = applyContentRange(rawContent, {
          from: num(args, 'from_line'),
          to: num(args, 'to_line'),
          truncate_long_lines: num(args, 'truncate_long_lines'),
        });
        return {
          success: true,
          file_path: filePath,
          size: rawContent.length,
          ...ranged,
        };
      }

      case 'delete': {
        await softDeleteFile(project, filePath);
        return { success: true, message: `Datei "${filePath}" geloescht` };
      }

      case 'move': {
        let newPath = reqStr(args, 'new_path');
        if (projectRootPath && path.isAbsolute(newPath)) {
          newPath = toRelativePath(projectRootPath, newPath);
        }
        await moveFileInPg(project, filePath, newPath);
        return { success: true, message: `Datei verschoben: "${filePath}" → "${newPath}"` };
      }

      case 'copy': {
        let newPath = reqStr(args, 'new_path');
        if (projectRootPath && path.isAbsolute(newPath)) {
          newPath = toRelativePath(projectRootPath, newPath);
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

      case 'search_replace_batch': {
        const currentContent = await getFileContentFromPg(project, filePath);
        if (currentContent === null) return { success: false, error: `Datei "${filePath}" nicht gefunden` };
        const rawEdits = args['edits'];
        if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
          return { success: false, error: 'edits muss ein nicht-leeres Array sein' };
        }
        const edits = rawEdits as BatchEdit[];
        const { content: newContent, result: batchResult } = searchReplaceBatch(currentContent, edits);

        // Nur schreiben wenn mindestens ein Edit angewendet wurde
        if (batchResult.applied === 0) {
          return {
            success: false,
            ...batchResult,
            message: `Keine Edits angewendet in "${filePath}"`,
          };
        }

        const writeResult = await updateFileInPg(project, filePath, newContent, agentId);
        const response: Record<string, unknown> = {
          success: true,
          ...batchResult,
          message: `${batchResult.applied}/${batchResult.total} Edits angewendet in "${filePath}"`,
        };
        return await attachWarnings(response, writeResult);
      }

      case 'versions': {
        const limit = num(args, 'limit') ?? 50;
        const versions = await listFileVersions(project, filePath, limit);
        return {
          success: true,
          project,
          file_path: filePath,
          count: versions.length,
          versions,
          tip: versions.length > 0
            ? `Voller Inhalt mit files(action: "get_version", version_id: "<id>"). Rollback mit files(action: "restore", version_id: "<id>").`
            : 'Keine Versionen — Datei wurde noch nicht editiert oder existiert nicht.',
        };
      }

      default:
        throw new Error(`Unbekannte files action: ${action}. Erlaubt: create, update, read, delete, move, copy, replace_lines, insert_after, delete_lines, search_replace, search_replace_batch, versions, get_version, restore, restore_batch`);
    }
  },
};
