/**
 * P15-T17 E2 (11.10.2026): Die REST-Routen /api/projects/:name/files haengen Fehlermuster-Treffer an.
 *
 * ZUSAGEN:
 *   R1 POST (create) mit passendem Inhalt -> Antwort traegt fehlermuster (Datei, was, wie), kein errorPatterns mehr.
 *   R2 PUT ohne operation (Vollersatz) -> fehlermuster.
 *   R3 PUT search_replace / replace_lines / insert_after / delete_lines -> fehlermuster, wenn der geaenderte
 *      Abschnitt passt; ohne passenden Inhalt keins.
 *   R4 ohne agent_id kein fehlermuster (und kein Fehler).
 *   R5 Nachlieferung: ein ausstehender Hinweis (z. B. aus MCP) kommt mit der naechsten REST-Antwort.
 * POSITIVKONTROLLE: R1 zeigt den Treffer; mit dem alten Code (errorPatterns aus result.warnings) war er immer leer.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: set -a; . <test-db.env>; set +a; node scripts/test-fehlermuster-rest.mjs  (core + rest-api vorher bauen)
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}

const MODELL = 'fake-fm-embed:latest';
const P_ID = 'f0f0f0f0-1717-4e00-8a17-0000000000e2';
const PRJ = 'zz-fehlermuster-rest';
const AGENT = 'zz-fm-rest';

const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: MODELL, model: MODELL, digest: 'ab'.repeat(32), size: 1000 }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } }));
    if (req.url === '/api/embed') {
      const a = JSON.parse(body);
      const liste = Array.isArray(a.input) ? a.input : [a.input];
      return res.end(JSON.stringify({ embeddings: liste.map((t) => (/PASSEND/.test(t) ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0])) }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
let ERRP = '';
const qdrant = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return res.end(JSON.stringify({ title: 'qdrant', version: '1.13.0' }));
    const m = /^\/collections\/([^/]+)\/points\/search$/.exec(u.pathname);
    if (m) {
      const b = JSON.parse(body || '{}');
      if (decodeURIComponent(m[1]) !== ERRP || b.vector?.[0] !== 1) return res.end(JSON.stringify({ status: 'ok', time: 0, result: [] }));
      return res.end(JSON.stringify({ status: 'ok', time: 0, result: [
        { id: P_ID, version: 0, score: 0.8, payload: { id: P_ID, model_scope: 'all', severity: 'warning' } }] }));
    }
    res.end(JSON.stringify({ status: 'ok', time: 0, result: {} }));
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
process.env.OLLAMA_MODEL = MODELL;
process.env.QDRANT_URL = `http://127.0.0.1:${qdrant.address().port}`;
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SCORE_SCHWELLE_ERROR_PATTERNS = '0.5';
process.env.FEHLERMUSTER_WARTE_MS = '2000';
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE',
  'FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE', 'FEHLERMUSTER_GESEHEN_STUNDEN', 'SYNAPSE_AGENT_NAME', 'SYNAPSE_DEFAULT_AGENT_ID']) delete process.env[name];
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) {
  console.error('ABBRUCH: Ollama/Qdrant zeigen auf Produktion.');
  process.exit(2);
}
const FA = await lade(dist, 'services', 'fehlermuster-auslieferung.js');
const db = await lade(dist, 'db', 'client.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');
ERRP = COLLECTIONS.globalErrorPatterns;
const restRequire = createRequire(join(hier, '..', 'packages', 'rest-api', 'package.json'));
const Fastify = restRequire('fastify');
const { filesRoutes } = await lade(hier, '..', 'packages', 'rest-api', 'dist', 'routes', 'files.js');
const pool = db.getPool();

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const vergessen = () => pool.query('DELETE FROM error_pattern_seen WHERE session_id = $1', [AGENT]);
async function aufraeumen() {
  await pool.query('DELETE FROM error_patterns WHERE id = $1', [P_ID]);
  await vergessen();
  await pool.query('DELETE FROM agent_sessions WHERE id = $1', [AGENT]).catch(() => {});
  await pool.query('DELETE FROM file_versions WHERE project = $1', [PRJ]).catch(() => {});
  await pool.query('DELETE FROM code_files WHERE project = $1', [PRJ]).catch(() => {});
}

const app = Fastify({ logger: false });
await app.register(filesRoutes);
await app.ready();
const url = `/api/projects/${PRJ}/files`;
const post = async (body) => (await app.inject({ method: 'POST', url, payload: body })).json();
const put = async (body) => (await app.inject({ method: 'PUT', url, payload: body })).json();

try {
  await aufraeumen();
  await pool.query(
    `INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model, status, titel)
     VALUES ($1, 'ZZ-TEST REST Muster', 'ZZ-TEST REST fix', 'warning', 'all', 'zz', 'opus', 'aktiv', 'ZZ-TEST titel')`, [P_ID]);
  FA._fehlermusterAuslieferungZuruecksetzen();

  const r1 = await post({ file_path: 'r/a.ts', content: 'export const a = 1; // PASSEND\nexport const b = 2;\n', agent_id: AGENT });
  pruefe(r1.success && r1.fehlermuster?.anzahl === 1 && r1.fehlermuster.treffer[0].datei === 'r/a.ts'
    && r1.fehlermuster.treffer[0].was === 'ZZ-TEST REST Muster' && r1.fehlermuster.treffer[0].wie === 'ZZ-TEST REST fix' && !('errorPatterns' in r1),
    'R1 POST create: fehlermuster mit Datei/was/wie, kein errorPatterns', r1);

  await vergessen();
  const r2 = await put({ file_path: 'r/a.ts', content: 'export const a = 3; // PASSEND voll\n', agent_id: AGENT });
  pruefe(r2.success && r2.fehlermuster?.anzahl === 1, 'R2 PUT Vollersatz: fehlermuster', r2);

  await vergessen();
  const r3a = await put({ file_path: 'r/a.ts', operation: 'search_replace', search: 'a = 3', replace: 'a = 4', agent_id: AGENT });
  pruefe(r3a.success && r3a.fehlermuster?.anzahl === 1, 'R3a search_replace (geaenderte Zeile passt): fehlermuster', r3a);
  await vergessen();
  // Negativfaelle in einer Datei ohne Treffer-Text: der gepruefte Abschnitt enthaelt auch Umfeldzeilen.
  const r3n = await post({ file_path: 'r/n.ts', content: 'export const n = 1;\nexport const m = 2;\n', agent_id: AGENT });
  pruefe(r3n.success && !r3n.fehlermuster, 'R3n POST ohne passenden Inhalt: kein fehlermuster', r3n);
  const r3b = await put({ file_path: 'r/n.ts', operation: 'insert_after', after_line: 1, content: 'export const c = 5;', agent_id: AGENT });
  pruefe(r3b.success && !r3b.fehlermuster, 'R3b insert_after ohne passenden Inhalt: kein fehlermuster', r3b);
  await vergessen();
  const r3c = await put({ file_path: 'r/a.ts', operation: 'replace_lines', line_start: 2, line_end: 2, content: 'export const c = 6; // PASSEND z2', agent_id: AGENT });
  pruefe(r3c.success && r3c.fehlermuster?.anzahl === 1, 'R3c replace_lines: fehlermuster', r3c);
  await vergessen();
  const r3d = await put({ file_path: 'r/n.ts', operation: 'delete_lines', line_start: 2, line_end: 2, agent_id: AGENT });
  pruefe(r3d.success && !r3d.fehlermuster, 'R3d delete_lines ohne passenden Abschnitt: kein fehlermuster', r3d);

  await vergessen();
  const r4 = await post({ file_path: 'r/b.ts', content: 'export const z = 1; // PASSEND\n' });
  pruefe(r4.success && !r4.fehlermuster, 'R4 ohne agent_id: kein fehlermuster, kein Fehler', r4);

  await vergessen();
  FA._fehlermusterAuslieferungZuruecksetzen();
  FA.verfolgeFehlermusterPruefung(AGENT, 'aus/mcp.ts', Promise.resolve([{ id: P_ID, severity: 'warning', description: 'ZZ-TEST REST Muster', fix: 'ZZ-TEST REST fix' }]));
  await schlaf(20);
  const r5 = await put({ file_path: 'r/a.ts', operation: 'insert_after', after_line: 1, content: 'export const d = 7;', agent_id: AGENT });
  pruefe(r5.success && r5.fehlermuster?.treffer?.[0]?.datei === 'aus/mcp.ts', 'R5 ausstehender Hinweis kommt mit der naechsten REST-Antwort', r5);
} catch (err) {
  fehler++;
  console.log('FEHLER  Ausnahme: ' + (err?.stack ?? err));
} finally {
  await schlaf(300);
  await aufraeumen().catch((e) => { fehler++; console.log('FEHLER  Aufraeumen: ' + e.message); });
  await app.close();
  ollama.close();
  qdrant.close();
}
console.log(`\nERGEBNIS: ${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
