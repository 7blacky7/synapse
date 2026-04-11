/**
 * MODUL: Dockerfile Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Dockerfiles
 *
 * EXTRAHIERT: FROM (stages), RUN, COPY, ADD, ENV, ARG, EXPOSE,
 *             ENTRYPOINT, CMD, LABEL, WORKDIR, VOLUME, USER,
 *             HEALTHCHECK, comment, todo
 * ANSATZ: Regex-basiert — Dockerfile hat Zeilen-basierte Instruktionen
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class DockerfileParser implements LanguageParser {
  language = 'dockerfile';
  extensions = ['.dockerfile'];

  parse(content: string, filePath: string): ParseResult {
    // Also handle files named "Dockerfile" (no extension)
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    let currentStage: string | undefined;

    // ══════════════════════════════════════════════
    // 1. FROM (base images + build stages)
    // ══════════════════════════════════════════════
    const fromRe = /^FROM\s+([\w./:@-]+)(?:\s+AS\s+(\w+))?/gim;
    while ((m = fromRe.exec(content)) !== null) {
      const image = m[1];
      const stageName = m[2];
      currentStage = stageName || undefined;

      symbols.push({
        symbol_type: 'import',
        name: stageName || image.split(':')[0].split('/').pop() || image,
        value: image,
        line_start: lineAt(content, m.index),
        is_exported: !!stageName,
      });

      references.push({
        symbol_name: image.split(':')[0],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. ENV (environment variables)
    // ══════════════════════════════════════════════
    const envRe = /^ENV\s+(\w+)[=\s]+(.+)/gim;
    while ((m = envRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: m[1],
        value: m[2].trim().replace(/\\\n\s*/g, ' ').slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. ARG (build arguments)
    // ══════════════════════════════════════════════
    const argRe = /^ARG\s+(\w+)(?:=(.+))?/gim;
    while ((m = argRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2] ? m[2].trim().slice(0, 200) : 'build-arg',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 4. EXPOSE (ports)
    // ══════════════════════════════════════════════
    const exposeRe = /^EXPOSE\s+(.+)/gim;
    while ((m = exposeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'EXPOSE',
        value: m[1].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. LABEL
    // ══════════════════════════════════════════════
    const labelRe = /^LABEL\s+([\w.-]+)[=\s]+["']?([^"'\n]+)/gim;
    while ((m = labelRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 6. WORKDIR
    // ══════════════════════════════════════════════
    const workdirRe = /^WORKDIR\s+(.+)/gim;
    while ((m = workdirRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'WORKDIR',
        value: m[1].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 7. ENTRYPOINT / CMD
    // ══════════════════════════════════════════════
    const entrypointRe = /^(ENTRYPOINT|CMD)\s+(.+)/gim;
    while ((m = entrypointRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1].toUpperCase(),
        value: m[2].trim().replace(/\\\n\s*/g, ' ').slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. COPY / ADD (with --from references)
    // ══════════════════════════════════════════════
    const copyRe = /^(COPY|ADD)\s+(?:--from=(\w+)\s+)?(.+)/gim;
    while ((m = copyRe.exec(content)) !== null) {
      const fromStage = m[2];
      if (fromStage) {
        references.push({
          symbol_name: fromStage,
          line_number: lineAt(content, m.index),
          context: `${m[1]} --from=${fromStage}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 9. HEALTHCHECK
    // ══════════════════════════════════════════════
    const healthRe = /^HEALTHCHECK\s+(.+)/gim;
    while ((m = healthRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: 'HEALTHCHECK',
        value: m[1].trim().replace(/\\\n\s*/g, ' ').slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. USER / VOLUME
    // ══════════════════════════════════════════════
    const userRe = /^USER\s+(\S+)/gim;
    while ((m = userRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'USER',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    const volumeRe = /^VOLUME\s+(.+)/gim;
    while ((m = volumeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'VOLUME',
        value: m[1].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 12. Block-Kommentare
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.match(/^#\s*(TODO|FIXME|HACK)/i) && !line.startsWith('#!')) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^#\s?/, ''));
      } else {
        if (commentBlock.length >= 2) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: commentBlock.join(' ').trim().slice(0, 500),
            line_start: commentStart,
            line_end: commentStart + commentBlock.length - 1,
            is_exported: false,
          });
        }
        commentBlock = [];
      }
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }
}

export const dockerfileParser = new DockerfileParser();
