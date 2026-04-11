/**
 * MODUL: PowerShell Parser
 * ZWECK: Extrahiert Struktur-Informationen aus PowerShell-Dateien (.ps1, .psm1, .psd1)
 *
 * EXTRAHIERT: function/filter, class, enum, param block, using,
 *             Import-Module/. source, Set-Variable, [CmdletBinding],
 *             #Requires, comment-based help, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class PowerShellParser implements LanguageParser {
  language = 'powershell';
  extensions = ['.ps1', '.psm1', '.psd1'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Using statements
    // ══════════════════════════════════════════════
    const usingRe = /^using\s+(namespace|module|assembly)\s+([\w.]+)/gim;
    while ((m = usingRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[2].split('.').pop() || m[2],
        value: `using ${m[1]} ${m[2]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[2].split('.').pop() || m[2],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. #Requires
    // ══════════════════════════════════════════════
    const requiresRe = /^#Requires\s+(.+)/gim;
    while ((m = requiresRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: '#Requires',
        value: m[1].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Import-Module / . source
    // ══════════════════════════════════════════════
    const importModRe = /^\s*Import-Module\s+(?:-Name\s+)?['"]?([\w.-]+)['"]?/gim;
    while ((m = importModRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `Import-Module ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `Import-Module ${m[1]}`.slice(0, 80),
      });
    }

    // Dot-sourcing
    const dotSourceRe = /^\s*\.\s+["']?([^\s"']+)["']?/gm;
    while ((m = dotSourceRe.exec(content)) !== null) {
      const file = m[1];
      if (!file.endsWith('.ps1') && !file.includes('$')) continue;
      const name = file.split(/[/\\]/).pop()?.replace('.ps1', '') || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: `. ${file}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Functions / Filters
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(function|filter)\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*\{/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const kind = m[1].toLowerCase();
      const name = m[2];
      const paramsRaw = m[3] || '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().replace(/^\[.*?\]\s*/, '').replace(/^\$/, '').split('=')[0].trim())
        .filter(Boolean);

      // Check for param() block inside function
      const funcBody = content.substring(m.index + m[0].length, m.index + m[0].length + 1000);
      const paramBlockMatch = funcBody.match(/param\s*\(([\s\S]*?)\)/i);
      if (paramBlockMatch && params.length === 0) {
        const blockParams = paramBlockMatch[1]
          .split(',')
          .map(p => p.trim().replace(/^\[.*?\]\s*/g, '').replace(/^\$/, '').split('=')[0].trim())
          .filter(p => p && !p.startsWith('[') && !p.startsWith('#'));
        params.push(...blockParams);
      }

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Classes (PowerShell 5+)
    // ══════════════════════════════════════════════
    const classRe = /^\s*class\s+(\w+)(?:\s*:\s*(\w+))?\s*\{/gim;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[1];
      const parent = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'class',
        params: parent ? [parent] : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `class ${name} : ${parent}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Enum (PowerShell 5+)
    // ══════════════════════════════════════════════
    const enumRe = /^\s*enum\s+(\w+)\s*\{/gim;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[1],
        value: 'enum',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Script-level Param block
    // ══════════════════════════════════════════════
    const scriptParamRe = /^(?:\[CmdletBinding\([^\]]*\)\]\s*)?param\s*\(([\s\S]*?)\)/gim;
    m = scriptParamRe.exec(content);
    if (m) {
      const params = m[1]
        .split(',')
        .map(p => p.trim().replace(/^\[.*?\]\s*/g, '').replace(/^\$/, '').split('=')[0].trim())
        .filter(p => p && !p.startsWith('[') && !p.startsWith('#'));

      if (params.length > 0) {
        for (const param of params) {
          if (!param) continue;
          symbols.push({
            symbol_type: 'variable',
            name: param,
            value: 'param',
            line_start: lineAt(content, m.index),
            is_exported: true,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 8. Module-level variables
    // ══════════════════════════════════════════════
    const varRe = /^\s*(?:New-Variable|Set-Variable)\s+(?:-Name\s+)?['"]?(\w+)['"]?\s+(?:-Value\s+)?([^\n]+)/gim;
    while ((m = varRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Script-scope variables
    const scriptVarRe = /^\$(?:script:|global:)(\w+)\s*=\s*(.+)/gm;
    while ((m = scriptVarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Export-ModuleMember
    // ══════════════════════════════════════════════
    const exportRe = /^\s*Export-ModuleMember\s+(?:-Function\s+)?(.+)/gim;
    while ((m = exportRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: 'Export-ModuleMember',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      // Skip #Requires
      if (m[0].trim().startsWith('#Requires')) continue;
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Comment-based help
    // ══════════════════════════════════════════════
    const helpRe = /<#([\s\S]*?)#>/g;
    while ((m = helpRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\.SYNOPSIS\s*/im, '').trim();
      if (text.length < 5) continue;
      const synopsis = text.split('\n')[0].trim();
      if (synopsis.length >= 3) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: synopsis.slice(0, 500),
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }

  private findClosingBrace(content: string, openPos: number): number {
    let depth = 1;
    for (let i = openPos + 1; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') depth--;
      if (depth === 0) return lineAt(content, i);
    }
    return lineAt(content, content.length);
  }
}

export const powershellParser = new PowerShellParser();
