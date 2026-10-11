/**
 * P16-T8 (11.10.2026): Syntaxbefund an der VERURSACHENDEN Op und ihren Zeilen (fehlermuster-pruefung.findeUrsache,
 * plan-befunde.opZuordnung). Der Parser bemerkt eine fehlende } erst am Dateiende - der Befund muss trotzdem an der Op
 * haengen, die sie entfernt hat, mit bemerkt_bei (Parser-Stelle) und entstanden_bei (Op + Zeilen).
 *  U1  fehlende } in Op 0 von 3 -> Befund an op 0, Zeile der Op, bemerkt am Dateiende; Diff zeigt ihn an der Op.
 *  U2  Fehler in Op 2 bei sauberer Op 0/1 -> an op 2.
 *  U3  Kombination: Op 2 entfernt die } einer Funktion, die Op 1 eingefuegt hat -> an op 2, beteiligt [1, 2].
 *  U4  Einzelweg: drei Aenderungen, die mittlere entfernt eine } -> Zeilen auf die mittlere eingegrenzt.
 *  U5  coedit A/B/A: Bs Op (Index 1) entfernt die }, As spaetere Op 2 ist sauber -> Befund an B, Sperre nennt B.
 *  U6  Deckel FEHLERPRUEFUNG_URSACHE_MAX_LAEUFE=1 -> alte Zuordnung (Befund bleibt, keine Ursache).
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/file-batch-befund-ursache.test.mjs  (core bauen)
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
const MODELL = 'fake-bu-embed:latest';
const PRJ = 'zz-befundursache';
const A = 'bu-a';
const B = 'bu-b';

const fake = (antwort) => http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(antwort(req, body))); });
});
const ollama = fake((req, body) => {
  if (req.url === '/api/tags') return { models: [{ name: MODELL, model: MODELL, digest: 'cd'.repeat(32), size: 1000 }] };
  if (req.url === '/api/ps') return { models: [] };
  if (req.url === '/api/show') return { model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } };
  if (req.url === '/api/embed') { const a = JSON.parse(body); return { embeddings: (Array.isArray(a.input) ? a.input : [a.input]).map(() => [0, 1, 0, 0, 0, 0, 0, 0]) }; }
  return {};
});
const qdrant = fake((req) => (req.method === 'GET' && req.url === '/' ? { title: 'qdrant', version: '1.13.0' } : { status: 'ok', time: 0, result: /points\/search/.test(req.url) ? [] : {} }));
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, OLLAMA_MODEL: MODELL,
  QDRANT_URL: `http://127.0.0.1:${qdrant.address().port}`, EMBED_MIN_GAP_MS: '0', SCORE_SCHWELLE_ERROR_PATTERNS: '0.5',
  EMBEDDING_QUERY_PREFIX: '', EMBEDDING_DOC_PREFIX: '', FEHLERMUSTER_WARTE_MS: '50', FEHLERPRUEFUNG_BUDGET_MS: '5000',
  SYNTAX_WORKER_THREADS: '0',
});
for (const n of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE', 'SYNAPSE_AGENT_NAME',
  'SYNAPSE_DEFAULT_AGENT_ID', 'FEHLERMUSTER_CACHE_MS', 'FEHLERPRUEFUNG_PLAN', 'FEHLERPRUEFUNG_GUELTIG_MS', 'FEHLERPRUEFUNG_MAX_ANZEIGE',
  'FEHLERPRUEFUNG_URSACHE_MAX_LAEUFE', 'FEHLERPRUEFUNG_URSACHE_MS', 'SYNTAXPRUEFUNG']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...t) => import(pathToFileURL(join(...t)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) { console.error('ABBRUCH: Produktion.'); process.exit(2); }
const batch = await lade(dist, 'services', 'file-batch.js');
const res = await lade(dist, 'services', 'file-reservations.js');
const FP = await lade(dist, 'services', 'fehlermuster-pruefung.js');
const S = await lade(dist, 'services', 'syntax-pruefer', 'index.js');
const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 2500) : '')); }
}
/** 10 Funktionen je 3 Zeilen: f<i> in Zeile 3i+1..3i+3, "  return a + <i>;" in Zeile 3i+2, "}" in Zeile 3i+3. */
const quelle = (n = 10) => Array.from({ length: n }, (_, i) => `export function f${i}(a: number): number {\n  return a + ${i};\n}`).join('\n') + '\n';
const ohneKlammer = (i) => ({ search: `  return a + ${i};\n}\n`, replace: `  return a + ${i};\n` });
const sr = (file_path, { search, replace }) => ({ file_path, action: 'search_replace', search, replace });
const wert = (file_path, i, neu) => sr(file_path, { search: `return a + ${i};`, replace: `return a + ${neu};` });
const syntaxBefund = (pr) => (pr?.befunde ?? []).find((b) => b.quelle === 'syntax');

