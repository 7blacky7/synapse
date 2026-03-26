/**
 * MODUL: TypeScript AST-Parser
 * ZWECK: Extrahiert 11 Symbol-Typen und Referenzen aus TS/JS-Dateien
 *        via TypeScript Compiler API
 */

import * as ts from 'typescript';
import type { LanguageParser, ParseResult, ParsedSymbol, ParsedReference } from './types.js';

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

// ---------------------------------------------------------------------------
// Symbol extraction pass
// ---------------------------------------------------------------------------

function extractSymbols(
  sourceFile: ts.SourceFile,
  fullText: string,
): { symbols: ParsedSymbol[]; definedNames: Set<string> } {
  const symbols: ParsedSymbol[] = [];
  const definedNames = new Set<string>();

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

  return { symbols, references };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const typescriptParser: LanguageParser = {
  language: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'],
  parse,
};
