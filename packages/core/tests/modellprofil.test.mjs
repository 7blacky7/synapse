/**
 * P15-T7/T8 (11.10.2026): MODELLPROFILE AUS POSTGRESQL - kein Modellwert im Code.
 *
 * ZUSAGEN:
 *   A ohne Profil: embed() scheitert mit modell_nicht_kalibriert, scoreSchwelle wirft, die
 *     Hinweis-Variante liefert schwelle null + Hinweis (kein stiller Ersatzwert).
 *   B Profil gesetzt (intern modellprofil_setzen): Praefixe, num_ctx und Stueckgroesse kommen an
 *     Ollama an, Schwellen kommen aus score_schwellen, Env SCORE_SCHWELLE_<ZWECK> hat Vorrang.
 *   C Ein Profil fuer den Digest des aktiven Modells schlaegt das digest-lose Profil.
 *   D Ohne Stueckgroesse lernt der Provider die Grenze aus der Ablehnung von Ollama
 *     ("current batch size: N") und teilt danach.
 *   E Ohne num_ctx im Profil (und ohne Env) bleibt num_ctx in der Anfrage weg.
 *   KONTROLLE: der Fake hat wirklich abgelehnt (sonst waere D ohne Aussage).
 *
 * AUFRUF (NUR gegen die Test-DB, nie Produktion; Tabelle embedding_modell_profile muss existieren):
 *   set -a; . <test-db.env>; set +a; node packages/core/tests/modellprofil.test.mjs
 * Exit 0 = gruen, 1 = Zusage verletzt, 2 = falsche DB / fehlende Tabelle.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}

const MODELL = 'fake-profil-embed:latest';
const DIGEST = 'abcdef0123456789'.repeat(4);
const BATCH_ZEICHEN = 50; // Fake: 1 Zeichen = 1 Token, physischer Batch 50

const anfragen = [];
let ablehnungen = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: MODELL, model: MODELL, digest: DIGEST, size: 1000 }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } }));
    if (req.url === '/api/embed') {
      const anfrage = JSON.parse(body);
      anfragen.push(anfrage);
      const zuLang = anfrage.input.find((t) => t.length > BATCH_ZEICHEN);
      if (zuLang) {
        ablehnungen++;
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: `input (${zuLang.length} tokens) is too large to process. increase the physical batch size (current batch size: ${BATCH_ZEICHEN})` }));
      }
      return res.end(JSON.stringify({ embeddings: anfrage.input.map(() => [1, 0, 0, 0, 0, 0, 0, 0]) }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
process.env.OLLAMA_MODEL = MODELL;
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SYNAPSE_MODELLPROFIL_TTL_MS = '0';
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_NUM_CTX', 'EMBEDDING_NUM_BATCH', 'EMBEDDING_MAX_INPUT_CHARS',
  'EMBEDDING_QUERY_PREFIX', 'EMBEDDING_DOC_PREFIX', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST',
  'SCORE_SCHWELLE_HOOK', 'SKILL_HOOK_MIN_SCORE', 'SCORE_SCHWELLE_GRAPH_CODE', 'SYNAPSE_COMPUTE_NODE']) delete process.env[name];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const emb = await import(join(dist, 'embeddings', 'index.js'));
const profil = await import(join(dist, 'embeddings', 'modell-profil.js'));
const pflege = await import(join(dist, 'services', 'intern-modellprofil.js'));
const db = await import(join(dist, 'db', 'client.js'));
const { getConfig } = await import(join(dist, 'config.js'));
const wirksam = getConfig();
if (/192\.168\.50\.65/.test(wirksam.embeddings.ollama.url + wirksam.qdrant.url)) {
  console.error('ABBRUCH: Ollama/Qdrant zeigen auf Produktion.');
  process.exit(2);
}
const tabelle = await db.getPool().query("SELECT to_regclass('embedding_modell_profile') AS t");
if (!tabelle.rows[0].t) {
  console.error('ABBRUCH: Tabelle embedding_modell_profile fehlt in der Test-DB (CREATE TABLE aus db/schema.ts ausfuehren).');
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
async function wirft(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
const neu = () => { profil.vergissModellprofil(); emb.resetEmbeddingProvider(); };
const aufraeumen = () => db.getPool().query('DELETE FROM embedding_modell_profile WHERE modell = $1', [MODELL]);

try {
  await aufraeumen();

  // ── A: ohne Profil kein Ersatzwert ──
  neu();
  const eA = await wirft(() => emb.embed('hallo', { art: 'query' }));
  pruefe(eA?.code === 'modell_nicht_kalibriert', 'A: embed ohne Profil -> modell_nicht_kalibriert', eA?.message);
  pruefe(anfragen.length === 0, 'A: ohne Profil ging keine Anfrage an Ollama', anfragen.length);
  const eA2 = await wirft(() => profil.scoreSchwelle('graph_code'));
  pruefe(eA2?.code === 'modell_nicht_kalibriert', 'A: scoreSchwelle ohne Profil wirft modell_nicht_kalibriert', eA2?.message);
  const hA = await profil.scoreSchwelleOderHinweis('graph_code');
  pruefe(hA.schwelle === null && /modell_nicht_kalibriert/.test(hA.hinweis ?? ''), 'A: Hinweis-Variante liefert null + Hinweis', hA);

  // ── B: Profil setzen und wirken lassen ──
  const gesetzt = await pflege.modellprofilSetzen({
    query_praefix: 'q: ', dok_praefix: 'd: ', num_ctx: 4096, max_stueck_zeichen: 40,
    score_schwellen: { graph_code: 0.42 }, notiz: 'modellprofil.test', agent: 'test',
  });
  pruefe(gesetzt.profil?.modell === MODELL && gesetzt.profil?.digest === '', 'B: ohne modell/digest gilt das aktive Modell, digest leer', gesetzt.profil);
  neu();
  anfragen.length = 0;
  await emb.embed('hallo', { art: 'query' });
  pruefe(anfragen[0]?.input?.[0] === 'q: hallo', 'B: Query-Praefix aus dem Profil', anfragen[0]);
  pruefe(anfragen[0]?.options?.num_ctx === 4096, 'B: num_ctx aus dem Profil', anfragen[0]?.options);
  anfragen.length = 0;
  await emb.embed('x'.repeat(100));
  const stuecke = anfragen[0]?.input ?? [];
  pruefe(stuecke.length === 3 && stuecke.every((s) => s.length <= 40) && stuecke[0].startsWith('d: '),
    'B: Dokument-Praefix + Stueckgroesse max_stueck_zeichen (103 Zeichen -> 3 Stuecke <= 40)', stuecke.map((s) => s.length));
  pruefe(await profil.scoreSchwelle('graph_code') === 0.42, 'B: Schwelle aus score_schwellen');
  const eB = await wirft(() => profil.scoreSchwelle('hook'));
  pruefe(eB?.code === 'modell_nicht_kalibriert', 'B: nicht gesetzter Zweck -> modell_nicht_kalibriert', eB?.message);
  process.env.SCORE_SCHWELLE_HOOK = '0.3';
  pruefe(await profil.scoreSchwelle('hook') === 0.3, 'B: Env SCORE_SCHWELLE_HOOK hat Vorrang');
  delete process.env.SCORE_SCHWELLE_HOOK;
  pruefe(/\|dokpraefix$/.test(profil.embeddingModellKennung()), 'B: Kennung kennt den Dokument-Praefix', profil.embeddingModellKennung());
  const misch = await pflege.modellprofilSetzen({ score_schwellen: { hook: 0.5, graph_code: null } });
  pruefe(misch.profil?.score_schwellen?.hook === 0.5 && !('graph_code' in (misch.profil?.score_schwellen ?? {})) && misch.profil?.query_praefix === 'q: ',
    'B: score_schwellen werden gemischt, null entfernt, andere Felder bleiben', misch.profil);
  const eFalsch = await wirft(() => pflege.modellprofilSetzen({ score_schwellen: { gibtsnicht: 0.5 } }));
  pruefe(eFalsch?.code === 'parameter_ungueltig', 'B: unbekannter Zweck wird abgelehnt', eFalsch?.message);

  // ── C: Digest-Profil schlaegt das digest-lose ──
  await pflege.modellprofilSetzen({ digest: DIGEST.slice(0, 12), query_praefix: 'qq: ', dok_praefix: 'dd: ' });
  neu();
  anfragen.length = 0;
  await emb.embed('hallo', { art: 'query' });
  pruefe(anfragen[0]?.input?.[0] === 'qq: hallo', 'C: Profil zum Digest des aktiven Modells gewinnt', anfragen[0]?.input);
  const stand = await profil.modellprofilStand();
  pruefe(stand.digest === DIGEST && stand.profil?.digest === DIGEST.slice(0, 12), 'C: Digest kam aus Ollama /api/tags', { digest: stand.digest, profil: stand.profil?.digest });
  await db.getPool().query("DELETE FROM embedding_modell_profile WHERE modell = $1 AND digest <> ''", [MODELL]);

  // ── D + E: Stueckgroesse lernen, num_ctx weglassen ──
  await pflege.modellprofilSetzen({ max_stueck_zeichen: null, num_batch: null, num_ctx: null });
  neu();
  anfragen.length = 0;
  ablehnungen = 0;
  const vektor = await emb.embed('y'.repeat(120));
  pruefe(Array.isArray(vektor) && vektor.length === 8, 'D: langer Text nach Ablehnung trotzdem eingebettet');
  pruefe(ablehnungen === 1, 'KONTROLLE: Ollama hat genau einmal abgelehnt', ablehnungen);
  const letzte = anfragen[anfragen.length - 1]?.input ?? [];
  pruefe(letzte.length > 1 && letzte.every((s) => s.length <= BATCH_ZEICHEN), 'D: danach in Stuecke <= gemeldeter Batch geteilt', letzte.map((s) => s.length));
  pruefe(anfragen.every((a) => a.options === undefined), 'E: ohne num_ctx in Profil/Env bleibt options weg', anfragen.map((a) => a.options));
} catch (error) {
  fehler++;
  console.error('ABBRUCH ' + (error?.stack ?? error));
} finally {
  await aufraeumen().catch((e) => { fehler++; console.error('Aufraeumen: ' + e.message); });
  const rest = (await db.getPool().query('SELECT count(*)::int AS n FROM embedding_modell_profile WHERE modell = $1', [MODELL])).rows[0].n;
  console.log(`AUFGERAEUMT (Rest ${rest})`);
  await db.closePool();
  server.close();
}
console.log(fehler === 0 ? 'ALLE PRUEFUNGEN GRUEN' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
