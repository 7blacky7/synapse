/**
 * MODUL: Fortran Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Fortran-Dateien (.f90, .f95, .f03, .f08, .f)
 *
 * EXTRAHIERT: program, module, submodule, subroutine, function, type,
 *             use, implicit, interface, contains, intent, allocatable,
 *             parameter, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (Fortran) — case-insensitive, line-based
// ---------------------------------------------------------------------------

function lineAtF(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowFortran(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    // Fortran function/subroutine calls: name( or CALL name(
    const callRe = /\bCALL\s+(\w+)\s*\(/gi;
    let mc: RegExpExecArray | null;
    while ((mc = callRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'function' });
    }
    const funcRe = /(?<![%\w])([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1].toLowerCase();
      if (['if','do','while','select','case','return','goto','stop','exit','cycle','then','else','endif','enddo','write','read','print','format','implicit','intent','allocate','deallocate','nullify','associated','present','size','len','trim','adjustl','adjustr','max','min','abs','mod','real','int','char','ichar','index','scan','verify'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'function' });
    }
  }

  // Find subroutine/function bodies
  const allLines = content.split('\n');

  interface SubBody { name: string; startLine: number; lines: { text: string; lineNo: number }[]; }

  function findSubBodies(): SubBody[] {
    const bodies: SubBody[] = [];
    const startRe = /^\s*(?:(?:pure|elemental|recursive|impure)\s+)*(?:subroutine|function)\s+(\w+)/i;
    const endRe = /^\s*end\s*(?:subroutine|function)\b/i;
    let i = 0;
    while (i < allLines.length) {
      const sm = startRe.exec(allLines[i]);
      if (sm) {
        const name = sm[1];
        const bodyLines: { text: string; lineNo: number }[] = [];
        let j = i + 1;
        while (j < allLines.length) {
          if (endRe.test(allLines[j])) { j++; break; }
          bodyLines.push({ text: allLines[j], lineNo: j + 1 });
          j++;
        }
        bodies.push({ name, startLine: i + 1, lines: bodyLines });
        i = j;
      } else {
        i++;
      }
    }
    return bodies;
  }

  function processBody(sb: SubBody): void {
    let order = 0;
    for (const { text, lineNo } of sb.lines) {
      const trimmed = text.trim();
      if (!trimmed || /^!/.test(trimmed)) continue;
      // Strip inline comments
      const code = trimmed.replace(/!.*$/, '').trim();
      if (!code) continue;

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'function', scope_name: sb.name, statement_type: type, node_kind: kind, line_start: lineNo, order_index: order++, depth: 0, is_top_level: false, is_awaited: false, text: code.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*IF\s*\(/i.test(code)) {
        const cm = code.match(/IF\s*\((.+)/i); const cond = cm ? cm[1].replace(/\)\s*(?:THEN)?.*$/i, '').slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*DO\b/i.test(code)) {
        const cm = code.match(/DO\s+(.+)/i); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('for', 'DoLoop', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*DO\s+WHILE\s*\(/i.test(code)) {
        const cm = code.match(/DO\s+WHILE\s*\((.+)/i); const cond = cm ? cm[1].replace(/\)\s*$/, '').slice(0, 200) : undefined;
        const st = emit('while', 'DoWhileLoop', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*SELECT\s+CASE\s*\(/i.test(code)) {
        const cm = code.match(/SELECT\s+CASE\s*\((.+)/i); const cond = cm ? cm[1].replace(/\)\s*$/, '').slice(0, 200) : undefined;
        const st = emit('switch', 'SelectCase', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*CALL\s+\w+/i.test(code)) {
        const cm = code.match(/CALL\s+(\w+)/i);
        const st = emit('call', 'CallStatement', { callee: cm ? cm[1] : undefined });
        extractCalls(code, st.temp_id, sb.name, lineNo);
      } else if (/^\s*RETURN\b/i.test(code)) {
        emit('return', 'ReturnStatement');
      } else if (/^\s*GOTO\s+\d+/i.test(code)) {
        const cm = code.match(/GOTO\s+(\d+)/i);
        emit('goto', 'GotoStatement', { callee: cm ? cm[1] : undefined });
      } else if (/^\w+\s*=\s*.+/.test(code) && !/^\s*(?:IF|DO|SELECT|CALL|RETURN|GOTO|END|USE|IMPLICIT|WRITE|READ|PRINT|ALLOCATE|DEALLOCATE)/i.test(code)) {
        const am = code.match(/^(\w+(?:\([^)]*\))?)\s*=\s*(.+)/);
        if (am) {
          const st = emit('assignment', 'AssignmentStatement', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, sb.name, lineNo);
        }
      } else if (/^\s*WRITE\s*\(/i.test(code) || /^\s*PRINT\s+/i.test(code) || /^\s*READ\s*\(/i.test(code)) {
        const ioM = code.match(/^(\w+)/i);
        emit('call', 'IOStatement', { callee: ioM ? ioM[1].toUpperCase() : 'IO' });
      }
    }
  }

  const bodies = findSubBodies();
  for (const sb of bodies) processBody(sb);

  return { statements, callEdges };
}

class FortranParser implements LanguageParser {
  language = 'fortran';
  extensions = ['.f90', '.f95', '.f03', '.f08', '.f', '.for'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Program
    // ══════════════════════════════════════════════
    const progRe = /^\s*program\s+(\w+)/gim;
    while ((m = progRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'program',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Module / Submodule
    // ══════════════════════════════════════════════
    const moduleRe = /^\s*(sub)?module\s+(\w+)/gim;
    while ((m = moduleRe.exec(content)) !== null) {
      const isSub = !!m[1];
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: isSub ? 'submodule' : 'module',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Use
    // ══════════════════════════════════════════════
    const useRe = /^\s*use\s+(\w+)(?:\s*,\s*only\s*:\s*([^\n]+))?/gim;
    while ((m = useRe.exec(content)) !== null) {
      const module = m[1];
      const only = m[2];

      symbols.push({
        symbol_type: 'import',
        name: module,
        value: only ? `use ${module}, only: ${only.trim()}` : `use ${module}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });

      references.push({
        symbol_name: module,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Subroutines
    // ══════════════════════════════════════════════
    const subRe = /^\s*(?:(pure|elemental|recursive|impure)\s+)*subroutine\s+(\w+)\s*\(([^)]*)\)/gim;
    while ((m = subRe.exec(content)) !== null) {
      const modifiers = m[1] || '';
      const name = m[2];
      const params = m[3].split(',').map(p => p.trim()).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: modifiers ? `${modifiers} subroutine` : 'subroutine',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(?:((?:pure|elemental|recursive|impure|integer|real|double\s+precision|complex|logical|character)\s+)*)?function\s+(\w+)\s*\(([^)]*)\)(?:\s+result\s*\((\w+)\))?/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const modifiers = m[1] ? m[1].trim() : '';
      const name = m[2];
      const params = m[3].split(',').map(p => p.trim()).filter(Boolean);
      const resultVar = m[4];

      symbols.push({
        symbol_type: 'function',
        name,
        value: modifiers ? `${modifiers} function` : 'function',
        params: params.length > 0 ? params : undefined,
        return_type: resultVar,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Type definitions
    // ══════════════════════════════════════════════
    const typeRe = /^\s*type(?:\s*,\s*(?:public|private|abstract|extends\((\w+)\)))?\s*::\s*(\w+)/gim;
    while ((m = typeRe.exec(content)) !== null) {
      const parent = m[1];
      const name = m[2];

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'type',
        params: parent ? [`extends ${parent}`] : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineAt(content, m.index),
          context: `type, extends(${parent}) :: ${name}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. Interface blocks
    // ══════════════════════════════════════════════
    const ifaceRe = /^\s*interface\s+(\w+)/gim;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: 'interface',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Variable declarations
    // ══════════════════════════════════════════════
    const varRe = /^\s*(integer|real|double\s+precision|complex|logical|character|type\(\w+\))\s*(?:\([^)]*\))?\s*(?:,\s*(?:intent\(\w+\)|parameter|allocatable|dimension\([^)]*\)|save|target|pointer|optional|value)\s*)*(?:,\s*(?:public|private))?\s*::\s*(\w+(?:\s*,\s*\w+)*)(?:\s*=\s*([^\n!]+))?/gim;
    while ((m = varRe.exec(content)) !== null) {
      const varType = m[1];
      const names = m[2].split(',').map(n => n.trim()).filter(Boolean);
      const value = m[3] ? m[3].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      const isParameter = /parameter/i.test(m[0]);

      for (const name of names) {
        symbols.push({
          symbol_type: 'variable',
          name,
          value: value || varType.trim(),
          return_type: varType.trim(),
          line_start: lineStart,
          is_exported: isParameter,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /!\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));

    const { statements, callEdges } = extractFlowFortran(content);
    return { symbols, references, statements, callEdges };
  }
}

export const fortranParser = new FortranParser();
