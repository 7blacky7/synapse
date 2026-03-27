/**
 * MODUL: Tcl Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Tcl-Dateien (.tcl, .tk)
 *
 * EXTRAHIERT: package require/provide, proc, namespace, variable, set,
 *             oo::class/oo::define, source, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class TclParser implements LanguageParser {
  language = 'tcl';
  extensions = ['.tcl', '.tk', '.itcl'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package require / provide
    // ══════════════════════════════════════════════
    const pkgReqRe = /^\s*package\s+require\s+(?:-exact\s+)?([\w:]+)(?:\s+([\d.]+))?/gm;
    while ((m = pkgReqRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: m[2] ? `package require ${m[1]} ${m[2]}` : `package require ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    const pkgProvRe = /^\s*package\s+provide\s+([\w:]+)(?:\s+([\d.]+))?/gm;
    while ((m = pkgProvRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: m[1],
        value: m[2] ? `${m[1]} ${m[2]}` : m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Source (imports)
    // ══════════════════════════════════════════════
    const sourceRe = /^\s*source\s+["']?([^\s"']+)["']?/gm;
    while ((m = sourceRe.exec(content)) !== null) {
      const file = m[1];
      if (file.startsWith('$') || file.startsWith('[')) continue;
      const name = file.split('/').pop()?.replace(/\.tcl$/, '') || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: `source ${file}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Namespace
    // ══════════════════════════════════════════════
    const nsRe = /^\s*namespace\s+eval\s+([\w:]+)\s*\{/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'namespace',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Namespace export
    const nsExportRe = /^\s*namespace\s+export\s+([\w\s*]+)/gm;
    while ((m = nsExportRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: 'namespace export',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Procedures (proc)
    // ══════════════════════════════════════════════
    const procRe = /^\s*proc\s+([\w:]+)\s*\{([^}]*)\}\s*\{/gm;
    while ((m = procRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].split(/\s+/).filter(p => p && p !== 'args');

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: !name.startsWith('_'),
      });
    }

    // Proc with list args
    const procListRe = /^\s*proc\s+([\w:]+)\s+([\w]+)\s*\{/gm;
    while ((m = procListRe.exec(content)) !== null) {
      const name = m[1];
      if (symbols.some(s => s.name === name && s.symbol_type === 'function')) continue;
      symbols.push({
        symbol_type: 'function',
        name,
        params: [m[2]],
        line_start: lineAt(content, m.index),
        is_exported: !name.startsWith('_'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. OO (TclOO / oo::class)
    // ══════════════════════════════════════════════
    const ooClassRe = /^\s*oo::class\s+create\s+([\w:]+)/gm;
    while ((m = ooClassRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'oo::class',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // oo::define methods
    const ooMethodRe = /^\s*(?:method|constructor|destructor)\s+(\w+)?\s*\{([^}]*)\}/gm;
    while ((m = ooMethodRe.exec(content)) !== null) {
      const name = m[1] || m[0].trim().split(/\s+/)[0];
      symbols.push({
        symbol_type: 'function',
        name,
        value: 'method',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Itcl classes
    const itclRe = /^\s*(?:itcl::)?class\s+([\w:]+)\s*\{/gm;
    while ((m = itclRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1])) continue;
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'itcl::class',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Variables
    // ══════════════════════════════════════════════
    const varRe = /^\s*(?:variable|set)\s+([\w:]+)\s+(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim().slice(0, 200);
      // Skip temp vars inside procs
      if (name.length <= 1) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        line_start: lineAt(content, m.index),
        is_exported: name.includes('::'),
      });
    }

    // ══════════════════════════════════════════════
    // 7. TODO / FIXME / HACK
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

    return { symbols, references };
  }
}

export const tclParser = new TclParser();
