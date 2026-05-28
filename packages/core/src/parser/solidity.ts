/**
 * MODUL: Solidity Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Solidity-Dateien (.sol)
 *
 * EXTRAHIERT: pragma, import, contract, interface, library, abstract contract,
 *             struct, enum, event, error, modifier, function, constructor,
 *             mapping, using, state variables, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer Solidity
// Erfasst: function/modifier Bodies mit if/for/while/require/revert/emit/calls
// ---------------------------------------------------------------------------
function extractSolidityFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;

  const lines = content.split('\n');

  // Per-parent order counter
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, scopeCounter: { n: number }): number {
    if (parentId === undefined) return scopeCounter.n++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  function emitStmt(
    lineStart: number,
    lineEnd: number,
    scopeType: string,
    scopeName: string | null,
    stmtType: string,
    depth: number,
    parentId: string | undefined,
    scopeCounter: { n: number },
    extra: Partial<ParsedStatement> = {},
  ): ParsedStatement {
    const isTop = scopeType === 'function' && depth === 0;
    const id = nextId();
    const st: ParsedStatement = {
      temp_id: id,
      parent_temp_id: parentId,
      scope_type: scopeType,
      scope_name: scopeName,
      statement_type: stmtType,
      line_start: lineStart,
      line_end: lineEnd,
      order_index: nextOrder(parentId, scopeCounter),
      depth,
      is_top_level: isTop,
      is_awaited: false,
      ...extra,
    };
    statements.push(st);
    return st;
  }

  // Find matching closing brace position (char index)
  function findClose(src: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return src.length - 1;
  }

  function charToLine(src: string, pos: number): number {
    return src.substring(0, pos).split('\n').length;
  }

  // Parse a block body (between { }) recursively
  function parseBlock(
    src: string,           // full content
    blockStart: number,    // position of '{'
    blockEnd: number,      // position of '}'
    scopeType: string,
    scopeName: string | null,
    depth: number,
    parentId: string | undefined,
    scopeCounter: { n: number },
  ): void {
    const body = src.substring(blockStart + 1, blockEnd);
    const baseOffset = blockStart + 1;

    // Strip comments for matching (but keep positions via offset)
    let pos = 0;
    while (pos < body.length) {
      // Skip strings
      if (body[pos] === '"' || body[pos] === "'") {
        const q = body[pos]; pos++;
        while (pos < body.length && body[pos] !== q) { if (body[pos] === '\\') pos++; pos++; }
        pos++; continue;
      }
      // Skip line comment
      if (body[pos] === '/' && body[pos+1] === '/') {
        while (pos < body.length && body[pos] !== '\n') pos++;
        continue;
      }
      // Skip block comment
      if (body[pos] === '/' && body[pos+1] === '*') {
        pos += 2;
        while (pos < body.length - 1 && !(body[pos] === '*' && body[pos+1] === '/')) pos++;
        pos += 2; continue;
      }

      // if(...) { ... } [else { ... }]
      const ifM = /^if\s*\(/.exec(body.slice(pos));
      if (ifM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        // find condition end
        let condEnd = pos + ifM[0].length - 1;
        let pDepth = 1;
        while (condEnd < body.length && pDepth > 0) {
          condEnd++;
          if (body[condEnd] === '(') pDepth++;
          else if (body[condEnd] === ')') pDepth--;
        }
        const condText = body.substring(pos + 3, condEnd).trim().slice(0, 200);
        // find then-block
        let thenStart = condEnd + 1;
        while (thenStart < body.length && /\s/.test(body[thenStart])) thenStart++;
        let lineEnd = lineStart;
        if (body[thenStart] === '{') {
          const thenClose = findClose(body, thenStart);
          lineEnd = charToLine(src, baseOffset + thenClose);
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'if', depth, parentId, scopeCounter, { condition_text: condText });
          parseBlock(body, thenStart, thenClose, scopeType, scopeName, depth + 1, st.temp_id, { n: 0 });
          pos = thenClose + 1;
          // else?
          const elseM = /^\s*else\s*\{/.exec(body.slice(pos));
          if (elseM) {
            const elseStart = pos + elseM[0].lastIndexOf('{');
            const elseClose = findClose(body, elseStart);
            parseBlock(body, elseStart, elseClose, scopeType, scopeName, depth + 1, st.temp_id, { n: orderCounters.get(`p:${st.temp_id}`) ?? 0 });
            pos = elseClose + 1;
          }
        } else {
          // single-line then
          const stmtEnd = body.indexOf(';', thenStart);
          lineEnd = stmtEnd >= 0 ? charToLine(src, baseOffset + stmtEnd) : lineStart;
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'if', depth, parentId, scopeCounter, { condition_text: condText });
          if (stmtEnd >= 0) pos = stmtEnd + 1;
          else pos = thenStart + 1;
        }
        continue;
      }

      // for(...) { ... }
      const forM = /^for\s*\(/.exec(body.slice(pos));
      if (forM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        let condEnd = pos + forM[0].length - 1;
        let pDepth = 1;
        while (condEnd < body.length && pDepth > 0) {
          condEnd++;
          if (body[condEnd] === '(') pDepth++;
          else if (body[condEnd] === ')') pDepth--;
        }
        const condText = body.substring(pos + 4, condEnd).trim().slice(0, 200);
        let bodyStart = condEnd + 1;
        while (bodyStart < body.length && /\s/.test(body[bodyStart])) bodyStart++;
        if (body[bodyStart] === '{') {
          const bodyClose = findClose(body, bodyStart);
          const lineEnd = charToLine(src, baseOffset + bodyClose);
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'for', depth, parentId, scopeCounter, { condition_text: condText });
          parseBlock(body, bodyStart, bodyClose, scopeType, scopeName, depth + 1, st.temp_id, { n: 0 });
          pos = bodyClose + 1;
        } else {
          emitStmt(lineStart, lineStart, scopeType, scopeName, 'for', depth, parentId, scopeCounter, { condition_text: condText });
          pos = condEnd + 1;
        }
        continue;
      }

      // while(...) { ... }
      const whileM = /^while\s*\(/.exec(body.slice(pos));
      if (whileM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        let condEnd = pos + whileM[0].length - 1;
        let pDepth = 1;
        while (condEnd < body.length && pDepth > 0) {
          condEnd++;
          if (body[condEnd] === '(') pDepth++;
          else if (body[condEnd] === ')') pDepth--;
        }
        const condText = body.substring(pos + 6, condEnd).trim().slice(0, 200);
        let bodyStart = condEnd + 1;
        while (bodyStart < body.length && /\s/.test(body[bodyStart])) bodyStart++;
        if (body[bodyStart] === '{') {
          const bodyClose = findClose(body, bodyStart);
          const lineEnd = charToLine(src, baseOffset + bodyClose);
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'while', depth, parentId, scopeCounter, { condition_text: condText });
          parseBlock(body, bodyStart, bodyClose, scopeType, scopeName, depth + 1, st.temp_id, { n: 0 });
          pos = bodyClose + 1;
        } else {
          emitStmt(lineStart, lineStart, scopeType, scopeName, 'while', depth, parentId, scopeCounter, { condition_text: condText });
          pos = condEnd + 1;
        }
        continue;
      }

      // require(...); or revert(...);
      const reqM = /^(require|revert)\s*\(/.exec(body.slice(pos));
      if (reqM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        let argEnd = pos + reqM[0].length - 1;
        let pDepth = 1;
        while (argEnd < body.length && pDepth > 0) {
          argEnd++;
          if (body[argEnd] === '(') pDepth++;
          else if (body[argEnd] === ')') pDepth--;
        }
        const argText = body.substring(pos + reqM[1].length + 1, argEnd).trim().slice(0, 200);
        const stmtType = reqM[1] === 'require' ? 'call' : 'throw';
        const st = emitStmt(lineStart, lineStart, scopeType, scopeName, stmtType, depth, parentId, scopeCounter, {
          callee: reqM[1],
          condition_text: argText,
        });
        callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: reqM[1], line_number: lineStart, call_kind: 'function' });
        pos = argEnd + 2; // skip ');'
        continue;
      }

      // emit EventName(...);
      const emitM = /^emit\s+(\w+)\s*\(/.exec(body.slice(pos));
      if (emitM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        const st = emitStmt(lineStart, lineStart, scopeType, scopeName, 'call', depth, parentId, scopeCounter, { callee: emitM[1] });
        callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: emitM[1], line_number: lineStart, call_kind: 'function' });
        const semi = body.indexOf(';', pos);
        pos = semi >= 0 ? semi + 1 : pos + emitM[0].length;
        continue;
      }

      // return ...;
      const retM = /^return\b/.exec(body.slice(pos));
      if (retM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        const semi = body.indexOf(';', pos);
        emitStmt(lineStart, lineStart, scopeType, scopeName, 'return', depth, parentId, scopeCounter);
        pos = semi >= 0 ? semi + 1 : pos + 6;
        continue;
      }

      // Generic statement ending in ;
      if (body[pos] === ';') { pos++; continue; }
      if (body[pos] === '{') { pos = findClose(body, pos) + 1; continue; }
      if (body[pos] === '}') { pos++; continue; }

      // Check for a generic function call: identifier(
      const callM = /^([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/.exec(body.slice(pos));
      if (callM) {
        const absPos = baseOffset + pos;
        const lineStart = charToLine(src, absPos);
        const parts = callM[1].split('.');
        const callee = parts[parts.length - 1];
        const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
        // find end of statement
        let argEnd = pos + callM[0].length - 1;
        let pDepth = 1;
        while (argEnd < body.length && pDepth > 0) {
          argEnd++;
          if (body[argEnd] === '(') pDepth++;
          else if (body[argEnd] === ')') pDepth--;
        }
        const semi = body.indexOf(';', argEnd);
        // Only emit as call if followed by ; (statement level)
        if (semi >= 0 && semi - argEnd < 5) {
          const st = emitStmt(lineStart, lineStart, scopeType, scopeName, 'call', depth, parentId, scopeCounter, { callee, receiver });
          callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: lineStart, call_kind: receiver ? 'method' : 'function' });
          pos = semi + 1;
          continue;
        }
      }

      pos++;
    }
  }

  // Extract function/modifier bodies and process them
  const funcBodyRe = /\b(function|modifier|constructor|receive|fallback)\s*(\w*)?\s*(?:\([^)]*\))?\s*(?:[^{]*?)\{/g;
  let fm: RegExpExecArray | null;
  while ((fm = funcBodyRe.exec(content)) !== null) {
    const kind = fm[1];
    const name = fm[2] || kind;
    const openBrace = content.indexOf('{', fm.index + fm[0].length - 1);
    if (openBrace < 0) continue;
    const closeBrace = findClose(content, openBrace);
    const scopeCounter = { n: 0 };
    parseBlock(content, openBrace, closeBrace, 'function', name, 0, undefined, scopeCounter);
  }

  return { statements, callEdges };
}

class SolidityParser implements LanguageParser {
  language = 'solidity';
  extensions = ['.sol'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Pragma
    // ══════════════════════════════════════════════
    const pragmaRe = /^pragma\s+(\w+)\s+([^;]+);/gm;
    while ((m = pragmaRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `pragma ${m[1]}`,
        value: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(?:\{([^}]+)\}\s+from\s+)?["']([^"']+)["']\s*;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const names = m[1] ? m[1].split(',').map(n => n.trim()).filter(Boolean) : [];
      const path = m[2];
      const shortName = path.split('/').pop()?.replace('.sol', '') || path;

      if (names.length > 0) {
        for (const name of names) {
          symbols.push({
            symbol_type: 'import',
            name: name.split(' as ').pop()!.trim(),
            value: `${name} from ${path}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      } else {
        symbols.push({
          symbol_type: 'import',
          name: shortName,
          value: path,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Contract / Interface / Library
    // ══════════════════════════════════════════════
    const contractRe = /^(abstract\s+)?(contract|interface|library)\s+(\w+)(?:\s+is\s+([^\n{]+))?\s*\{/gm;
    while ((m = contractRe.exec(content)) !== null) {
      const isAbstract = !!m[1];
      const kind = m[2];
      const name = m[3];
      const inherits = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface' : 'class';
      const parents: string[] = [];
      if (inherits) {
        parents.push(...inherits.split(',').map(s => s.trim().split('(')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} is ${inherits?.trim()}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Struct
    // ══════════════════════════════════════════════
    const structRe = /^\s*struct\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^\s*enum\s+(\w+)\s*\{/gm;
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
    // 6. Event
    // ══════════════════════════════════════════════
    const eventRe = /^\s*event\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = eventRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => {
        const parts = p.trim().split(/\s+/);
        return parts[parts.length - 1];
      }).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'event',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Error (custom errors)
    // ══════════════════════════════════════════════
    const errorRe = /^\s*error\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = errorRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'error',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Modifier
    // ══════════════════════════════════════════════
    const modRe = /^\s*modifier\s+(\w+)\s*(?:\(([^)]*)\))?\s*\{/gm;
    while ((m = modRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'modifier',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^\s*function\s+(\w+)\s*\(([^)]*)\)\s*((?:(?:public|external|internal|private|view|pure|payable|virtual|override|returns)\s*(?:\([^)]*\))?\s*)*)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const modifiers = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      const returnsMatch = modifiers.match(/returns\s*\(([^)]*)\)/);
      const returnType = returnsMatch ? returnsMatch[1].trim() : undefined;

      const visibility = /\b(public|external|internal|private)\b/.exec(modifiers);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: visibility ? !['private', 'internal'].includes(visibility[1]) : true,
      });
    }

    // Constructor
    const ctorRe = /^\s*constructor\s*\(([^)]*)\)/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: 'constructor',
        value: 'constructor',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Receive / Fallback
    const specialRe = /^\s*(receive|fallback)\s*\(\s*\)/gm;
    while ((m = specialRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. State variables
    // ══════════════════════════════════════════════
    const stateVarRe = /^\s*(mapping\s*\([^)]+\)|[\w\[\]]+)\s+(public\s+|private\s+|internal\s+)?(constant\s+|immutable\s+)?(\w+)(?:\s*=\s*([^;]+))?;/gm;
    while ((m = stateVarRe.exec(content)) !== null) {
      const varType = m[1];
      const visibility = m[2] ? m[2].trim() : '';
      const modifier = m[3] ? m[3].trim() : '';
      const name = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip common false positives
      if (['return', 'emit', 'require', 'revert', 'delete', 'event', 'error', 'struct', 'enum'].includes(varType)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || `${modifier} ${varType}`.trim(),
        return_type: varType,
        line_start: lineStart,
        is_exported: visibility === 'public',
      });
    }

    // ══════════════════════════════════════════════
    // 11. Using
    // ══════════════════════════════════════════════
    const usingRe = /^\s*using\s+([\w.]+)\s+for\s+(\S+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `using ${m[1]} for ${m[2]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 13. NatSpec comments (/** ... */ or /// ...)
    // ══════════════════════════════════════════════
    const natspecRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = natspecRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));

    const { statements, callEdges } = extractSolidityFlow(content);
    return { symbols, references, statements, callEdges };
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

export const solidityParser = new SolidityParser();
