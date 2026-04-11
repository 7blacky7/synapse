/**
 * MODUL: Elixir Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Elixir-Dateien (.ex, .exs)
 *
 * EXTRAHIERT: defmodule, def/defp, defmacro/defmacrop, defguard, defdelegate,
 *             defstruct, defexception, defprotocol, defimpl, use, import,
 *             alias, require, @moduledoc, @doc, @spec, @type/@typep/@opaque,
 *             @callback, @behaviour, module attribute, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ElixirParser implements LanguageParser {
  language = 'elixir';
  extensions = ['.ex', '.exs'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Modules (defmodule)
    // ══════════════════════════════════════════════
    const moduleRe = /^(\s*)defmodule\s+([\w.]+)\s+do\b/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(content, m.index);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'defmodule',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Protocols & Implementations
    // ══════════════════════════════════════════════
    const protoRe = /^(\s*)defprotocol\s+([\w.]+)\s+do\b/gm;
    while ((m = protoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: 'defprotocol',
        line_start: lineAt(content, m.index),
        line_end: this.findEnd(content, m.index),
        is_exported: true,
      });
    }

    const implRe = /^(\s*)defimpl\s+([\w.]+)\s*,\s*for:\s*([\w.]+)/gm;
    while ((m = implRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'class',
        name: `${m[2]}.${m[3]}`,
        value: 'defimpl',
        params: [`for ${m[3]}`],
        line_start: lineStart,
        line_end: this.findEnd(content, m.index),
        is_exported: true,
      });
      references.push({
        symbol_name: m[2],
        line_number: lineStart,
        context: `defimpl ${m[2]}, for: ${m[3]}`.slice(0, 80),
      });
      references.push({
        symbol_name: m[3],
        line_number: lineStart,
        context: `defimpl ${m[2]}, for: ${m[3]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Functions (def/defp)
    // ══════════════════════════════════════════════
    const defRe = /^(\s*)(def|defp|defmacro|defmacrop|defguard|defguardp)\s+(\w+[?!]?)(?:\(([^)]*)\))?/gm;
    const seenFunctions = new Set<string>();
    while ((m = defRe.exec(content)) !== null) {
      const indent = m[1].length;
      const kind = m[2];
      const name = m[3];
      const paramsRaw = m[4] || '';
      const lineStart = lineAt(content, m.index);

      // Deduplicate multi-clause functions (same name + kind)
      const key = `${kind}:${name}`;
      if (seenFunctions.has(key)) continue;
      seenFunctions.add(key);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().replace(/\\\\.*$/, '').split('=')[0].trim())
        .filter(p => p && !p.startsWith('_'))
        .map(p => p.replace(/^%\w*\{.*\}$/, 'map'));

      const parentModule = this.findParentModule(content, m.index);
      const isPublic = !kind.endsWith('p');

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: isPublic,
        parent_id: parentModule,
      });
    }

    // ══════════════════════════════════════════════
    // 4. defdelegate
    // ══════════════════════════════════════════════
    const delegateRe = /^(\s*)defdelegate\s+(\w+[?!]?)(?:\(([^)]*)\))?\s*,\s*to:\s*([\w.]+)/gm;
    while ((m = delegateRe.exec(content)) !== null) {
      const name = m[2];
      const paramsRaw = m[3] || '';
      const target = m[4];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw.split(',').map(p => p.trim()).filter(Boolean);
      const parentModule = this.findParentModule(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'defdelegate',
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: true,
        parent_id: parentModule,
      });

      references.push({
        symbol_name: target,
        line_number: lineStart,
        context: `defdelegate ${name}(...), to: ${target}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 5. defstruct / defexception
    // ══════════════════════════════════════════════
    const structRe = /^(\s*)(defstruct|defexception)\s+([^\n]+)/gm;
    while ((m = structRe.exec(content)) !== null) {
      const kind = m[2];
      const fieldsRaw = m[3].trim();
      const lineStart = lineAt(content, m.index);
      const parentModule = this.findParentModule(content, m.index);

      const fields = fieldsRaw
        .replace(/[\[\]]/g, '')
        .split(',')
        .map(f => f.trim().replace(/^:/, '').split(':')[0].trim())
        .filter(Boolean)
        .slice(0, 20);

      symbols.push({
        symbol_type: 'class',
        name: kind,
        value: kind,
        params: fields.length > 0 ? fields : undefined,
        line_start: lineStart,
        is_exported: true,
        parent_id: parentModule,
      });
    }

    // ══════════════════════════════════════════════
    // 6. use / import / alias / require
    // ══════════════════════════════════════════════
    const useRe = /^(\s*)(use|import|alias|require)\s+([\w.]+(?:\s*,\s*[\w.:]+)*)/gm;
    while ((m = useRe.exec(content)) !== null) {
      const kind = m[2];
      const target = m[3].split(',')[0].trim();
      const lineStart = lineAt(content, m.index);
      const shortName = target.split('.').pop() || target;

      symbols.push({
        symbol_type: 'import',
        name: shortName,
        value: `${kind} ${target}`,
        line_start: lineStart,
        is_exported: false,
      });

      references.push({
        symbol_name: shortName,
        line_number: lineStart,
        context: `${kind} ${target}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. @behaviour
    // ══════════════════════════════════════════════
    const behaviourRe = /^\s*@behaviou?r\s+([\w.]+)/gm;
    while ((m = behaviourRe.exec(content)) !== null) {
      const target = m[1];
      const lineStart = lineAt(content, m.index);

      references.push({
        symbol_name: target.split('.').pop() || target,
        line_number: lineStart,
        context: `@behaviour ${target}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8. @type / @typep / @opaque
    // ══════════════════════════════════════════════
    const typeRe = /^\s*@(type|typep|opaque)\s+(\w+)(?:\(([^)]*)\))?\s*::\s*(.+)/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const typeValue = m[4].trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'interface',
        name,
        value: `@${kind} :: ${typeValue}`,
        line_start: lineStart,
        is_exported: kind !== 'typep',
      });
    }

    // ══════════════════════════════════════════════
    // 9. @spec
    // ══════════════════════════════════════════════
    const specRe = /^\s*@spec\s+(\w+[?!]?)\(([^)]*)\)\s*::\s*(.+)/gm;
    while ((m = specRe.exec(content)) !== null) {
      // Specs are metadata, create a reference
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `@spec ${m[1]}(${m[2]}) :: ${m[3]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 10. @callback
    // ══════════════════════════════════════════════
    const callbackRe = /^\s*@callback\s+(\w+[?!]?)\(([^)]*)\)\s*::\s*(.+)/gm;
    while ((m = callbackRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].split(',').map(p => p.trim()).filter(Boolean);
      const returnType = m[3].trim();

      symbols.push({
        symbol_type: 'function',
        name,
        value: '@callback',
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Module attributes (@attr value)
    // ══════════════════════════════════════════════
    const attrRe = /^\s*@(\w+)\s+([^\n]+)/gm;
    while ((m = attrRe.exec(content)) !== null) {
      const name = m[1];
      // Skip already-handled attributes
      if (['moduledoc', 'doc', 'spec', 'type', 'typep', 'opaque', 'callback',
           'behaviour', 'behavior', 'impl', 'derive', 'enforce_keys'].includes(name)) continue;
      const value = m[2].trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: `@${name}`,
        value,
        line_start: lineStart,
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

    // ══════════════════════════════════════════════
    // 13. @moduledoc / @doc
    // ══════════════════════════════════════════════
    const docRe = /@(?:moduledoc|doc)\s+~[sS]?"""([\s\S]*?)"""/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Simple heredoc docs
    const docSimpleRe = /@(?:moduledoc|doc)\s+"""([\s\S]*?)"""/g;
    while ((m = docSimpleRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }

  private findEnd(content: string, startPos: number): number {
    // Find matching 'end' for 'do' blocks
    let depth = 0;
    const lines = content.substring(startPos).split('\n');
    let currentLine = lineAt(content, startPos);

    for (const line of lines) {
      const trimmed = line.trim();
      // Count do/end blocks
      const doMatches = trimmed.match(/\b(do|fn)\b/g);
      const endMatches = trimmed.match(/\bend\b/g);
      if (doMatches) depth += doMatches.length;
      if (endMatches) depth -= endMatches.length;
      if (depth <= 0) return currentLine;
      currentLine++;
    }
    return currentLine;
  }

  private findParentModule(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const moduleMatch = before.match(/defmodule\s+([\w.]+)\s+do\b(?:(?!defmodule)[\s\S])*$/);
    return moduleMatch ? moduleMatch[1] : undefined;
  }
}

export const elixirParser = new ElixirParser();
