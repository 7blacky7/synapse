/**
 * MODUL: TypeScript AST-Parser
 * ZWECK: Extrahiert 11 Symbol-Typen und Referenzen aus TS/JS-Dateien
 *        via TypeScript Compiler API
 */

import * as ts from 'typescript';
import type {
  LanguageParser,
  ParseResult,
  ParsedSymbol,
  ParsedReference,
  ParsedStatement,
  ParsedCallEdge,
} from './types.js';
import { extractStringLiterals } from './types.js';
import { HTTP_VERBS, NEST_DECORATORS, formatRouteName, isLikelyHttpPath } from './patterns/http.js';
import { SQL_DB_METHODS, SQL_TAGS, parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLineNumber(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1; // 1-based
}

function getLineEnd(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function isExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  if (!mods) return false;
  return mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function typeToString(type: ts.TypeNode | undefined): string | undefined {
  if (!type) return undefined;
  return type.getText();
}

function getContextSnippet(text: string, pos: number, length = 80): string {
  const half = Math.floor(length / 2);
  const start = Math.max(0, pos - half);
  const end = Math.min(text.length, pos + half);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Extrahiert den String-Inhalt aus einem ts.Expression Node, falls es ein
 * StringLiteral oder ein NoSubstitutionTemplateLiteral ist. Gibt null zurueck
 * wenn der Node keinen statischen String enthaelt (z.B. Variable, Komposition).
 * Bei Template-Strings mit ${...} wird der Rohtext zurueckgegeben (Substitutions
 * bleiben als Platzhalter erhalten — fuer SQL-Parser ist das ok).
 */
function getStaticStringValue(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isTemplateExpression(expr)) {
    // Template mit Substitutions: head + spans (text-only, Substitutions als ${})
    let s = expr.head.text;
    for (const span of expr.templateSpans) {
      s += '${}' + span.literal.text;
    }
    return s;
  }
  return null;
}

/**
 * Sammelt alle const/let-Variablen die einem String/Template-Literal zugewiesen
 * sind (auf beliebiger Ebene). Nuetzlich um z.B. db.exec(SCHEMA_SQL) aufzuloesen
 * wo SCHEMA_SQL ein Top-Level-const mit Template-Literal ist.
 *
 * Map: variable-name → { value, defLine } — defLine ist die Zeile der Definition,
 * nicht des call-sites. Embedded-SQL-Subparsing bekommt diese Zeile als Offset.
 */
function collectStringConsts(
  sourceFile: ts.SourceFile,
): Map<string, { value: string; defLine: number }> {
  const out = new Map<string, { value: string; defLine: number }>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const value = getStaticStringValue(node.initializer);
      if (value !== null) {
        const defLine = sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart()).line + 1;
        out.set(node.name.getText(), { value, defLine });
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
  return out;
}

/**
 * Versucht einen Expression-Wert als String zu resolven. Erst direkt
 * (Literal/Template), dann Identifier-Reference auf eine string-const aus dem
 * stringConsts-Cache. Gibt {value, defLine} zurueck — defLine ist die Zeile
 * des Quell-Literals (nicht des call-sites), damit Embedded-SQL-Symbole sich
 * auf die richtige Stelle beziehen.
 */
function resolveStringExpression(
  expr: ts.Expression,
  stringConsts: Map<string, { value: string; defLine: number }>,
  sourceFile: ts.SourceFile,
): { value: string; defLine: number } | null {
  const direct = getStaticStringValue(expr);
  if (direct !== null) {
    const defLine = sourceFile.getLineAndCharacterOfPosition(expr.getStart()).line + 1;
    return { value: direct, defLine };
  }
  if (ts.isIdentifier(expr)) {
    const ref = stringConsts.get(expr.getText());
    if (ref) return ref;
  }
  return null;
}

// parseEmbeddedSql ist jetzt aus './patterns/sql.js' importiert (geteilt mit
// anderen Sprach-Parsern).

// ---------------------------------------------------------------------------
// Symbol extraction pass
// ---------------------------------------------------------------------------

function extractSymbols(
  sourceFile: ts.SourceFile,
  fullText: string,
): { symbols: ParsedSymbol[]; definedNames: Set<string> } {
  const symbols: ParsedSymbol[] = [];
  const definedNames = new Set<string>();
  // Pre-Pass: sammle alle String-Konstanten fuer Identifier-Resolution
  // (z.B. const SCHEMA_SQL = `CREATE...` ; pool.query(SCHEMA_SQL))
  const stringConsts = collectStringConsts(sourceFile);

  // Track nesting for parent_id
  const functionStack: string[] = [];

  function addSymbol(sym: ParsedSymbol): void {
    symbols.push(sym);
    if (sym.name) definedNames.add(sym.name);
  }

  function getParentId(): string | undefined {
    return functionStack.length > 0
      ? functionStack[functionStack.length - 1]
      : undefined;
  }

  function visitFunctionLike(
    node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    name: string | null,
    exported: boolean,
    variableName?: string,
  ): void {
    const displayName = variableName ?? name;
    const params = node.parameters.map(p => {
      const paramName = p.name.getText();
      const paramType = p.type ? `:${p.type.getText()}` : '';
      return `${paramName}${paramType}`;
    });
    const returnType = typeToString(node.type);
    const line_start = getLineNumber(sourceFile, node.getStart());
    const line_end = getLineEnd(sourceFile, node);
    const parent_id = getParentId();

    addSymbol({
      symbol_type: 'function',
      name: displayName,
      line_start,
      line_end,
      params,
      return_type: returnType,
      is_exported: exported,
      parent_id,
    });

    // Push onto stack for nested functions
    if (displayName) functionStack.push(displayName);
    ts.forEachChild(node, visitNode);
    if (displayName) functionStack.pop();
  }

  function visitNode(node: ts.Node): void {
    // Function declarations
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText() ?? null;
      visitFunctionLike(node, name, isExported(node));
      return; // already recursed inside visitFunctionLike
    }

    // Class declarations
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText() ?? null;
      const extendsClause = node.heritageClauses?.find(
        h => h.token === ts.SyntaxKind.ExtendsKeyword,
      );
      const implementsClause = node.heritageClauses?.find(
        h => h.token === ts.SyntaxKind.ImplementsKeyword,
      );
      const extendsList = extendsClause?.types.map(t => t.getText()) ?? [];
      const implementsList = implementsClause?.types.map(t => t.getText()) ?? [];
      const allParents = [...extendsList, ...implementsList];

      addSymbol({
        symbol_type: 'class',
        name,
        line_start: getLineNumber(sourceFile, node.getStart()),
        line_end: getLineEnd(sourceFile, node),
        params: allParents.length > 0 ? allParents : undefined,
        is_exported: isExported(node),
      });
      ts.forEachChild(node, visitNode);
      return;
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText();
      const fields = node.members
        .slice(0, 30)
        .map(m => {
          const memberName = 'name' in m && m.name ? (m.name as ts.Identifier).getText() : '?';
          const memberType =
            ts.isPropertySignature(m) && m.type ? `:${m.type.getText()}` : '';
          return `${memberName}${memberType}`;
        });

      addSymbol({
        symbol_type: 'interface',
        name,
        line_start: getLineNumber(sourceFile, node.getStart()),
        line_end: getLineEnd(sourceFile, node),
        params: fields,
        is_exported: isExported(node),
      });
      // No need to recurse into interface body for deeper symbols
      return;
    }

    // Enum declarations
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText();
      const members = node.members.map(m => {
        const mName = m.name.getText();
        const mVal = m.initializer ? `=${m.initializer.getText()}` : '';
        return `${mName}${mVal}`;
      });

      addSymbol({
        symbol_type: 'enum',
        name,
        line_start: getLineNumber(sourceFile, node.getStart()),
        line_end: getLineEnd(sourceFile, node),
        params: members,
        is_exported: isExported(node),
      });
      return;
    }

    // Variable statements (const/let/var)
    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      const declList = node.declarationList;
      const keyword =
        declList.flags & ts.NodeFlags.Const
          ? 'const'
          : declList.flags & ts.NodeFlags.Let
          ? 'let'
          : 'var';

      for (const decl of declList.declarations) {
        const varName = decl.name.getText();
        const init = decl.initializer;
        const line_start = getLineNumber(sourceFile, decl.getStart());

        if (init) {
          // Arrow function → emit as 'function'
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            visitFunctionLike(init, varName, exported, varName);
            continue;
          }

          // Object literal or array → const_object (only top-level / exported)
          if (
            (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) &&
            (exported || functionStack.length === 0)
          ) {
            const keys = ts.isObjectLiteralExpression(init)
              ? init.properties
                  .slice(0, 20)
                  .map(p => {
                    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
                      return p.name.getText();
                    }
                    if (ts.isSpreadAssignment(p)) return '...';
                    return '?';
                  })
              : init.elements
                  .slice(0, 20)
                  .map(e => e.getText().slice(0, 40));

            addSymbol({
              symbol_type: 'const_object',
              name: varName,
              value: ts.isObjectLiteralExpression(init) ? 'object' : 'array',
              line_start,
              line_end: getLineEnd(sourceFile, init),
              params: keys,
              is_exported: exported,
            });
            continue;
          }

          // String literal
          if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
            const strVal = init.text;
            addSymbol({
              symbol_type: 'variable',
              name: varName,
              value: strVal,
              line_start,
              is_exported: exported,
            });
            addSymbol({
              symbol_type: 'string',
              name: varName,
              value: strVal,
              line_start,
              is_exported: false,
            });
            continue;
          }
        }

        // Plain variable — Wert kuerzen wenn zu lang
        const rawValue = init ? init.getText().slice(0, 200) : undefined;
        addSymbol({
          symbol_type: 'variable',
          name: varName,
          value: rawValue,
          line_start,
          is_exported: exported,
        });
      }
      ts.forEachChild(node, visitNode);
      return;
    }

    // Import declarations — gruppiert als ein Symbol pro Statement
    if (ts.isImportDeclaration(node)) {
      const source = (node.moduleSpecifier as ts.StringLiteral).text;
      const clause = node.importClause;
      const line_start = getLineNumber(sourceFile, node.getStart());
      const importNames: string[] = [];

      if (clause) {
        // Default import
        if (clause.name) {
          importNames.push(clause.name.getText());
        }

        // Named imports
        const namedBindings = clause.namedBindings;
        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            importNames.push(`* as ${namedBindings.name.getText()}`);
          } else if (ts.isNamedImports(namedBindings)) {
            for (const el of namedBindings.elements) {
              importNames.push(el.name.getText());
            }
          }
        }
      }

      // Ein Symbol pro Import-Statement, alle Bezeichner in params[]
      if (importNames.length > 0) {
        addSymbol({
          symbol_type: 'import',
          name: importNames.join(', '),
          value: source,
          params: importNames,
          line_start,
          is_exported: false,
        });
        // Alle importierten Namen als definiert markieren
        for (const n of importNames) {
          const cleanName = n.replace(/^\* as /, '');
          definedNames.add(cleanName);
        }
      }
      return;
    }

    // Export declarations (re-exports like `export { foo } from './bar'`)
    if (ts.isExportDeclaration(node)) {
      const line_start = getLineNumber(sourceFile, node.getStart());
      const source = node.moduleSpecifier
        ? (node.moduleSpecifier as ts.StringLiteral).text
        : undefined;
      const clause = node.exportClause;

      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const name = el.name.getText();
          addSymbol({
            symbol_type: 'export',
            name,
            value: source,
            line_start,
            is_exported: true,
          });
        }
      } else {
        // export * from '...'
        addSymbol({
          symbol_type: 'export',
          name: '*',
          value: source,
          line_start,
          is_exported: true,
        });
      }
      return;
    }

    // Export assignment: `export default foo`
    if (ts.isExportAssignment(node)) {
      const line_start = getLineNumber(sourceFile, node.getStart());
      addSymbol({
        symbol_type: 'export',
        name: node.expression.getText(),
        value: 'default',
        line_start,
        is_exported: true,
      });
      return;
    }

    // ----- Route-Detection: app.get/post/put/... + fastify.* + router.* -----
    // Pattern: <obj>.<verb>(<path>, <handler>...)  wobei verb in HTTP_VERBS
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.getText();
      if (HTTP_VERBS.has(methodName) && node.arguments.length >= 1) {
        const pathArg = node.arguments[0];
        const pathStr = getStaticStringValue(pathArg);
        // Nur als Route werten wenn das erste Argument ein String-Pfad ist (mit "/").
        // Das filtert z.B. Array.get(0) raus.
        if (pathStr !== null && pathStr.startsWith('/')) {
          const verb = methodName.toUpperCase();
          addSymbol({
            symbol_type: 'route',
            name: `${verb} ${pathStr}`,
            value: pathStr,
            params: [verb],
            line_start: getLineNumber(sourceFile, node.getStart()),
            line_end: getLineEnd(sourceFile, node),
            is_exported: false,
          });
        }
      }
    }

    // ----- NestJS-Decorator-Routes: @Get('/path'), @Post('/x') etc. -----
    if (ts.isMethodDeclaration(node) && ts.canHaveDecorators(node)) {
      const decorators = ts.getDecorators(node);
      if (decorators) {
        for (const dec of decorators) {
          if (!ts.isCallExpression(dec.expression)) continue;
          const decName = dec.expression.expression.getText();
          const verb = NEST_DECORATORS[decName];
          if (!verb) continue;
          const pathStr = dec.expression.arguments[0]
            ? getStaticStringValue(dec.expression.arguments[0])
            : '';
          const fullPath = pathStr && pathStr.length > 0
            ? (pathStr.startsWith('/') ? pathStr : '/' + pathStr)
            : '/';
          addSymbol({
            symbol_type: 'route',
            name: `${verb.toUpperCase()} ${fullPath}`,
            value: fullPath,
            params: [verb.toUpperCase(), node.name.getText()],
            line_start: getLineNumber(sourceFile, node.getStart()),
            line_end: getLineEnd(sourceFile, node),
            is_exported: false,
          });
        }
      }
    }

    // ----- Embedded-SQL via Tagged Template: sql`CREATE TABLE ...` -----
    if (ts.isTaggedTemplateExpression(node)) {
      const tagName = node.tag.getText();
      if (SQL_TAGS.has(tagName)) {
        const sqlText = ts.isNoSubstitutionTemplateLiteral(node.template)
          ? node.template.text
          : getStaticStringValue(node.template) ?? '';
        if (looksLikeSql(sqlText)) {
          const baseLine = getLineNumber(sourceFile, node.template.getStart());
          symbols.push(...parseEmbeddedSql(sqlText, sourceFile.fileName, baseLine));
        }
      }
    }

    // ----- Embedded-SQL via DB-Method-Call: db.exec(`...`), pool.query(`...`) -----
    // Resolved auch Identifier wie pool.query(SCHEMA_SQL) wenn SCHEMA_SQL ein
    // const mit String/Template-Literal ist.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.getText();
      if (SQL_DB_METHODS.has(methodName) && node.arguments.length >= 1) {
        const resolved = resolveStringExpression(node.arguments[0], stringConsts, sourceFile);
        if (resolved && looksLikeSql(resolved.value)) {
          symbols.push(...parseEmbeddedSql(resolved.value, sourceFile.fileName, resolved.defLine));
        }
      }
    }

    // Recurse into other nodes
    ts.forEachChild(node, visitNode);
  }

  ts.forEachChild(sourceFile, visitNode);

  // ---- Comments (regex pass on full text) ----------------------------------
  // Block / JSDoc comments: /** ... */ and /* ... */
  const blockCommentRe = /\/\*\*([\s\S]*?)\*\/|\/\*([\s\S]*?)\*\//g;
  let m: RegExpExecArray | null;
  while ((m = blockCommentRe.exec(fullText)) !== null) {
    const content = (m[1] ?? m[2]).trim();
    if (!content) continue;
    const linesBefore = fullText.slice(0, m.index).split('\n');
    const line_start = linesBefore.length;
    const linesInComment = m[0].split('\n').length;
    symbols.push({
      symbol_type: 'comment',
      name: null,
      value: content.slice(0, 500),
      line_start,
      line_end: line_start + linesInComment - 1,
      is_exported: false,
    });
  }

  // TODO / FIXME / HACK via single-line comments
  const todoRe = /\/\/\s*(TODO|FIXME|HACK)[:\s]+(.*)/g;
  while ((m = todoRe.exec(fullText)) !== null) {
    const linesBefore = fullText.slice(0, m.index).split('\n');
    const line_start = linesBefore.length;
    symbols.push({
      symbol_type: 'todo',
      name: null,
      value: `${m[1]}: ${m[2].trim()}`,
      line_start,
      is_exported: false,
    });
  }

  return { symbols, definedNames };
}

