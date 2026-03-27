/**
 * MODUL: Svelte Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Svelte-Dateien (.svelte)
 *
 * EXTRAHIERT: <script> block (imports, exports, let/const/function, $:),
 *             <style> block, component props (export let), stores ($store),
 *             event dispatchers, slots, actions, transitions,
 *             {#if}/{#each}/{#await} blocks, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class SvelteParser implements LanguageParser {
  language = 'svelte';
  extensions = ['.svelte'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // Extract script block content
    const scriptMatch = content.match(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/i);
    const scriptContent = scriptMatch ? scriptMatch[1] : '';
    const scriptOffset = scriptMatch ? content.indexOf(scriptMatch[1]) : 0;

    // ══════════════════════════════════════════════
    // 1. Script: Imports
    // ══════════════════════════════════════════════
    const importRe = /^\s*import\s+(?:\{([^}]+)\}\s+from\s+)?(?:(\w+)\s+from\s+)?['"]([^'"]+)['"]/gm;
    while ((m = importRe.exec(scriptContent)) !== null) {
      const named = m[1] ? m[1].split(',').map(n => n.trim().split(' as ').pop()!.trim()).filter(Boolean) : [];
      const defaultImport = m[2];
      const source = m[3];
      const lineStart = lineAt(content, scriptOffset + m.index);

      if (defaultImport) {
        symbols.push({
          symbol_type: 'import',
          name: defaultImport,
          value: source,
          line_start: lineStart,
          is_exported: false,
        });
      }

      for (const name of named) {
        symbols.push({
          symbol_type: 'import',
          name,
          value: source,
          line_start: lineStart,
          is_exported: false,
        });
      }

      references.push({
        symbol_name: source.split('/').pop()?.replace(/\.\w+$/, '') || source,
        line_number: lineStart,
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Script: Props (export let)
    // ══════════════════════════════════════════════
    const propRe = /^\s*export\s+let\s+(\w+)(?:\s*:\s*(\w[\w<>|&\s]*))?(?:\s*=\s*([^\n;]+))?/gm;
    while ((m = propRe.exec(scriptContent)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[3] ? m[3].trim() : m[2] || 'prop',
        return_type: m[2] ? m[2].trim() : undefined,
        line_start: lineAt(content, scriptOffset + m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Script: Functions
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = funcRe.exec(scriptContent)) !== null) {
      const params = m[2].split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, scriptOffset + m.index),
        is_exported: m[0].includes('export'),
      });
    }

    // Arrow functions assigned to const/let
    const arrowRe = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|(\w+))\s*=>/gm;
    while ((m = arrowRe.exec(scriptContent)) !== null) {
      const params = (m[2] || m[3] || '').split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, scriptOffset + m.index),
        is_exported: m[0].includes('export'),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Script: Constants / Variables (not props or functions)
    // ══════════════════════════════════════════════
    const varRe = /^\s*(?:export\s+)?(?:const|let)\s+(\w+)(?:\s*:\s*(\w[\w<>|&\s]*))?(?:\s*=\s*(?!(?:async\s+)?(?:\(|function|\w+\s*=>))([^\n;]+))?/gm;
    while ((m = varRe.exec(scriptContent)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, scriptOffset + m.index);

      // Skip if already captured as prop or function
      if (symbols.some(s => s.name === name && (s.line_start === lineStart))) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: m[3] ? m[3].trim().slice(0, 200) : m[2] || 'let',
        line_start: lineStart,
        is_exported: m[0].includes('export'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Script: Reactive statements ($:)
    // ══════════════════════════════════════════════
    const reactiveRe = /^\s*\$:\s*(?:(\w+)\s*=\s*)?(.+)/gm;
    while ((m = reactiveRe.exec(scriptContent)) !== null) {
      const name = m[1] || '$';
      symbols.push({
        symbol_type: 'variable',
        name: `$: ${name}`,
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, scriptOffset + m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Script: Store subscriptions ($storeName)
    // ══════════════════════════════════════════════
    const storeRe = /\$(\w+)/g;
    const seenStores = new Set<string>();
    while ((m = storeRe.exec(scriptContent)) !== null) {
      const name = m[1];
      if (name === ':' || seenStores.has(name)) continue;
      if (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(name[0])) continue;
      seenStores.add(name);
      references.push({
        symbol_name: `$${name}`,
        line_number: lineAt(content, scriptOffset + m.index),
        context: `$${name} (store)`,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Script: Event dispatcher
    // ══════════════════════════════════════════════
    const dispatchRe = /createEventDispatcher(?:<([^>]+)>)?\s*\(\s*\)/g;
    m = dispatchRe.exec(scriptContent);
    if (m) {
      symbols.push({
        symbol_type: 'function',
        name: 'dispatch',
        value: 'createEventDispatcher',
        line_start: lineAt(content, scriptOffset + m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Template: Component usage
    // ══════════════════════════════════════════════
    const componentRe = /<([A-Z]\w+)/g;
    const seenComponents = new Set<string>();
    while ((m = componentRe.exec(content)) !== null) {
      const name = m[1];
      if (seenComponents.has(name)) continue;
      seenComponents.add(name);
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: `<${name} ...>`,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Template: Slots
    // ══════════════════════════════════════════════
    const slotRe = /<slot\s+name=["'](\w+)["']/g;
    while ((m = slotRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `slot:${m[1]}`,
        value: 'named slot',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Default slot
    if (/<slot\s*\/?>/.test(content) && !/<slot\s+name=/.test(content.match(/<slot\s*\/?>/)?.[0] || '')) {
      const slotMatch = content.match(/<slot\s*\/?>/);
      if (slotMatch) {
        symbols.push({
          symbol_type: 'variable',
          name: 'slot:default',
          value: 'default slot',
          line_start: lineAt(content, content.indexOf(slotMatch[0])),
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 10. Style block
    // ══════════════════════════════════════════════
    const styleMatch = content.match(/<style(?:\s+[^>]*)?>[\s\S]*?<\/style>/i);
    if (styleMatch) {
      symbols.push({
        symbol_type: 'variable',
        name: 'style',
        value: styleMatch[0].includes('lang=') ? 'scoped (preprocessor)' : 'scoped',
        line_start: lineAt(content, content.indexOf(styleMatch[0])),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /(?:\/\/|<!--)\s*(TODO|FIXME|HACK):?\s*(.*?)(?:-->)?$/gim;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    return { symbols, references };
  }
}

export const svelteParser = new SvelteParser();
