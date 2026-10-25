/**
 * P4-T80 DB: parseAndEmbed mit einer Minify-artigen Datei (700 lokale Variablen 'n', ohne Deckel 2.940.003
 * Verweiszeilen) speichert nur die eindeutigen Verweise; eine normale Datei behaelt alle. Embedding-Attrappe.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/verweis-zuordnung-db-p4-t80.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';

pruefeTestDbUrl('verweis-zuordnung-db-p4-t80.test');
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.FEHLERMUSTER_WARTE_MS = '0';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const core = await lade(dist, 'index.js');
const codeMod = await lade(dist, 'services', 'code.js');
const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (/192\.168\.50\.65/.test(wirksam.qdrant.url) || /192\.168\.50\.65/.test(wirksam.embeddings.ollama.url)) {
  console.error('ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappen.');
  process.exit(2);
}

const PROJECT = 'verweis-t80';
const wurzel = mkdtempSync(join(tmpdir(), 'verweis-t80-'));
const pool = core.getPool();
let ok = 0;
const fehler = [];
const pruefe = (bed, text, detail) => {
  if (bed) { ok++; console.log('OK  ' + text); return; }
  fehler.push(text);
  console.log('FEHLER ' + text + (detail !== undefined ? '\n   ' + JSON.stringify(detail).slice(0, 600) : ''));
};
async function aufraeumen() {
  for (const t of ['code_references', 'code_chunks', 'code_symbols', 'file_versions', 'code_files']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]).catch(() => {});
  }
}
const lege = async (p, inhalt) => pool.query(
  `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at, ignored)
   VALUES ($1, $2, $3, $4, 'js', $5, $6, $7, NOW(), false)`,
  [`${PROJECT}:${p}`, PROJECT, p, p.split('/').pop(), inhalt, core.contentHash(inhalt), inhalt.length],
);
const verweise = async (p) => Number((await pool.query(
  'SELECT COUNT(*)::int AS n FROM code_references WHERE project = $1 AND file_path = $2', [PROJECT, p])).rows[0].n);

try {
  await aufraeumen();
  await core.registerProject(PROJECT, wurzel);
  await pool.query('UPDATE projects SET hostname = $2 WHERE name = $1', [PROJECT, 'verweis-t80-ohne-daemon']);

  let minify = '';
  for (let i = 0; i < 700; i++) minify += `function a${i}(){var n=${i};return n+n+n+n+n+n}`;
  minify += '\nclass Haupt{}\nnew Haupt();new Haupt();new Haupt();\n';
  const normal = 'class Box {}\nconst eins = new Box();\nconst zwei = new Box();\nfunction mach(x) { return x; }\nmach(eins);\n';
  await lege('bundle/app.js', minify);
  await lege('src/normal.js', normal);

  const t0 = Date.now();
  for (const p of ['bundle/app.js', 'src/normal.js']) {
    try { await codeMod.parseAndEmbed(PROJECT, p, { erzwingeParse: true }); } catch { /* Embedding-Attrappe 127.0.0.1:9 */ }
  }
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);

  const bundle = await verweise('bundle/app.js');
  pruefe(bundle === 3, 'Minify: nur die eindeutigen Verweise (Haupt x3), die 2.940.000 mehrdeutigen nicht', bundle);
  const sym = Number((await pool.query(
    "SELECT COUNT(*)::int AS n FROM code_symbols WHERE project = $1 AND file_path = 'bundle/app.js'", [PROJECT])).rows[0].n);
  pruefe(sym >= 700, 'Minify: Symbole bleiben vollstaendig', sym);
  const zeile = (await pool.query(
    "SELECT parser_version, parsed_at FROM code_files WHERE project = $1 AND file_path = 'bundle/app.js'", [PROJECT])).rows[0];
  pruefe(zeile?.parsed_at && zeile.parser_version !== null, 'Minify: Datei gilt als geparst (kein Endlos-Retry)', zeile);
  pruefe(heapMb < 1024, `Speicher bleibt klein (${heapMb} MB Heap, ${Date.now() - t0} ms)`, heapMb);

  const box = Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM code_references r JOIN code_symbols s ON s.id = r.symbol_id
      WHERE r.project = $1 AND r.file_path = 'src/normal.js' AND s.name = 'Box'`, [PROJECT])).rows[0].n);
  pruefe(box === 2, 'Normale Datei: Verweise wie bisher (Box x2)', box);
  pruefe(await verweise('src/normal.js') >= 3, 'Normale Datei: weitere Verweise vorhanden (mach, eins)', await verweise('src/normal.js'));
} finally {
  await aufraeumen();
  await pool.query('DELETE FROM projects WHERE name = $1', [PROJECT]).catch(() => {});
  rmSync(wurzel, { recursive: true, force: true });
  await core.resetParserPool?.().catch(() => {});
  await pool.end().catch(() => {});
}
console.log(`\n${ok} OK, ${fehler.length} FEHLER`);
process.exit(fehler.length ? 1 : 0);
