/**
 * MODUL: Groovy Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Groovy/Gradle-Dateien (.groovy, .gradle, .gradle.kts)
 *
 * EXTRAHIERT: package, import, class, interface, trait, enum, annotation,
 *             def/typed methods, closures, Gradle DSL (plugins, dependencies,
 *             tasks, repositories), comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class GroovyParser implements LanguageParser {
  language = 'groovy';
  extensions = ['.groovy', '.gradle'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    const isGradle = filePath.endsWith('.gradle') || filePath.endsWith('.gradle.kts');

    // ══════════════════════════════════════════════
    // 1. Package
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w.]+)/m;
    m = pkgRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'package',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Imports
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(static\s+)?([\w.*]+)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const isStatic = !!m[1];
      const pkg = m[2];
      const name = pkg.split('.').pop() || pkg;

      symbols.push({
        symbol_type: 'import',
        name: name === '*' ? pkg.split('.').slice(-2, -1)[0] || pkg : name,
        value: isStatic ? `static ${pkg}` : pkg,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });

      references.push({
        symbol_name: name === '*' ? pkg.split('.').slice(-2, -1)[0] || pkg : name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes, Interfaces, Traits, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:public|protected|private|static|abstract|final)\s+)*)(class|interface|trait|enum|@interface)\s+(\w+)(?:<[^>]+>)?(?:\s+(?:extends|implements)\s+([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const extendsClause = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' || kind === '@interface' ? 'interface'
        : kind === 'trait' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (extendsClause) {
        parents.push(...extendsClause.split(',').map(s =>
          s.trim().replace(/^(extends|implements)\s+/, '').split('<')[0].trim()
        ).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !/\bprivate\b/.test(modifiers),
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} extends/implements ${parent}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methods (typed + def)
    // ══════════════════════════════════════════════
    const methodRe = /^(\s*)((?:(?:public|protected|private|static|abstract|final|synchronized|native)\s+)*)(def|void|boolean|byte|char|short|int|long|float|double|[\w.]+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:\{|=)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const returnType = m[3];
      const name = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      // Skip Gradle DSL blocks that look like methods
      if (isGradle && ['plugins', 'dependencies', 'repositories', 'allprojects',
           'subprojects', 'buildscript', 'task', 'sourceSets'].includes(name)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType !== 'def' ? returnType : undefined,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Properties (in class context)
    // ══════════════════════════════════════════════
    const propRe = /^(\s+)((?:(?:public|protected|private|static|final|transient|volatile)\s+)*)([\w.]+(?:<[^>]+>)?)\s+(\w+)\s*(?:=\s*([^\n]+))?$/gm;
    while ((m = propRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const propType = m[3];
      const name = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip if it looks like a method
      if (['def', 'void', 'class', 'interface', 'trait', 'enum', 'import',
           'package', 'return', 'if', 'else', 'for', 'while', 'switch', 'try'].includes(propType)) continue;
      if (indent > 8) continue;

      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || propType,
        return_type: propType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Gradle: plugins
    // ══════════════════════════════════════════════
    if (isGradle) {
      const pluginRe = /id\s+['"]([^'"]+)['"]/g;
      while ((m = pluginRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'import',
          name: m[1].split('.').pop() || m[1],
          value: `plugin ${m[1]}`,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }

      // Gradle: dependencies
      const depRe = /^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|classpath)\s+['"]([^'"]+)['"]/gm;
      while ((m = depRe.exec(content)) !== null) {
        const scope = m[1];
        const dep = m[2];
        const name = dep.split(':')[1] || dep;

        symbols.push({
          symbol_type: 'import',
          name,
          value: `${scope} ${dep}`,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });

        references.push({
          symbol_name: name,
          line_number: lineAt(content, m.index),
          context: `${scope} '${dep}'`.slice(0, 80),
        });
      }

      // Gradle: task definitions
      const taskRe = /^\s*task\s+['"]?(\w+)['"]?(?:\s*\(\s*type:\s*(\w+)\s*\))?\s*\{/gm;
      while ((m = taskRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'function',
          name: m[1],
          value: m[2] ? `task(${m[2]})` : 'task',
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. Annotations
    // ══════════════════════════════════════════════
    const annotRe = /^\s*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['Override', 'Deprecated', 'SuppressWarnings', 'interface'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
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
    // 9. Groovydoc (/** ... */)
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
        is_exported: false,
      });
    }

    return { symbols, references };
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

export const groovyParser = new GroovyParser();