async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PRJ]).catch(() => {});
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PRJ]).catch(() => {});
  }
}
async function anlegen(p, t) {
  const x = await batch.planBatch({ project: PRJ, agent_id: 'bu-setup', ops: [{ file_path: p, action: 'create', content: t }] });
  const c = await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'bu-setup' });
  if (!c.success) throw new Error(`anlegen ${p}: ${c.message}`);
}

try {
  await aufraeumen();
  FP._signaturMusterCacheLeeren();
  FP._syntaxPrueferLeeren();
  S.registriereStandardSyntaxPruefer();

  // ===== U1 fehlende } in Op 0 von 3 =====
  await anlegen('u/u1.ts', quelle());
  const p1 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    sr('u/u1.ts', ohneKlammer(2)), wert('u/u1.ts', 5, 55), wert('u/u1.ts', 8, 88),
  ] });
  const b1 = syntaxBefund(p1.pruefung);
  pruefe(p1.pruefung?.sperre === true && b1?.op_index === 0 && b1.agent_id === A && b1.severity === 'error',
    'U1 fehlende } in Op 0 von 3: Befund an op 0 (Positivkontrolle; vorher an op 2)', p1.pruefung);
  pruefe(b1?.zeilen?.[0] === 8 && b1?.entstanden_bei?.op_index === 0 && (b1?.bemerkt_bei?.zeile ?? 0) >= 28 && !b1?.beteiligt,
    'U1 entstanden_bei Z.8 (Zeile vor der entfernten }), bemerkt_bei am Dateiende, keine Beteiligten', b1);
  pruefe(/bemerkt/.test(b1?.was ?? '') && /op 0/.test(b1?.was ?? ''), 'U1 Meldung nennt Parser-Stelle und Op', b1?.was);
  const t1 = String(p1.diff?.dateien?.[0]?.text ?? '');
  pruefe(b1 && t1.includes(`   return a + 2;\n!! befund ${b1.id} op 0 error`), 'U1 Diff: Befund an der Stelle der Op 0', t1);
  await batch.cancelBatch(p1.plan_id, A, 'test');

  // ===== U2 Fehler in Op 2 =====
  await anlegen('u/u2.ts', quelle());
  const p2 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    wert('u/u2.ts', 1, 11), wert('u/u2.ts', 4, 44), sr('u/u2.ts', ohneKlammer(6)),
  ] });
  const b2 = syntaxBefund(p2.pruefung);
  pruefe(b2?.op_index === 2 && b2.entstanden_bei?.op_index === 2 && b2.zeilen?.[0] === 20 && p2.pruefung?.anzahl === 1,
    'U2 Fehler in Op 2 bei sauberer Op 0/1: an op 2, Z.20', p2.pruefung);
  await batch.cancelBatch(p2.plan_id, A, 'test');

  // ===== U3 Kombination =====
  await anlegen('u/u3.ts', quelle());
  const p3 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    wert('u/u3.ts', 1, 11),
    sr('u/u3.ts', { search: '  return a + 5;\n}\n', replace: '  return a + 5;\n}\nexport function g(a: number): number {\n  return a;\n}\n' }),
    sr('u/u3.ts', { search: '  return a;\n}\n', replace: '  return a;\n' }),
  ] });
  const b3 = syntaxBefund(p3.pruefung);
  pruefe(b3?.op_index === 2 && (b3.beteiligt ?? []).join(',') === '1,2' && /op 1/.test(b3.was ?? ''),
    'U3 Kombination (Op 2 entfernt die } aus Text von Op 1): an op 2, beteiligt [1,2], Hinweis auf op 1', p3.pruefung);
  await batch.cancelBatch(p3.plan_id, A, 'test');

  // ===== U4 Einzelweg =====
  const alt = quelle();
  const neu = alt.replace('return a + 1;', 'return a + 11;').replace('  return a + 5;\n}\n', '  return a + 5;\n').replace('return a + 8;', 'return a + 88;');
  const r4 = await FP.pruefeSyntaxEinzelweg({ filePath: 'u/u4.ts', alt, neu });
  const b4 = r4.blockierend[0];
  pruefe(r4.blockierend.length === 1 && b4.zeilen[0] === 17 && b4.entstanden_bei?.zeilen?.[0] === 17 && b4.entstanden_bei?.op_index === undefined
    && (b4.bemerkt_bei?.zeile ?? 0) >= 28 && /ausserhalb der geaenderten Zeilen/.test(b4.was),
    'U4 Einzelweg: drei Aenderungen, Ursache auf die mittlere eingegrenzt (Z.17), bemerkt am Dateiende', r4);

  // ===== U5 coedit A/B/A =====
  await anlegen('u/u5.ts', quelle());
  await res.addFileReservations({ project: PRJ, agentId: A, filePaths: ['u/u5.ts'] });
  const p5 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [wert('u/u5.ts', 1, 11)] });
  const bOp = sr('u/u5.ts', ohneKlammer(3));
  await batch.planBatch({ project: PRJ, agent_id: B, ops: [bOp] });
  const add5 = await batch.addCoeditContribution({ project: PRJ, plan_id: p5.plan_id, agent_id: B, ops: [bOp] });
  const nach = await batch.planBatch({ project: PRJ, agent_id: A, ops: [wert('u/u5.ts', 8, 88)] });
  const g5 = await batch.pruefeGespeichertenPlan(p5.plan_id);
  const b5 = syntaxBefund({ befunde: g5?.pruefung?.befunde });
  pruefe(add5.success === true && b5?.op_index === 1 && b5.agent_id === B && b5.entstanden_bei?.op_index === 1,
    'U5 coedit: Befund an Bs Op 1, obwohl As Op 2 spaeter kommt', { add5: add5.success, nach: nach.merged_into ?? nach.plan_id, ops: g5?.pruefung?.befunde });
  const c5 = await batch.commitBatch({ plan_id: p5.plan_id, agent_id: A });
  pruefe(c5.error === 'pruef_befunde' && c5.blockierende?.[0]?.agent_id === B && c5.blockierende[0].op_index === 1,
    'U5 commit des Owners gesperrt, Sperre nennt B und seine Op', c5);
  await batch.cancelBatch(p5.plan_id, A, 'test').catch(() => {});
  await batch.cancelBatch(p5.plan_id, B, 'test').catch(() => {});

  // ===== U6 Deckel =====
  process.env.FEHLERPRUEFUNG_URSACHE_MAX_LAEUFE = '1';
  const r6 = await FP.pruefeSyntaxEinzelweg({ filePath: 'u/u6.ts', alt, neu });
  pruefe(r6.blockierend.length === 1 && !r6.blockierend[0].entstanden_bei && (r6.blockierend[0].bemerkt_bei?.zeile ?? 0) >= 28,
    'U6 Deckel 1 Lauf: Befund bleibt (sperrt), ohne Ursache', r6.blockierend[0]);
  delete process.env.FEHLERPRUEFUNG_URSACHE_MAX_LAEUFE;
} catch (err) {
  fehler++;
  console.log('FEHLER  Ausnahme', err?.stack ?? err);
} finally {
  await aufraeumen().catch(() => {});
  await S.beendeSyntaxPool().catch(() => {});
  ollama.close();
  qdrant.close();
  await pool.end().catch(() => {});
}
console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
