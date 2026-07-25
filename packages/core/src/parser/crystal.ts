/**
 * MODUL: Crystal Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Crystal-Dateien (.cr)
 *
 * EXTRAHIERT: require, module, class, struct, enum, lib, fun, def,
 *             macro, alias, annotation, abstract class/struct,
 *             include/extend, property (getter/setter), comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (Crystal)
// ---------------------------------------------------------------------------

function lineAtCr(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowCrystal(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    const methodRe = /(\w+)\.(\w+)\s*[({]/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    const funcRe = /(?<![.\w])([a-zA-Z_]\w*[?!]?)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','elsif','else','unless','while','until','case','when','return','raise','rescue','ensure','begin','do','end','def','class','module','struct','enum','macro','require','include','extend','new','typeof','sizeof','instance_sizeof','offsetof','pointerof'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: 'function' });
    }
    // new ClassName(
    const newRe = /\bnew\s+(\w+)/g;
    while ((mc = newRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'new' });
    }
  }

  // Crystal: find def bodies. Crystal uses keyword-based blocks (def...end).
  // We scan for `def name` and collect until matching `end`.
  const lines = content.split('\n');

  interface DefBody { name: string; startLine: number; bodyLines: { text: string; lineNo: number }[]; }

  function findDefBodies(): DefBody[] {
    const bodies: DefBody[] = [];
    const defRe = /^\s*(?:(?:private|protected|abstract)\s+)*def\s+((?:self\.)?\w+[?!]?)/;
    let i = 0;
    while (i < lines.length) {
      const dm = defRe.exec(lines[i]);
      if (dm) {
        const name = dm[1];
        const bodyLines: { text: string; lineNo: number }[] = [];
        let depth = 1;
        let j = i + 1;
        while (j < lines.length && depth > 0) {
          const l = lines[j];
          const t = l.trim();
          if (/^\s*(?:def|class|module|struct|if|unless|while|until|begin|case|do)\b/.test(l)) depth++;
          if (/^\s*end\b/.test(l)) { depth--; if (depth === 0) { j++; break; } }
          if (depth > 0) bodyLines.push({ text: l, lineNo: j + 1 });
          j++;
        }
        bodies.push({ name, startLine: i + 1, bodyLines });
        i = j;
      } else {
        i++;
      }
    }
    return bodies;
  }

  function processBody(db: DefBody): void {
    let order = 0;
    for (const { text, lineNo } of db.bodyLines) {
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'method', scope_name: db.name, statement_type: type, node_kind: kind, line_start: lineNo, order_index: order++, depth: 0, is_top_level: false, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*if\s+/.test(text) || /^\s*unless\s+/.test(text)) {
        const cm = trimmed.match(/^(?:if|unless)\s+(.+)/); const cond = cm ? cm[1].replace(/\s*(?:then)?$/, '').slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, db.name, lineNo);
      } else if (/^\s*while\s+/.test(text) || /^\s*until\s+/.test(text)) {
        const cm = trimmed.match(/^(?:while|until)\s+(.+)/); const cond = cm ? cm[1].replace(/\s*$/, '').slice(0, 200) : undefined;
        const st = emit('while', 'WhileStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, db.name, lineNo);
      } else if (/^\s*case\s+/.test(text)) {
        const cm = trimmed.match(/^case\s+(.+)/); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('switch', 'CaseStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, db.name, lineNo);
      } else if (/^\s*begin\b/.test(text)) {
        emit('try', 'BeginBlock');
      } else if (/^\s*rescue\b/.test(text)) {
        emit('try', 'RescueClause');
      } else if (/^\s*return\b/.test(text)) {
        const expr = trimmed.replace(/^return\s*/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, db.name, lineNo);
      } else if (/^\s*raise\b/.test(text)) {
        const expr = trimmed.replace(/^raise\s*/, '');
        const st = emit('throw', 'RaiseStatement');
        if (expr) extractCalls(expr, st.temp_id, db.name, lineNo);
      } else if (/^\s*\w+\s*=\s*.+/.test(text) && !/^\s*(?:if|while|until|case|return|raise|def|class|module|end|rescue|ensure)/.test(text)) {
        const am = trimmed.match(/^(\w+)\s*=\s*(.+)/);
        if (am) {
          const st = emit('assignment', 'AssignmentStatement', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, db.name, lineNo);
        }
      } else if (/\w+[?!]?\s*[({]/.test(trimmed) && !/^\s*(?:if|while|until|case|return|raise|def|class|module|end|rescue|ensure|when|elsif|else)/.test(text)) {
        const cm2 = trimmed.match(/(?:(\w+)\.)?(\w+[?!]?)\s*[({]/);
        if (cm2) {
          const st = emit('call', 'CallExpression', { callee: cm2[2], receiver: cm2[1] || undefined });
          extractCalls(trimmed, st.temp_id, db.name, lineNo);
        }
      }
    }
  }

  const bodies = findDefBodies();
  for (const db of bodies) processBody(db);

  return { statements, callEdges };
}

class CrystalParser implements LanguageParser {
  language = 'crystal';
  extensions = ['.cr'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  version = 1;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Require
    // ══════════════════════════════════════════════
    const requireRe = /^require\s+"([^"]+)"/gm;
    while ((m = requireRe.exec(content)) !== null) {
      const path = m[1];
      const name = path.split('/').pop()?.replace(/\*$/, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^(\s*)module\s+([\w:]+)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'module',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Class / Struct (with abstract)
    // ══════════════════════════════════════════════
    const classRe = /^(\s*)(abstract\s+)?(class|struct)\s+([\w:]+)(?:\s*<\s*([\w:]+))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      const isAbstract = !!m[2];
      const kind = m[3];
      const name = m[4];
      const parent = m[5];
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'class',
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parent ? [parent] : undefined,
        line_start: lineStart,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} < ${parent}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)enum\s+([\w:]+)(?:\s*:\s*(\w+))?/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[2],
        value: m[3] ? `enum : ${m[3]}` : 'enum',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Lib (C bindings)
    // ══════════════════════════════════════════════
    const libRe = /^(\s*)lib\s+(\w+)/gm;
    while ((m = libRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'lib',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Fun (C function bindings inside lib)
    const funRe = /^\s+fun\s+(\w+)(?:\s*=\s*"(\w+)")?\s*\(([^)]*)\)(?:\s*:\s*(\w[\w*]*))?/gm;
    while ((m = funRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[2] || m[1],
        value: 'fun',
        return_type: m[4],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Methods (def)
    // ══════════════════════════════════════════════
    const defRe = /^(\s*)((?:(?:private|protected|abstract)\s+)*)def\s+(self\.)?(\w+[?!]?)(?:\(([^)]*)\))?(?:\s*:\s*(\w[\w|&?]*))?/gm;
    const seenDefs = new Set<string>();
    while ((m = defRe.exec(content)) !== null) {
      const modifiers = m[2];
      const isSelf = !!m[3];
      const name = m[4];
      const paramsRaw = m[5] || '';
      const returnType = m[6];
      const lineStart = lineAt(content, m.index);

      const key = `${isSelf ? 'self.' : ''}${name}`;
      if (seenDefs.has(key)) continue;
      seenDefs.add(key);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].split('=')[0].replace(/^\*+/, '').trim())
        .filter(p => p && !p.startsWith('&'));

      symbols.push({
        symbol_type: 'function',
        name: isSelf ? `self.${name}` : name,
        value: modifiers.includes('abstract') ? 'abstract def' : undefined,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !modifiers.includes('private'),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Macros
    // ══════════════════════════════════════════════
    const macroRe = /^(\s*)macro\s+(\w+)(?:\(([^)]*)\))?/gm;
    while ((m = macroRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[2],
        value: 'macro',
        params: m[3] ? m[3].split(',').map(p => p.trim()).filter(Boolean) : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Alias
    // ══════════════════════════════════════════════
    const aliasRe = /^\s*alias\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = aliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `alias = ${m[2].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Include / Extend
    // ══════════════════════════════════════════════
    const inclRe = /^\s*(include|extend)\s+([\w:]+)/gm;
    while ((m = inclRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `${m[1]} ${m[2]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 10. Properties (getter/setter/property)
    // ══════════════════════════════════════════════
    const propRe = /^\s*(getter|setter|property)\s+([\w?!]+)(?:\s*:\s*(\w[\w|?]*))?/gm;
    while ((m = propRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[1],
        return_type: m[3],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Annotation
    // ══════════════════════════════════════════════
    const annotRe = /^(\s*)annotation\s+(\w+)/gm;
    while ((m = annotRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: 'annotation',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 13. Routes — Kemal: get "/x" do, post "/x" do, ws "/x" do
    // ══════════════════════════════════════════════
    const kemalRouteRe = /^\s*(get|post|put|patch|delete|head|options|ws)\s+["']([^"']+)["']\s+do\b/gm;
    while ((m = kemalRouteRe.exec(content)) !== null) {
      const rawVerb = m[1].toLowerCase();
      const verb = rawVerb === 'ws' ? 'ws' : rawVerb;
      if (verb !== 'ws' && !HTTP_VERBS.has(verb)) continue;
      const routePath = m[2];
      if (!isLikelyHttpPath(routePath)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, routePath),
        value: routePath,
        params: [verb.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 14. Embedded SQL — DB.exec / db.query / db.scalar / db.query_one
    // ══════════════════════════════════════════════
    const sqlExecRe = /\b(?:DB|db)\.(?:exec|query|scalar|query_one)\s*\(\s*["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = sqlExecRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (looksLikeSql(sqlText)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
      }
    }

    const { statements, callEdges } = extractFlowCrystal(content);
    return { symbols, references, statements, callEdges };
  }
}

export const crystalParser = new CrystalParser();
