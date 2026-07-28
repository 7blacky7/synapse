/**
 * MODUL: Nim Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Nim-Dateien (.nim, .nims)
 *
 * EXTRAHIERT: import/from, include, proc/func/method/iterator/converter,
 *             type (object/enum/tuple/ref/distinct), template, macro,
 *             const/let/var, pragma, export marker (*), comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';

// Zeilenindex je Datei zwischenspeichern — siehe zeileFuerPosition in types.ts.
// Vorher wurde pro Treffer ein Praefix der Datei kopiert und zerlegt: das ist
// O(Treffer x Dateigroesse) und laesst grosse Dateien praktisch nie fertig werden.
let zeilenCacheText: string | null = null;
let zeilenCacheIndex: number[] = [];
function lineAt(text: string, pos: number): number {
  if (text !== zeilenCacheText) {
    zeilenCacheText = text;
    zeilenCacheIndex = erstelleZeilenIndex(text);
  }
  return zeileFuerPosition(zeilenCacheIndex, pos);
}

// ---------------------------------------------------------------------------
// Flow extraction (Nim) — indentation-based
// ---------------------------------------------------------------------------

function lineAtNim(text: string, pos: number): number {
  return lineAt(text, pos);
}

function extractFlowNim(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    // method call / UFCS: receiver.method(
    const methodRe = /(\w+)\.(\w+)\s*\(/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    // plain proc/func calls
    const funcRe = /(?<![.\w])([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','elif','else','for','while','case','of','return','yield','try','except','finally','defer','discard','when','import','from','include','proc','func','method','iterator','template','macro'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: 'function' });
    }
  }

  // Find proc/func/method bodies by indentation
  // We look for proc/func/method declarations and collect their indented bodies
  const lines = content.split('\n');

  interface ProcBody { name: string; startLine: number; bodyLines: { text: string; lineNo: number }[]; }

  function findProcBodies(): ProcBody[] {
    const bodies: ProcBody[] = [];
    const procRe = /^(proc|func|method|iterator|converter)\s+(\w+)/;
    let i = 0;
    while (i < lines.length) {
      const pm = procRe.exec(lines[i]);
      if (pm) {
        const name = pm[2];
        const startLine = i + 1; // 1-based
        // Collect body: next lines with indent > 0
        const bodyLines: { text: string; lineNo: number }[] = [];
        let j = i + 1;
        // Skip the header continuation lines (with indent, no body yet — until we get '=')
        // In Nim, body is after '=' or on next indented lines
        while (j < lines.length) {
          const l = lines[j];
          if (l.trim() === '' || l.trim().startsWith('#')) { j++; continue; }
          if (/^\S/.test(l)) break; // new top-level declaration
          bodyLines.push({ text: l, lineNo: j + 1 });
          j++;
        }
        if (bodyLines.length > 0) bodies.push({ name, startLine, bodyLines });
        i = j;
      } else {
        i++;
      }
    }
    return bodies;
  }

  function processBody(pb: ProcBody): void {
    let order = 0;
    for (const { text, lineNo } of pb.bodyLines) {
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'function', scope_name: pb.name, statement_type: type, node_kind: kind, line_start: lineNo, order_index: order++, depth: 0, is_top_level: false, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*if\s+/.test(text)) {
        const cm = trimmed.match(/^if\s+(.+?):/); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, pb.name, lineNo);
      } else if (/^\s*elif\s+/.test(text)) {
        const cm = trimmed.match(/^elif\s+(.+?):/); const cond = cm ? cm[1].slice(0, 200) : undefined;
        emit('if', 'ElifBranch', { condition_text: cond });
      } else if (/^\s*for\s+/.test(text)) {
        const cm = trimmed.match(/^for\s+(.+?):/); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('for', 'ForStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, pb.name, lineNo);
      } else if (/^\s*while\s+/.test(text)) {
        const cm = trimmed.match(/^while\s+(.+?):/); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('while', 'WhileStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, pb.name, lineNo);
      } else if (/^\s*case\s+/.test(text)) {
        const cm = trimmed.match(/^case\s+(.+)/); const cond = cm ? cm[1].slice(0, 200) : undefined;
        const st = emit('switch', 'CaseStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, pb.name, lineNo);
      } else if (/^\s*try:/.test(text)) {
        emit('try', 'TryStatement');
      } else if (/^\s*defer:/.test(text)) {
        emit('call', 'DeferStatement', { callee: 'defer' });
      } else if (/^\s*return\b/.test(text)) {
        const expr = trimmed.replace(/^return\s*/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, pb.name, lineNo);
      } else if (/^\s*raise\b/.test(text)) {
        const expr = trimmed.replace(/^raise\s*/, '');
        const st = emit('throw', 'RaiseStatement');
        if (expr) extractCalls(expr, st.temp_id, pb.name, lineNo);
      } else if (/^\s*(?:let|var|const)\s+\w+/.test(text)) {
        const vm = trimmed.match(/(?:let|var|const)\s+(\w+)(?:\s*:\s*\S+)?\s*=\s*(.+)/);
        if (vm) {
          const st = emit('variable', 'VariableDeclaration', { assigned_to: vm[1].slice(0, 120) });
          extractCalls(vm[2], st.temp_id, pb.name, lineNo);
        }
      } else if (/^\s*\w+\s*=\s*.+/.test(text) && !/^\s*(?:if|for|while|case|return|raise|let|var|const|proc|func|type|import)/.test(text)) {
        const am = trimmed.match(/^(\w+)\s*=\s*(.+)/);
        if (am) {
          const st = emit('assignment', 'AssignmentStatement', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, pb.name, lineNo);
        }
      } else if (/\w+\s*\(/.test(trimmed) && !/^\s*(?:if|for|while|case|return|raise|proc|func|let|var|const|type|import)/.test(text)) {
        const cm2 = trimmed.match(/(?:(\w+)\.)?(\w+)\s*\(/);
        if (cm2) {
          const st = emit('call', 'CallExpression', { callee: cm2[2], receiver: cm2[1] || undefined });
          extractCalls(trimmed, st.temp_id, pb.name, lineNo);
        }
      }
    }
  }

  const bodies = findProcBodies();
  for (const pb of bodies) processBody(pb);

  return { statements, callEdges };
}

