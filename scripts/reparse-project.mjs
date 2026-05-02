#!/usr/bin/env node
// reparse-project.mjs — Alle Files eines Projekts neu parsen + Cross-File-Refs neu aufbauen
// Nutzung: node scripts/reparse-project.mjs <project> [file_ext] [--no-embeddings]
//
// --no-embeddings: ueberspringt Qdrant-Vektor-Update (spart Embedding-API-Kosten).
//                  PG-Symbole werden trotzdem aktualisiert — code_intel(symbols, ...)
//                  zeigt sofort die neuen Routes/SQL-Queries. Semantische Suche
//                  laeuft mit den alten Vektoren weiter.

const args = process.argv.slice(2).filter(a => a !== '--no-embeddings');
const skipEmb = process.argv.includes('--no-embeddings');
if (skipEmb) {
  process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
  console.log('[reparse] --no-embeddings aktiv: Qdrant-Update wird uebersprungen.');
}

const { parseAndEmbed, linkCrossFileReferences } = await import('../packages/core/dist/services/code.js');
const { getPool } = await import('../packages/core/dist/index.js');

const project = args[0];
const fileExt = args[1];
if (!project) {
  console.error('Usage: node scripts/reparse-project.mjs <project> [file_ext] [--no-embeddings]');
  process.exit(1);
}
const pool = getPool();
const params = [project];
let extFilter = '';
if (fileExt) {
  params.push(`%.${fileExt}`);
  extFilter = `AND file_path LIKE $2`;
}

const r = await pool.query(
  `SELECT file_path FROM code_files WHERE project = $1 ${extFilter} ORDER BY file_path`,
  params
);
console.log(`[reparse] ${r.rows.length} Files gefunden${fileExt ? ` (.${fileExt})` : ''}`);

let ok = 0, failed = 0;
for (const row of r.rows) {
  try {
    await parseAndEmbed(project, row.file_path);
    ok++;
    if (ok % 20 === 0) console.log(`[reparse] ${ok}/${r.rows.length}`);
  } catch (err) {
    failed++;
    console.error(`[reparse] FAIL ${row.file_path}:`, err.message);
  }
}
console.log(`[reparse] Fertig: ${ok} ok, ${failed} failed`);

const linked = await linkCrossFileReferences(project);
console.log(`[reparse] Cross-File-Links: ${linked}`);

await pool.end();
