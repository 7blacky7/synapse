/**
 * MODUL: Ada Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Ada-Dateien (.adb, .ads)
 *
 * EXTRAHIERT: with/use, package, procedure, function, type (record/enum/tagged/
 *             access/derived), subtype, generic, task, protected, entry,
 *             exception, pragma, constant, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (Ada) — case-insensitive, keyword-based
// ---------------------------------------------------------------------------

function lineAtAda(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowAda(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    // Ada procedure/function calls: Name(...) or Pkg.Name(...)
    const methodRe = /(\w+)\.(\w+)\s*\(/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    const funcRe = /(?<![.\w])([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1].toLowerCase();
      if (['if','elsif','else','loop','while','for','case','when','return','raise','declare','begin','end','exception','exit','goto','select','accept','delay','abort','null','new','not','and','or','xor','in','out','rem','mod','abs'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'function' });
    }
    // new TypeName(...)
    const newRe = /\bnew\s+(\w[\w.]*)/gi;
    while ((mc = newRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'new' });
    }
  }

  const allLines = content.split('\n');

  interface SubBody { name: string; startLine: number; lines: { text: string; lineNo: number }[]; }

  function findSubBodies(): SubBody[] {
    const bodies: SubBody[] = [];
    // Match procedure/function body start: "procedure/function Name ..."
    // Body begins at "is" keyword on same or next line and ends at "end Name;"
    const startRe = /^\s*(?:overriding\s+)?(?:procedure|function)\s+(\w+)/i;
    let i = 0;
    while (i < allLines.length) {
      const sm = startRe.exec(allLines[i]);
      if (sm) {
        const name = sm[1];
        // Look for "is" to mark body start (skip spec-only declarations ending with ";")
        let bodyStart = -1;
        let j = i;
        while (j < allLines.length && j < i + 20) {
          if (/\bis\b/i.test(allLines[j]) && !/\bis\s+(?:new|abstract|separate|null)/i.test(allLines[j])) {
            bodyStart = j + 1;
            break;
          }
          if (/;\s*$/.test(allLines[j].trim()) && j > i) break; // spec only
          j++;
        }
        if (bodyStart < 0) { i++; continue; }
        // Collect until "end Name;" or "end;"
        const endRe = new RegExp(`^\\s*end\\s+(?:${name}\\s*)?;`, 'i');
        const bodyLines: { text: string; lineNo: number }[] = [];
        let k = bodyStart;
        while (k < allLines.length) {
          if (endRe.test(allLines[k]) || /^\s*end\s*;/i.test(allLines[k])) { k++; break; }
          bodyLines.push({ text: allLines[k], lineNo: k + 1 });
          k++;
        }
        bodies.push({ name, startLine: i + 1, lines: bodyLines });
        i = k;
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
      if (!trimmed || trimmed.startsWith('--')) continue;
      const code = trimmed.replace(/--.*$/, '').trim();
      if (!code) continue;

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'function', scope_name: sb.name, statement_type: type, node_kind: kind, line_start: lineNo, order_index: order++, depth: 0, is_top_level: false, is_awaited: false, text: code.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*if\b/i.test(code)) {
        const cm = code.match(/\bif\s+(.+?)\s+then\b/i); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*elsif\b/i.test(code)) {
        const cm = code.match(/\belsif\s+(.+?)\s+then\b/i); const cond = cm ? cm[1].slice(0, 200) : undefined;
        emit('if', 'ElsifBranch', { condition_text: cond });
      } else if (/^\s*loop\b/i.test(code) || /^\s*while\s+.+\s+loop\b/i.test(code)) {
        const cm = code.match(/\bwhile\s+(.+?)\s+loop\b/i); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('while', 'WhileLoop', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*for\s+\w+\s+in\b/i.test(code)) {
        const cm = code.match(/\bfor\s+(.+?)\s+loop\b/i); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('for', 'ForLoop', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*case\s+.+\s+is\b/i.test(code)) {
        const cm = code.match(/\bcase\s+(.+?)\s+is\b/i); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('switch', 'CaseStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, sb.name, lineNo);
      } else if (/^\s*begin\b/i.test(code)) {
        emit('try', 'BeginBlock');
      } else if (/^\s*exception\b/i.test(code)) {
        emit('try', 'ExceptionBlock');
      } else if (/^\s*return\b/i.test(code)) {
        const expr = code.replace(/^return\s*/i, '').replace(/;$/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, sb.name, lineNo);
      } else if (/^\s*raise\b/i.test(code)) {
        const expr = code.replace(/^raise\s*/i, '').replace(/;$/, '');
        const st = emit('throw', 'RaiseStatement');
        if (expr) extractCalls(expr, st.temp_id, sb.name, lineNo);
      } else if (/^\s*goto\b/i.test(code)) {
        const cm = code.match(/\bgoto\s+(\w+)/i);
        emit('goto', 'GotoStatement', { callee: cm ? cm[1] : undefined });
      } else if (/\s*:=\s*/.test(code) && !/^\s*(?:if|elsif|while|for|case|begin|exception|return|raise|goto|declare|end|when|else|loop)/.test(code.toLowerCase())) {
        const am = code.match(/^([\w.()]+)\s*:=\s*(.+);?$/);
        if (am) {
          const st = emit('assignment', 'AssignmentStatement', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, sb.name, lineNo);
        }
      } else if (/^\s*[\w.]+\s*\(/.test(code) && /;\s*$/.test(code) && !/^\s*(?:if|elsif|while|for|case|begin|exception|return|raise|goto|declare|end|when|else|loop|procedure|function|type|subtype|package|with|use|pragma)/i.test(code)) {
        const cm2 = code.match(/^([\w.]+)\s*\(/);
        if (cm2) {
          const parts = cm2[1].split('.');
          const callee = parts[parts.length - 1];
          const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
          const st = emit('call', 'ProcedureCall', { callee, receiver });
          extractCalls(code, st.temp_id, sb.name, lineNo);
        }
      }
    }
  }

  const bodies = findSubBodies();
  for (const sb of bodies) processBody(sb);

  return { statements, callEdges };
}

