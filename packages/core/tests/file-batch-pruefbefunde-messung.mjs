/**
 * P15-T17 E3 ABNAHMEMESSUNG (Koordinator 5f914485): typische Datei <= 100 KB
 *   (1) Zusammenbau + Stufe 1 < 50 ms p95   (2) files(plan)-Antwortzeit steigt um <= 10 ms p95.
 * Aufbau: Test-DB (synapse_test, gleicher PG-Server wie Live), Ollama/Qdrant als Fakes, Stufe 1 realistisch:
 * TS-Parser (ts.createSourceFile().parseDiagnostics, sperrfaehig, wie P16-T4 geplant) + 30 aktive Signatur-Muster.
 * Je Konfiguration (5/50/100 KB x 1/10/50 Ops) N verschraenkte Laeufe planBatch mit Pruefung gegen
 * FEHLERPRUEFUNG_PLAN=0; Plan danach verworfen. (1) misst pruefeGespeichertenPlan (Schatten neu bauen inkl.
 * PG-Lesen + Pruefung, obere Schranke) und pruefung.dauer_ms (nur Stufe 1).
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/file-batch-pruefbefunde-messung.mjs [N] [ohne-ts]
 *   ohne-ts = Stand heute (noch kein Syntaxpruefer registriert, P16-T4), nur Signatur-Muster.
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) { console.error('ABBRUCH: nur Test-DB'); process.exit(2); }
const N = Number(process.argv[2] ?? 100);
const PRJ = 'zz-planbefunde-messung';
const MODELL = 'fake-pbm-embed:latest';
const fake = (antwort) => http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(antwort(req, body))); });
});
const ollama = fake((req, body) => {
  if (req.url === '/api/tags') return { models: [{ name: MODELL, model: MODELL, digest: 'ef'.repeat(32), size: 1000 }] };
  if (req.url === '/api/show') return { model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } };
  if (req.url === '/api/embed') { const a = JSON.parse(body); return { embeddings: (Array.isArray(a.input) ? a.input : [a.input]).map(() => [0, 1, 0, 0, 0, 0, 0, 0]) }; }
  return { models: [] };
});
const qdrant = fake((req) => (req.method === 'GET' && req.url === '/' ? { title: 'qdrant', version: '1.13.0' } : { status: 'ok', time: 0, result: /points\/search/.test(req.url) ? [] : {} }));
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, OLLAMA_MODEL: MODELL,
  QDRANT_URL: `http://127.0.0.1:${qdrant.address().port}`, EMBED_MIN_GAP_MS: '0', FEHLERPRUEFUNG_BUDGET_MS: '1000',
});
for (const n of ['FEHLERPRUEFUNG_PLAN', 'FEHLERPRUEFUNG_GUELTIG_MS', 'FEHLERMUSTER_CACHE_MS', 'SYNAPSE_AGENT_NAME']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...t) => import(pathToFileURL(join(...t)).href);
const batch = await lade(dist, 'services', 'file-batch.js');
const FP = await lade(dist, 'services', 'fehlermuster-pruefung.js');
const pool = (await lade(dist, 'db', 'client.js')).getPool();
const ts = createRequire(join(hier, '..', 'package.json'))('typescript');

const MUSTER_IDS = Array.from({ length: 30 }, (_, i) => `f0f0f0f0-1717-4e00-8a17-0000000009${String(i).padStart(2, '0')}`);
async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PRJ]).catch(() => {});
  await pool.query('DELETE FROM error_patterns WHERE id = ANY($1::uuid[])', [MUSTER_IDS]);
}
const p95 = (w) => { const s = [...w].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const p50 = (w) => { const s = [...w].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r1 = (x) => Math.round(x * 10) / 10;

try {
  await aufraeumen();
  for (const [i, id] of MUSTER_IDS.entries()) {
    await pool.query(
      `INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model, status, titel, erkennung)
       VALUES ($1, $2, 'fix', 'warning', 'all', 'zz', 'opus', 'aktiv', $3, $4::jsonb)`,
      [id, 'ZZ-MESSUNG ' + i, 'ZZ Messmuster ' + i, JSON.stringify({ art: 'regex', signatur: [`zzMess${i}_[A-Z]+\\(`, '(?:await\\s+)?Promise\\.all\\(\\s*\\w+\\.map\\('], fenster: i % 3 === 0 ? 'datei' : 'block', version: 1 })],
    );
  }
  FP._signaturMusterCacheLeeren();
  if (process.argv[3] !== 'ohne-ts') FP.registriereSyntaxPruefer({
    name: 'typescript', version: ts.version, endungen: ['ts', 'tsx', 'js', 'mjs'], sperrfaehig: true,
    pruefe: (text, filePath) => {
      const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false);
      return (sf.parseDiagnostics ?? []).map((d) => ({ zeile: sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, code: `TS${d.code}`, meldung: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
    },
  });
  const zeilenFuer = (kb) => {
    const out = [];
    let i = 0;
    while (out.join('\n').length < kb * 1024) { out.push(`export function f${i}(a: number): number { return a + ${i}; } // zeile ${i}`); i++; }
    return out;
  };
  const ergebnisse = [];
  for (const kb of [5, 50, 100]) {
    const zeilen = zeilenFuer(kb);
    const pfad = `m/datei-${kb}kb.ts`;
    const x = await batch.planBatch({ project: PRJ, agent_id: 'pbm-setup', ops: [{ file_path: pfad, action: 'create', content: zeilen.join('\n') + '\n' }] });
    await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'pbm-setup' });
    for (const anzahl of [1, 10, 50]) {
      const schritt = Math.max(1, Math.floor(zeilen.length / (anzahl + 1)));
      const ops = Array.from({ length: anzahl }, (_, k) => {
        const n = (k + 1) * schritt;
        return { file_path: pfad, action: 'search_replace', search: `return a + ${n}; } // zeile ${n}\n`, replace: `return a + ${n} + 1; } // zeile ${n}\n` };
      });
      const an = [];
      const aus = [];
      const stufe1 = [];
      const zusammenbau = [];
      for (let lauf = 0; lauf < N + 5; lauf++) {
        for (const modus of lauf % 2 === 0 ? ['an', 'aus'] : ['aus', 'an']) {
          if (modus === 'aus') process.env.FEHLERPRUEFUNG_PLAN = '0'; else delete process.env.FEHLERPRUEFUNG_PLAN;
          const t0 = performance.now();
          const p = await batch.planBatch({ project: PRJ, agent_id: 'pbm-a', ops });
          const ms = performance.now() - t0;
          if (lauf >= 5) {
            (modus === 'an' ? an : aus).push(ms);
            if (modus === 'an' && typeof p.pruefung?.dauer_ms === 'number') stufe1.push(p.pruefung.dauer_ms);
          }
          if (modus === 'an' && lauf >= 5 && lauf % 2 === 0) {
            process.env.FEHLERPRUEFUNG_GUELTIG_MS = '0';
            const t1 = performance.now();
            await batch.pruefeGespeichertenPlan(p.plan_id);
            zusammenbau.push(performance.now() - t1);
            delete process.env.FEHLERPRUEFUNG_GUELTIG_MS;
          }
          await pool.query(`UPDATE file_batch_plans SET status = 'cancelled' WHERE id = $1::bigint`, [p.plan_id]);
        }
      }
      delete process.env.FEHLERPRUEFUNG_PLAN;
      const e = {
        kb, ops: anzahl, n: an.length,
        plan_an_p50: r1(p50(an)), plan_an_p95: r1(p95(an)), plan_aus_p50: r1(p50(aus)), plan_aus_p95: r1(p95(aus)),
        delta_p95: r1(p95(an) - p95(aus)), delta_p50: r1(p50(an) - p50(aus)),
        stufe1_p95: r1(p95(stufe1)), zusammenbau_plus_stufe1_p95: r1(p95(zusammenbau)),
      };
      ergebnisse.push(e);
      console.log(JSON.stringify(e));
    }
  }
  console.log('ERGEBNIS ' + JSON.stringify(ergebnisse));
} finally {
  await aufraeumen().catch(() => {});
  ollama.close();
  qdrant.close();
  await pool.end().catch(() => {});
  process.exit(0);
}
