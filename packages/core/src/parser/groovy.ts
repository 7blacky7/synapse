/**
 * MODUL: Groovy Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Groovy/Gradle-Dateien (.groovy, .gradle, .gradle.kts)
 *
 * EXTRAHIERT: package, import, class, interface, trait, enum, annotation,
 *             def/typed methods, closures, Gradle DSL (plugins, dependencies,
 *             tasks, repositories), comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

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

class GroovyParser implements LanguageParser {
  language = 'groovy';
  extensions = ['.groovy', '.gradle'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Eltern-Typ ueber vorberechnete Grenzen statt Rueckwaertssuche je Treffer.
  // 4: Eltern-Typ ist jetzt die INNERSTE umschliessende Deklaration. Version 3
  //    bildete die alte match()-Semantik nach und verlor den Eltern-Typ, sobald
  //    vor der Fundstelle eine schliessende Klammer stand (siehe findParentType).
  version = 4;

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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 10. Routes: Spark Java (Groovy-DSL)
    //     get("/x", { req, res -> ... }), post("/x", ...)
    // ══════════════════════════════════════════════
    const sparkRouteRe = /\b(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']\s*,\s*\{/g;
    while ((m = sparkRouteRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      const path = m[2];
      if (!HTTP_VERBS.has(verb)) continue;
      if (!isLikelyHttpPath(path)) continue;
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb.toUpperCase()],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Routes: Grails UrlMappings
    //     "/x"(controller: "name", action: "act") oder "/x" {action = "..."}
    // ══════════════════════════════════════════════
    const grailsRouteRe = /^\s*["']([^"']+)["']\s*\(/gm;
    while ((m = grailsRouteRe.exec(content)) !== null) {
      const path = m[1];
      if (!isLikelyHttpPath(path)) continue;
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('any', path),
        value: path,
        params: ['ANY'],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 12. Embedded SQL: groovy.sql.Sql / JdbcTemplate (single/double quoted)
    // ══════════════════════════════════════════════
    const sqlCallRe = /\b\w+\.(?:eachRow|execute|executeUpdate|rows|firstRow|query|queryForList|queryForObject|update)\s*\(\s*["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const sqlBody = m[1];
      if (!looksLikeSql(sqlBody)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlBody, filePath, baseLine));
    }

    // ══════════════════════════════════════════════
    // 13. Embedded SQL: triple-quoted Strings ("""...""")
    // ══════════════════════════════════════════════
    const tripleStrRe = /"""([\s\S]{10,}?)"""/g;
    while ((m = tripleStrRe.exec(content)) !== null) {
      const body = m[1];
      if (!looksLikeSql(body)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(body, filePath, baseLine));
    }

    // ══════════════════════════════════════════════
    // FLOW: Statements + CallEdges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tid = 0;
    const nid = (): string => `s${tid++}`;
    const oc = new Map<string, number>();
    const nord = (p: string | undefined): number => { const k = p ?? 'root'; const v = oc.get(k) ?? 0; oc.set(k, v + 1); return v; };
    interface GS { type: string; name: string | null; }
    const ss: GS[] = [{ type: 'module', name: null }];
    // Rueckfallebene: ss darf nie leer sein, sonst wirft jeder Zugriff auf sc.type.
    // Die Ursache ist unten beim splice abgesichert; das hier faengt kuenftige Wege ab.
    const cs = (): GS => ss[ss.length - 1] ?? { type: 'module', name: null };

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs(); const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: nord(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    const gLines = content.split('\n');
    // scopeIdx = auf welche Laenge der Scope-Stapel beim Schliessen dieses Blocks
    // zurueckgeschnitten wird. Wer selbst einen Scope anlegt (Klasse, Methode), traegt
    // ss.length - 1 ein und raeumt ihn damit wieder ab. Wer KEINEN anlegt (if, while,
    // for, switch, try, Gradle-DSL), muss ss.length eintragen — sonst entfernt er den
    // Scope, den er nur vorgefunden hat. Genau das war bis heute der Fall: bei
    // scopeIdx 0 fuehrte es zum Absturz (leerer Stapel), darueber still zu einer
    // falschen Zuordnung fuer alles, was nach dem Block kommt.
    interface GF { pid: string | undefined; depth: number; braceDepthAtOpen: number; scopeIdx: number; }
    const fs: GF[] = [{ pid: undefined, depth: 0, braceDepthAtOpen: 0, scopeIdx: 0 }];
    const tf = (): GF => fs[fs.length - 1];
    let braceDepth = 0;

    for (let i = 0; i < gLines.length; i++) {
      const raw = gLines[i];
      const tr = raw.replace(/\/\/.*$/, '').trim();
      const ln = i + 1;
      if (!tr || tr.startsWith('*') || tr.startsWith('/*')) continue;

      const openB = (tr.match(/\{/g) || []).length;
      const closeB = (tr.match(/\}/g) || []).length;

      // Pop frames for leading close braces BEFORE reading current frame
      if (closeB > openB) {
        braceDepth -= (closeB - openB);
        // p.scopeIdx > 0: Index 0 ist der Modul-Scope und wird nie abgeschnitten.
        // Ohne diese Grenze leerte ss.splice(0) den kompletten Stapel, und der naechste
        // Zugriff auf cs().type warf einen TypeError — das traf 13 von 17 echten
        // Gradle-Dateien. Bloecke auf Modulebene (plugins { ... }) tragen scopeIdx 0,
        // weil sie selbst keinen Scope anlegen; sie duerfen also auch keinen entfernen.
        while (fs.length > 1 && braceDepth < fs[fs.length - 1].braceDepthAtOpen) { const p = fs.pop()!; if (p.scopeIdx > 0 && ss.length > p.scopeIdx) ss.splice(p.scopeIdx); }
      }

      const f = tf();
      const d = f.depth;

      // class / interface / trait declaration
      const classM = /^(?:(?:abstract|final|public|protected|private|static)\s+)*(?:class|interface|trait|enum)\s+(\w+)/.exec(tr);
      if (classM) {
        const name = classM[1];
        if (openB > closeB) {
          ss.push({ type: 'class', name });
          fs.push({ pid: undefined, depth: 0, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length - 1 });
        }
        braceDepth += openB - closeB;
        continue;
      }

      // method / function declaration
      const fnM = /^(?:(?:public|protected|private|static|def|void|abstract|final|override|synchronized)\s+)*(?:def\s+)?(\w+)\s*\(/.exec(tr);
      if (fnM && /\{/.test(tr) && !/^(?:if|while|for|switch|try|catch|finally|new)\b/.test(tr)) {
        const name = fnM[1];
        const sc = cs();
        const scopeType = sc.type === 'class' ? 'method' : 'function';
        const scopeName = sc.type === 'class' && sc.name ? `${sc.name}.${name}` : name;
        if (openB > closeB) {
          ss.push({ type: scopeType, name: scopeName });
          fs.push({ pid: undefined, depth: 0, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length - 1 });
        }
        braceDepth += openB - closeB;
        continue;
      }

      // if / else if
      const ifM = /^(?:else\s+)?if\s*\((.{0,200})\)/.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length }); }
        braceDepth += openB - closeB;
        continue;
      }
      if (/^\}\s*else\s*\{/.test(tr) || /^else\s*\{/.test(tr)) { braceDepth += openB - closeB; continue; }

      // while
      const whM = /^while\s*\((.{0,200})\)/.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length }); }
        braceDepth += openB - closeB;
        continue;
      }

      // for / each
      const forM = /^for\s*\((.{0,200})\)/.exec(tr);
      if (forM) {
        const st = es('for', ln, f.pid, d, { condition_text: forM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length }); }
        braceDepth += openB - closeB;
        continue;
      }

      // switch
      const swM = /^switch\s*\((.{0,200})\)/.exec(tr);
      if (swM) {
        const st = es('switch', ln, f.pid, d, { condition_text: swM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length }); }
        braceDepth += openB - closeB;
        continue;
      }

      // try / catch / finally
      if (/^try\s*\{/.test(tr)) {
        const st = es('try', ln, f.pid, d, { text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length });
        braceDepth += openB - closeB;
        continue;
      }
      if (/^\}\s*catch\b|\}\s*finally\b/.test(tr)) { braceDepth += openB - closeB; continue; }

      // throw
      if (/^throw\b/.test(tr)) { es('throw', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      // return
      if (/^return\b/.test(tr)) { const st = es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); const cM = /(\w+)\s*\(/.exec(tr.slice(6)); if (cM) ec(st.temp_id, cM[1], undefined, ln, 'function'); continue; }

      // assignment: type var = expr  or  def var = expr  or  var = expr
      const assignM = /^(?:(?:def|final|var|val)\s+)?(\w+)\s*(?:[+\-*\/]?=)(?!=)\s*(.+)/.exec(tr);
      if (assignM && !/^(?:if|while|for|switch|try|throw|return|class|interface|trait|enum|new)\b/.test(tr)) {
        const rhs = assignM[2];
        const callM = /(\w+)\s*\(/.exec(rhs);
        const newM = /new\s+(\w+)\s*\(/.exec(rhs);
        const st = es(newM ? 'new' : 'assignment', ln, f.pid, d, { assigned_to: assignM[1], text: tr.slice(0, 120) });
        if (newM) ec(st.temp_id, newM[1], undefined, ln, 'new');
        else if (callM) ec(st.temp_id, callM[1], undefined, ln, 'function');
        braceDepth += openB - closeB;
        // p.scopeIdx > 0: Index 0 ist der Modul-Scope und wird nie abgeschnitten.
        // Ohne diese Grenze leerte ss.splice(0) den kompletten Stapel, und der naechste
        // Zugriff auf cs().type warf einen TypeError — das traf 13 von 17 echten
        // Gradle-Dateien. Bloecke auf Modulebene (plugins { ... }) tragen scopeIdx 0,
        // weil sie selbst keinen Scope anlegen; sie duerfen also auch keinen entfernen.
        while (fs.length > 1 && braceDepth < fs[fs.length - 1].braceDepthAtOpen) { const p = fs.pop()!; if (p.scopeIdx > 0 && ss.length > p.scopeIdx) ss.splice(p.scopeIdx); }
        continue;
      }

      // new Expr(...).method() or new Expr(...)
      if (/^new\s+\w/.test(tr)) {
        const newM = /^new\s+(\w+)\s*\(/.exec(tr);
        const chainM = /^new\s+\w+\s*\([^)]*\)\.(\w+)\s*\(/.exec(tr);
        if (chainM) {
          const st = es('call', ln, f.pid, d, { callee: chainM[1], text: tr.slice(0, 120) });
          ec(st.temp_id, chainM[1], newM?.[1], ln, 'method');
        } else if (newM) {
          const st = es('new', ln, f.pid, d, { callee: newM[1], text: tr.slice(0, 120) });
          ec(st.temp_id, newM[1], undefined, ln, 'new');
        }
      // method call: obj.method() or func()
      } else {
        const mCallM = /^(\w+)\.(\w+)\s*\(/.exec(tr);
        if (mCallM && !/^(?:if|while|for|switch|try|throw|return|class)\b/.test(tr)) {
          const st = es('call', ln, f.pid, d, { callee: mCallM[2], receiver: mCallM[1], text: tr.slice(0, 120) });
          ec(st.temp_id, mCallM[2], mCallM[1], ln, 'method');
        } else {
          const plainCallM = /^(\w+)\s*\(/.exec(tr);
          if (plainCallM && !/^(?:if|while|for|switch|try|throw|return|class|interface|trait|enum|new|def)\b/.test(tr)) {
            const st = es('call', ln, f.pid, d, { callee: plainCallM[1], text: tr.slice(0, 120) });
            ec(st.temp_id, plainCallM[1], undefined, ln, 'function');
          }
        }
      }

      // Gradle DSL: task/plugins/dependencies blocks
      if (isGradle && /^(?:task|plugins|dependencies|repositories|configurations)\s*\{?/.test(tr)) {
        const dslM = /^(\w+)/.exec(tr);
        if (dslM) {
          const st = es('call', ln, f.pid, d, { callee: dslM[1], text: tr.slice(0, 120) });
          ec(st.temp_id, dslM[1], undefined, ln, 'function');
          if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB, scopeIdx: ss.length }); }
        }
      }

      // Only accumulate open braces here; close braces handled at top of loop
      if (openB > closeB) braceDepth += (openB - closeB);
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

  // Typ-Grenzen EINMAL vorwaerts sammeln statt pro Treffer rueckwaerts zu suchen.
  private grenzenText: string | null = null;
  private typBereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];

  private bereiteTypGrenzenVor(content: string): void {
    if (content === this.grenzenText) return;
    this.grenzenText = content;
    const nameAnKlammer = new Map<number, string>();
    const deklRe = /(?:class|interface|trait|enum)\s+(\w+)[^{]*\{/g;
    let d: RegExpExecArray | null;
    while ((d = deklRe.exec(content)) !== null) {
      nameAnKlammer.set(d.index + d[0].length - 1, d[1]);
    }
    // Ein einziger Durchlauf mit Klammer-Stapel paart jede oeffnende Klammer mit
    // ihrer schliessenden. Das ergibt echte Bereiche und bleibt linear in der
    // Dateigroesse — die Vorberechnung aus Version 3 wird dadurch nicht teurer.
    const bereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];
    const offen: number[] = [];
    for (let i = 0; i < content.length; i++) {
      const zeichen = content.charCodeAt(i);
      if (zeichen === 123) offen.push(i);
      else if (zeichen === 125) {
        const auf = offen.pop();
        if (auf === undefined) continue;
        const name = nameAnKlammer.get(auf);
        if (name !== undefined) bereiche.push({ name, start: auf, end: i, eltern: -1 });
      }
    }
    bereiche.sort((x, y) => x.start - y.start);
    // Elternkette: Typ-Bereiche sind ineinander geschachtelt und ueberlappen nie,
    // deshalb genuegt ein Stapel ueber die nach start sortierte Liste.
    const stapel: number[] = [];
    for (let i = 0; i < bereiche.length; i++) {
      while (stapel.length > 0 && bereiche[stapel[stapel.length - 1]].end < bereiche[i].start) stapel.pop();
      bereiche[i].eltern = stapel.length > 0 ? stapel[stapel.length - 1] : -1;
      stapel.push(i);
    }
    this.typBereiche = bereiche;
  }

  /**
   * In welcher Typ-Deklaration liegt pos? Geliefert wird die INNERSTE
   * umschliessende: der Scope eines Symbols ist die naechstgelegene Deklaration,
   * die es enthaelt — nur sie ergibt einen richtigen qualifizierten Namen.
   *
   * Bis Version 3 wurde hier die Eigenheit von String.match ohne g nachgebildet
   * ("erste Deklaration hinter der letzten schliessenden Klammer vor pos"). Das
   * war in zwei Faellen falsch: bei direkt verschachtelten Deklarationen lieferte
   * es die AEUSSERE, und — weit haeufiger — sobald vor pos ueberhaupt eine
   * schliessende Klammer stand und danach keine neue Deklaration folgte, lieferte
   * es gar nichts. Schon die zweite Methode einer gewoehnlichen Klasse verlor so
   * ihren Eltern-Typ.
   *
   * ABWEICHUNG VON cpp.ts, bewusst und nicht zu "vereinheitlichen": cpp liefert den
   * vollen Pfad ("Aussen::Innen"), die uebrigen acht Parser nur den innersten Namen.
   * Grund: java.ts und dart.ts erkennen Konstruktoren daran, dass der Eltern-Typ
   * GLEICH dem Symbolnamen ist. Ein Pfad waere nie gleich dem Namen — saemtliche
   * Konstruktoren fielen aus dem Index. Wer das angleichen will, muss zuerst diesen
   * Vergleich umbauen.
   */
  private findParentType(content: string, pos: number): string | undefined {
    this.bereiteTypGrenzenVor(content);
    const bereiche = this.typBereiche;
    let lo = 0;
    let hi = bereiche.length;
    while (lo < hi) {
      const mitte = (lo + hi) >> 1;
      if (bereiche[mitte].start < pos) lo = mitte + 1;
      else hi = mitte;
    }
    // Letzter Bereich, der vor pos beginnt. Endet er schon vor pos, ist er ein
    // abgeschlossener Nachbar — dann ueber die Elternkette nach aussen weiter.
    let i = lo - 1;
    while (i >= 0 && bereiche[i].end <= pos) i = bereiche[i].eltern;
    return i >= 0 ? bereiche[i].name : undefined;
  }
}

export const groovyParser = new GroovyParser();