class AdaParser implements LanguageParser {
  language = 'ada';
  extensions = ['.adb', '.ads', '.ada'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  version = 1;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. With / Use (imports)
    // ══════════════════════════════════════════════
    const withRe = /^\s*with\s+([\w.,\s]+)\s*;/gim;
    while ((m = withRe.exec(content)) !== null) {
      const pkgs = m[1].split(',').map(p => p.trim()).filter(Boolean);
      for (const pkg of pkgs) {
        symbols.push({
          symbol_type: 'import',
          name: pkg.split('.').pop() || pkg,
          value: pkg,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
        references.push({
          symbol_name: pkg.split('.').pop() || pkg,
          line_number: lineAt(content, m.index),
          context: `with ${pkg}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 2. Package
    // ══════════════════════════════════════════════
    const pkgRe = /^\s*package\s+(?:body\s+)?(\w[\w.]*)\s+is/gim;
    while ((m = pkgRe.exec(content)) !== null) {
      const isBody = /body/i.test(m[0]);
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: isBody ? 'package body' : 'package',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Procedure
    // ══════════════════════════════════════════════
    const procRe = /^\s*(?:overriding\s+)?procedure\s+(\w+)\s*(?:\(([^)]*)\))?/gim;
    while ((m = procRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2]
        ? m[2].split(';').map(p => p.trim().split(':')[0].trim().split(',')[0].trim()).filter(Boolean)
        : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'procedure',
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Function
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(?:overriding\s+)?function\s+(\w+)\s*(?:\(([^)]*)\))?\s*return\s+(\w[\w.]*)/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2]
        ? m[2].split(';').map(p => p.trim().split(':')[0].trim().split(',')[0].trim()).filter(Boolean)
        : undefined;
      const returnType = m[3];

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Type definitions
    // ══════════════════════════════════════════════
    const typeRe = /^\s*type\s+(\w+)(?:\s+is\s+(.+?))?;/gim;
    while ((m = typeRe.exec(content)) !== null) {
      const name = m[1];
      const def = m[2] ? m[2].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      if (!def) {
        // Incomplete/private type
        symbols.push({
          symbol_type: 'interface',
          name,
          value: 'private type',
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/^\(/.test(def)) {
        // Enum
        const values = def.replace(/[()]/g, '').split(',').map(v => v.trim()).filter(Boolean);
        symbols.push({
          symbol_type: 'enum',
          name,
          value: 'enum',
          params: values,
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/record/i.test(def)) {
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'record',
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/tagged/i.test(def)) {
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'tagged type',
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/new\s+(\w+)/i.test(def)) {
        const parentMatch = def.match(/new\s+(\w[\w.]*)/i);
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'derived type',
          params: parentMatch ? [`new ${parentMatch[1]}`] : undefined,
          line_start: lineStart,
          is_exported: true,
        });
        if (parentMatch) {
          references.push({
            symbol_name: parentMatch[1],
            line_number: lineStart,
            context: `type ${name} is new ${parentMatch[1]}`.slice(0, 80),
          });
        }
      } else if (/access/i.test(def)) {
        symbols.push({
          symbol_type: 'interface',
          name,
          value: `access ${def.replace(/access\s*/i, '').trim()}`,
          line_start: lineStart,
          is_exported: true,
        });
      } else {
        symbols.push({
          symbol_type: 'interface',
          name,
          value: `type = ${def.slice(0, 200)}`,
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Subtype
    // ══════════════════════════════════════════════
    const subtypeRe = /^\s*subtype\s+(\w+)\s+is\s+(.+);/gim;
    while ((m = subtypeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `subtype ${m[2].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Generic
    // ══════════════════════════════════════════════
    const genericRe = /^\s*generic/gim;
    while ((m = genericRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'generic',
        value: 'generic',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Task / Protected
    // ══════════════════════════════════════════════
    const taskRe = /^\s*(task|protected)\s+(?:type\s+|body\s+)?(\w+)\s+is/gim;
    while ((m = taskRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: m[1].toLowerCase(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Entry
    const entryRe = /^\s*entry\s+(\w+)\s*(?:\(([^)]*)\))?/gim;
    while ((m = entryRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'entry',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Exception
    // ══════════════════════════════════════════════
    const exnRe = /^\s*(\w+)\s*:\s*exception\s*;/gim;
    while ((m = exnRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'exception',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Constants
    // ══════════════════════════════════════════════
    const constRe = /^\s*(\w+)\s*:\s*constant\s+(\w[\w.]*)\s*:=\s*([^;]+);/gim;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[3].trim().slice(0, 200),
        return_type: m[2],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Pragma
    // ══════════════════════════════════════════════
    const pragmaRe = /^\s*pragma\s+(\w+)(?:\s*\(([^)]*)\))?;/gim;
    while ((m = pragmaRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `pragma ${m[1]}`,
        value: m[2] ? m[2].trim() : m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /--\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 13. Embedded SQL (APQ + GNATColl)
    // ══════════════════════════════════════════════
    const apqRe = /\b(?:Execute|Prepare|Query)\s*\(\s*\w+\s*,\s*"((?:[^"\\]|\\.){10,})"/gi;
    while ((m = apqRe.exec(content)) !== null) {
      const sqlContent = m[1];
      if (looksLikeSql(sqlContent)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
      }
    }

    const gnatRe = /\bGNATColl\.SQL\.\w+\s*\(\s*"((?:[^"\\]|\\.){10,})"/gi;
    while ((m = gnatRe.exec(content)) !== null) {
      const sqlContent = m[1];
      if (looksLikeSql(sqlContent)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
      }
    }

    const { statements, callEdges } = extractFlowAda(content);
    return { symbols, references, statements, callEdges };
  }
}

export const adaParser = new AdaParser();
