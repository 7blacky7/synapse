/**
 * P15-T17 E0 (11.10.2026): Fehlermuster-Treffer kommen wieder beim Agenten an.
 *
 * ZUSAGEN:
 *   C1 Agent ohne Session (model unbekannt) sieht ALLE passenden Muster, auch scope 'haiku'.
 *   C2 FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE=0 -> unbekannt sieht nur 'all' (altes Verhalten, abschaltbar).
 *   C3 Session mit bekanntem Modell (opus): scope-Filter bleibt -> nur 'all'.
 *   C4 checkErrorPatterns schreibt KEINEN gesehen-Vermerk mehr.
 *   C5 gesehen gilt nur im Fenster: frisch -> unterdrueckt; 25 h alt -> wieder da;
 *      vor der Registrierung des Agenten -> wieder da.
 *   A1 verfolge + hole: Treffer mit was/wie/datei, danach gesehen-Vermerk in PG.
 *   A2 zweites hole -> null (einmalig).
 *   A3 vor der Auslieferung KEIN gesehen-Vermerk.
 *   A4 laufende Pruefung (100 ms) -> hole wartet und liefert in derselben Antwort.
 *   A5 langsame Pruefung (1 s, Warten 150 ms) -> erst null, spaeter Nachlieferung.
 *   A6 dasselbe Muster an derselben Datei zweimal -> ein Treffer.
 *   A7 mehr als 5 -> 5 jetzt, Rest mit der naechsten Antwort.
 *   K1 Kette: createFileInPg + updateFileInPg mit passendem Text -> hole liefert Treffer mit Datei.
 * POSITIVKONTROLLE: C1 und K1 zeigen Treffer; ohne Fix (alter Code) waeren beide leer.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node scripts/test-fehlermuster-auslieferung.mjs
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-fehlermuster-auslieferung');

const MODELL = 'fake-fm-embed:latest';
const P_ALL = 'f0f0f0f0-1717-4e00-8a17-0000000000a1';
const P_HAIKU = 'f0f0f0f0-1717-4e00-8a17-0000000000b2';
const PRJ = 'zz-fehlermuster-test';
const AGENTEN = ['zz-fm-a', 'zz-fm-b', 'zz-fm-opus', 'zz-fm-c5', 'zz-fm-k1', 'zz-fm-x'];

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
        { id: P_ALL, version: 0, score: 0.8, payload: { id: P_ALL, model_scope: 'all', severity: 'error' } },
        { id: P_HAIKU, version: 0, score: 0.8, payload: { id: P_HAIKU, model_scope: 'haiku', severity: 'warning' } },
      ] }));
    }
    // alles andere (Upserts aus dem Index-Pfad) still bestaetigen
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
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE',
  'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE', 'FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE', 'FEHLERMUSTER_WARTE_MS',
  'FEHLERMUSTER_GESEHEN_STUNDEN']) delete process.env[name];
// Praefixe sonst aus dem Modellprofil (PG) - das Fake-Modell hat keins.
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
const EP = await lade(dist, 'services', 'error-patterns.js');
const FA = await lade(dist, 'services', 'fehlermuster-auslieferung.js');
const CW = await lade(dist, 'services', 'code-write.js');
const db = await lade(dist, 'db', 'client.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');
ERRP = COLLECTIONS.globalErrorPatterns;
const pool = db.getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const gesehen = async (agent) => (await pool.query(
  'SELECT pattern_id::text AS p, shown_at FROM error_pattern_seen WHERE session_id = $1 ORDER BY 1', [agent])).rows;
const w = (id, extra = '') => ({ id, severity: 'error', description: 'ZZ-TEST Muster ' + id.slice(-2) + extra, fix: 'ZZ-TEST fix ' + id.slice(-2) });

async function aufraeumen() {
  await pool.query('DELETE FROM error_patterns WHERE id = ANY($1::uuid[])', [[P_ALL, P_HAIKU]]);
  await pool.query('DELETE FROM error_pattern_seen WHERE session_id = ANY($1)', [AGENTEN]);
  await pool.query('DELETE FROM agent_sessions WHERE id = ANY($1)', [AGENTEN]);
  await pool.query('DELETE FROM file_versions WHERE project = $1', [PRJ]).catch(() => {});
  await pool.query('DELETE FROM code_files WHERE project = $1', [PRJ]).catch(() => {});
}

try {
  await aufraeumen();
  await pool.query(
    `INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model) VALUES
     ($1, 'ZZ-TEST alle', 'ZZ-TEST fix alle', 'error', 'all', 'zz', 'opus'),
     ($2, 'ZZ-TEST haiku', 'ZZ-TEST fix haiku', 'warning', 'haiku', 'zz', 'haiku')`, [P_ALL, P_HAIKU]);

  // ---- C: checkErrorPatterns ----
  const c1 = await EP.checkErrorPatterns('PASSEND code', 'zz-fm-a');
  pruefe(c1.length === 2 && c1.some((x) => x.id === P_HAIKU), 'C1 ohne Session: unbekanntes Modell sieht alle (auch haiku)', c1);
  const c4 = await gesehen('zz-fm-a');
  pruefe(c4.length === 0, 'C4 checkErrorPatterns schreibt keinen gesehen-Vermerk', c4);

  process.env.FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE = '0';
  const c2 = await EP.checkErrorPatterns('PASSEND code', 'zz-fm-b');
  delete process.env.FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE;
  pruefe(c2.length === 1 && c2[0].id === P_ALL, 'C2 FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE=0: nur all', c2);

  await pool.query(`INSERT INTO agent_sessions (id, project, model, status, registered_at) VALUES ('zz-fm-opus', $1, 'claude-opus-5', 'active', NOW())`, [PRJ]);
  const c3 = await EP.checkErrorPatterns('PASSEND code', 'zz-fm-opus');
  pruefe(c3.length === 1 && c3[0].id === P_ALL, 'C3 bekanntes Modell (opus): scope-Filter bleibt', c3);

  const leer = await EP.checkErrorPatterns('nichts hier', 'zz-fm-a');
  pruefe(leer.length === 0, 'C0 Anker: unpassender Text liefert nichts', leer);

  await pool.query(`INSERT INTO agent_sessions (id, project, status, registered_at) VALUES ('zz-fm-c5', $1, 'active', NOW() - interval '2 days')`, [PRJ]);
  await pool.query(`INSERT INTO error_pattern_seen (pattern_id, session_id, shown_at) VALUES ($1, 'zz-fm-c5', NOW()), ($2, 'zz-fm-c5', NOW() - interval '25 hours')`, [P_ALL, P_HAIKU]);
  const c5a = await EP.checkErrorPatterns('PASSEND code', 'zz-fm-c5');
  pruefe(c5a.length === 1 && c5a[0].id === P_HAIKU, 'C5 frisch gesehen unterdrueckt, 25 h alt wieder da', c5a);
  await pool.query(`UPDATE agent_sessions SET registered_at = NOW() + interval '1 second' WHERE id = 'zz-fm-c5'`);
  const c5b = await EP.checkErrorPatterns('PASSEND code', 'zz-fm-c5');
  pruefe(c5b.length === 2, 'C5 gesehen vor der Registrierung zaehlt nicht', c5b);
  await pool.query(`DELETE FROM error_pattern_seen WHERE session_id = 'zz-fm-c5'`);

  // ---- A: Auslieferung ----
  FA._fehlermusterAuslieferungZuruecksetzen();
  FA.verfolgeFehlermusterPruefung('zz-fm-x', 'src/a.ts', Promise.resolve([w(P_ALL)]));
  await schlaf(5);
  pruefe((await gesehen('zz-fm-x')).length === 0, 'A3 vor der Auslieferung kein gesehen-Vermerk');
  const a1 = await FA.holeFehlermusterHinweise('zz-fm-x');
  pruefe(a1?.anzahl === 1 && a1.treffer[0].datei === 'src/a.ts' && /ZZ-TEST/.test(a1.treffer[0].was) && /fix/.test(a1.treffer[0].wie)
    && a1.treffer[0].pattern_id === P_ALL && /THEMATISCH/.test(a1.hinweis), 'A1 Treffer mit was/wie/datei ausgeliefert', a1);
  const a1s = await gesehen('zz-fm-x');
  pruefe(a1s.length === 1 && a1s[0].p === P_ALL, 'A1 danach gesehen-Vermerk in PG', a1s);
  pruefe((await FA.holeFehlermusterHinweise('zz-fm-x')) === null, 'A2 zweites Abholen liefert nichts');

  FA.verfolgeFehlermusterPruefung('zz-fm-x', 'src/b.ts', schlaf(100).then(() => [w(P_HAIKU)]));
  const t0 = Date.now();
  const a4 = await FA.holeFehlermusterHinweise('zz-fm-x');
  pruefe(a4?.anzahl === 1 && a4.treffer[0].datei === 'src/b.ts', 'A4 laufende Pruefung: hole wartet und liefert sofort', { a4, ms: Date.now() - t0 });

  process.env.FEHLERMUSTER_WARTE_MS = '150';
  FA.verfolgeFehlermusterPruefung('zz-fm-x', 'src/c.ts', schlaf(1000).then(() => [w(P_ALL)]));
  const t1 = Date.now();
  const a5a = await FA.holeFehlermusterHinweise('zz-fm-x');
  const dauer = Date.now() - t1;
  pruefe(a5a === null && dauer < 600, 'A5 langsame Pruefung: Antwort wartet nur kurz', { a5a, dauer });
  await schlaf(1000);
  const a5b = await FA.holeFehlermusterHinweise('zz-fm-x');
  pruefe(a5b?.anzahl === 1 && a5b.treffer[0].datei === 'src/c.ts', 'A5 Nachlieferung mit der naechsten Antwort', a5b);
  delete process.env.FEHLERMUSTER_WARTE_MS;

  FA.verfolgeFehlermusterPruefung('zz-fm-x', 'src/d.ts', Promise.resolve([w(P_ALL)]));
  FA.verfolgeFehlermusterPruefung('zz-fm-x', 'src/d.ts', Promise.resolve([w(P_ALL)]));
  const a6 = await FA.holeFehlermusterHinweise('zz-fm-x');
  pruefe(a6?.anzahl === 1, 'A6 gleiches Muster an gleicher Datei nur einmal', a6);

  for (let i = 0; i < 7; i++) FA.verfolgeFehlermusterPruefung('zz-fm-x', `src/v${i}.ts`, Promise.resolve([w(P_ALL)]));
  const a7a = await FA.holeFehlermusterHinweise('zz-fm-x');
  const a7b = await FA.holeFehlermusterHinweise('zz-fm-x');
  pruefe(a7a?.anzahl === 5 && /Weitere 2/.test(a7a.hinweis) && a7b?.anzahl === 2, 'A7 hoechstens 5 je Antwort, Rest folgt', { a: a7a?.anzahl, b: a7b?.anzahl, h: a7a?.hinweis });

  // ---- K: Kette ueber code-write ----
  FA._fehlermusterAuslieferungZuruecksetzen();
  await CW.createFileInPg(PRJ, 'k1/neu.ts', 'export const x = 1; // PASSEND\n', 'zz-fm-k1');
  const k1 = await FA.holeFehlermusterHinweise('zz-fm-k1');
  pruefe(k1?.anzahl === 2 && k1.treffer.every((t) => t.datei === 'k1/neu.ts'), 'K1 createFileInPg -> Treffer kommen beim Agenten an', k1);
  await pool.query(`DELETE FROM error_pattern_seen WHERE session_id = 'zz-fm-k1'`);
  await CW.updateFileInPg(PRJ, 'k1/neu.ts', 'export const x = 2; // PASSEND geaendert\n', 'zz-fm-k1');
  const k2 = await FA.holeFehlermusterHinweise('zz-fm-k1');
  pruefe(k2?.anzahl === 2, 'K1 updateFileInPg -> Treffer kommen beim Agenten an', k2);
  await CW.updateFileInPg(PRJ, 'k1/neu.ts', 'export const x = 3; // PASSEND nochmal\n', 'zz-fm-k1');
  const k3 = await FA.holeFehlermusterHinweise('zz-fm-k1');
  pruefe(k3 === null, 'K1 nach Auslieferung innerhalb der Sitzung nicht erneut', k3);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await schlaf(300); // nachlaufende Index-Jobs des Kettentests
  await aufraeumen().catch((e) => { fehler++; console.error('FEHLER  Aufraeumen: ' + e.message); });
  const rest = await pool.query('SELECT count(*)::int AS n FROM error_patterns WHERE id = ANY($1::uuid[])', [[P_ALL, P_HAIKU]]);
  if (rest.rows[0].n !== 0) fehler++;
  ollama.close();
  qdrant.close();
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