// ---------------------------------------------------------------------------
// Reference extraction pass
// ---------------------------------------------------------------------------

function extractReferences(
  sourceFile: ts.SourceFile,
  fullText: string,
  definedNames: Set<string>,
): ParsedReference[] {
  const references: ParsedReference[] = [];

  // Nodes that ARE definition sites — we skip identifiers that are the
  // primary name of a definition to avoid self-reporting.
  function isDefinitionSite(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (!parent) return false;

    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionExpression(parent)) &&
      parent.name === node
    ) {
      return true;
    }

    if (ts.isVariableDeclaration(parent) && parent.name === node) return true;

    if (
      (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
      parent.name === node
    ) {
      return true;
    }

    if (ts.isImportClause(parent) && parent.name === node) return true;
    if (ts.isNamespaceImport(parent) && parent.name === node) return true;

    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
    if (ts.isPropertySignature(parent) && parent.name === node) return true;
    if (ts.isEnumMember(parent) && parent.name === node) return true;

    return false;
  }

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const name = node.getText();
      if (definedNames.has(name) && !isDefinitionSite(node)) {
        const line_number = getLineNumber(sourceFile, node.getStart());
        const context = getContextSnippet(fullText, node.getStart());
        references.push({ symbol_name: name, line_number, context });
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return references;
}

