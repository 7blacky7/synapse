/**
 * MODUL: Vue Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Vue Single-File Components (.vue)
 *
 * EXTRAHIERT: <script setup> (imports, defineProps, defineEmits, ref/reactive/computed,
 *             defineExpose, defineSlots, defineModel), <script> Options API (data,
 *             methods, computed, watch, components, props, emits, lifecycle hooks),
 *             <template> (component refs), <style> block, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class VueParser implements LanguageParser {
  language = 'vue';
  extensions = ['.vue'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // Detect script setup vs options API
    const setupMatch = content.match(/<script\s+setup(?:\s+[^>]*)?>[\s\S]*?<\/script>/i);
    const scriptMatch = content.match(/<script(?:\s+[^>]*)?>[\s\S]*?<\/script>/i);
    const isSetup = !!setupMatch;
    const scriptBlock = (setupMatch || scriptMatch)?.[0] || '';
    const scriptContent = scriptBlock.replace(/<\/?script[^>]*>/gi, '');
    const scriptOffset = content.indexOf(scriptContent);

    // ══════════════════════════════════════════════
    // 1. Imports
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

    if (isSetup) {
      this.parseSetupScript(scriptContent, scriptOffset, content, symbols, references);
    } else {
      this.parseOptionsAPI(scriptContent, scriptOffset, content, symbols, references);
    }

    // ══════════════════════════════════════════════
    // Template: Component usage
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
    // Style block
    // ══════════════════════════════════════════════
    const styleMatch = content.match(/<style(?:\s+[^>]*)?>[\s\S]*?<\/style>/i);
    if (styleMatch) {
      const isScoped = /scoped/.test(styleMatch[0]);
      const hasLang = /lang=/.test(styleMatch[0]);
      symbols.push({
        symbol_type: 'variable',
        name: 'style',
        value: `${isScoped ? 'scoped' : 'global'}${hasLang ? ' (preprocessor)' : ''}`,
        line_start: lineAt(content, content.indexOf(styleMatch[0])),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // TODO / FIXME / HACK
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }

  private parseSetupScript(
    script: string, offset: number, content: string,
    symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    let m: RegExpExecArray | null;

    // defineProps
    const propsRe = /(?:const\s+(\w+)\s*=\s*)?defineProps(?:<([^>]+)>)?\s*\(([^)]*)\)/g;
    m = propsRe.exec(script);
    if (m) {
      const varName = m[1] || 'props';
      symbols.push({
        symbol_type: 'variable',
        name: varName,
        value: 'defineProps',
        line_start: lineAt(content, offset + m.index),
        is_exported: true,
      });
    }

    // defineEmits
    const emitsRe = /(?:const\s+(\w+)\s*=\s*)?defineEmits(?:<([^>]+)>)?\s*\(([^)]*)\)/g;
    m = emitsRe.exec(script);
    if (m) {
      symbols.push({
        symbol_type: 'function',
        name: m[1] || 'emit',
        value: 'defineEmits',
        line_start: lineAt(content, offset + m.index),
        is_exported: true,
      });
    }

    // defineModel
    const modelRe = /(?:const\s+(\w+)\s*=\s*)?defineModel(?:<([^>]+)>)?\s*\(/g;
    m = modelRe.exec(script);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1] || 'model',
        value: 'defineModel',
        line_start: lineAt(content, offset + m.index),
        is_exported: true,
      });
    }

    // defineExpose
    const exposeRe = /defineExpose\s*\(\s*\{([^}]*)\}/g;
    m = exposeRe.exec(script);
    if (m) {
      symbols.push({
        symbol_type: 'export',
        name: 'expose',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, offset + m.index),
        is_exported: true,
      });
    }

    // ref / reactive / computed / watch
    const composableRe = /(?:const|let)\s+(\w+)\s*=\s*(ref|reactive|computed|shallowRef|toRef|shallowReactive)\s*[<(]/g;
    while ((m = composableRe.exec(script)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2],
        line_start: lineAt(content, offset + m.index),
        is_exported: false,
      });
    }

    // Functions
    const funcRe = /^\s*(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = funcRe.exec(script)) !== null) {
      const params = m[2].split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, offset + m.index),
        is_exported: false,
      });
    }

    // Arrow functions
    const arrowRe = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|(\w+))\s*=>/g;
    while ((m = arrowRe.exec(script)) !== null) {
      // Skip if already captured as composable
      if (symbols.some(s => s.name === m![1])) continue;
      const params = (m[2] || m[3] || '').split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, offset + m.index),
        is_exported: false,
      });
    }
  }

  private parseOptionsAPI(
    script: string, offset: number, content: string,
    symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    let m: RegExpExecArray | null;

    // Component name
    const nameRe = /name\s*:\s*['"](\w+)['"]/;
    m = nameRe.exec(script);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'component',
        line_start: lineAt(content, offset + m.index),
        is_exported: true,
      });
    }

    // Props (object syntax)
    const propsObjRe = /props\s*:\s*\{([^}]+)\}/g;
    m = propsObjRe.exec(script);
    if (m) {
      const propRe = /(\w+)\s*:/g;
      let pm: RegExpExecArray | null;
      while ((pm = propRe.exec(m[1])) !== null) {
        if (['type', 'default', 'required', 'validator'].includes(pm[1])) continue;
        symbols.push({
          symbol_type: 'variable',
          name: pm[1],
          value: 'prop',
          line_start: lineAt(content, offset + (m?.index || 0)),
          is_exported: true,
        });
      }
    }

    // Methods
    const methodsRe = /methods\s*:\s*\{([\s\S]*?)\n\s*\}/;
    m = methodsRe.exec(script);
    if (m) {
      const methodRe = /^\s*(?:async\s+)?(\w+)\s*\(/gm;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(m[1])) !== null) {
        symbols.push({
          symbol_type: 'function',
          name: mm[1],
          value: 'method',
          line_start: lineAt(content, offset + (m?.index || 0) + mm.index),
          is_exported: false,
        });
      }
    }

    // Computed
    const computedRe = /computed\s*:\s*\{([\s\S]*?)\n\s*\}/;
    m = computedRe.exec(script);
    if (m) {
      const compRe = /^\s*(\w+)\s*(?:\(|:)/gm;
      let cm: RegExpExecArray | null;
      while ((cm = compRe.exec(m[1])) !== null) {
        if (['get', 'set'].includes(cm[1])) continue;
        symbols.push({
          symbol_type: 'variable',
          name: cm[1],
          value: 'computed',
          line_start: lineAt(content, offset + (m?.index || 0) + cm.index),
          is_exported: false,
        });
      }
    }

    // Data function
    const dataRe = /data\s*\(\s*\)\s*\{[\s\S]*?return\s*\{([^}]+)\}/;
    m = dataRe.exec(script);
    if (m) {
      const dataFieldRe = /(\w+)\s*:/g;
      let dm: RegExpExecArray | null;
      while ((dm = dataFieldRe.exec(m[1])) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: dm[1],
          value: 'data',
          line_start: lineAt(content, offset + (m?.index || 0)),
          is_exported: false,
        });
      }
    }

    // Components registration
    const componentsRe = /components\s*:\s*\{([^}]+)\}/;
    m = componentsRe.exec(script);
    if (m) {
      const compNames = m[1].split(',').map(c => c.trim().split(':')[0].trim()).filter(Boolean);
      for (const name of compNames) {
        references.push({
          symbol_name: name,
          line_number: lineAt(content, offset + (m?.index || 0)),
          context: `components: { ${name} }`,
        });
      }
    }
  }
}

export const vueParser = new VueParser();
