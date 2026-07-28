/**
 * MODUL: Assembly Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Assembly-Dateien (.asm, .s, .S)
 *
 * EXTRAHIERT: labels (global/local), sections (.text/.data/.bss/.rodata),
 *             directives (.global/.extern/.equ/.set/.macro), %include/%define,
 *             data definitions (db/dw/dd/dq), comment, todo
 * ANSATZ: Regex-basiert (unterstuetzt AT&T und Intel Syntax)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';

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

class AsmParser implements LanguageParser {
  language = 'asm';
  extensions = ['.asm', '.s', '.S', '.nasm'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // Pre-scan: Collect global labels first (needed for export marking)
    const globalLabels = new Set<string>();
    const preGlobalRe = /^\s*(?:\.globl?|\.global|global|GLOBAL)\s+([\w, ]+)/gim;
    let pg: RegExpExecArray | null;
    while ((pg = preGlobalRe.exec(content)) !== null) {
      pg[1].split(',').map(n => n.trim()).filter(Boolean).forEach(n => globalLabels.add(n));
    }

    // ══════════════════════════════════════════════
    // 1. Sections
    // ══════════════════════════════════════════════
    const sectionRe = /^\s*(?:section|\.section|SECTION)\s+([.\w]+)/gim;
    while ((m = sectionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'section',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Shorthand sections (.text, .data, .bss)
    const shortSecRe = /^\s*\.(text|data|bss|rodata)\s*$/gim;
    while ((m = shortSecRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: `.${m[1]}`,
        value: 'section',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Labels (functions/entry points)
    // ══════════════════════════════════════════════
    const labelRe = /^(\w[\w.@$]*)\s*:/gm;
    while ((m = labelRe.exec(content)) !== null) {
      const name = m[1];
      // Skip local labels (starting with . or L or numbers)
      if (/^[.L\d]/.test(name)) continue;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'label',
        line_start: lineAt(content, m.index),
        is_exported: globalLabels.has(name),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Global / Extern directives
    // ══════════════════════════════════════════════
    // globalLabels already populated by pre-scan above

    const externRe = /^\s*(?:\.extern|extern|EXTERN)\s+([\w,\s]+)/gim;
    while ((m = externRe.exec(content)) !== null) {
      const names = m[1].split(',').map(n => n.trim()).filter(Boolean);
      for (const name of names) {
        references.push({
          symbol_name: name,
          line_number: lineAt(content, m.index),
          context: `extern ${name}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Include
    // ══════════════════════════════════════════════
    const includeRe = /^\s*(?:%include|\.include|INCLUDE)\s+["']?([^\s"']+)["']?/gim;
    while ((m = includeRe.exec(content)) !== null) {
      const file = m[1];
      symbols.push({
        symbol_type: 'import',
        name: file.split('/').pop()?.replace(/\.\w+$/, '') || file,
        value: file,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Constants (equ/set/define)
    // ══════════════════════════════════════════════
    const equRe = /^\s*(?:(\w+)\s+(?:equ|EQU)\s+(.+)|\.(?:equ|set)\s+(\w+)\s*,\s*(.+))/gm;
    while ((m = equRe.exec(content)) !== null) {
      const name = m[1] || m[3];
      const value = (m[2] || m[4]).trim();
      symbols.push({
        symbol_type: 'variable',
        name,
        value: value.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: globalLabels.has(name),
      });
    }

    // %define (NASM)
    const defineRe = /^\s*%define\s+(\w+)(?:\(([^)]*)\))?\s+(.*)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: m[2] !== undefined ? 'function' : 'variable',
        name: m[1],
        value: m[2] !== undefined ? 'macro' : m[3].trim().slice(0, 200),
        params: m[2] ? m[2].split(',').map(p => p.trim()).filter(Boolean) : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Macros (.macro / %macro)
    // ══════════════════════════════════════════════
    const macroRe = /^\s*(?:\.macro|%macro)\s+(\w+)(?:\s+(\d+))?/gim;
    while ((m = macroRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'macro',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Data definitions
    // ══════════════════════════════════════════════
    const dataRe = /^(\w+)\s+(?:db|dw|dd|dq|dt|resb|resw|resd|resq|\.byte|\.word|\.long|\.quad|\.ascii|\.asciz|\.string|\.space|\.zero|\.fill)\s+(.+)/gim;
    while ((m = dataRe.exec(content)) !== null) {
      const name = m[1];
      if (symbols.some(s => s.name === name)) continue; // Skip if already a label
      symbols.push({
        symbol_type: 'variable',
        name,
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: globalLabels.has(name),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Call/Jump references
    // ══════════════════════════════════════════════
    const callRe = /^\s*(?:call|jmp|je|jne|jz|jnz|jg|jl|jge|jle|ja|jb|bl|b)\s+(\w+)/gim;
    const seenCalls = new Set<string>();
    while ((m = callRe.exec(content)) !== null) {
      const target = m[1];
      if (seenCalls.has(target) || /^\d/.test(target)) continue;
      seenCalls.add(target);
      references.push({
        symbol_name: target,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /[;#@!]\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));

    const { statements, callEdges } = extractAsmFlow(content);
    return { symbols, references, statements, callEdges };
  }
}

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer Assembly
// Labels als Scopes, Instruktionen als geordnete Statements
// jmp/call/branch als callEdges/control-flow
// ---------------------------------------------------------------------------
function extractAsmFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;

  const lines = content.split('\n');
  let currentScope: string | null = null;
  let orderCounter = 0;

  const JUMP_OPS = new Set([
    'jmp','je','jne','jz','jnz','jg','jl','jge','jle','ja','jb','jae','jbe',
    'jo','jno','js','jns','jp','jnp','jcxz','jecxz','jrcxz',
    // ARM
    'b','bl','beq','bne','blt','bgt','ble','bge','bcs','bcc','bmi','bpl','bvs','bvc','bhi','bls','blx',
    // RISC-V
    'beq','bne','blt','bge','bltu','bgeu','jal','jalr',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;

    // Skip empty/comment-only lines
    const commentStripped = raw.replace(/[;#@].*$/, '').trim();
    if (!commentStripped) continue;

    // Label: word followed by ':'
    const labelM = /^(\w[\w.@$]*)\s*:/.exec(commentStripped);
    if (labelM) {
      const name = labelM[1];
      if (!/^[.L\d]/.test(name)) {
        // New scope
        currentScope = name;
        orderCounter = 0;
      }
      continue;
    }

    if (!currentScope) continue;

    // Instruction line: first token is mnemonic
    const instrM = /^(\w+)\s*(.*)$/.exec(commentStripped);
    if (!instrM) continue;

    const mnemonic = instrM[1].toLowerCase();
    const operands = instrM[2].trim();

    // Skip assembler directives
    if (mnemonic.startsWith('.') || ['section','global','globl','extern','equ','db','dw','dd','dq','resb','resw','resd','resq','org','align','times','byte','word','long','quad','ascii','asciz','string','space','zero','fill','macro','endm','%macro','%endmacro','%define','%include','%if','%endif'].includes(mnemonic)) continue;

    let stmtType = 'expression';
    let callTarget: string | undefined;
    let callKind: string | undefined;

    if (mnemonic === 'call') {
      stmtType = 'call';
      callTarget = operands.split(/[,\s]/)[0].replace(/^\*/, '');
      callKind = 'function';
    } else if (JUMP_OPS.has(mnemonic)) {
      stmtType = mnemonic === 'jmp' || mnemonic === 'b' ? 'call' : 'if';
      callTarget = operands.split(/[,\s]/)[0];
      callKind = 'function';
    } else if (['ret','retn','retf','bx','blr'].includes(mnemonic)) {
      stmtType = 'return';
    } else if (['mov','movq','movl','movw','movb','lea','ldr','str','push','pop'].includes(mnemonic)) {
      stmtType = 'assignment';
    }

    const id = nextId();
    const st: ParsedStatement = {
      temp_id: id,
      scope_type: 'function',
      scope_name: currentScope,
      statement_type: stmtType,
      node_kind: mnemonic,
      line_start: lineNum,
      order_index: orderCounter++,
      depth: 0,
      is_top_level: true,
      is_awaited: false,
      text: commentStripped.slice(0, 200),
      callee: callTarget,
    };
    statements.push(st);

    if (callTarget && callKind && !/^\d/.test(callTarget)) {
      callEdges.push({
        statement_temp_id: id,
        caller_scope: currentScope,
        callee_name: callTarget,
        line_number: lineNum,
        call_kind: callKind,
      });
    }
  }

  return { statements, callEdges };
}

export const asmParser = new AsmParser();