// ---------------------------------------------------------------------------
// Flow extraction pass (Ablauf-Ebene: statements + call edges)
// ---------------------------------------------------------------------------
//
// REFERENZ-IMPLEMENTIERUNG fuer alle anderen Sprach-Parser.
//
// Konzept:
//  - Wir laufen ueber die AST und erzeugen pro "ausfuehrbarem" Statement einen
//    ParsedStatement-Eintrag. Dabei tracken wir den umschliessenden Scope
//    (Modul / Funktion / Methode) ueber einen Stack.
//  - order_index zaehlt die Reihenfolge der Statements INNERHALB des aktuellen
//    Scopes (jeder Scope hat seinen eigenen Zaehler).
//  - depth ist die Verschachtelungstiefe relativ zum Scope (0 = direkt im Scope).
//  - is_top_level = Statement liegt direkt im Modul-Scope (scope_type 'module').
//  - parent_temp_id verknuepft verschachtelte Statements mit ihrem Eltern-
//    Statement (z.B. ein return innerhalb eines if).
//  - Fuer jeden Aufruf (CallExpression / NewExpression) wird zusaetzlich eine
//    ParsedCallEdge erzeugt (callee_name, receiver, call_kind).
//
// Erfasste statement_type-Werte:
//   if | for | while | do | switch | try | throw | return | await | new |
//   call | assignment | variable | expression
//
// call_kind-Werte: function | method | new | await
// ---------------------------------------------------------------------------

