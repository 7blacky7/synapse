/**
 * MODUL: Assembly Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Assembly-Dateien (.asm, .s, .S)
 *
 * EXTRAHIERT: labels (global/local), sections (.text/.data/.bss/.rodata),
 *             directives (.global/.extern/.equ/.set/.macro), %include/%define,
 *             data definitions (db/dw/dd/dq), comment, todo
 * ANSATZ: Regex-basiert (unterstuetzt AT&T und Intel Syntax)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class AsmParser implements LanguageParser {
  language = 'asm';
  extensions = ['.asm', '.s', '.S', '.nasm'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // Pre-scan: Collect global labels first (needed for export marking)
    const globalLabels = new Set<string>();
    const preGlobalRe = /^\s*(?:\.globl?|\.global|global|GLOBAL)\s+([\w, ]+)/gim;
    let pg: RegExpExecArray | null;
    while ((pg = preGlobalRe.exec(content)) !== null) {
      pg[1].split(',').map(n => n.trim()).filter(Boolean).forEach(n => globalLabels.add(n));
    }

    // ══════════════════════════════════════════════
    // 1. Sections
    // ══════════════════════════════════════════════
    const sectionRe = /^\s*(?:section|\.section|SECTION)\s+([.\w]+)/gim;
    while ((m = sectionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'section',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Shorthand sections (.text, .data, .bss)
    const shortSecRe = /^\s*\.(text|data|bss|rodata)\s*$/gim;
    while ((m = shortSecRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: `.${m[1]}`,
        value: 'section',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Labels (functions/entry points)
    // ══════════════════════════════════════════════
    const labelRe = /^(\w[\w.@$]*)\s*:/gm;
    while ((m = labelRe.exec(content)) !== null) {
      const name = m[1];
      // Skip local labels (starting with . or L or numbers)
      if (/^[.L\d]/.test(name)) continue;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'label',
        line_start: lineAt(content, m.index),
        is_exported: globalLabels.has(name),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Global / Extern directives
    // ══════════════════════════════════════════════
    // globalLabels already populated by pre-scan above

    const externRe = /^\s*(?:\.extern|extern|EXTERN)\s+([\w,\s]+)/gim;
    while ((m = externRe.exec(content)) !== null) {
      const names = m[1].split(',').map(n => n.trim()).filter(Boolean);
      for (const name of names) {
        references.push({
          symbol_name: name,
          line_number: lineAt(content, m.index),
          context: `extern ${name}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Include
    // ══════════════════════════════════════════════
    const includeRe = /^\s*(?:%include|\.include|INCLUDE)\s+["']?([^\s"']+)["']?/gim;
    while ((m = includeRe.exec(content)) !== null) {
      const file = m[1];
      symbols.push({
        symbol_type: 'import',
        name: file.split('/').pop()?.replace(/\.\w+$/, '') || file,
        value: file,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Constants (equ/set/define)
    // ══════════════════════════════════════════════
    const equRe = /^\s*(?:(\w+)\s+(?:equ|EQU)\s+(.+)|\.(?:equ|set)\s+(\w+)\s*,\s*(.+))/gm;
    while ((m = equRe.exec(content)) !== null) {
      const name = m[1] || m[3];
      const value = (m[2] || m[4]).trim();
      symbols.push({
        symbol_type: 'variable',
        name,
        value: value.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: globalLabels.has(name),
      });
    }

    // %define (NASM)
    const defineRe = /^\s*%define\s+(\w+)(?:\(([^)]*)\))?\s+(.*)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: m[2] !== undefined ? 'function' : 'variable',
        name: m[1],
        value: m[2] !== undefined ? 'macro' : m[3].trim().slice(0, 200),
        params: m[2] ? m[2].split(',').map(p => p.trim()).filter(Boolean) : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Macros (.macro / %macro)
    // ══════════════════════════════════════════════
    const macroRe = /^\s*(?:\.macro|%macro)\s+(\w+)(?:\s+(\d+))?/gim;
    while ((m = macroRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'macro',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Data definitions
    // ══════════════════════════════════════════════
    const dataRe = /^(\w+)\s+(?:db|dw|dd|dq|dt|resb|resw|resd|resq|\.byte|\.word|\.long|\.quad|\.ascii|\.asciz|\.string|\.space|\.zero|\.fill)\s+(.+)/gim;
    while ((m = dataRe.exec(content)) !== null) {
      const name = m[1];
      if (symbols.some(s => s.name === name)) continue; // Skip if already a label
      symbols.push({
        symbol_type: 'variable',
        name,
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: globalLabels.has(name),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Call/Jump references
    // ══════════════════════════════════════════════
    const callRe = /^\s*(?:call|jmp|je|jne|jz|jnz|jg|jl|jge|jle|ja|jb|bl|b)\s+(\w+)/gim;
    const seenCalls = new Set<string>();
    while ((m = callRe.exec(content)) !== null) {
      const target = m[1];
      if (seenCalls.has(target) || /^\d/.test(target)) continue;
      seenCalls.add(target);
      references.push({
        symbol_name: target,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /[;#@!]\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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

export const asmParser = new AsmParser();
