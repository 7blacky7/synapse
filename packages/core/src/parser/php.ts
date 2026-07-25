/**
 * MODUL: PHP Parser
 * ZWECK: Extrahiert Struktur-Informationen aus PHP-Dateien
 *
 * EXTRAHIERT: class, interface, trait, enum, function, method, property,
 *             const, use/namespace, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

function isExportedMod(modifiers: string): boolean {
  return /\b(public|protected)\b/.test(modifiers) || !/\bprivate\b/.test(modifiers);
}

class PhpParser implements LanguageParser {
  language = 'php';
  extensions = ['.php'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  version = 1;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Namespace
    // ══════════════════════════════════════════════
    const nsRe = /^namespace\s+([\w\\]+)\s*;/m;
    m = nsRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. use-Statements
    // ══════════════════════════════════════════════
    const useRe = /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm;
    while ((m = useRe.exec(content)) !== null) {
      const fqn = m[1];
      const alias = m[2];
      const name = alias || fqn.split('\\').pop() || fqn;
      symbols.push({
        symbol_type: 'import',
        name,
        value: fqn,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // Trait use inside classes
    const traitUseRe = /^\s+use\s+([\w\\,\s]+)\s*;/gm;
    while ((m = traitUseRe.exec(content)) !== null) {
      const traits = m[1].split(',').map(s => s.trim().split('\\').pop() || s.trim()).filter(Boolean);
      for (const trait of traits) {
        references.push({
          symbol_name: trait,
          line_number: lineAt(content, m.index),
          context: `use ${trait}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Classes, Interfaces, Traits, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+([\w\\]+))?(?:\s+implements\s+([\w\\,\s]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const extendsClause = m[3];
      const implementsClause = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (extendsClause) parents.push(extendsClause.split('\\').pop() || extendsClause);
      if (implementsClause) {
        parents.push(...implementsClause.split(',').map(s => {
          const p = s.trim();
          return p.split('\\').pop() || p;
        }).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methods
    // ══════════════════════════════════════════════
    const methodRe = /^(\s+)((?:(?:public|protected|private|static|abstract|final)\s+)*)function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\??\w[\w\\|]*))?(?:\s*\{)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] || undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/[=]/)[0].trim().split(/\s+/).pop()?.replace(/^\$/, '') || '')
        .filter(Boolean);

      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // Free functions
    const funcRe = /^function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\??\w[\w\\|]*))?(?:\s*\{)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const returnType = m[3] || undefined;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/[=]/)[0].trim().split(/\s+/).pop()?.replace(/^\$/, '') || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Properties
    // ══════════════════════════════════════════════
    const propRe = /^\s+((?:(?:public|protected|private|static|readonly)\s+)+)(?:(\??\w[\w\\]*)\s+)?\$(\w+)(?:\s*=\s*([^;]+))?\s*;/gm;
    while ((m = propRe.exec(content)) !== null) {
      const modifiers = m[1];
      const propType = m[2] || undefined;
      const propName = m[3];
      const value = m[4] ? m[4].trim().slice(0, 200) : undefined;
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: propName,
        value: value || propType,
        return_type: propType,
        line_start: lineAt(content, m.index),
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Constants
    // ══════════════════════════════════════════════
    const constRe = /^\s+(?:(?:public|protected|private)\s+)?const\s+(\w+)\s*=\s*([^;]+);/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
        parent_id: this.findParentType(content, m.index),
      });
    }

    // ══════════════════════════════════════════════
    // 7. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /(?:\/\/|#)\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 8. PHPDoc-Kommentare (/** ... */)
    // ══════════════════════════════════════════════
    const docRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 9. Routes — Laravel: Route::get('/x', ...), Route::post('/x', ...)
    //    Auch Router::, $router->get(...), $route->match([...], '/x', ...)
    // ══════════════════════════════════════════════
    const laravelRouteRe = /\b(?:Route|Router)\s*::\s*(get|post|put|patch|delete|head|options|any|match)\s*\(\s*(?:\[\s*([^\]]+)\s*\]\s*,\s*)?['"]([^'"]+)['"]/g;
    while ((m = laravelRouteRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      const matchMethods = m[2];
      const routePath = m[3];
      if (!isLikelyHttpPath(routePath)) continue;
      const line = lineAt(content, m.index);
      let methods: string[];
      if (verb === 'match' && matchMethods) {
        methods = matchMethods.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean);
      } else if (verb === 'any') {
        methods = ['ANY'];
      } else {
        methods = [verb.toUpperCase()];
      }
      for (const method of methods) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(method, routePath),
          value: routePath,
          params: [method],
          line_start: line,
          is_exported: false,
        });
      }
    }

    // Laravel/Lumen instance-style: $router->get('/x', ...), $app->post('/x', ...)
    const laravelInstanceRe = /\$\w+\s*->\s*(get|post|put|patch|delete|head|options|any)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = laravelInstanceRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      if (!HTTP_VERBS.has(verb) && verb !== 'any') continue;
      const routePath = m[2];
      if (!isLikelyHttpPath(routePath)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb === 'any' ? 'ANY' : verb.toUpperCase(), routePath),
        value: routePath,
        params: [verb === 'any' ? 'ANY' : verb.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Routes — Symfony 6+: #[Route('/x', methods: ['GET'])]
    //     Auch: #[Route(path: '/x', methods: ['POST'])]
    // ══════════════════════════════════════════════
    const symfonyRouteRe = /#\[\s*Route\s*\(\s*(?:path\s*:\s*)?['"]([^'"]+)['"](?:[^)]*?methods\s*:\s*\[([^\]]+)\])?/g;
    while ((m = symfonyRouteRe.exec(content)) !== null) {
      const routePath = m[1];
      if (!isLikelyHttpPath(routePath)) continue;
      const methodsRaw = m[2];
      const methods = methodsRaw
        ? methodsRaw.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean)
        : ['GET'];
      const line = lineAt(content, m.index);
      for (const method of methods) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(method, routePath),
          value: routePath,
          params: [method],
          line_start: line,
          is_exported: false,
        });
      }
    }

    // Symfony legacy annotation: @Route("/x", methods={"GET"}) inside docblocks
    const symfonyAnnotRe = /@Route\s*\(\s*['"]([^'"]+)['"](?:[^)]*?methods\s*=\s*\{([^}]+)\})?/g;
    while ((m = symfonyAnnotRe.exec(content)) !== null) {
      const routePath = m[1];
      if (!isLikelyHttpPath(routePath)) continue;
      const methodsRaw = m[2];
      const methods = methodsRaw
        ? methodsRaw.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean)
        : ['GET'];
      const line = lineAt(content, m.index);
      for (const method of methods) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(method, routePath),
          value: routePath,
          params: [method],
          line_start: line,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 11. Embedded SQL — PDO::query('...'), $pdo->exec('...'), $pdo->prepare('...')
    // ══════════════════════════════════════════════
    const phpSqlRe = /(?:->|::)\s*(?:query|exec|prepare)\s*\(\s*['"]((?:[^'"\\]|\\.){10,})['"]/g;
    while ((m = phpSqlRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (looksLikeSql(sqlText)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
      }
    }

    // ══════════════════════════════════════════════
    // FLOW: Statements + CallEdges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tempId = 0;
    const nextTmpId = (): string => `s${tempId++}`;
    const orderCounters = new Map<string, number>();
    function nextOrder(parentId: string | undefined): number {
      const key = parentId ?? 'root';
      const cur = orderCounters.get(key) ?? 0;
      orderCounters.set(key, cur + 1);
      return cur;
    }

    interface PhpScope { type: string; name: string | null; }
    const scopeStack: PhpScope[] = [{ type: 'module', name: null }];
    const curScope = (): PhpScope => scopeStack[scopeStack.length - 1];

    function emitS(
      stmtType: string, lineStart: number, parentId: string | undefined, depth: number,
      extra: Partial<ParsedStatement> = {},
    ): ParsedStatement {
      const sc = curScope();
      const id = nextTmpId();
      const st: ParsedStatement = {
        temp_id: id, parent_temp_id: parentId,
        scope_type: sc.type, scope_name: sc.name,
        statement_type: stmtType,
        line_start: lineStart, order_index: nextOrder(parentId), depth,
        is_top_level: sc.type === 'module' && depth === 0,
        is_awaited: false, ...extra,
      };
      statements.push(st);
      return st;
    }
    function emitC(stmtId: string, callee: string, receiver: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: curScope().name, callee_name: callee, callee_receiver: receiver, line_number: line, call_kind: kind });
    }

    const phpLines = content.split('\n');
    // brace-depth tracking for scope enter/exit
    let braceDepth = 0;
    // stack: { parentId, depth, braceDepthAtOpen, scopeIdx }
    interface PhpFrame { parentId: string | undefined; stmtDepth: number; braceDepthAtOpen: number; scopeName: string | null; scopeType: string; }
    const frameStack: PhpFrame[] = [{ parentId: undefined, stmtDepth: 0, braceDepthAtOpen: 0, scopeName: null, scopeType: 'module' }];
    const topFrame = (): PhpFrame => frameStack[frameStack.length - 1];

    for (let i = 0; i < phpLines.length; i++) {
      const rawLine = phpLines[i];
      const trimmed = rawLine.replace(/\/\/.*$/, '').trim();
      const lineNum = i + 1;
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      // Count braces
      const openBraces = (trimmed.match(/\{/g) || []).length;
      const closeBraces = (trimmed.match(/\}/g) || []).length;

      // Pop frames when braces close
      const prevDepth = braceDepth;
      // Process close braces first
      const netClose = closeBraces - openBraces;

      const frame = topFrame();
      const stmtDepth = frame.stmtDepth;

      // if / elseif
      const ifMatch = /^\}?\s*(?:elseif|if)\s*\((.{1,200})\)/.exec(trimmed);
      if (ifMatch) {
        const st = emitS('if', lineNum, frame.parentId, stmtDepth, { condition_text: ifMatch[1].slice(0, 200), text: trimmed.slice(0, 120) });
        if (openBraces > 0) frameStack.push({ parentId: st.temp_id, stmtDepth: stmtDepth + 1, braceDepthAtOpen: braceDepth + 1, scopeName: frame.scopeName, scopeType: frame.scopeType });
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // while / do
      const whileMatch = /^while\s*\((.{1,200})\)/.exec(trimmed);
      if (whileMatch) {
        const st = emitS('while', lineNum, frame.parentId, stmtDepth, { condition_text: whileMatch[1].slice(0, 200), text: trimmed.slice(0, 120) });
        if (openBraces > 0) frameStack.push({ parentId: st.temp_id, stmtDepth: stmtDepth + 1, braceDepthAtOpen: braceDepth + 1, scopeName: frame.scopeName, scopeType: frame.scopeType });
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // for / foreach
      const forMatch = /^for(?:each)?\s*\((.{1,200})\)/.exec(trimmed);
      if (forMatch) {
        const st = emitS('for', lineNum, frame.parentId, stmtDepth, { condition_text: forMatch[1].slice(0, 200), text: trimmed.slice(0, 120) });
        if (openBraces > 0) frameStack.push({ parentId: st.temp_id, stmtDepth: stmtDepth + 1, braceDepthAtOpen: braceDepth + 1, scopeName: frame.scopeName, scopeType: frame.scopeType });
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // switch
      const switchMatch = /^switch\s*\((.{1,200})\)/.exec(trimmed);
      if (switchMatch) {
        const st = emitS('switch', lineNum, frame.parentId, stmtDepth, { condition_text: switchMatch[1].slice(0, 200), text: trimmed.slice(0, 120) });
        if (openBraces > 0) frameStack.push({ parentId: st.temp_id, stmtDepth: stmtDepth + 1, braceDepthAtOpen: braceDepth + 1, scopeName: frame.scopeName, scopeType: frame.scopeType });
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // try / catch / finally
      if (/^try\s*\{/.test(trimmed)) {
        const st = emitS('try', lineNum, frame.parentId, stmtDepth, { text: trimmed.slice(0, 120) });
        frameStack.push({ parentId: st.temp_id, stmtDepth: stmtDepth + 1, braceDepthAtOpen: braceDepth + 1, scopeName: frame.scopeName, scopeType: frame.scopeType });
        braceDepth += openBraces - closeBraces;
        continue;
      }
      if (/^\}\s*catch\b/.test(trimmed) || /^\}\s*finally\b/.test(trimmed)) {
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // throw
      if (/^throw\b/.test(trimmed)) {
        emitS('throw', lineNum, frame.parentId, stmtDepth, { text: trimmed.slice(0, 120) });
        continue;
      }

      // return
      if (/^return\b/.test(trimmed)) {
        const callM = /(\w+)\s*\(/.exec(trimmed.slice(6));
        const st = emitS('return', lineNum, frame.parentId, stmtDepth, { text: trimmed.slice(0, 120) });
        if (callM) emitC(st.temp_id, callM[1], undefined, lineNum, 'function');
        continue;
      }

      // function / method declaration
      const fnMatch = /^(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+(\w+)\s*\(/.exec(trimmed);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const sc = curScope();
        const fnType = sc.type === 'class' ? 'method' : 'function';
        const scopeName2 = sc.type === 'class' && sc.name ? `${sc.name}.${fnName}` : fnName;
        if (openBraces > 0) {
          scopeStack.push({ type: fnType, name: scopeName2 });
          frameStack.push({ parentId: undefined, stmtDepth: 0, braceDepthAtOpen: braceDepth + openBraces - closeBraces, scopeName: scopeName2, scopeType: fnType });
        }
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // class declaration
      const classMatch = /^(?:abstract\s+|final\s+)?class\s+(\w+)/.exec(trimmed);
      if (classMatch && openBraces > 0) {
        scopeStack.push({ type: 'class', name: classMatch[1] });
        frameStack.push({ parentId: undefined, stmtDepth: 0, braceDepthAtOpen: braceDepth + openBraces - closeBraces, scopeName: classMatch[1], scopeType: 'class' });
        braceDepth += openBraces - closeBraces;
        continue;
      }

      // assignment: $var = expr
      const assignMatch = /^(\$\w+(?:->\w+)?)\s*(?:[.+\-*]?=)(?!=)\s*(.+)/.exec(trimmed);
      if (assignMatch) {
        const callM = /(\w+)\s*\(/.exec(assignMatch[2]);
        const st = emitS('assignment', lineNum, frame.parentId, stmtDepth, { assigned_to: assignMatch[1].slice(0, 120), text: trimmed.slice(0, 120) });
        if (callM) emitC(st.temp_id, callM[1], undefined, lineNum, 'function');
        braceDepth += openBraces - closeBraces;
        // pop frames for close braces
        while (frameStack.length > 1 && braceDepth < frameStack[frameStack.length - 1].braceDepthAtOpen) {
          const popped = frameStack.pop()!;
          if (popped.scopeType !== frame.scopeType || popped.scopeName !== frame.scopeName) scopeStack.pop();
        }
        continue;
      }

      // method call: $obj->method() or ClassName::method() or functionCall()
      const methodCallM = /^(?:\$(\w+)->|(\w+)::)?(\w+)\s*\(/.exec(trimmed);
      if (methodCallM && !/^(?:if|while|for|foreach|switch|function|class|return|throw|echo|print|new)\b/.test(trimmed)) {
        const receiver = methodCallM[1] || methodCallM[2];
        const callee = methodCallM[3];
        const kind = receiver ? (methodCallM[1] ? 'method' : 'method') : 'function';
        const st = emitS('call', lineNum, frame.parentId, stmtDepth, { callee, receiver, text: trimmed.slice(0, 120) });
        emitC(st.temp_id, callee, receiver, lineNum, kind);
        braceDepth += openBraces - closeBraces;
        while (frameStack.length > 1 && braceDepth < frameStack[frameStack.length - 1].braceDepthAtOpen) {
          const popped = frameStack.pop()!;
          if (popped.scopeType !== frame.scopeType || popped.scopeName !== frame.scopeName) scopeStack.pop();
        }
        continue;
      }

      // echo / print
      if (/^echo\b|^print\b/.test(trimmed)) {
        emitS('call', lineNum, frame.parentId, stmtDepth, { callee: trimmed.startsWith('echo') ? 'echo' : 'print', text: trimmed.slice(0, 120) });
      }

      braceDepth += openBraces - closeBraces;
      while (frameStack.length > 1 && braceDepth < frameStack[frameStack.length - 1].braceDepthAtOpen) {
        const popped = frameStack.pop()!;
        if (popped.scopeType !== frame.scopeType || popped.scopeName !== frame.scopeName) scopeStack.pop();
      }
    }

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

  private findParentType(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const classMatch = before.match(/(?:class|interface|trait|enum)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const phpParser = new PhpParser();