interface ScopeFrame {
  scopeType: string;        // 'module' | 'function' | 'method'
  scopeName: string | null;
  orderCounter: number;     // laufender order_index innerhalb dieses Scopes
}

function extractFlow(
  sourceFile: ts.SourceFile,
): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextTempId = (): string => `s${tempIdCounter++}`;

  // Scope-Stack: oberster Frame ist der aktuelle Scope. Start = Modul.
  const scopeStack: ScopeFrame[] = [
    { scopeType: 'module', scopeName: null, orderCounter: 0 },
  ];
  const currentScope = (): ScopeFrame => scopeStack[scopeStack.length - 1];

  function lineOf(node: ts.Node): number {
    return getLineNumber(sourceFile, node.getStart());
  }
  function snippet(node: ts.Node): string {
    return node.getText().replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  // Liefert callee_name, receiver, call_kind fuer einen Call/New-Ausdruck.
  function describeCall(
    expr: ts.CallExpression | ts.NewExpression,
    kind: 'call' | 'new',
  ): { callee: string; receiver?: string; callKind: string } {
    const target = expr.expression;
    if (ts.isPropertyAccessExpression(target)) {
      return {
        callee: target.name.getText(),
        receiver: target.expression.getText().slice(0, 80),
        callKind: kind === 'new' ? 'new' : 'method',
      };
    }
    if (ts.isElementAccessExpression(target)) {
      const arg = target.argumentExpression?.getText().replace(/['"`]/g, '') ?? '?';
      return {
        callee: arg,
        receiver: target.expression.getText().slice(0, 80),
        callKind: kind === 'new' ? 'new' : 'method',
      };
    }
    return {
      callee: target.getText().slice(0, 120),
      callKind: kind === 'new' ? 'new' : 'function',
    };
  }

  // Per-Parent order_index-Zaehler. Schluessel ist die parent_temp_id (oder ein
  // Scope-Sentinel fuer depth-0-Statements, die keinen Parent haben). So bekommt
  // JEDE Verschachtelungsebene eine eigene, bei 0 startende Reihenfolge.
  const orderCounters = new Map<string, number>();
  function nextOrder(scope: ScopeFrame, parentTempId: string | undefined): number {
    // depth-0-Statements (kein Parent) zaehlen pro Scope ueber scope.orderCounter,
    // damit jeder Funktions-/Modul-Scope bei 0 beginnt.
    if (parentTempId === undefined) return scope.orderCounter++;
    const key = `p:${parentTempId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  // Emit-Helper: erzeugt ein ParsedStatement im aktuellen Scope.
  function emit(
    node: ts.Node,
    statementType: string,
    depth: number,
    parentTempId: string | undefined,
    extra: Partial<ParsedStatement> = {},
  ): ParsedStatement {
    const scope = currentScope();
    // Top-Level NUR wenn im Modul-Scope UND direkt darin (nicht in Block/if/for/try).
    const isTop = scope.scopeType === 'module' && depth === 0;
    const st: ParsedStatement = {
      temp_id: nextTempId(),
      parent_temp_id: parentTempId,
      scope_type: scope.scopeType,
      scope_name: scope.scopeName,
      statement_type: statementType,
      node_kind: ts.SyntaxKind[node.kind],
      line_start: lineOf(node),
      line_end: getLineEnd(sourceFile, node),
      order_index: nextOrder(scope, parentTempId),
      depth,
      text: snippet(node),
      is_top_level: isTop,
      is_awaited: false,
      ...extra,
    };
    statements.push(st);
    return st;
  }

  // Sucht die unmittelbaren Calls/New innerhalb eines Ausdrucks (nicht rekursiv
  // ueber verschachtelte Funktionskoerper hinaus) und legt CallEdges an.
  // `awaited` markiert ob der Ausdruck in einem await steht.
  function collectCallsInExpression(
    expr: ts.Node,
    stmtTempId: string,
    awaited: boolean,
  ): void {
    const scope = currentScope();
    function walk(n: ts.Node): void {
      // Nicht in verschachtelte Funktions-Bodies absteigen — deren Calls
      // gehoeren zu deren eigenem Scope (separat behandelt).
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n)
      ) {
        return;
      }
      if (ts.isCallExpression(n)) {
        const d = describeCall(n, 'call');
        callEdges.push({
          statement_temp_id: stmtTempId,
          caller_scope: scope.scopeName,
          callee_name: d.callee,
          callee_receiver: d.receiver,
          line_number: lineOf(n),
          call_kind: awaited ? 'await' : d.callKind,
        });
      } else if (ts.isNewExpression(n)) {
        const d = describeCall(n, 'new');
        callEdges.push({
          statement_temp_id: stmtTempId,
          caller_scope: scope.scopeName,
          callee_name: d.callee,
          callee_receiver: d.receiver,
          line_number: lineOf(n),
          call_kind: 'new',
        });
      }
      ts.forEachChild(n, walk);
    }
    ts.forEachChild(expr, walk);
    // Falls der Ausdruck selbst direkt ein Call/New ist (forEachChild ueberspringt den Root):
    if (ts.isCallExpression(expr)) {
      const d = describeCall(expr, 'call');
      callEdges.push({
        statement_temp_id: stmtTempId,
        caller_scope: scope.scopeName,
        callee_name: d.callee,
        callee_receiver: d.receiver,
        line_number: lineOf(expr),
        call_kind: awaited ? 'await' : d.callKind,
      });
    } else if (ts.isNewExpression(expr)) {
      const d = describeCall(expr, 'new');
      callEdges.push({
        statement_temp_id: stmtTempId,
        caller_scope: scope.scopeName,
        callee_name: d.callee,
        callee_receiver: d.receiver,
        line_number: lineOf(expr),
        call_kind: 'new',
      });
    }
  }

  // Prueft ob ein Ausdruck (oder sein direkter inneren Ausdruck) ein await ist.
  function unwrapAwait(expr: ts.Expression): { inner: ts.Expression; awaited: boolean } {
    if (ts.isAwaitExpression(expr)) {
      return { inner: expr.expression, awaited: true };
    }
    return { inner: expr, awaited: false };
  }

  // Verarbeitet eine Liste von Statements innerhalb eines Blocks/Scopes.
  // depth = Verschachtelung relativ zum aktuellen Scope.
  function processStatements(
    nodes: readonly ts.Statement[],
    depth: number,
    parentTempId: string | undefined,
  ): void {
    for (const stmt of nodes) {
      processStatement(stmt, depth, parentTempId);
    }
  }

  // Verarbeitet einen Funktions-/Methoden-Body als neuen Scope.
  function enterFunctionScope(
    name: string | null,
    scopeType: string,
    body: ts.Node | undefined,
  ): void {
    if (!body) return;
    scopeStack.push({ scopeType, scopeName: name, orderCounter: 0 });
    if (ts.isBlock(body)) {
      processStatements(body.statements, 0, undefined);
    } else {
      // Arrow mit Expression-Body: der Ausdruck ist das einzige "Statement".
      const { inner, awaited } = unwrapAwait(body as ts.Expression);
      const st = emit(body, 'return', 0, undefined, { is_awaited: awaited });
      collectCallsInExpression(inner, st.temp_id, awaited);
    }
    scopeStack.pop();
  }

  // Kern: ein einzelnes Statement verarbeiten.
  function processStatement(
    node: ts.Node,
    depth: number,
    parentTempId: string | undefined,
  ): void {
    // --- Funktions-/Klassendeklarationen: eigenen Scope eroeffnen ---
    if (ts.isFunctionDeclaration(node)) {
      enterFunctionScope(node.name?.getText() ?? null, 'function', node.body);
      return;
    }
    if (ts.isClassDeclaration(node)) {
      // Methoden der Klasse als eigene Scopes verarbeiten.
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
          const mName = ts.isConstructorDeclaration(member)
            ? `${node.name?.getText() ?? 'anon'}.constructor`
            : `${node.name?.getText() ?? 'anon'}.${member.name.getText()}`;
          enterFunctionScope(mName, 'method', member.body);
        }
      }
      return;
    }

    // --- Kontrollfluss-Statements ---
    if (ts.isIfStatement(node)) {
      const st = emit(node, 'if', depth, parentTempId, {
        condition_text: node.expression.getText().slice(0, 200),
      });
      collectCallsInExpression(node.expression, st.temp_id, false);
      processBranch(node.thenStatement, depth + 1, st.temp_id);
      if (node.elseStatement) processBranch(node.elseStatement, depth + 1, st.temp_id);
      return;
    }
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const cond = ts.isForStatement(node)
        ? node.condition?.getText()
        : node.expression.getText();
      const st = emit(node, 'for', depth, parentTempId, {
        condition_text: cond?.slice(0, 200),
      });
      processBranch(node.statement, depth + 1, st.temp_id);
      return;
    }
    if (ts.isWhileStatement(node)) {
      const st = emit(node, 'while', depth, parentTempId, {
        condition_text: node.expression.getText().slice(0, 200),
      });
      collectCallsInExpression(node.expression, st.temp_id, false);
      processBranch(node.statement, depth + 1, st.temp_id);
      return;
    }
    if (ts.isDoStatement(node)) {
      const st = emit(node, 'do', depth, parentTempId, {
        condition_text: node.expression.getText().slice(0, 200),
      });
      processBranch(node.statement, depth + 1, st.temp_id);
      return;
    }
    if (ts.isSwitchStatement(node)) {
      const st = emit(node, 'switch', depth, parentTempId, {
        condition_text: node.expression.getText().slice(0, 200),
      });
      collectCallsInExpression(node.expression, st.temp_id, false);
      for (const clause of node.caseBlock.clauses) {
        processStatements(clause.statements, depth + 1, st.temp_id);
      }
      return;
    }
    if (ts.isTryStatement(node)) {
      const st = emit(node, 'try', depth, parentTempId);
      processStatements(node.tryBlock.statements, depth + 1, st.temp_id);
      if (node.catchClause) {
        processStatements(node.catchClause.block.statements, depth + 1, st.temp_id);
      }
      if (node.finallyBlock) {
        processStatements(node.finallyBlock.statements, depth + 1, st.temp_id);
      }
      return;
    }
    if (ts.isThrowStatement(node)) {
      const st = emit(node, 'throw', depth, parentTempId);
      if (node.expression) collectCallsInExpression(node.expression, st.temp_id, false);
      return;
    }
    if (ts.isReturnStatement(node)) {
      let awaited = false;
      let inner: ts.Expression | undefined = node.expression;
      if (node.expression) {
        const u = unwrapAwait(node.expression);
        inner = u.inner;
        awaited = u.awaited;
      }
      const st = emit(node, 'return', depth, parentTempId, { is_awaited: awaited });
      if (inner) collectCallsInExpression(inner, st.temp_id, awaited);
      return;
    }
    if (ts.isBlock(node)) {
      // Nackter Block: Statements eine Ebene tiefer, aber kein eigener Scope.
      processStatements(node.statements, depth, parentTempId);
      return;
    }

    // --- Variable-Deklarationen (mit moeglichem Call/await im Initializer) ---
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const assignedTo = decl.name.getText().slice(0, 120);
        let awaited = false;
        let init = decl.initializer;
        if (init) {
          const u = unwrapAwait(init);
          init = u.inner;
          awaited = u.awaited;
        }
        const st = emit(decl, awaited ? 'await' : 'variable', depth, parentTempId, {
          assigned_to: assignedTo,
          is_awaited: awaited,
        });
        if (init) collectCallsInExpression(init, st.temp_id, awaited);
      }
      return;
    }

    // --- Expression-Statements (calls, assignments, await) ---
    if (ts.isExpressionStatement(node)) {
      const expr = node.expression;
      // Assignment?
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const rhs = unwrapAwait(expr.right);
        const st = emit(node, rhs.awaited ? 'await' : 'assignment', depth, parentTempId, {
          assigned_to: expr.left.getText().slice(0, 120),
          is_awaited: rhs.awaited,
        });
        collectCallsInExpression(rhs.inner, st.temp_id, rhs.awaited);
        return;
      }
      // await expr;
      if (ts.isAwaitExpression(expr)) {
        const st = emit(node, 'await', depth, parentTempId, { is_awaited: true });
        collectCallsInExpression(expr.expression, st.temp_id, true);
        return;
      }
      // new expr;
      if (ts.isNewExpression(expr)) {
        const d = describeCall(expr, 'new');
        const st = emit(node, 'new', depth, parentTempId, {
          callee: d.callee,
          receiver: d.receiver,
        });
        collectCallsInExpression(expr, st.temp_id, false);
        return;
      }
      // plain call expr;
      if (ts.isCallExpression(expr)) {
        const d = describeCall(expr, 'call');
        const st = emit(node, 'call', depth, parentTempId, {
          callee: d.callee,
          receiver: d.receiver,
        });
        collectCallsInExpression(expr, st.temp_id, false);
        return;
      }
      // generischer Ausdruck
      const st = emit(node, 'expression', depth, parentTempId);
      collectCallsInExpression(expr, st.temp_id, false);
      return;
    }

    // --- Fallback: sonstige Statements generisch erfassen, in Bodies absteigen ---
    // (z.B. labeled statements). Wir erfassen sie als 'expression' und steigen
    // NICHT weiter ab, um Doppelzaehlung zu vermeiden.
    emit(node, 'expression', depth, parentTempId);
  }

  // Verarbeitet einen Branch-Body (then/else/loop-body): ist es ein Block,
  // verarbeiten wir dessen Statements; sonst das einzelne Statement direkt.
  function processBranch(
    node: ts.Statement,
    depth: number,
    parentTempId: string | undefined,
  ): void {
    if (ts.isBlock(node)) {
      processStatements(node.statements, depth, parentTempId);
    } else {
      processStatement(node, depth, parentTempId);
    }
  }

  // Einstieg: Top-Level-Statements des Moduls.
  processStatements(sourceFile.statements, 0, undefined);

  return { statements, callEdges };
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

function parse(content: string, filePath: string): ParseResult {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX, // handles .ts / .tsx / .js / .jsx
  );

  const { symbols, definedNames } = extractSymbols(sourceFile, content);
  const references = extractReferences(sourceFile, content, definedNames);

  symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

  const { statements, callEdges } = extractFlow(sourceFile);

  return { symbols, references, statements, callEdges };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const typescriptParser: LanguageParser = {
  language: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'],
  parse,
};
