/**
 * MODUL: Python Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Python-Dateien
 *
 * EXTRAHIERT: function (def/async def), class, variable, import, decorator,
 *             comment, todo, const_object (__all__), string (docstrings)
 * ANSATZ: Regex-basiert — Python hat einrueckungsbasierte Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

/** Zeilennummer fuer eine Position im Text (1-basiert) */
function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

/** Prueft ob ein Name "exported" ist (kein fuehrender Underscore) */
function isPublic(name: string): boolean {
  return !name.startsWith('_');
}

class PythonParser implements LanguageParser {
  language = 'python';
  extensions = ['.py', '.pyw'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports (import X / from X import Y)
    // ══════════════════════════════════════════════
    const importRe = /^(from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))/gm;
    while ((m = importRe.exec(content)) !== null) {
      const line = lineAt(content, m.index);
      if (m[2]) {
        // from X import Y, Z
        const module = m[2];
        const names = m[3].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        symbols.push({
          symbol_type: 'import',
          name: module,
          value: `from ${module} import ${names.join(', ')}`,
          line_start: line,
          is_exported: false,
        });
        references.push({
          symbol_name: module,
          line_number: line,
          context: m[0].trim().slice(0, 80),
        });
      } else if (m[4]) {
        // import X, Y
        const modules = m[4].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const mod of modules) {
          symbols.push({
            symbol_type: 'import',
            name: mod,
            value: m[0].trim(),
            line_start: line,
            is_exported: false,
          });
          references.push({
            symbol_name: mod,
            line_number: line,
            context: m[0].trim().slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 2. Klassen (class Name(Base):)
    // ══════════════════════════════════════════════
    const classRe = /^(class)\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm;
    while ((m = classRe.exec(content)) !== null) {
      const className = m[2];
      const bases = m[3] ? m[3].split(',').map(s => s.trim()).filter(Boolean) : [];
      const lineStart = lineAt(content, m.index);

      // Endzeile: naechste Zeile mit gleicher oder weniger Einrueckung (oder EOF)
      const lineEnd = this.findBlockEnd(lines, lineStart - 1);

      symbols.push({
        symbol_type: 'class',
        name: className,
        value: bases.length > 0 ? `(${bases.join(', ')})` : undefined,
        params: bases,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(className),
      });

      // Referenzen auf Basisklassen
      for (const base of bases) {
        const baseName = base.split('[')[0].split('(')[0].trim();
        if (baseName && baseName !== 'object') {
          references.push({
            symbol_name: baseName,
            line_number: lineStart,
            context: `class ${className}(${bases.join(', ')})`,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Funktionen (def / async def)
    // ══════════════════════════════════════════════
    const funcRe = /^( *)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?\s*:/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isAsync = !!m[2];
      const funcName = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] ? m[5].trim() : undefined;
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findBlockEnd(lines, lineStart - 1);

      // Parameter parsen (self/cls entfernen)
      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].split('=')[0].trim())
        .filter(p => p && p !== 'self' && p !== 'cls');

      // Ist es eine Methode (eingerueckt) oder top-level?
      const isMethod = indent > 0;
      const parentClass = isMethod ? this.findParentClass(lines, lineStart - 1) : undefined;

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        value: isAsync ? 'async' : undefined,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(funcName),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Top-Level Variablen / Konstanten
    // ══════════════════════════════════════════════
    const varRe = /^([A-Z_][A-Z0-9_]*)\s*(?::\s*[^\n=]+)?\s*=\s*(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      const varName = m[1];
      const value = m[2].trim().slice(0, 200);
      const line = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: varName,
        value,
        line_start: line,
        is_exported: isPublic(varName),
      });
    }

    // Lowercase top-level assignments (nur am Zeilenanfang, nicht in Funktionen)
    const assignRe = /^([a-z_]\w*)\s*(?::\s*[^\n=]+)?\s*=\s*(.+)/gm;
    while ((m = assignRe.exec(content)) !== null) {
      // Nur echte Top-Level Variablen (keine Einrueckung)
      const lineIdx = lineAt(content, m.index) - 1;
      if (lineIdx < lines.length && lines[lineIdx].match(/^\S/)) {
        const varName = m[1];
        // Skip bekannte Keywords/Patterns
        if (['if', 'else', 'elif', 'for', 'while', 'with', 'try', 'except', 'finally', 'return', 'yield'].includes(varName)) continue;
        const value = m[2].trim().slice(0, 200);

        symbols.push({
          symbol_type: 'variable',
          name: varName,
          value,
          line_start: lineIdx + 1,
          is_exported: isPublic(varName),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. __all__ (explizite Exports)
    // ══════════════════════════════════════════════
    const allRe = /__all__\s*=\s*\[([^\]]*)\]/gs;
    while ((m = allRe.exec(content)) !== null) {
      const exports = m[1]
        .split(',')
        .map(s => s.trim().replace(/['"]/g, ''))
        .filter(Boolean);
      symbols.push({
        symbol_type: 'const_object',
        name: '__all__',
        value: exports.join(', '),
        params: exports,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Decorators (@decorator)
    // ══════════════════════════════════════════════
    const decoratorRe = /^( *)@(\w[\w.]*(?:\([^)]*\))?)/gm;
    while ((m = decoratorRe.exec(content)) !== null) {
      const decName = m[2].split('(')[0];
      const line = lineAt(content, m.index);
      references.push({
        symbol_name: decName,
        line_number: line,
        context: m[0].trim().slice(0, 80),
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

    // ══════════════════════════════════════════════
    // 8. Block-Kommentare (zusammenhaengende #-Zeilen)
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.match(/^#\s*(TODO|FIXME|HACK)/i)) {
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

    // ══════════════════════════════════════════════
    // 9. Docstrings (Triple-Quote Strings nach def/class)
    // ══════════════════════════════════════════════
    const docstringRe = /(?:def|class)\s+\w+[^:]*:\s*\n\s*("""[\s\S]*?"""|'''[\s\S]*?''')/g;
    while ((m = docstringRe.exec(content)) !== null) {
      const docText = m[1].replace(/^"""|"""$|^'''|'''$/g, '').trim();
      if (docText.length > 3) {
        symbols.push({
          symbol_type: 'string',
          name: null,
          value: docText.slice(0, 500),
          line_start: lineAt(content, m.index + m[0].indexOf(m[1])),
          line_end: lineAt(content, m.index + m[0].length),
          is_exported: false,
        });
      }
    }

    return { symbols, references };
  }

  /** Findet das Ende eines eingerueckten Blocks (naechste Zeile mit <= Einrueckung) */
  private findBlockEnd(lines: string[], startIdx: number): number {
    const startIndent = lines[startIdx].search(/\S/);
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue; // Leerzeilen ueberspringen
      const indent = line.search(/\S/);
      if (indent <= startIndent) return i; // Block endet eine Zeile vorher
    }
    return lines.length; // Bis zum Dateiende
  }

  /** Findet die uebergeordnete Klasse fuer eine Methode */
  private findParentClass(lines: string[], methodIdx: number): string | undefined {
    const methodIndent = lines[methodIdx].search(/\S/);
    for (let i = methodIdx - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.search(/\S/);
      if (indent < methodIndent) {
        const classMatch = line.match(/^(\s*)class\s+(\w+)/);
        if (classMatch) return classMatch[2];
        break;
      }
    }
    return undefined;
  }
}

export const pythonParser = new PythonParser();
