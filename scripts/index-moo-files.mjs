#!/usr/bin/env node
// index-moo-files.mjs — Indexiert alle .moo-Dateien eines Projekts (FileWatcher-Bypass)
// Nutzung: node scripts/index-moo-files.mjs <project> <project_root> [ext]

import { indexFile, linkCrossFileReferences } from '../packages/core/dist/services/code.js';
import { getPool } from '../packages/core/dist/index.js';
import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';

const project = process.argv[2];
const root = process.argv[3];
const ext = process.argv[4] ?? '.moo';
if (!project || !root) {
  console.error('Usage: node scripts/index-moo-files.mjs <project> <project_root> [ext]');
  process.exit(1);
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith(ext)) yield p;
  }
}

const files = [];
for await (const f of walk(root)) files.push(f);
console.log(`[index] ${files.length} Files mit Extension ${ext} gefunden`);

let ok = 0, failed = 0;
for (const absPath of files) {
  const relPath = relative(root, absPath);
  try {
    await indexFile(relPath, project, root);
    ok++;
    if (ok % 10 === 0) console.log(`[index] ${ok}/${files.length}`);
  } catch (err) {
    failed++;
    console.error(`[index] FAIL ${relPath}:`, err.message);
  }
}
console.log(`[index] Fertig: ${ok} ok, ${failed} failed`);

// Warte auf debounced parseAndEmbed (2s) + crossRef (5s) + Safety-Buffer
console.log('[index] Warte 10s auf Debounce-Queues...');
await new Promise(r => setTimeout(r, 10000));

const linked = await linkCrossFileReferences(project);
console.log(`[index] Cross-File-Links: ${linked}`);

const pool = getPool();
const stats = await pool.query(
  `SELECT symbol_type, COUNT(*) FROM code_symbols
   WHERE project = $1 AND file_path LIKE $2
   GROUP BY symbol_type ORDER BY 2 DESC`,
  [project, `%${ext}`]
);
console.log(`\n${ext} Symbol-Stats:`);
console.table(stats.rows);

await pool.end();