class NimParser implements LanguageParser {
  language = 'nim';
  extensions = ['.nim', '.nims'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: type-Abschnitt endet an der ersten nicht eingerueckten Zeile — vorher sammelte
  //    jeder Abschnitt auch alle nachfolgenden Typen ein (massenhaft Duplikate).
  version = 3;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+([\w\/,\s]+)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const modules = m[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const mod of modules) {
        const name = mod.split('/').pop() || mod;
        symbols.push({
          symbol_type: 'import',
          name,
          value: mod,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
        references.push({
          symbol_name: name,
          line_number: lineAt(content, m.index),
          context: `import ${mod}`.slice(0, 80),
        });
      }
    }

    // From import
    const fromRe = /^from\s+([\w\/]+)\s+import\s+([\w,\s]+)/gm;
    while ((m = fromRe.exec(content)) !== null) {
      const module = m[1];
      const items = m[2].split(',').map(s => s.trim()).filter(Boolean);
      for (const item of items) {
        symbols.push({
          symbol_type: 'import',
          name: item,
          value: `from ${module} import ${item}`,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
      references.push({
        symbol_name: module.split('/').pop() || module,
        line_number: lineAt(content, m.index),
        context: `from ${module} import ${items.join(', ')}`.slice(0, 80),
      });
    }

    // Include
    const includeRe = /^include\s+([\w\/,\s]+)/gm;
    while ((m = includeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1].trim().split('/').pop() || m[1].trim(),
        value: `include ${m[1].trim()}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Type definitions
    // ══════════════════════════════════════════════
    const typeBlockRe = /^type\b/gm;
    while ((m = typeBlockRe.exec(content)) !== null) {
      // Der type-Abschnitt endet bei der ersten NICHT eingerueckten Zeile — Nim ist
      // einrueckungsbasiert. Vorher wurde ab hier der gesamte REST DER DATEI durchsucht,
      // wodurch jeder type-Abschnitt zusaetzlich alle nachfolgenden Typen einsammelte:
      // bei N Abschnitten N + (N-1) + ... Eintraege. Das erzeugte nicht nur Last, sondern
      // zehntausende exakte Duplikate im Index (bei 50KB: 12364 Symbole, davon 880 eindeutig).
      const blockStart = m.index + m[0].length;
      const endeRe = /\n(?=\S)/g;
      endeRe.lastIndex = blockStart;
      const endeTreffer = endeRe.exec(content);
      const blockEnde = endeTreffer ? endeTreffer.index : content.length;
      const typeDefRe = /^\s{2}(\w+)\*?\s*(?:\[([^\]]*)\])?\s*=\s*(ref\s+)?(?:object(?:\s+of\s+(\w+))?|enum|tuple|distinct\s+\w+|concept)/gm;
      // Direkt auf dem Original suchen statt eine Kopie zu bilden; dadurch ist die
      // Trefferposition bereits absolut und die Zeilennummer braucht keinen Offset.
      typeDefRe.lastIndex = blockStart;
      let tm: RegExpExecArray | null;

      while ((tm = typeDefRe.exec(content)) !== null) {
        if (tm.index >= blockEnde) break;
        const name = tm[1];
        const typeParams = tm[2];
        const isRef = !!tm[3];
        const parentType = tm[4];
        const kind = tm[0].includes('enum') ? 'enum'
          : tm[0].includes('object') ? 'class'
          : tm[0].includes('concept') ? 'interface'
          : 'interface';
        const lineStart = lineAt(content, tm.index);
        const isExported = tm[0].includes('*');

        symbols.push({
          symbol_type: kind === 'enum' ? 'enum' : kind === 'interface' ? 'interface' : 'class',
          name,
          value: isRef ? 'ref object' : kind === 'enum' ? 'enum' : 'object',
          params: parentType ? [`of ${parentType}`] : typeParams ? [`[${typeParams}]`] : undefined,
          line_start: lineStart,
          is_exported: isExported,
        });

        if (parentType) {
          references.push({
            symbol_name: parentType,
            line_number: lineStart,
            context: `${name} = object of ${parentType}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Procedures / Functions / Methods / Iterators
    // ══════════════════════════════════════════════
    const procRe = /^(proc|func|method|iterator|converter)\s+(\w+)\*?\s*(?:\[([^\]]*)\])?\s*\(([^)]*)\)(?:\s*:\s*(\w[\w\[\],\s]*))?/gm;
    while ((m = procRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const typeParams = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] ? m[5].trim() : undefined;
      const lineStart = lineAt(content, m.index);
      const isExported = m[0].includes('*');

      const params = paramsRaw
        .split(/[,;]/)
        .map(p => p.trim().split(':')[0].trim())
        .filter(p => p && p !== 'self');

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isExported,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Templates
    // ══════════════════════════════════════════════
    const templateRe = /^template\s+(\w+)\*?\s*(?:\(([^)]*)\))?/gm;
    while ((m = templateRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2] || '';
      const params = paramsRaw.split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'template',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: m[0].includes('*'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Macros
    // ══════════════════════════════════════════════
    const macroRe = /^macro\s+(\w+)\*?\s*\(([^)]*)\)/gm;
    while ((m = macroRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'macro',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: m[0].includes('*'),
      });
    }

    // ══════════════════════════════════════════════
    // 6. Constants / Let / Var (top-level)
    // ══════════════════════════════════════════════
    const constBlockRe = /^(const|let|var)\b/gm;
    while ((m = constBlockRe.exec(content)) !== null) {
      const kind = m[1];
      const afterBlock = content.substring(m.index + m[0].length);

      // Single-line: const NAME* = value
      const singleRe = /^\s+(\w+)\*?(?:\s*:\s*(\w[\w\[\]]*))?\s*=\s*(.+)/gm;
      let vm: RegExpExecArray | null;
      while ((vm = singleRe.exec(afterBlock)) !== null) {
        const name = vm[1];
        const varType = vm[2];
        const value = vm[3].trim().slice(0, 200);
        const isExported = vm[0].includes('*');
        const lineStart = lineAt(content, m.index + m[0].length + vm.index);

        // Stop when we hit unindented content
        if (!afterBlock.substring(vm.index).match(/^\s{2}/)) break;

        symbols.push({
          symbol_type: 'variable',
          name,
          value,
          return_type: varType,
          line_start: lineStart,
          is_exported: isExported,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. Pragmas ({.pragma.})
    // ══════════════════════════════════════════════
    // Pragmas are inline markers — skip for now (too noisy)

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
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
    // 9. Doc comments (## ...)
    // ══════════════════════════════════════════════
    const docRe = /((?:##[^\n]*\n)+)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/##\s?/g, '').trim();
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

    // ══════════════════════════════════════════════
    // 10. Jester Routes: get "/x": / post "/x": / ...
    // ══════════════════════════════════════════════
    const jesterRouteRe = /^\s*(get|post|put|patch|delete|head|options)\s+["']([^"']+)["']\s*:/gm;
    while ((m = jesterRouteRe.exec(content)) !== null) {
      const method = m[1].toLowerCase();
      const path = m[2];
      if (!HTTP_VERBS.has(method)) continue;
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    const { statements, callEdges } = extractFlowNim(content);
    return { symbols, references, statements, callEdges };
  }
}

export const nimParser = new NimParser();
