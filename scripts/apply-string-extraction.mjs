#!/usr/bin/env node
// apply-string-extraction.mjs — Fuegt extractStringLiterals zu allen Parsern hinzu.
//
// Fuer jede <sprache>.ts in packages/core/src/parser/:
//   1. Ergaenzt Import: import { extractStringLiterals } from './types.js';
//   2. Fuegt vor letztem `return { symbols, references };` eine Zeile ein:
//        symbols.push(...extractStringLiterals(content, { includeSingleQuotes: <bool> }));
//
// Sprachen mit char-literals ('a') bekommen nur ", alle anderen " + '.

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

const PARSER_DIR = new URL('../packages/core/src/parser/', import.meta.url);

// Sprachen mit char-literals → includeSingleQuotes: false (nur ")
const NO_SINGLE_QUOTES = new Set([
  'c', 'cpp', 'csharp', 'java', 'go', 'rust', 'kotlin', 'scala', 'swift',
  'crystal', 'dlang', 'fortran', 'fsharp', 'groovy', 'julia', 'nim', 'objc',
  'vlang', 'zig', 'haskell', 'ocaml', 'lean', 'ada', 'cobol', 'glsl', 'wgsl',
  'smithy', 'protobuf', 'graphql', 'solidity', 'dhall', 'asm',
]);

// Dateien die nicht editiert werden
const SKIP = new Set(['types.ts', 'index.ts']);

const entries = await readdir(PARSER_DIR, { withFileTypes: true });
const files = entries.filter(e => e.isFile() && e.name.endsWith('.ts') && !SKIP.has(e.name));

let updated = 0, skipped = 0, failed = 0;
for (const ent of files) {
  const path = join(PARSER_DIR.pathname, ent.name);
  const base = ent.name.replace(/\.ts$/, '');
  try {
    let src = await readFile(path, 'utf8');
    if (src.includes('extractStringLiterals')) { skipped++; continue; }

    // 1. Import ergaenzen — nach erstem import type/from '...types.js'
    const importAnchor = /import type \{[^}]+\} from '\.\/types\.js';/;
    if (!importAnchor.test(src)) {
      console.error(`[skip ${ent.name}] no types.js import anchor`);
      failed++; continue;
    }
    src = src.replace(importAnchor, (m) =>
      `${m}\nimport { extractStringLiterals } from './types.js';`);

    // 2. Insert vor letztem `return { symbols, references };`
    const returnPattern = /(\n(\s*)return \{ symbols, references \};)/g;
    const matches = [...src.matchAll(returnPattern)];
    if (matches.length === 0) {
      console.error(`[skip ${ent.name}] no return pattern`);
      failed++; continue;
    }
    const last = matches[matches.length - 1];
    const indent = last[2];
    const opts = NO_SINGLE_QUOTES.has(base) ? '' : ', { includeSingleQuotes: true }';
    const insert = `\n${indent}symbols.push(...extractStringLiterals(content${opts}));\n`;
    src = src.slice(0, last.index) + insert + src.slice(last.index);

    await writeFile(path, src);
    updated++;
  } catch (err) {
    console.error(`[fail ${ent.name}]`, err.message);
    failed++;
  }
}

console.log(`\n✓ Updated: ${updated} | Skipped: ${skipped} | Failed: ${failed}`);
